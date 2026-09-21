import type { VadSensitivity } from '@shared/settings';

/**
 * Local, dependency-free voice activity detector: adaptive noise floor + energy threshold + onset/hangover
 * hysteresis over 20 ms frames of 16 kHz mono PCM16.
 *
 * Limits (stated plainly): this is an energy detector, not a neural VAD. It separates speech from quiet and
 * steady noise well, but loud non-speech (keyboard clatter, music) can trigger it. The STT provider's own
 * endpointing remains the authority on transcripts; the VAD is used for the level meter, for pause/onset
 * timing, and to ask the provider to finalize early.
 */

export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME_MS = 20;
export const VAD_FRAME_SAMPLES = (VAD_SAMPLE_RATE * VAD_FRAME_MS) / 1000;

export type VadEvent =
  | { type: 'speech_start'; atMs: number }
  | { type: 'speech_end'; atMs: number; hangoverMs: number };

export interface VadProfile {
  marginDb: number;
  onsetFrames: number;
  hangoverFrames: number;
}

export const VAD_PROFILES: Record<VadSensitivity, VadProfile> = {
  // More sensitive = lower margin over the noise floor, shorter onset, shorter hangover (faster end-of-speech).
  high: { marginDb: 7, onsetFrames: 2, hangoverFrames: 12 },
  medium: { marginDb: 10, onsetFrames: 3, hangoverFrames: 15 },
  low: { marginDb: 14, onsetFrames: 5, hangoverFrames: 20 },
};

const ABS_MIN_DB = -50;
const FLOOR_INIT_DB = -62;

export class EnergyVad {
  private readonly profile: VadProfile;
  private carry = new Int16Array(0);
  private frameIndex = 0;
  private noiseFloorDb = FLOOR_INIT_DB;
  private speaking = false;
  private voicedRun = 0;
  private silentRun = 0;
  private lastVoicedEndMs = 0;
  private lastDb = -100;

  constructor(sensitivity: VadSensitivity = 'medium') {
    this.profile = VAD_PROFILES[sensitivity];
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Last frame level in dBFS (for the meter). */
  get levelDb(): number {
    return this.lastDb;
  }

  get hangoverMs(): number {
    return this.profile.hangoverFrames * VAD_FRAME_MS;
  }

  /** Stream time of the end of the last processed frame. */
  get streamMs(): number {
    return this.frameIndex * VAD_FRAME_MS;
  }

  push(samples: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    let buf = samples;
    if (this.carry.length > 0) {
      buf = new Int16Array(this.carry.length + samples.length);
      buf.set(this.carry, 0);
      buf.set(samples, this.carry.length);
    }
    let offset = 0;
    while (offset + VAD_FRAME_SAMPLES <= buf.length) {
      const ev = this.processFrame(buf.subarray(offset, offset + VAD_FRAME_SAMPLES));
      if (ev) events.push(ev);
      offset += VAD_FRAME_SAMPLES;
    }
    this.carry = offset < buf.length ? buf.slice(offset) : new Int16Array(0);
    return events;
  }

  reset(): void {
    this.carry = new Int16Array(0);
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
  }

  private processFrame(frame: Int16Array): VadEvent | null {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frame.length) / 32768;
    const db = 20 * Math.log10(rms + 1e-9);
    this.lastDb = db;

    const threshold = Math.max(this.noiseFloorDb + this.profile.marginDb, ABS_MIN_DB);
    const voiced = db >= threshold;

    // Track the noise floor only from non-speech frames: fast down, slow up.
    if (!voiced && !this.speaking) {
      this.noiseFloorDb = db < this.noiseFloorDb ? this.noiseFloorDb * 0.8 + db * 0.2 : this.noiseFloorDb + 0.02 * (db - this.noiseFloorDb);
    }

    const frameStartMs = this.frameIndex * VAD_FRAME_MS;
    const frameEndMs = frameStartMs + VAD_FRAME_MS;
    this.frameIndex++;

    let event: VadEvent | null = null;
    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
      this.lastVoicedEndMs = frameEndMs;
      if (!this.speaking && this.voicedRun >= this.profile.onsetFrames) {
        this.speaking = true;
        event = { type: 'speech_start', atMs: frameEndMs - this.voicedRun * VAD_FRAME_MS };
      }
    } else {
      this.silentRun++;
      this.voicedRun = 0;
      if (this.speaking && this.silentRun >= this.profile.hangoverFrames) {
        this.speaking = false;
        event = { type: 'speech_end', atMs: this.lastVoicedEndMs, hangoverMs: this.hangoverMs };
      }
    }
    return event;
  }
}

/** RMS of a PCM16 buffer, 0..1. Used by the level meter. */
export function rmsLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length) / 32768;
}
