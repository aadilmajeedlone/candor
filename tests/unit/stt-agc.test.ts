import { describe, expect, it } from 'vitest';
import { AutoGain } from '../../src/main/stt/local/agc';

/** Speech-like test signal: a few harmonics with a 4 Hz syllable envelope, at a given average level (dBFS RMS). */
function speech(seconds: number, dbfs: number, phase = 0): Int16Array {
  const n = Math.round(seconds * 16000);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i + phase) / 16000;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t) ** 2; // syllables
    x[i] = env * (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 720 * t) + 0.3 * Math.sin(2 * Math.PI * 2100 * t));
  }
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  const k = 10 ** (dbfs / 20) / rms;
  return Int16Array.from(x, (v) => Math.round(v * k * 32768));
}
/** Steady background noise at a level (deterministic). */
function noise(seconds: number, dbfs: number): Int16Array {
  const n = Math.round(seconds * 16000);
  let s = 12345;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((s / 0x7fffffff) * 2 - 1) * 1.7 * 10 ** (dbfs / 20) * 32768);
  }
  return out;
}
const dbOf = (x: Int16Array): number => 20 * Math.log10(Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length)) / 32768 + 1e-12);
const tail = (x: Int16Array, seconds: number): Int16Array => x.subarray(Math.max(0, x.length - Math.round(seconds * 16000)));
const concat = (...parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('automatic gain for speech recognition', () => {
  it('brings quiet speech up to a normal level within a couple of seconds', () => {
    const agc = new AutoGain();
    const input = concat(noise(0.5, -75), speech(6, -52));
    const out = agc.process(input);
    expect(dbOf(tail(input, 1))).toBeCloseTo(-52, 0);
    expect(dbOf(tail(out, 1))).toBeGreaterThan(-26); // was 26+ dB too quiet
    expect(dbOf(tail(out, 1))).toBeLessThan(-14);
    expect(agc.gainDb).toBeGreaterThan(18);
    expect(agc.gainDb).toBeLessThanOrEqual(30.01);
  });

  it('leaves speech that is already loud enough alone, and returns the very same array', () => {
    const agc = new AutoGain();
    const input = concat(noise(0.3, -70), speech(3, -18));
    const out = agc.process(input);
    expect(out).toBe(input);
    expect(agc.gainDb).toBeCloseTo(0, 5);
  });

  it('never boosts silence or steady background noise', () => {
    const agc = new AutoGain();
    const quiet = noise(10, -60);
    expect(agc.process(new Int16Array(16000 * 2))).toHaveLength(32000); // digital silence
    const out = agc.process(quiet);
    expect(out).toBe(quiet); // background noise: no gain applied
    expect(agc.gainDb).toBeCloseTo(0, 5);
  });

  it('holds its gain through a long silence instead of pumping the background up', () => {
    const agc = new AutoGain();
    agc.process(concat(noise(0.5, -72), speech(5, -50)));
    const before = agc.gainDb;
    expect(before).toBeGreaterThan(15);
    const out = agc.process(noise(20, -72)); // 20 s of quiet room
    expect(agc.gainDb).toBeCloseTo(before, 3); // held, not raised
    expect(dbOf(out)).toBeLessThan(-72 + before + 1); // background was scaled by the held gain only
  });

  it('never boosts by more than 30 dB', () => {
    const agc = new AutoGain();
    agc.process(concat(noise(0.5, -85), speech(20, -56)));
    expect(agc.gainDb).toBeLessThanOrEqual(30.001);
  });

  it('comes down fast when a loud voice follows a quiet one', () => {
    const agc = new AutoGain();
    agc.process(concat(noise(0.5, -75), speech(6, -52)));
    expect(agc.gainDb).toBeGreaterThan(18);
    agc.process(speech(0.3, -12)); // someone starts shouting
    expect(agc.gainDb).toBeLessThan(2);
  });

  it('cannot click: the gain moves smoothly inside every block, and samples never overflow', () => {
    const agc = new AutoGain();
    const input = concat(noise(0.5, -75), speech(4, -50), speech(2, -14, 3));
    const out = agc.process(input);
    let worst = 0;
    for (let i = 1; i < out.length; i++) {
      const jumpOut = Math.abs(out[i] - out[i - 1]);
      const jumpIn = Math.abs(input[i] - input[i - 1]);
      worst = Math.max(worst, jumpOut - jumpIn * 32); // more than the maximum boost allows would be a click
    }
    expect(worst).toBeLessThan(200);
    expect(Math.max(...out)).toBeLessThanOrEqual(32767);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(-32768);
  });

  it('works on any chunking of the same audio (the microphone delivers 20–40 ms frames)', () => {
    const input = concat(noise(0.5, -75), speech(4, -52));
    const whole = new AutoGain().process(input);
    const parts: Int16Array[] = [];
    const agc = new AutoGain();
    for (let i = 0; i < input.length; i += 640) parts.push(agc.process(input.subarray(i, Math.min(input.length, i + 640))));
    const chunked = concat(...parts);
    expect(dbOf(tail(chunked, 1))).toBeCloseTo(dbOf(tail(whole, 1)), 0);
  });
});
