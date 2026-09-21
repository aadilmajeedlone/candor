import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectQuestion } from '../../src/core/question/detector';
import { LocalSttHost } from '../../src/main/stt/local/host';
import { LOCAL_MODELS, locateModel, type LocalModelId, type LocatedModel } from '../../src/main/stt/local/models';
import { RecognizerCore, type CoreResult, type SherpaModule } from '../../src/main/stt/local/recognizer';
import { runLocalSelfTest } from '../../src/main/stt/local/selftest';
import { parseWavPcm16 } from '../../src/main/stt/local/wav';
import { inProcessWorker } from '../helpers/fakeSherpa';

/**
 * The REAL speech engine (sherpa-onnx + the bundled models) on real audio: the microphone path from PCM frames to
 * words, in this process. Skipped, loudly, when the models are not installed (`npm run models`).
 *
 * What is measured here is audio-time, not wall-clock: "how much audio had gone in when the first words appeared".
 * That is independent of how busy this PC is, so it is stable enough to assert on. Wall-clock latency and CPU use are
 * measured by `npm run bench:stt`.
 */

const root = resolve(__dirname, '../../resources/models/stt');
const speech = resolve(__dirname, '../fixtures/speech');
const models = (['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]).map((id) => ({ id, found: locateModel(id, [root]) }));
const haveModels = models.every((m) => m.found.ok);
const nativeRequire = createRequire(import.meta.url);

if (!haveModels) console.warn('stt-local-real: speech models not found in resources/models/stt — run "npm run models". Skipping the real-engine tests.');

interface Clip {
  id: string;
  text: string;
  pcm: Int16Array;
}

function loadClips(): Clip[] {
  const refs = JSON.parse(readFileSync(join(speech, 'refs.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, { text: string }>;
  return Object.entries(refs).map(([id, r]) => {
    const wav = parseWavPcm16(readFileSync(join(speech, `${id}.wav`)));
    const bytes = wav.bytes.slice(); // aligned copy
    return { id, text: r.text, pcm: new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1) };
  });
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function wordErrors(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length];
}

interface Run {
  results: CoreResult[];
  finalText: string;
  /** Audio (ms) that had been fed when each result appeared. */
  firstPartialAtMs: number | null;
  audioMs: number;
  stats: ReturnType<RecognizerCore['stats']>;
}

/** Stream a clip in 40 ms frames (as fast as possible: audio-time is what is measured), then flush. */
function stream(core: RecognizerCore, id: number, pcm: Int16Array): Run {
  const results: CoreResult[] = [];
  const off = core as unknown as { emit: (r: CoreResult) => void };
  const original = off.emit;
  off.emit = (r) => {
    results.push(r);
    original(r);
  };
  core.open(id);
  const frame = 640;
  for (let i = 0; i < pcm.length; i += frame) core.push(id, pcm.subarray(i, Math.min(pcm.length, i + frame)));
  core.finalize(id);
  off.emit = original;
  const partials = results.filter((r) => !r.isFinal);
  const finals = results.filter((r) => r.isFinal).map((r) => r.text);
  return { results, finalText: finals.join(' '), firstPartialAtMs: partials[0]?.processedMs ?? null, audioMs: Math.round((pcm.length / 16000) * 1000), stats: core.stats() };
}

describe.skipIf(!haveModels)('the on-device speech engine on real audio', () => {
  const clips = haveModels ? loadClips() : [];
  const cores = new Map<LocalModelId, RecognizerCore>();
  const located = new Map<LocalModelId, LocatedModel>();

  beforeAll(() => {
    const sherpa = nativeRequire('sherpa-onnx-node') as SherpaModule;
    for (const { id, found } of models) {
      if (!found.ok) continue;
      located.set(id, found.model);
      const spec = LOCAL_MODELS[id];
      // The same settings the app uses (see LocalSttHost): one thread, automatic gain on.
      cores.set(id, new RecognizerCore(sherpa, { ...found.model.paths, numThreads: 1, endpointSilenceSec: 0.8, casing: spec.casing, autoGain: true }, () => undefined));
    }
  }, 180_000);

  for (const id of ['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]) {
    describe(LOCAL_MODELS[id].label, () => {
      it('transcribes spoken interview questions accurately enough to answer them', () => {
        const core = cores.get(id)!;
        let errors = 0;
        let total = 0;
        const rows: string[] = [];
        for (const clip of clips.filter((c) => c.id !== 'p01')) {
          const run = stream(core, 1, clip.pcm);
          const e = wordErrors(clip.text, run.finalText);
          errors += e;
          total += words(clip.text).length;
          rows.push(`${clip.id}: ${e} error(s) — ${run.finalText}`);
        }
        const wer = errors / total;
        // Synthetic Windows voices are clean but the vocabulary includes "Kubernetes" and "PostgreSQL". Measured on the
        // development machine: 3.6 % (accurate) and 9.3 % (light). The bounds leave room for a different CPU/runtime.
        const bound = id === 'x-asr-160' ? 0.1 : 0.16;
        expect(wer, rows.join('\n')).toBeLessThan(bound);
      }, 120_000);

      it('shows the first words while the question is still being spoken', () => {
        const core = cores.get(id)!;
        const clip = clips.find((c) => c.id === 'q01')!; // "Tell me about a time when you had to lead a team through a difficult project."
        const run = stream(core, 2, clip.pcm);
        expect(run.firstPartialAtMs).not.toBeNull();
        // The clip is ~4.7 s long. The first words must appear long before its end: well inside the first 1.5 s of audio.
        expect(run.firstPartialAtMs!).toBeLessThan(1500);
        const partials = run.results.filter((r) => !r.isFinal);
        expect(partials.length).toBeGreaterThan(5); // a running transcript, not one block at the end
        for (let i = 1; i < partials.length; i++) expect(partials[i].processedMs).toBeGreaterThanOrEqual(partials[i - 1].processedMs);
      }, 60_000);

      it('lets the question detector recognise the question before the speaker has finished it', () => {
        const core = cores.get(id)!;
        const clip = clips.find((c) => c.id === 'q01')!;
        const run = stream(core, 3, clip.pcm);
        const partials = run.results.filter((r) => !r.isFinal);
        const firstDetected = partials.find((r) => detectQuestion(r.text).isQuestion && detectQuestion(r.text).confidence >= 0.6);
        expect(firstDetected, 'no partial result was recognised as a question').toBeTruthy();
        // …with a good deal of the sentence still to come (the clip runs ~4.7 s).
        expect(firstDetected!.processedMs).toBeLessThan(run.audioMs - 1500);
        const final = detectQuestion(run.finalText);
        expect(final.isQuestion).toBe(true);
        expect(['behavioral', 'leadership']).toContain(final.kind);
      }, 60_000);

      it('keeps up with real time on one thread (decoding takes less time than the audio lasts)', () => {
        const core = cores.get(id)!;
        const before = core.stats();
        const clip = clips.find((c) => c.id === 'q06')!;
        stream(core, 4, clip.pcm);
        const after = core.stats();
        const decodeMs = after.decodeMsTotal - before.decodeMsTotal;
        const audioMs = (clip.pcm.length / 16000) * 1000;
        const rtf = decodeMs / audioMs;
        // Measured 0.24 (light) and 0.6 (accurate) on a 2019 4-core laptop CPU while other apps were running.
        expect(rtf).toBeLessThan(1);
      }, 60_000);

      it('ends the utterance itself when the speaker goes quiet, and starts the next one clean', () => {
        const core = cores.get(id)!;
        const clip = clips.find((c) => c.id === 'q10')!; // "Do you have any questions for us?"
        const silence = new Int16Array(16000 * 2); // 2 s of silence
        const results: CoreResult[] = [];
        const off = core as unknown as { emit: (r: CoreResult) => void };
        const original = off.emit;
        off.emit = (r) => results.push(r);
        core.open(5);
        for (let i = 0; i < clip.pcm.length; i += 640) core.push(5, clip.pcm.subarray(i, Math.min(clip.pcm.length, i + 640)));
        for (let i = 0; i < silence.length; i += 640) core.push(5, silence.subarray(i, i + 640));
        off.emit = original;
        const finals = results.filter((r) => r.isFinal);
        expect(finals).toHaveLength(1);
        expect(finals[0].speechFinal).toBe(true);
        expect(finals[0].text).toMatch(/^Do you have any questions for us[?.]?$/i);
        expect(finals[0].text.endsWith('?')).toBe(true); // punctuated like a cloud provider's final result
      }, 60_000);
    });
  }

  it('an interview: several different questions in a row, with pauses, are separate utterances in the right order', () => {
    for (const id of ['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]) {
      const core = cores.get(id)!;
      const order = ['q01', 'q06', 'q10', 'q03'];
      const results: CoreResult[] = [];
      const off = core as unknown as { emit: (r: CoreResult) => void };
      const original = off.emit;
      off.emit = (r) => results.push(r);
      core.open(8);
      const gap = new Int16Array(16000 * 1.3); // the interviewer waits for an answer
      for (const q of order) {
        const pcm = clips.find((c) => c.id === q)!.pcm;
        for (let i = 0; i < pcm.length; i += 640) core.push(8, pcm.subarray(i, Math.min(pcm.length, i + 640)));
        for (let i = 0; i < gap.length; i += 640) core.push(8, gap.subarray(i, Math.min(gap.length, i + 640)));
      }
      off.emit = original;
      const finals = results.filter((r) => r.isFinal);
      expect(finals.map((f) => f.text), `${id}: ${finals.length} final results`).toHaveLength(order.length);
      expect(finals[0].text).toMatch(/lead a team/i);
      expect(finals[1].text).toMatch(/your tasks when you have multiple deadlines/i); // ("prioritize" is spelled differently by different models)
      expect(finals[2].text).toMatch(/any questions/i);
      expect(finals[3].text).toMatch(/notification system/i);
      for (const f of finals) expect(detectQuestion(f.text).isQuestion, f.text).toBe(true);
      // each utterance starts clean: nothing from the previous question leaks into the next
      expect(finals[1].text).not.toMatch(/lead a team/i);
      expect(finals[3].text).not.toMatch(/any questions/i);
    }
  }, 180_000);

  it('a long stretch of continuous speech (about 20 s, no pauses) is transcribed in full', () => {
    for (const id of ['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]) {
      const core = cores.get(id)!;
      const order = ['q02', 'q04', 'q05', 'q07'];
      const pcm = new Int16Array(order.reduce((n, q) => n + clips.find((c) => c.id === q)!.pcm.length + 800, 0));
      let o = 0;
      for (const q of order) {
        const c = clips.find((x) => x.id === q)!.pcm;
        pcm.set(c, o);
        o += c.length + 800; // 50 ms between sentences
      }
      const before = core.stats();
      const results: CoreResult[] = [];
      const off = core as unknown as { emit: (r: CoreResult) => void };
      const original = off.emit;
      off.emit = (r) => results.push(r);
      core.open(9);
      for (let i = 0; i < pcm.length; i += 640) core.push(9, pcm.subarray(i, Math.min(pcm.length, i + 640)));
      core.finalize(9);
      off.emit = original;
      const text = results.filter((r) => r.isFinal).map((r) => r.text).join(' ');
      const ref = order.map((q) => clips.find((c) => c.id === q)!.text).join(' ');
      const seconds = pcm.length / 16000;
      expect(seconds).toBeGreaterThan(17);
      expect(wordErrors(ref, text) / words(ref).length, `${id}: ${text}`).toBeLessThan(0.2);
      // Real-time factor over the whole stretch: it did not fall behind.
      const decodeMs = core.stats().decodeMsTotal - before.decodeMsTotal;
      expect(decodeMs / (seconds * 1000)).toBeLessThan(1);
    }
  }, 240_000);

  it('quiet speech (a video call at low volume, 35 dB down) is still understood, thanks to automatic gain', () => {
    for (const id of ['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]) {
      const core = cores.get(id)!;
      const clip = clips.find((c) => c.id === 'q02')!; // "What is your greatest strength and how has it helped you in your previous roles?"
      const k = 10 ** (-35 / 20);
      const quiet = Int16Array.from(clip.pcm, (v) => Math.round(v * k));
      const lead = new Int16Array(16000 / 2).map((_, i) => Math.round(((i * 7919) % 17) - 8)); // half a second of room tone
      const pcm = new Int16Array(lead.length + quiet.length);
      pcm.set(lead, 0);
      pcm.set(quiet, lead.length);
      const run = stream(core, 10, pcm);
      const wer = wordErrors(clip.text, run.finalText) / words(clip.text).length;
      // Without automatic gain the light model heard almost nothing at this level (75 % word error).
      expect(wer, `${id}: ${run.finalText}`).toBeLessThan(0.2);
    }
  }, 120_000);

  it('the accurate model writes real capitalisation; the light one is sentence-cased for the app', () => {
    const clip = clips.find((c) => c.id === 'q08')!; // Kubernetes and PostgreSQL
    const accurate = stream(cores.get('x-asr-160')!, 6, clip.pcm).finalText;
    const light = stream(cores.get('zipformer-en-70m')!, 6, clip.pcm).finalText;
    expect(accurate).toMatch(/^Tell me about a project where you used /);
    expect(accurate).toMatch(/SQL/); // "PostgreSQL"-ish: acronyms keep their capitals
    expect(light).toMatch(/^Tell me about a project where you used /);
    expect(light).not.toMatch(/TELL|PROJECT/); // ALL CAPS output was converted
  }, 60_000);

  it('a pause inside a question does not lose or garble the rest of it', () => {
    const core = cores.get('x-asr-160')!;
    const clip = clips.find((c) => c.id === 'p01')!; // "Tell me about a time when … (0.9 s pause) … you had to deliver bad news to a stakeholder."
    const run = stream(core, 7, clip.pcm);
    expect(wordErrors(clip.text, run.finalText)).toBeLessThanOrEqual(2);
  }, 60_000);

  it('runs the whole host → worker protocol → engine path and passes "Test speech recognition" on the bundled sample', async () => {
    const host = new LocalSttHost({
      createWorker: () => inProcessWorker(() => nativeRequire('sherpa-onnx-node') as SherpaModule),
      roots: () => [root],
      hardware: { cores: 8, totalMemGB: 14 },
      preference: () => 'light', // the model that loads fastest; the protocol is identical
      endpointingMs: () => 300,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      idleUnloadMs: 0,
    });
    try {
      const result = await runLocalSelfTest(host, { samplePath: join(root, 'selftest.wav'), paceMs: 0 });
      expect(result.ok, result.error).toBe(true);
      expect(result.detail).toMatch(/Heard: “After early nightfall/);
    } finally {
      await host.dispose();
    }
  }, 180_000);
});
