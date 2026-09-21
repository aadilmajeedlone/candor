import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerPort } from './host';

/**
 * Where the speech worker's script is. It is built as a second entry next to the main bundle (see
 * electron.vite.config.ts). Inside the installed app the main bundle lives in app.asar, but a worker thread needs a
 * real file, so the packaged copy is unpacked beside the archive and preferred when present.
 */
export function speechWorkerPath(dir: string = __dirname): string {
  const inArchive = join(dir, 'sttWorker.js');
  const unpacked = inArchive.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  return unpacked !== inArchive && existsSync(unpacked) ? unpacked : inArchive;
}

/** Start the speech worker thread (from `scriptPath`, by default the one built next to the app). */
export function spawnSpeechWorker(scriptPath: string = speechWorkerPath()): WorkerPort {
  const worker = new Worker(scriptPath);
  return {
    post: (m, transfer) => worker.postMessage(m, transfer ?? []),
    onMessage: (cb) => worker.on('message', cb),
    onError: (cb) => worker.on('error', cb),
    onExit: (cb) => worker.on('exit', cb),
    terminate: async () => {
      await worker.terminate();
    },
  };
}
