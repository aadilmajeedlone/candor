import { performance } from 'node:perf_hooks';
import type { FromWorker, ToWorker } from './protocol';
import { RecognizerCore, type SherpaModule } from './recognizer';

/** The end of a worker's message channel (a `worker_threads` MessagePort, or a MessageChannel port in tests). */
export interface PortLike {
  postMessage(m: FromWorker): void;
  on(event: 'message', cb: (m: ToWorker) => void): unknown;
}

/** How often progress is reported per stream (the host uses it to notice recognition falling behind real time). */
const PROGRESS_EVERY_MS = 250;

/**
 * The worker's whole job: load the model once, then turn `audio` messages into `result` messages. Kept apart from
 * the entry file (`worker.ts`) so tests can run it without starting a thread.
 */
export function attachWorker(port: PortLike, loadSherpa: () => SherpaModule, now: () => number = () => performance.now()): void {
  let core: RecognizerCore | null = null;
  const lastProgress = new Map<number, number>();

  const send = (m: FromWorker): void => port.postMessage(m);

  port.on('message', (m: ToWorker) => {
    try {
      switch (m.t) {
        case 'init': {
          let sherpa: SherpaModule;
          try {
            sherpa = loadSherpa();
          } catch (e) {
            send({ t: 'failed', code: 'runtime_missing', message: e instanceof Error ? e.message : String(e) });
            return;
          }
          const t0 = now();
          try {
            core = new RecognizerCore(sherpa, m.cfg, (r) => send({ t: 'result', ...r }), now);
          } catch (e) {
            send({ t: 'failed', code: 'model_load_failed', message: e instanceof Error ? e.message : String(e) });
            return;
          }
          send({ t: 'ready', loadMs: Math.round(now() - t0), rssMb: Math.round(process.memoryUsage().rss / 1_048_576) });
          return;
        }
        case 'open':
          core?.open(m.id);
          return;
        case 'audio': {
          if (!core) return;
          core.push(m.id, new Int16Array(m.pcm, 0, m.pcm.byteLength >> 1));
          const t = now();
          if (t - (lastProgress.get(m.id) ?? 0) >= PROGRESS_EVERY_MS) {
            lastProgress.set(m.id, t);
            send({ t: 'progress', id: m.id, processedMs: core.processedMs(m.id), stats: core.stats() });
          }
          return;
        }
        case 'finalize':
          core?.finalize(m.id);
          return;
        case 'close':
          core?.close(m.id);
          lastProgress.delete(m.id);
          return;
        case 'dispose':
          core = null;
          return;
      }
    } catch (e) {
      send({ t: 'error', id: 'id' in m ? m.id : undefined, message: e instanceof Error ? e.message : String(e) });
    }
  });
}
