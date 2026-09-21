const t0 = performance.now();

import { BrowserWindow, Menu, app, ipcMain, safeStorage, session } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AllPush } from '@shared/ipc';
import { dispatch } from './ipc/dispatch';
import { createHandlers } from './ipc/handlers';
import { validators } from './ipc/validators';
import { Hotkeys } from './electron/hotkeys';
import { createHttp, createPlatform, type PlatformState } from './electron/platform';
import { APP_SCHEME, configureSession, createMainWindow, isTrustedSender, registerAppProtocol, registerScheme } from './electron/window';
import { aiDebug } from './ai/diagnostics';
import { log, logger } from './logging';
import { modelSearchRoots } from './stt/local/models';
import { createServices, type Services } from './services';

registerScheme();

const l = log('main');
let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let hotkeys: Hotkeys | null = null;
let startupMs = 0;
const platformState: PlatformState = { systemAudioArmed: false };

// Development / tests can redirect user data so they never touch a real profile.
if (process.env.CANDOR_USER_DATA) app.setPath('userData', process.env.CANDOR_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function loadEnv(): void {
  // Optional .env next to the app (development) or in the user-data folder (installed app). Existing variables win.
  for (const p of [join(app.getAppPath(), '.env'), join(app.getPath('userData'), '.env')]) {
    try {
      if (existsSync(p)) process.loadEnvFile(p);
    } catch {
      /* ignore malformed .env */
    }
  }
}

function push<K extends keyof AllPush>(channel: K, payload: AllPush[K]): void {
  const win = mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc(handlers: ReturnType<typeof createHandlers>): void {
  for (const channel of Object.keys(validators)) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted sender.');
      return dispatch(handlers, channel, payload);
    });
  }
  // Captured audio: high-rate, fire-and-forget, validated by shape and size only.
  ipcMain.on('audio:chunk', (event, source: unknown, buf: unknown) => {
    if (!isTrustedSender(event)) return;
    if (source !== 'mic' && source !== 'system') return;
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf instanceof Uint8Array ? buf : null;
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 65_536) return;
    const s = services;
    if (!s) return;
    if (source === 'mic' && s.mock.listening) s.mock.audio(bytes);
    else s.live.audio(source, bytes);
  });
}

function boot(): void {
  loadEnv();
  const logsDir = join(app.getPath('userData'), 'logs');
  logger.configure({ level: (process.env.CANDOR_LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug' | undefined) ?? 'info', dir: logsDir });
  l.info('starting', { version: app.getVersion(), packaged: app.isPackaged });
  // Off unless the person starts Candor with CANDOR_DEBUG_AI=1 (or =full): raw model replies for diagnosing formatting problems.
  aiDebug.configure({ mode: process.env.CANDOR_DEBUG_AI, dir: logsDir });
  if (aiDebug.enabled) l.warn('AI debug capture is ON: raw model replies are being written to a local file', { file: aiDebug.path, includesPrompts: aiDebug.capturesPrompts });

  registerAppProtocol(join(__dirname, '../renderer'));
  configureSession(session.defaultSession, platformState);

  const platform = createPlatform({ getWindow: () => mainWindow, hotkeys: () => hotkeys, startupMs: () => startupMs, state: platformState });
  const stt = process.env.CANDOR_DEEPGRAM_URL ? { deepgram: process.env.CANDOR_DEEPGRAM_URL } : undefined;
  services = createServices({
    dbPath: join(app.getPath('userData'), 'candor.db'),
    cipher: { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: (p) => safeStorage.encryptString(p), decrypt: (b) => safeStorage.decryptString(b) },
    env: process.env,
    http: createHttp(() => session.defaultSession),
    platform,
    emit: push,
    sttUrls: stt,
    localSpeech: {
      modelRoots: () =>
        modelSearchRoots({
          override: process.env.CANDOR_STT_MODELS_DIR,
          userData: app.getPath('userData'),
          resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
          appRoot: app.getAppPath(),
        }),
    },
  });
  hotkeys = new Hotkeys(() => services!, (action) => push('hotkey', { action }));
  registerIpc(createHandlers(services));

  if (app.isPackaged) Menu.setApplicationMenu(null);
  openMainWindow();
  hotkeys.register();
}

function openMainWindow(): void {
  if (!services) return;
  const settings = services.repos.getSettings();
  mainWindow = createMainWindow({
    preload: join(__dirname, '../preload/index.js'),
    devUrl: !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined,
    backgroundColor: settings.theme === 'light' ? '#f6f4ef' : '#0b0d12',
    onReady: () => {
      startupMs = Math.round(performance.now() - t0 + process.uptime() * 0); // main-process time to first window
      l.info('window ready', { startupMs });
    },
  });
  if (settings.live.keepOnTop) mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.on('closed', () => (mainWindow = null));
}

// Never crash silently and never print a secret: unexpected errors go to the redacting logger.
process.on('unhandledRejection', (reason) => l.error('unhandled rejection', { message: reason instanceof Error ? reason.message : String(reason) }));
process.on('uncaughtException', (err) => l.error('uncaught exception', { message: err.message }));

app.setAppUserModelId('com.candor.interview');
app.whenReady().then(boot).catch((err) => {
  l.error('startup failed', { message: err instanceof Error ? err.message : String(err) });
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  hotkeys?.dispose();
  if (services) {
    e.preventDefault();
    services
      .dispose()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  }
});

void APP_SCHEME;
