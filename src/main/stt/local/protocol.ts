import type { Casing } from './format';

/**
 * Messages between the main process and the speech worker thread. Speech recognition runs in a worker so decoding
 * (tens of milliseconds of pure computation every chunk) can never delay IPC, timers or the answer stream.
 */

export interface WorkerInit {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  /** One decoding thread measured best on a 4-core laptop: more threads spin-wait and burn a whole core for no gain. */
  numThreads: number;
  /** Silence after speech (seconds) at which the recogniser ends a segment on its own. */
  endpointSilenceSec: number;
  casing: Casing;
  /** Bring quiet speech up to a normal level before recognition (see agc.ts). */
  autoGain?: boolean;
}

export type ToWorker =
  | { t: 'init'; cfg: WorkerInit }
  | { t: 'open'; id: number }
  /** 16 kHz mono PCM16 little-endian; the buffer is transferred, not copied. */
  | { t: 'audio'; id: number; pcm: ArrayBuffer }
  /** End of an utterance: flush what is pending into a final result now. */
  | { t: 'finalize'; id: number }
  | { t: 'close'; id: number }
  | { t: 'dispose' };

export type WorkerFailure = 'runtime_missing' | 'model_load_failed';

export interface CoreStatsDTO {
  audioMs: number;
  chunks: number;
  decodeMsTotal: number;
  decodeMsMax: number;
}

export type FromWorker =
  | { t: 'ready'; loadMs: number; rssMb: number }
  | { t: 'failed'; code: WorkerFailure; message: string }
  | { t: 'result'; id: number; text: string; isFinal: boolean; speechFinal: boolean; processedMs: number }
  /** How much audio has been consumed so far, so the host can tell when recognition is falling behind real time. */
  | { t: 'progress'; id: number; processedMs: number; stats: CoreStatsDTO }
  | { t: 'error'; id?: number; message: string };
