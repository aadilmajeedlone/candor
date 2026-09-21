import { parentPort } from 'node:worker_threads';
import type { SherpaModule } from './recognizer';
import { attachWorker } from './workerLoop';

/**
 * Entry point of the speech worker thread (bundled separately by electron-vite; see `host.ts`). All the logic is in
 * `workerLoop.ts`; this file only connects it to the thread's message port and to the native library.
 */
if (!parentPort) throw new Error('This file must be started as a worker thread.');

attachWorker(parentPort, () => {
  // Loaded lazily and by name so a missing or blocked native library is reported as a clear error, not a crash at import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('sherpa-onnx-node') as SherpaModule;
});
