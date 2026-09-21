/**
 * Automatic gain for speech recognition. A recogniser trained on studio-level recordings can fall apart on a quiet
 * signal: in the robustness benchmark the light model went from 6 % to 75 % word error when the same speech was
 * 35 dB quieter, which is what a video call at a low system volume looks like. This brings quiet speech up to a
 * normal level, causally (no look-ahead, so no added delay) and cheaply (one multiply per sample).
 *
 * Rules that keep it from making things worse:
 *  - it only ever *boosts* (never attenuates), up to +30 dB;
 *  - the gain follows the loudest recent speech, and is held — not raised — through silence, so background noise is
 *    not pumped up between sentences;
 *  - only blocks clearly above the noise floor count as speech;
 *  - the gain changes smoothly (fast down, slow up) and is ramped inside every block, so it cannot click.
 */

export interface AutoGainOptions {
  /** RMS level (dBFS) that loud-enough speech is brought to. */
  targetDb?: number;
  /** The most it will ever boost. */
  maxGainDb?: number;
  /** Blocks quieter than this (dBFS RMS) are never treated as speech. */
  gateDb?: number;
  /** How long the "loudest recent speech" memory takes to halve, in milliseconds. */
  halfLifeMs?: number;
}

const BLOCK = 160; // 10 ms at 16 kHz
/** A block must be this many times louder than the background to count as speech (about +9.5 dB). */
const SPEECH_OVER_FLOOR = 3;

export class AutoGain {
  private readonly target: number;
  private readonly maxGain: number;
  private readonly gate: number;
  private readonly decay: number;
  private peak = 0;
  private floor = 1;
  private gain = 1;
  private prev: number | null = null;

  constructor(o: AutoGainOptions = {}) {
    this.target = 10 ** ((o.targetDb ?? -20) / 20);
    this.maxGain = 10 ** ((o.maxGainDb ?? 30) / 20);
    this.gate = 10 ** ((o.gateDb ?? -58) / 20);
    this.decay = 0.5 ** (10 / (o.halfLifeMs ?? 2000));
  }

  /** The gain currently applied, in dB (for diagnostics and tests). */
  get gainDb(): number {
    return 20 * Math.log10(this.gain);
  }

  /** Returns `pcm` itself when nothing needs to change, otherwise a new, boosted array. */
  process(pcm: Int16Array): Int16Array {
    let out: Int16Array | null = null;
    for (let start = 0; start < pcm.length; start += BLOCK) {
      const end = Math.min(pcm.length, start + BLOCK);
      let sum = 0;
      for (let i = start; i < end; i++) sum += (pcm[i] ?? 0) * (pcm[i] ?? 0);
      const rms = Math.sqrt(sum / (end - start)) / 32768;

      const speech = rms > this.gate && rms > this.floor * SPEECH_OVER_FLOOR;
      if (speech) {
        this.peak = Math.max(rms, this.peak * this.decay);
        const desired = Math.min(this.maxGain, Math.max(1, this.target / this.peak));
        // Down quickly (a sudden loud voice), up slowly (no pumping).
        this.gain += (desired - this.gain) * (desired < this.gain ? 0.5 : 0.05);
      } else if (rms > 1e-6) {
        // Background: jump down to a quieter background at once, drift up to a louder one slowly. Digital silence
        // (an idle loopback device) says nothing about the background and is ignored.
        this.floor = rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.02;
      }

      if (this.gain > 1.01) {
        out ??= pcm.slice();
        const from = this.prev ?? this.gain;
        const n = end - start;
        for (let i = 0; i < n; i++) {
          const g = from + ((this.gain - from) * (i + 1)) / n;
          const v = Math.round((pcm[start + i] ?? 0) * g);
          out[start + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
      }
      this.prev = this.gain;
    }
    return out ?? pcm;
  }
}
