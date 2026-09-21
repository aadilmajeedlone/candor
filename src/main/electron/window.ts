import { BrowserWindow, app, desktopCapturer, net, protocol, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import { statSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../logging';
import { isAllowedExternalUrl } from '../security/links';
import { resolveAppPath } from './appPath';
import type { PlatformState } from './platform';

const l = log('window');

export const APP_SCHEME = 'candor';
export const APP_ORIGIN = `${APP_SCHEME}://app`;

/** Must run before app "ready". */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

const CSP_PROD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The renderer never talks to the network: every provider call goes through the main process.
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

/** Serve the built renderer from disk under candor://app/, refusing anything outside its folder. */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
    const full = resolveAppPath(rendererDir, url.pathname);
    if (!full) return new Response('Forbidden', { status: 403 });
    if (!isFile(full)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(full).toString());
    const headers = new Headers(res.headers);
    headers.set('content-type', MIME[extname(full).toLowerCase()] ?? 'application/octet-stream');
    headers.set('content-security-policy', CSP_PROD);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile(); // also excludes directories and Windows device names such as CON
  } catch {
    return false;
  }
}

export function isTrustedUrl(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN) return true;
  const dev = process.env.ELECTRON_RENDERER_URL;
  return !!dev && !app.isPackaged && url.startsWith(dev);
}

export function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return isTrustedUrl(url);
}

/** Permissions: the microphone (audio only, never the camera) for our own UI, and system audio only after an explicit arm from the UI. */
export function configureSession(ses: Session, state: PlatformState): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const wantsVideo = permission === 'media' && ((details as { mediaTypes?: string[] }).mediaTypes ?? []).includes('video');
    const ok = permission === 'media' && !wantsVideo && isTrustedUrl(details.requestingUrl ?? wc.getURL());
    if (!ok) l.warn('permission denied', { permission });
    callback(ok);
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => permission === 'media' && (details as { mediaType?: string }).mediaType !== 'video' && isTrustedUrl(origin || wc?.getURL() || ''));

  // System audio (WASAPI loopback) is granted per request, and only while the user has armed it in the UI.
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!state.systemAudioArmed) {
        callback({});
        return;
      }
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  if (!app.isPackaged) {
    // Vite's dev server needs inline scripts and a websocket for HMR, so the dev CSP is relaxed. Production is strict.
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' ws://localhost:* http://localhost:* data: blob:"] } });
    });
  }
}

export function createMainWindow(opts: { preload: string; devUrl?: string; backgroundColor: string; onReady: () => void }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: opts.backgroundColor,
    title: 'Candor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // the live screen must keep streaming while another window is in front
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    opts.onReady();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Never open new Electron windows; only allow-listed https links go to the system browser.
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (opts.devUrl) void win.loadURL(opts.devUrl);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}
