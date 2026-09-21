import { Notification, app, clipboard, dialog, shell, type BrowserWindow, type Session } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HttpClient } from '../ai/types';
import { MAX_FILE_BYTES } from '../documents/limits';
import type { PlatformBridge } from '../services';
import type { Hotkeys } from './hotkeys';

export interface PlatformState {
  systemAudioArmed: boolean;
}

/** Electron-backed implementation of everything the services need from the desktop. */
export function createPlatform(deps: {
  getWindow: () => BrowserWindow | null;
  hotkeys: () => Hotkeys | null;
  startupMs: () => number;
  state: PlatformState;
}): PlatformBridge {
  return {
    async pickFile(purpose) {
      const win = deps.getWindow();
      const opts: Electron.OpenDialogOptions = {
        title: purpose === 'resume' ? 'Choose your résumé' : 'Choose the job description',
        properties: ['openFile'],
        filters: [
          { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      const path = res.filePaths[0];
      if (res.canceled || !path) return null;
      // The path comes from the OS dialog (never from the renderer). Check the size before reading it into memory.
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`That file is larger than ${MAX_FILE_BYTES / 1048576} MB.`);
      return { name: basename(path), data: new Uint8Array(readFileSync(path)) };
    },
    async openExternal(url) {
      await shell.openExternal(url);
    },
    async openSystemSettings(page) {
      if (process.platform === 'win32') await shell.openExternal(page === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:sound');
      else if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    },
    setKeepOnTop(value) {
      deps.getWindow()?.setAlwaysOnTop(value, 'floating');
    },
    notify(title, body) {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    },
    async saveFile(defaultName, contents) {
      const win = deps.getWindow();
      const opts: Electron.SaveDialogOptions = { title: 'Export your data', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      writeFileSync(res.filePath, contents, 'utf8');
      return res.filePath;
    },
    writeClipboard: (text) => clipboard.writeText(text),
    info: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
      startupMs: deps.startupMs(),
      logPath: join(app.getPath('userData'), 'logs'),
    }),
    hotkeyStatus: () => deps.hotkeys()?.get() ?? ({} as never),
    reregisterHotkeys: () => deps.hotkeys()?.register(),
    setSystemAudioArmed: (armed) => {
      deps.state.systemAudioArmed = armed;
    },
    // Sum of every Electron process (main, renderer, GPU, utility): what Task Manager attributes to the app.
    memoryMB: () => Math.round(app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024),
  };
}

/** HTTP over Chromium's network stack: system proxy and certificate store, HTTP/2, connection reuse. */
export function createHttp(getSession: () => Session): HttpClient {
  // `net` is imported lazily so unit tests never need Electron.
  return {
    fetch: async (url, init) => {
      const { net } = await import('electron');
      return net.fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    },
    preconnect: (url) => {
      try {
        getSession().preconnect({ url, numSockets: 2 });
      } catch {
        /* best effort */
      }
    },
  };
}
