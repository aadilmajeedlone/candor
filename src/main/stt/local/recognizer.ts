import { AutoGain } from './agc';
import { formatTranscript } from './format';
import type { CoreStatsDTO, WorkerInit } from './protocol';

/**
 * The recogniser itself: one loaded model shared by any number of audio streams (the microphone and system audio
 * are two streams of the same model). It knows nothing about threads or IPC, so the same code runs in the worker
 * and, in tests, in-process against a scripted stand-in for the native library.
 *
 * Incremental by construction. Every audio frame is fed straight in; whenever the model has a full chunk it decodes
 * it and the running text is compared with what was last reported. A changed text goes out as a partial result at
 * once, so downstream code can start understanding a question while it is still being spoken.
 */

/** The parts of `sherpa-onnx-node`'s OnlineRecognizer/OnlineStream this code uses. */
export interface OnlineStreamLike {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
}
export interface OnlineRecognizerLike {
  createStream(): OnlineStreamLike;
  isReady(s: OnlineStreamLike): boolean;
  decode(s: OnlineStreamLike): void;
  isEndpoint(s: OnlineStreamLike): boolean;
  reset(s: OnlineStreamLike): void;
  getResult(s: OnlineStreamLike): { text: string };
}
export interface SherpaModule {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizerLike;
}

export interface CoreResult {
  id: number;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  processedMs: number;
}

export const SAMPLE_RATE = 16_000;
/** Silence appended on flush so the model's right-hand context is complete and the last word is emitted. */
const FLUSH_PADDING_MS = 400;

/** The native recogniser's configuration for a streaming transducer. Exported so tests can check it. */
export function buildRecognizerConfig(init: WorkerInit): Record<string, unknown> {
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: init.encoder, decoder: init.decoder, joiner: init.joiner },
      tokens: init.tokens,
      numThreads: init.numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4, // long silence with nothing heard: drop the (empty) segment
    rule2MinTrailingSilence: init.endpointSilenceSec, // silence after speech: the utterance is over
    rule3MinUtteranceLength: 20, // cut a monologue that never pauses
  };
}

interface StreamState {
  stream: OnlineStreamLike;
  lastRaw: string;
  samples: number;
  gain: AutoGain | null;
}

export class RecognizerCore {
  private readonly rec: OnlineRecognizerLike;
  private readonly streams = new Map<number, StreamState>();
  private chunks = 0;
  private decodeMsTotal = 0;
  private decodeMsMax = 0;

  constructor(
    sherpa: SherpaModule,
    private readonly init: WorkerInit,
    private readonly emit: (r: CoreResult) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.rec = new sherpa.OnlineRecognizer(buildRecognizerConfig(init));
  }

  get openStreams(): number {
    return this.streams.size;
  }

  open(id: number): void {
    this.close(id);
    this.streams.set(id, { stream: this.rec.createStream(), lastRaw: '', samples: 0, gain: this.init.autoGain ? new AutoGain() : null });
  }

  close(id: number): void {
    this.streams.delete(id); // the native stream is released with its last reference
  }

  processedMs(id: number): number {
    return Math.round(((this.streams.get(id)?.samples ?? 0) / SAMPLE_RATE) * 1000);
  }

  stats(): CoreStatsDTO {
    let samples = 0;
    for (const s of this.streams.values()) samples += s.samples;
    return { audioMs: Math.round((samples / SAMPLE_RATE) * 1000), chunks: this.chunks, decodeMsTotal: Math.round(this.decodeMsTotal), decodeMsMax: Math.round(this.decodeMsMax) };
  }

  /** Feed audio. Emits a partial result when the running text changed, and a final one when the model ends the segment. */
  push(id: number, pcm: Int16Array): void {
    const st = this.streams.get(id);
    if (!st || pcm.length === 0) return;
    const level = st.gain ? st.gain.process(pcm) : pcm;
    const samples = new Float32Array(level.length);
    for (let i = 0; i < level.length; i++) samples[i] = (level[i] ?? 0) / 32768;
    st.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    st.samples += pcm.length;
    if (!this.decodeReady(st)) return;
    const raw = this.rec.getResult(st.stream).text;
    if (this.rec.isEndpoint(st.stream)) {
      this.endSegment(id, st, raw, true);
      return;
    }
    this.partial(id, st, raw);
  }

  /** The speaker stopped (a local decision, e.g. end of speech): turn whatever is pending into a final result now. */
  finalize(id: number): void {
    const st = this.streams.get(id);
    if (!st) return;
    st.stream.acceptWaveform({ samples: new Float32Array((SAMPLE_RATE * FLUSH_PADDING_MS) / 1000), sampleRate: SAMPLE_RATE });
    this.decodeReady(st);
    this.endSegment(id, st, this.rec.getResult(st.stream).text, true);
  }

  private decodeReady(st: StreamState): boolean {
    let decoded = false;
    const t0 = this.now();
    while (this.rec.isReady(st.stream)) {
      this.rec.decode(st.stream);
      decoded = true;
      this.chunks++;
    }
    if (decoded) {
      const ms = this.now() - t0;
      this.decodeMsTotal += ms;
      if (ms > this.decodeMsMax) this.decodeMsMax = ms;
    }
    return decoded;
  }

  private partial(id: number, st: StreamState, raw: string): void {
    if (!raw.trim() || raw === st.lastRaw) return;
    st.lastRaw = raw;
    this.emit({ id, text: formatTranscript(raw, { casing: this.init.casing, final: false }), isFinal: false, speechFinal: false, processedMs: this.processedMs(id) });
  }

  private endSegment(id: number, st: StreamState, raw: string, speechFinal: boolean): void {
    if (raw.trim()) {
      this.emit({ id, text: formatTranscript(raw, { casing: this.init.casing, final: true }), isFinal: true, speechFinal, processedMs: this.processedMs(id) });
    }
    this.rec.reset(st.stream);
    st.lastRaw = '';
  }
}
