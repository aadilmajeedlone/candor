import type { LocalSttFailure, LocalSttState, LocalSttStatus } from '@shared/speech';
import type { ScopedLogger } from '../../logging';
import type { SttConfig, SttEvents, SttState, SttStream } from '../types';
import { chooseModel, LOCAL_MODELS, locateModel, modelSizeLabel, type Hardware, type LocalModelId, type LocalModelPreference, type LocalModelSpec, type LocatedModel } from './models';
import type { FromWorker, ToWorker, WorkerInit } from './protocol';

/** One end of the connection to a speech worker (a `worker_threads` Worker in the app, a fake in tests). */
export interface WorkerPort {
  post(m: ToWorker, transfer?: ArrayBuffer[]): void;
  onMessage(cb: (m: FromWorker) => void): void;
  onError(cb: (e: Error) => void): void;
  onExit(cb: (code: number) => void): void;
  terminate(): Promise<void>;
}

export type { LocalSttFailure, LocalSttState, LocalSttStatus };

export class LocalSttError extends Error {
  constructor(
    readonly code: LocalSttFailure,
    message: string,
    /** Retrying cannot help (nothing will change without the user or an update). */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'LocalSttError';
  }
}

export interface HostDeps {
  createWorker: () => WorkerPort;
  /** Folders that may contain the model folders. */
  roots: () => string[];
  hardware: Hardware;
  preference: () => LocalModelPreference;
  /** The user's end-of-speech wait (ms); shapes the recogniser's own endpointing. */
  endpointingMs: () => number;
  log: Pick<ScopedLogger, 'info' | 'warn' | 'error' | 'debug'>;
  now?: () => number;
  /** Free the model after this long with no stream open. 0 disables. */
  idleUnloadMs?: number;
  /** Give up on a model load after this long. */
  loadTimeoutMs?: number;
  /** Threads for decoding. One is fastest per CPU-second on the development machine; more only add busy-waiting. */
  numThreads?: number;
  /** Model catalogue. Tests substitute tiny files. */
  specs?: Record<LocalModelId, LocalModelSpec>;
}

/** Recognition is "behind" when more than this much audio is waiting… */
const LAG_WARN_MS = 1200;
/** …for this long. */
const LAG_WARN_AFTER_MS = 2000;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

function endpointSilenceSec(endpointingMs: number): number {
  return Math.min(2, Math.max(0.6, endpointingMs / 1000 + 0.5));
}

function short(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Owns the speech worker thread: starts it on demand, loads the model once, multiplexes audio streams onto it, and
 * turns every way it can fail into a plain-language status. The model stays loaded between listening sessions (no
 * reload on every question) and is released after a long idle period.
 */
export class LocalSttHost {
  private worker: WorkerPort | null = null;
  private state: LocalSttState = 'idle';
  private located: LocatedModel | null = null;
  private plannedModel: LocalModelId | null = null;
  private loading: Promise<void> | null = null;
  private loadMs: number | null = null;
  private rssMb: number | null = null;
  private failure: { code: LocalSttFailure; message: string } | null = null;
  private readonly streams = new Map<number, LocalStream>();
  private nextId = 1;
  private crashes: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private waiter: { resolve: () => void; reject: (e: LocalSttError) => void } | null = null;
  private readonly now: () => number;

  private readonly specs: Record<LocalModelId, LocalModelSpec>;

  constructor(private readonly d: HostDeps) {
    this.now = d.now ?? (() => Date.now());
    this.specs = d.specs ?? LOCAL_MODELS;
  }

  status(): LocalSttStatus {
    const id = this.located?.spec.id ?? this.plannedModel ?? this.plan();
    const spec = this.specs[id];
    let lag = 0;
    for (const s of this.streams.values()) lag = Math.max(lag, s.backlogMs);
    return {
      state: this.state,
      modelId: id,
      modelLabel: spec.label,
      tier: spec.tier,
      modelSize: modelSizeLabel(spec),
      loadMs: this.loadMs,
      rssMb: this.rssMb,
      code: this.failure?.code ?? null,
      message: this.failure?.message ?? null,
      openStreams: this.streams.size,
      lagMs: lag,
    };
  }

  /** Which model a start would use right now (without loading anything). */
  private plan(): LocalModelId {
    return chooseModel(this.d.preference(), this.d.hardware);
  }

  /** Is a usable model on disk? Cheap: only checks that the files exist with the right sizes. */
  check(): { ok: true; model: LocatedModel } | { ok: false; error: LocalSttError } {
    const wanted = this.plan();
    const lookup = locateModel(wanted, this.d.roots(), this.specs);
    if (lookup.ok) return { ok: true, model: lookup.model };
    // "Auto" may step down to the light model when the accurate one is not installed; an explicit choice may not.
    if (this.d.preference() === 'auto' && wanted !== 'zipformer-en-70m') {
      const light = locateModel('zipformer-en-70m', this.d.roots(), this.specs);
      if (light.ok) return { ok: true, model: light.model };
    }
    const spec = this.specs[wanted];
    const detail = lookup.problems.length ? ` (${short(lookup.problems.join(' | '))})` : '';
    return {
      ok: false,
      error:
        lookup.reason === 'incomplete'
          ? new LocalSttError('model_incomplete', `The speech model "${spec.label}" is damaged or incomplete${detail}. Reinstall Candor, or from the source folder run "npm run models".`, true)
          : new LocalSttError('model_missing', `The speech model "${spec.label}" is not installed. Reinstall Candor, or from the source folder run "npm run models".`, true),
    };
  }

  /** Load the model now (idempotent). Safe to call ahead of a session so listening starts instantly. */
  ensureReady(): Promise<void> {
    if (this.state === 'ready' && this.worker) {
      // The preference may have changed since the model was loaded; swap only when nothing is listening.
      if (this.streams.size === 0) {
        const want = this.check();
        if (want.ok && want.model.spec.id !== this.located?.spec.id) return this.unload().then(() => this.ensureReady());
      }
      return Promise.resolve();
    }
    if (this.loading) return this.loading;
    const p = this.load().finally(() => {
      this.loading = null;
    });
    this.loading = p;
    return p;
  }

  private fail(err: LocalSttError): never {
    this.state = 'failed';
    this.failure = { code: err.code, message: err.message };
    this.d.log.warn(`local speech: ${err.code}`);
    throw err;
  }

  private async load(): Promise<void> {
    this.cancelIdle();
    const found = this.check();
    if (!found.ok) {
      this.located = null;
      this.plannedModel = this.plan();
      this.fail(found.error);
    }
    const model = found.model;
    this.located = model;
    this.plannedModel = model.spec.id;
    this.state = 'loading';
    this.failure = null;

    const init: WorkerInit = {
      encoder: model.paths.encoder,
      decoder: model.paths.decoder,
      joiner: model.paths.joiner,
      tokens: model.paths.tokens,
      numThreads: this.d.numThreads ?? 1,
      endpointSilenceSec: endpointSilenceSec(this.d.endpointingMs()),
      casing: model.spec.casing,
      autoGain: true,
    };

    let worker: WorkerPort;
    try {
      worker = this.d.createWorker();
    } catch (e) {
      this.fail(new LocalSttError('runtime_missing', `The speech engine could not be started (${short(e instanceof Error ? e.message : String(e))}).`, true));
    }
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
    worker.onMessage((m) => this.onMessage(worker, m));
    worker.onError((e) => this.onGone(worker, `The speech engine hit an error: ${short(e.message)}`));
    worker.onExit((code) => this.onGone(worker, `The speech engine stopped (exit code ${code}).`));
    worker.post({ t: 'init', cfg: init });

    const timeoutMs = this.d.loadTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalSttError('model_load_failed', `Loading the speech model took longer than ${Math.round(timeoutMs / 1000)} seconds.`, false)), timeoutMs);
    });
    try {
      await Promise.race([ready, timeout]);
    } catch (e) {
      this.waiter = null;
      this.dropWorker();
      this.fail(e instanceof LocalSttError ? e : new LocalSttError('model_load_failed', short(e instanceof Error ? e.message : String(e)), false));
    } finally {
      clearTimeout(timer);
    }
    this.state = 'ready';
    this.d.log.info(`local speech ready: ${model.spec.id}, loaded in ${this.loadMs ?? '?'} ms`);
  }

  private onMessage(from: WorkerPort, m: FromWorker): void {
    if (from !== this.worker) return;
    switch (m.t) {
      case 'ready':
        this.loadMs = m.loadMs;
        this.rssMb = m.rssMb;
        this.waiter?.resolve();
        this.waiter = null;
        return;
      case 'failed': {
        const err =
          m.code === 'runtime_missing'
            ? new LocalSttError('runtime_missing', `The speech engine could not start on this PC (${short(m.message)}). Security software may have blocked it — allow Candor, or choose a cloud speech service in Settings → Speech.`, true)
            : new LocalSttError('model_load_failed', `The speech model could not be loaded (${short(m.message)}).`, false);
        this.waiter?.reject(err);
        this.waiter = null;
        return;
      }
      case 'result':
        this.streams.get(m.id)?.onResult(m);
        return;
      case 'progress':
        this.streams.get(m.id)?.onProgress(m.processedMs);
        return;
      case 'error':
        this.d.log.warn(`local speech worker error: ${short(m.message)}`);
        if (m.id !== undefined) this.streams.get(m.id)?.onWorkerError(m.message);
        return;
    }
  }

  /** The worker died or errored outside our control. */
  private onGone(from: WorkerPort, message: string): void {
    if (from !== this.worker) return;
    this.dropWorker();
    if (this.waiter) {
      this.waiter.reject(new LocalSttError('worker_crashed', message, false));
      this.waiter = null;
      return;
    }
    this.state = 'failed';
    this.failure = { code: 'worker_crashed', message };
    const t = this.now();
    this.crashes = this.crashes.filter((x) => t - x < CRASH_WINDOW_MS);
    this.crashes.push(t);
    const repeated = this.crashes.length >= MAX_CRASHES;
    this.d.log.error(`local speech worker gone (${this.crashes.length} in the last minute)`);
    for (const s of [...this.streams.values()]) s.onWorkerGone(repeated ? `${message} It keeps stopping — choose a cloud speech service in Settings → Speech.` : message, repeated);
  }

  private dropWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w) void w.terminate().catch(() => undefined);
  }

  /** @internal used by streams */
  clock(): number {
    return this.now();
  }

  /** @internal used by streams */
  post(m: ToWorker, transfer?: ArrayBuffer[]): void {
    this.worker?.post(m, transfer);
  }

  open(cfg: SttConfig, events: SttEvents): SttStream {
    this.cancelIdle();
    const stream = new LocalStream(this, this.nextId++, cfg, events);
    this.streams.set(stream.id, stream);
    return stream;
  }

  /** @internal */
  release(stream: LocalStream): void {
    this.streams.delete(stream.id);
    if (this.streams.size === 0) this.scheduleIdle();
  }

  private scheduleIdle(): void {
    const ms = this.d.idleUnloadMs ?? 10 * 60_000;
    if (ms <= 0 || this.state !== 'ready') return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.streams.size === 0) void this.unload();
    }, ms);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Free the model's memory (it loads again on the next use). */
  async unload(): Promise<void> {
    this.cancelIdle();
    const w = this.worker;
    this.worker = null;
    if (this.state === 'ready' || this.state === 'loading') this.state = 'idle';
    if (w) {
      w.post({ t: 'dispose' });
      await w.terminate().catch(() => undefined);
    }
    this.d.log.info('local speech unloaded');
  }

  async dispose(): Promise<void> {
    for (const s of [...this.streams.values()]) await s.close();
    await this.unload();
  }
}

class LocalStream implements SttStream {
  state: SttState = 'connecting';
  private closed = false;
  private sentMs = 0;
  private processedMs = 0;
  private lagSince: number | null = null;
  private lagReported = false;

  constructor(
    private readonly host: LocalSttHost,
    readonly id: number,
    private readonly cfg: SttConfig,
    private readonly ev: SttEvents,
  ) {
    void this.start();
  }

  get backlogMs(): number {
    return this.state === 'connected' ? Math.max(0, this.sentMs - this.processedMs) : 0;
  }

  private set(state: SttState, message?: string, fatal = false): void {
    this.state = state;
    this.ev.onState(state, message, fatal);
  }

  private async start(): Promise<void> {
    try {
      await this.host.ensureReady();
    } catch (e) {
      if (this.closed) return;
      const err = e instanceof LocalSttError ? e : new LocalSttError('model_load_failed', short(e instanceof Error ? e.message : String(e)), false);
      this.set('error', err.message, err.fatal);
      return;
    }
    if (this.closed) return;
    this.host.post({ t: 'open', id: this.id });
    this.set('connected');
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.state !== 'connected') return;
    const even = pcm.byteLength & ~1;
    if (even === 0) return;
    // A transferable copy: the caller's buffer may be reused or unaligned.
    const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + even) as ArrayBuffer;
    this.sentMs += even / 32;
    this.host.post({ t: 'audio', id: this.id, pcm: copy }, [copy]);
  }

  finalize(): void {
    if (this.state === 'connected') this.host.post({ t: 'finalize', id: this.id });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.state === 'connected') this.host.post({ t: 'close', id: this.id });
    this.state = 'closed';
    this.host.release(this);
    return Promise.resolve();
  }

  /** @internal */
  onResult(m: Extract<FromWorker, { t: 'result' }>): void {
    if (this.closed) return;
    this.processedMs = m.processedMs;
    this.ev.onTranscript({ text: m.text, isFinal: m.isFinal, speechFinal: m.speechFinal });
  }

  /** @internal Tracks whether recognition keeps up with the microphone; says so once when it does not. */
  onProgress(processedMs: number): void {
    if (this.closed) return;
    this.processedMs = processedMs;
    const behind = this.backlogMs;
    const t = this.host.clock();
    if (behind > LAG_WARN_MS) {
      this.lagSince ??= t;
      if (!this.lagReported && t - this.lagSince > LAG_WARN_AFTER_MS) {
        this.lagReported = true;
        this.ev.onNotice?.('warn', `Speech recognition is running about ${(behind / 1000).toFixed(1)} s behind real time. Close heavy apps, or choose the light speech model in Settings → Speech.`);
      }
    } else if (behind < 400) {
      this.lagSince = null;
      if (this.lagReported) {
        this.lagReported = false;
        this.ev.onNotice?.('info', 'Speech recognition has caught up.');
      }
    }
  }

  /** @internal A recoverable error for this stream only. */
  onWorkerError(message: string): void {
    if (this.closed) return;
    this.set('error', `Speech recognition error: ${short(message)}`, false);
  }

  /** @internal The worker died: the resilient wrapper above will reconnect (or give up if it keeps happening). */
  onWorkerGone(message: string, fatal: boolean): void {
    if (this.closed) return;
    this.set('error', message, fatal);
  }
}
