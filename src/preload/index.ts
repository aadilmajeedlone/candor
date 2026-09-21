import { contextBridge, ipcRenderer } from 'electron';
import type { AllPush, DesktopApi } from '../shared/ipc';

/**
 * The only surface the renderer gets. It exposes typed invoke/subscribe/sendAudio and nothing else: no Node,
 * no filesystem, no shell, no raw ipcRenderer.
 */
const PUSH: (keyof AllPush)[] = ['live.event', 'gen.event', 'prep.progress', 'bench.progress', 'hotkey', 'app.notice', 'mock.event'];

function clean(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron prefixes rejections with "Error invoking remote method '<channel>': IpcError: ".
  return new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, ''));
}

const api: DesktopApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, args[0]).catch((e: unknown) => Promise.reject(clean(e))),
  on: (channel, cb) => {
    if (!PUSH.includes(channel)) return () => undefined;
    const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => (cb as (p: unknown) => void)(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  sendAudio: (source, pcm) => ipcRenderer.send('audio:chunk', source, pcm),
};

contextBridge.exposeInMainWorld('api', api);
