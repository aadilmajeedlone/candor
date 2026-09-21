import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_MODELS, locateModel, type LocalModelId } from '../../src/main/stt/local/models';
import { RecognizerCore, type CoreResult, type SherpaModule } from '../../src/main/stt/local/recognizer';
import { parseWavPcm16 } from '../../src/main/stt/local/wav';

/**
 * `npm run bench:robustness` — how much does each on-device model degrade when the audio is not studio-clean?
 * The same clips are played clean and then through deterministic, reproducible damage that approximates a video call:
 * background noise, telephone-band audio, quiet speakers and room echo. Accuracy only (word error rate); speed is
 * measured by `npm run bench:stt`.
 *
 * Honest limits: the damage is synthetic and the clips are Windows text-to-speech voices plus two LibriSpeech
 * recordings. Real meeting audio (codec artefacts, cross-talk, accents, overlapping voices) will differ.
 */

const root = resolve(__dirname, '../../resources/models/stt');
const speech = resolve(__dirname, '../fixtures/speech');
const ALL_IDS: LocalModelId[] = ['x-asr-160', 'zipformer-en-70m'];
/** CANDOR_ROBUSTNESS_MODELS=light|accurate, CANDOR_ROBUSTNESS_CONDITIONS=clean,quiet,…, CANDOR_ROBUSTNESS_AGC=0|1 (default 1: the app's setting). */
const wantModels = process.env.CANDOR_ROBUSTNESS_MODELS;
const ids: LocalModelId[] = ALL_IDS.filter((id) => !wantModels || (wantModels === 'light' ? id === 'zipformer-en-70m' : id === 'x-asr-160'));
const autoGain = process.env.CANDOR_ROBUSTNESS_AGC !== '0';
const found = ids.map((id) => locateModel(id, [root]));
const ready = found.every((f) => f.ok);
const nativeRequire = createRequire(import.meta.url);

/* ------------------------------- audio damage ------------------------------- */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

function withNoise(x: Float32Array, snrDb: number, seed: number): Float32Array {
  const r = rng(seed);
  const sigma = rms(x) / 10 ** (snrDb / 20);
  return x.map((v) => v + sigma * gauss(r));
}
/** Telephone band: low-pass at 3.4 kHz (windowed sinc), decimate to 8 kHz, and back up to 16 kHz. */
function narrowband(x: Float32Array): Float32Array {
  const taps = 63;
  const fc = 3400 / 16000;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - (taps - 1) / 2;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] = h[i] / sum;
  const lp = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) acc += (x[i - k + (taps >> 1)] ?? 0) * h[k];
    lp[i] = acc;
  }
  const down = new Float32Array(Math.ceil(lp.length / 2));
  for (let i = 0; i < down.length; i++) down[i] = lp[i * 2] ?? 0;
  const up = new Float32Array(lp.length);
  for (let i = 0; i < up.length; i++) {
    const p = i / 2;
    const a = down[Math.floor(p)] ?? 0;
    const b = down[Math.min(down.length - 1, Math.floor(p) + 1)] ?? 0;
    up[i] = a + (b - a) * (p - Math.floor(p));
  }
  return up;
}
const gain = (x: Float32Array, db: number): Float32Array => x.map((v) => v * 10 ** (db / 20));
/** Room echo: an exponentially decaying noise impulse response (RT60 ≈ 0.4 s), 35 % wet. */
function reverb(x: Float32Array, seed: number): Float32Array {
  const r = rng(seed);
  const len = 3200;
  const ir = new Float32Array(len);
  for (let i = 0; i < len; i++) ir[i] = gauss(r) * Math.exp((-6.9 * i) / len);
  const norm = Math.sqrt(ir.reduce((s, v) => s + v * v, 0));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let acc = 0;
    for (let k = 0; k < len && k <= i; k += 2) acc += x[i - k] * ir[k]; // every other tap: plenty for a reverb tail, half the cost
    out[i] = 0.65 * x[i] + 0.35 * (acc * 2) / norm;
  }
  return out;
}

const ALL_CONDITIONS: { name: string; apply: (x: Float32Array, seed: number) => Float32Array }[] = [
  { name: 'clean', apply: (x) => x },
  { name: 'noise 20 dB SNR', apply: (x, s) => withNoise(x, 20, s) },
  { name: 'noise 10 dB SNR', apply: (x, s) => withNoise(x, 10, s) },
  { name: 'telephone band', apply: (x) => narrowband(x) },
  { name: 'quiet speaker (-35 dB)', apply: (x) => gain(x, -35) },
  { name: 'room echo', apply: (x, s) => reverb(x, s) },
  { name: 'video call (band + echo + 15 dB noise)', apply: (x, s) => withNoise(reverb(narrowband(x), s), 15, s + 1) },
];

const wantConditions = process.env.CANDOR_ROBUSTNESS_CONDITIONS?.split(',').map((s) => s.trim().toLowerCase());
const CONDITIONS = ALL_CONDITIONS.filter((c) => !wantConditions || wantConditions.some((w) => c.name.toLowerCase().includes(w)));

/* ------------------------------- scoring ------------------------------- */

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function errors(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length];
}

interface Clip {
  id: string;
  text: string;
  samples: Float32Array;
}
function loadClips(): Clip[] {
  const refs = JSON.parse(readFileSync(join(speech, 'refs.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, { text: string }>;
  const clips: Clip[] = [];
  const read = (path: string): Float32Array => {
    const wav = parseWavPcm16(readFileSync(path));
    const i16 = new Int16Array(wav.bytes.slice().buffer);
    return Float32Array.from(i16, (v) => v / 32768);
  };
  for (const id of ['q01', 'q02', 'q03', 'q04', 'q05', 'q06', 'q07', 'q08']) clips.push({ id, text: refs[id].text, samples: read(join(speech, `${id}.wav`)) });
  const real: [string, string][] = [
    ['real:0', 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels'],
    ['real:1', 'god as a direct consequence of the sin which man thus punished had given her a lovely child whose place was on that same dishonoured bosom to connect her parent for ever with the race and descent of mortals and to be finally a blessed soul in heaven'],
  ];
  for (const [id, text] of real) {
    const path = id === 'real:0' ? join(root, 'selftest.wav') : join(speech, 'librispeech-1.wav'); // LibriSpeech clips (CC BY 4.0)
    if (existsSync(path)) clips.push({ id, text, samples: read(path) });
  }
  return clips;
}

function recognise(core: RecognizerCore, id: number, samples: Float32Array): string {
  const finals: string[] = [];
  const off = core as unknown as { emit: (r: CoreResult) => void };
  const original = off.emit;
  off.emit = (r) => {
    if (r.isFinal) finals.push(r.text);
  };
  core.open(id);
  const frame = 640;
  const pcm = Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
  for (let i = 0; i < pcm.length; i += frame) core.push(id, pcm.subarray(i, Math.min(pcm.length, i + frame)));
  core.finalize(id);
  off.emit = original;
  return finals.join(' ');
}

describe.skipIf(!ready)('on-device speech: accuracy on damaged audio', () => {
  it('measures word error rate per model and condition', () => {
    const sherpa = nativeRequire('sherpa-onnx-node') as SherpaModule;
    const clips = loadClips();
    const out: Record<string, Record<string, { wer: number; words: number; errors: number }>> = {};
    for (const [i, id] of ids.entries()) {
      const f = found[i];
      if (!f.ok) continue;
      const core = new RecognizerCore(sherpa, { ...f.model.paths, numThreads: 1, endpointSilenceSec: 60, casing: LOCAL_MODELS[id].casing, autoGain }, () => undefined);
      out[id] = {};
      for (const cond of CONDITIONS) {
        let err = 0;
        let total = 0;
        clips.forEach((clip, n) => {
          const damaged = cond.apply(clip.samples, 1000 + n);
          err += errors(clip.text, recognise(core, 1, damaged));
          total += words(clip.text).length;
        });
        out[id][cond.name] = { wer: err / total, words: total, errors: err };
        console.log(`${id.padEnd(17)} ${cond.name.padEnd(40)} WER ${(100 * (err / total)).toFixed(1).padStart(5)}%  (${err}/${total})  auto-gain ${autoGain ? 'on' : 'off'}`);
      }
    }
    const dir = resolve(__dirname, '../../bench-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, autoGain ? 'stt-robustness.json' : 'stt-robustness-no-agc.json'), JSON.stringify({ measuredAt: new Date().toISOString(), autoGain, clips: loadClips().map((c) => c.id), results: out }, null, 2));
    // Sanity only: clean audio must be understood; everything else is a measurement, not a threshold.
    for (const id of ids) if (out[id]?.clean) expect(out[id].clean.wer).toBeLessThan(0.2);
  }, 1_200_000);
});
