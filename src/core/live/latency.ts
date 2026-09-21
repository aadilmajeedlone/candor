import type { TurnLatency } from '@shared/types';
import { median, percentile } from '@shared/util';

export type Clock = () => number;
export const systemClock: Clock = () => performance.now();

export type Mark =
  | 'speechStart'
  | 'firstPartial'
  | 'speechEnd'
  | 'finalTranscript'
  | 'questionDetected'
  | 'retrievalStart'
  | 'retrievalEnd'
  | 'llmSend'
  | 'firstToken'
  | 'complete';

/**
 * Wall-clock marks for one question→answer turn, taken from a monotonic clock.
 * Every number the UI shows comes from these marks; nothing is estimated or defaulted.
 */
export class TurnTimeline {
  private marks: Partial<Record<Mark, number>> = {};
  private detectionMs: number | null = null;

  constructor(private readonly clock: Clock = systemClock) {}

  /** First write wins unless `overwrite` is set. Returns the recorded time. */
  mark(name: Mark, at: number = this.clock(), overwrite = false): number {
    const existing = this.marks[name];
    if (existing !== undefined && !overwrite) return existing;
    this.marks[name] = at;
    return at;
  }

  get(name: Mark): number | undefined {
    return this.marks[name];
  }

  /**
   * Compute time of the question detector for the evaluation that started this answer. This is the detector's
   * own cost; it deliberately excludes the short "text has been stable" wait used before speculative starts,
   * which shows up in perceived latency instead.
   */
  setDetection(ms: number): void {
    this.detectionMs = ms;
  }

  reset(names?: Mark[]): void {
    if (!names) {
      this.marks = {};
      this.detectionMs = null;
      return;
    }
    for (const n of names) delete this.marks[n];
  }

  /** Clear the generation marks (used when a speculative generation is restarted) but keep speech marks. */
  resetGeneration(): void {
    this.reset(['retrievalStart', 'retrievalEnd', 'llmSend', 'firstToken', 'complete']);
  }

  latency(extra: Partial<TurnLatency> = {}): TurnLatency {
    const m = this.marks;
    const d = (a: Mark, b: Mark): number | undefined =>
      m[a] !== undefined && m[b] !== undefined ? Math.max(0, (m[b]) - (m[a])) : undefined;
    const out: TurnLatency = { ...extra };
    const firstPartial = d('speechStart', 'firstPartial');
    if (firstPartial !== undefined) out.firstPartialMs = round(firstPartial);
    const sttFinal = d('speechEnd', 'finalTranscript');
    if (sttFinal !== undefined) out.sttFinalMs = round(sttFinal);
    if (this.detectionMs !== null) out.detectionMs = round(this.detectionMs);
    const retrieval = d('retrievalStart', 'retrievalEnd');
    if (retrieval !== undefined) out.retrievalMs = round(retrieval);
    const ttft = d('llmSend', 'firstToken');
    if (ttft !== undefined) out.ttftMs = round(ttft);
    const total = d('questionDetected', 'complete');
    if (total !== undefined) out.totalMs = round(total);
    // Perceived latency: from the moment the interviewer stopped talking to the first visible word.
    // Negative means a speculative answer had already started while they were still speaking.
    const anchor = m.speechEnd ?? m.questionDetected;
    if (anchor !== undefined && m.firstToken !== undefined) out.perceivedMs = round(m.firstToken - anchor);
    return out;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface LatencySummary {
  count: number;
  median: number | null;
  p90: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export function summarize(values: number[]): LatencySummary {
  if (values.length === 0) return { count: 0, median: null, p90: null, p95: null, min: null, max: null };
  return {
    count: values.length,
    median: median(values),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Rolling window of per-turn latencies for the session summary and the debug panel. */
export class LatencyLog {
  private readonly turns: TurnLatency[] = [];
  constructor(private readonly max = 200) {}

  add(l: TurnLatency): void {
    this.turns.push(l);
    if (this.turns.length > this.max) this.turns.shift();
  }

  all(): TurnLatency[] {
    return [...this.turns];
  }

  summary(): { ttft: LatencySummary; total: LatencySummary; perceived: LatencySummary; retrieval: LatencySummary; cacheHits: number; turns: number } {
    const pick = (k: keyof TurnLatency) => this.turns.map((t) => t[k]).filter((v): v is number => typeof v === 'number');
    return {
      ttft: summarize(this.turns.filter((t) => !t.cacheHit).map((t) => t.ttftMs).filter((v): v is number => typeof v === 'number')),
      total: summarize(pick('totalMs')),
      perceived: summarize(pick('perceivedMs')),
      retrieval: summarize(pick('retrievalMs')),
      cacheHits: this.turns.filter((t) => t.cacheHit).length,
      turns: this.turns.length,
    };
  }
}
