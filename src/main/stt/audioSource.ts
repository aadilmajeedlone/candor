import type { Clock } from '@core/live/latency';
import { EnergyVad, rmsLevel, type VadEvent } from '@core/vad/vad';
import type { VadSensitivity } from '@shared/settings';
import type { Speaker } from '@shared/types';
import type { SttStream } from './types';

export interface AudioSourceOptions {
  name: 'mic' | 'system';
  role: Speaker;
  sensitivity: VadSensitivity;
  clock: Clock;
  stt: SttStream | null;
  onVad: (role: Speaker, ev: { type: 'speech_start' | 'speech_end'; at: number }) => void;
  /** Ask the STT provider to flush now (local end of speech). */
  finalizeOnSpeechEnd: boolean;
  onLevel?: (name: 'mic' | 'system', rms: number) => void;
}

/**
 * One captured audio source: local VAD for speech boundaries, forwarding of every frame to streaming STT, and
 * conversion of VAD stream-time to the shared monotonic clock so latency measurements line up.
 */
export class AudioSource {
  private readonly vad: EnergyVad;
  private bytesSeen = 0;
  private lastLevelAt = 0;

  constructor(private readonly o: AudioSourceOptions) {
    this.vad = new EnergyVad(o.sensitivity);
  }

  get speaking(): boolean {
    return this.vad.isSpeaking;
  }

  get name(): 'mic' | 'system' {
    return this.o.name;
  }

  /** Feed PCM16 mono 16 kHz little-endian bytes. */
  push(bytes: Uint8Array): void {
    if (bytes.byteLength < 2) return;
    const arrived = this.o.clock();
    this.bytesSeen += bytes.byteLength;
    const even = bytes.byteLength & ~1;
    // Copy: IPC buffers can be unaligned, and Int16Array needs an even byte offset.
    const samples = new Int16Array(bytes.slice(0, even).buffer);

    this.o.stt?.sendAudio(bytes);

    const events = this.vad.push(samples);
    for (const e of events) this.emitVad(e, arrived);

    if (this.o.onLevel && arrived - this.lastLevelAt > 60) {
      this.lastLevelAt = arrived;
      this.o.onLevel(this.o.name, rmsLevel(samples));
    }
  }

  private emitVad(e: VadEvent, arrived: number): void {
    // VAD time is stream time; align it to the clock using "now" as the end of the processed audio.
    const at = arrived - (this.vad.streamMs - e.atMs);
    if (e.type === 'speech_start') this.o.onVad(this.o.role, { type: 'speech_start', at });
    else {
      if (this.o.finalizeOnSpeechEnd) this.o.stt?.finalize();
      this.o.onVad(this.o.role, { type: 'speech_end', at });
    }
  }

  get seconds(): number {
    return this.bytesSeen / 32000;
  }
}
