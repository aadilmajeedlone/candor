import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import type { WorkerPort } from '../../src/main/stt/local/host';
import { LOCAL_MODELS, type LocalModelId, type LocalModelSpec } from '../../src/main/stt/local/models';
import type { FromWorker, ToWorker } from '../../src/main/stt/local/protocol';
import type { OnlineRecognizerLike, OnlineStreamLike, SherpaModule } from '../../src/main/stt/local/recognizer';
import { attachWorker } from '../../src/main/stt/local/workerLoop';

/**
 * A scripted stand-in for the native speech library. It "hears" a fixed sentence one word per chunk of non-silent
 * audio, and treats all-zero audio as silence, so tests can exercise partial results, endpointing and flushing
 * deterministically. It is NOT a speech model: accuracy and latency of the real engine are measured separately.
 */
export interface FakeSherpaOptions {
  /** What the "speaker" says, one word per speech chunk. */
  words?: string[];
  /** Samples per decode step (2560 = 160 ms at 16 kHz). */
  chunkSamples?: number;
  /** Trailing silence (samples) after which the recogniser reports an endpoint. */
  endpointSamples?: number;
  /** Throw when the recogniser is created (a model that cannot be loaded). */
  failOnCreate?: string;
}

class FakeStream implements OnlineStreamLike {
  buffered = 0;
  hasSpeechInBuffer = false;
  wordsHeard = 0;
  trailingSilence = 0;
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void {
    this.buffered += o.samples.length;
    if (o.samples.some((x) => Math.abs(x) > 0.001)) this.hasSpeechInBuffer = true;
  }
}

export function fakeSherpa(o: FakeSherpaOptions = {}): SherpaModule & { created: unknown[]; decodeSteps: number } {
  const words = o.words ?? 'tell me about a time when you led a team'.split(' ');
  const chunk = o.chunkSamples ?? 2560;
  const endpoint = o.endpointSamples ?? 12800; // 0.8 s
  const state = { created: [] as unknown[], decodeSteps: 0 };
  class Recognizer implements OnlineRecognizerLike {
    constructor(config: unknown) {
      if (o.failOnCreate) throw new Error(o.failOnCreate);
      state.created.push(config);
    }
    createStream(): OnlineStreamLike {
      return new FakeStream();
    }
    isReady(s: OnlineStreamLike): boolean {
      return (s as FakeStream).buffered >= chunk;
    }
    decode(s: OnlineStreamLike): void {
      const st = s as FakeStream;
      state.decodeSteps++;
      st.buffered -= chunk;
      if (st.hasSpeechInBuffer) {
        st.wordsHeard = Math.min(words.length, st.wordsHeard + 1);
        st.trailingSilence = 0;
        if (st.buffered < chunk) st.hasSpeechInBuffer = false;
      } else st.trailingSilence += chunk;
    }
    isEndpoint(s: OnlineStreamLike): boolean {
      const st = s as FakeStream;
      return st.wordsHeard > 0 && st.trailingSilence >= endpoint;
    }
    reset(s: OnlineStreamLike): void {
      const st = s as FakeStream;
      st.wordsHeard = 0;
      st.trailingSilence = 0;
      st.hasSpeechInBuffer = false;
    }
    getResult(s: OnlineStreamLike): { text: string } {
      return { text: words.slice(0, (s as FakeStream).wordsHeard).join(' ').toUpperCase() };
    }
  }
  return Object.assign({ OnlineRecognizer: Recognizer }, state, {
    get decodeSteps() {
      return state.decodeSteps;
    },
  });
}

/** 40 ms of "speech" (constant non-zero samples) or silence, as the PCM16 bytes the microphone path delivers. */
export function pcmFrame(kind: 'speech' | 'silence', ms = 40): Uint8Array {
  const samples = new Int16Array((16 * ms) | 0);
  if (kind === 'speech') samples.fill(3000);
  return new Uint8Array(samples.buffer);
}

export interface InProcessWorker extends WorkerPort {
  /** Everything the host sent, in order. */
  readonly received: ToWorker[];
  /** Simulate the thread dying unexpectedly. */
  crash(message?: string): void;
  terminated: boolean;
}

/**
 * The worker side of the protocol running in this thread over a MessageChannel: the real `attachWorker` loop with
 * the scripted library behind it. Used to test the host without starting a thread or loading a model.
 */
export function inProcessWorker(loadSherpa: () => SherpaModule, opts: { onMessage?: (m: FromWorker) => void } = {}): InProcessWorker {
  const { port1, port2 } = new MessageChannel();
  const received: ToWorker[] = [];
  const errorHandlers: ((e: Error) => void)[] = [];
  const exitHandlers: ((code: number) => void)[] = [];
  // Record host → worker traffic, then let the real worker loop handle it.
  const origPostMessage = port1.postMessage.bind(port1);
  attachWorker(port2, loadSherpa);
  const worker: InProcessWorker = {
    received,
    terminated: false,
    post(m, transfer) {
      // Keep a copy: a transferred buffer is detached (empty) on this side once it has been sent.
      received.push(m.t === 'audio' ? { ...m, pcm: m.pcm.slice(0) } : m);
      if (this.terminated) return;
      origPostMessage(m, transfer ?? []);
    },
    onMessage(cb) {
      port1.on('message', (m: FromWorker) => {
        opts.onMessage?.(m);
        cb(m);
      });
    },
    onError(cb) {
      errorHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },
    crash(message = 'boom') {
      worker.terminated = true;
      port1.close();
      for (const h of errorHandlers) h(new Error(message));
      for (const h of exitHandlers) h(1);
    },
    async terminate() {
      if (worker.terminated) return;
      worker.terminated = true;
      port1.close();
      for (const h of exitHandlers) h(1);
    },
  };
  return worker;
}

const TINY = 16;

/** The real model catalogue with every file shrunk to 16 bytes, so tests can lay out "installed" models instantly. */
export const tinySpecs = Object.fromEntries(
  Object.entries(LOCAL_MODELS).map(([id, spec]) => [id, { ...spec, files: Object.fromEntries(Object.entries(spec.files).map(([k, f]) => [k, { ...f, bytes: TINY }])) }]),
) as Record<LocalModelId, LocalModelSpec>;

/** A folder holding tiny stand-ins for the given models (default: both). The caller removes it. */
export function tinyModelRoot(ids: LocalModelId[] = ['x-asr-160', 'zipformer-en-70m']): string {
  const root = mkdtempSync(join(tmpdir(), 'candor-models-'));
  for (const id of ids) {
    mkdirSync(join(root, id), { recursive: true });
    for (const f of Object.values(LOCAL_MODELS[id].files)) writeFileSync(join(root, id, f.name), Buffer.alloc(TINY));
  }
  return root;
}
