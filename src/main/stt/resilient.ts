import type { SttProviderId } from '@shared/types';
import type { SttConfig, SttEvents, SttProvider, SttState, SttStream } from './types';

export interface ResilientOptions {
  primary: { provider: SttProvider; key: string; cfg: SttConfig };
  fallback?: { provider: SttProvider; key: string; cfg: SttConfig } | null;
  events: SttEvents;
  /** Called (visibly) when the provider changes. */
  onSwitch?: (from: SttProviderId, to: SttProviderId, reason: string) => void;
  maxReconnects?: number;
  /** Audio kept while reconnecting so a brief drop loses no speech. */
  replayMs?: number;
}

/**
 * Wraps an STT stream with recovery. A dropped connection is retried with backoff while the last few seconds of
 * audio are buffered and replayed; an authentication failure or exhausted retries switches to the fallback
 * provider (if one is configured). Every transition is reported: nothing fails silently.
 */
export class ResilientStt implements SttStream {
  private active: { provider: SttProvider; key: string; cfg: SttConfig };
  private inner: SttStream | null = null;
  private attempts = 0;
  private usedFallback = false;
  private closed = false;
  private buffer: Uint8Array[] = [];
  private bufferBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  state: SttState = 'connecting';
  private readonly maxReconnects: number;
  private readonly replayBytes: number;

  constructor(private readonly o: ResilientOptions) {
    this.active = o.primary;
    this.maxReconnects = o.maxReconnects ?? 4;
    this.replayBytes = Math.round(((o.replayMs ?? 4000) / 1000) * 32000);
    this.open();
  }

  private emit(state: SttState, message?: string, fatal = false): void {
    this.state = state;
    this.o.events.onState(state, message, fatal);
  }

  private open(): void {
    const { provider, key, cfg } = this.active;
    const stream = provider.open(cfg, key, {
      onTranscript: (t) => this.o.events.onTranscript(t),
      onState: (state, message, fatal) => this.onInnerState(stream, state, message, fatal),
      onNotice: (level, message) => this.o.events.onNotice?.(level, message),
    });
    this.inner = stream;
  }

  private onInnerState(from: SttStream, state: SttState, message?: string, fatal?: boolean): void {
    if (this.closed || from !== this.inner) return;
    if (state === 'connected') {
      this.attempts = 0;
      this.emit('connected', this.usedFallback ? `Using ${this.active.provider.label} (fallback)` : undefined);
      this.replay();
      return;
    }
    if (state === 'connecting') return;
    if (state === 'closed') return;
    // state === 'error'
    void from.close().catch(() => undefined);
    this.inner = null;
    if (fatal || this.attempts >= this.maxReconnects) {
      if (this.trySwitch(message ?? 'connection failed')) return;
      this.emit('error', message ?? 'Speech recognition connection failed.', true);
      return;
    }
    this.attempts++;
    const wait = Math.min(4000, 400 * 2 ** (this.attempts - 1));
    this.emit('reconnecting', `${message ?? 'Connection lost'} — retrying in ${(wait / 1000).toFixed(1)}s (${this.attempts}/${this.maxReconnects})`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.open();
    }, wait);
  }

  private trySwitch(reason: string): boolean {
    const fb = this.o.fallback;
    if (!fb || this.usedFallback) return false;
    this.usedFallback = true;
    const from = this.active.provider.id;
    this.active = fb;
    this.attempts = 0;
    this.o.onSwitch?.(from, fb.provider.id, reason);
    this.emit('reconnecting', `Switching to ${fb.provider.label}…`);
    this.open();
    return true;
  }

  private replay(): void {
    const inner = this.inner;
    if (!inner) return;
    for (const chunk of this.buffer) inner.sendAudio(chunk);
    this.buffer = [];
    this.bufferBytes = 0;
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    if (this.state === 'connected' && this.inner) {
      this.inner.sendAudio(pcm);
      return;
    }
    // Not connected: keep the most recent audio for replay.
    this.buffer.push(pcm);
    this.bufferBytes += pcm.byteLength;
    while (this.bufferBytes > this.replayBytes && this.buffer.length > 1) this.bufferBytes -= this.buffer.shift()!.byteLength;
  }

  finalize(): void {
    if (this.state === 'connected') this.inner?.finalize();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const inner = this.inner;
    this.inner = null;
    if (inner) await inner.close().catch(() => undefined);
    this.state = 'closed';
  }
}
