import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { LocalSttHost } from '../../src/main/stt/local/host';
import { locateModel, type LocalModelId, type LocalModelPreference } from '../../src/main/stt/local/models';
import { spawnSpeechWorker } from '../../src/main/stt/local/spawn';
import { parseWavPcm16 } from '../../src/main/stt/local/wav';

/**
 * `npm run bench:stt` — measures the speech pipeline AS SHIPPED on this machine: the host, a real worker thread
 * (out/main/sttWorker.js, so run `npm run build` first), the real model, audio paced in real time in 40 ms frames
 * exactly as the microphone delivers it. Nothing here is estimated; every figure is a wall-clock measurement.
 *
 * Caveats stated plainly: the clips are synthetic Windows voices plus one real recording (LibriSpeech); results depend
 * on what else the PC is doing while this runs (the run records free memory to make that visible).
 */

const root = resolve(__dirname, '../../resources/models/stt');
const worker = resolve(__dirname, '../../out/main/sttWorker.js');
const fixtures = resolve(__dirname, '../fixtures/speech');
const ready = existsSync(worker) && (['x-asr-160', 'zipformer-en-70m'] as LocalModelId[]).every((id) => locateModel(id, [root]).ok);
if (!ready) console.warn('stt-local bench: needs the models (npm run models) and a build (npm run build). Skipping.');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : NaN);
const p95 = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(0.95 * a.length))] : NaN);
const norm = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
function errors(ref: string, hyp: string): number {
  const r = norm(ref);
  const h = norm(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length];
}

interface ClipResult {
  id: string;
  audioS: number;
  firstWordMs: number;
  /** When the complete text had appeared in a partial result, relative to the end of the speech. */
  textCompleteAfterSpeechMs: number;
  /** End of speech → final transcript, with a 300 ms voice-activity hangover and an explicit flush (what a live session does). */
  finalAfterSpeechMs: number;
  cpuOfOneCore: number;
  wer: number;
  words: number;
  text: string;
}

async function runModel(pref: LocalModelPreference): Promise<{ model: string; loadMs: number; rssMb: number; rows: ClipResult[]; freeMemMbBefore: number }> {
  const host = new LocalSttHost({
    createWorker: () => spawnSpeechWorker(worker),
    roots: () => [root],
    hardware: { cores: cpus().length, totalMemGB: totalmem() / 2 ** 30 },
    preference: () => pref,
    endpointingMs: () => 300,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    idleUnloadMs: 0,
    loadTimeoutMs: 170_000,
  });
  const freeMemMbBefore = Math.round(freemem() / 2 ** 20);
  const t0 = performance.now();
  await host.ensureReady();
  const loadMs = Math.round(performance.now() - t0);
  const status = host.status();

  const refs = JSON.parse(readFileSync(join(fixtures, 'refs.json'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, { text: string }>;
  const clips: { id: string; text: string; file: string }[] = Object.entries(refs).map(([id, r]) => ({ id, text: r.text, file: join(fixtures, `${id}.wav`) }));
  clips.push({ id: 'real:librispeech', text: 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels', file: join(root, 'selftest.wav') });

  async function measure(clip: { id: string; text: string; file: string }): Promise<ClipResult> {
    const audio = parseWavPcm16(readFileSync(clip.file));
    let firstWordAt: number | null = null;
    let lastChangeAt = 0;
    let lastText = '';
    let finalAt: number | null = null;
    let finalText = '';
    const stream = host.open(
      { language: 'en', model: '', endpointingMs: 300, diarize: false },
      {
        onTranscript: (t) => {
          const now = performance.now();
          if (t.text && firstWordAt === null) firstWordAt = now;
          if (t.isFinal) {
            finalAt ??= now;
            finalText = t.text;
          } else if (t.text !== lastText) {
            lastText = t.text;
            lastChangeAt = now;
          }
        },
        onState: () => undefined,
      },
    );
    while (stream.state !== 'connected') await sleep(5);

    const cpu0 = process.cpuUsage();
    const start = performance.now();
    const frame = 1280;
    let k = 0;
    for (let off = 0; off < audio.bytes.byteLength; off += frame, k++) {
      stream.sendAudio(audio.bytes.subarray(off, Math.min(audio.bytes.byteLength, off + frame)));
      const wait = start + (k + 1) * 40 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const speechEnd = start + audio.seconds * 1000;
    // 300 ms of silence (the voice-activity hangover), then the flush the live pipeline sends at end of speech.
    for (let i = 0; i < 8; i++) {
      stream.sendAudio(new Uint8Array(frame));
      const wait = start + (k + 1 + i) * 40 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    stream.finalize();
    const deadline = performance.now() + 4000;
    while (finalAt === null && performance.now() < deadline) await sleep(5);
    const cpu = process.cpuUsage(cpu0);
    const wall = performance.now() - start;
    await stream.close();

    const text = finalText || lastText;
    return {
      id: clip.id,
      audioS: Math.round(audio.seconds * 10) / 10,
      firstWordMs: firstWordAt === null ? NaN : Math.round(firstWordAt - start),
      textCompleteAfterSpeechMs: Math.round(lastChangeAt - speechEnd),
      finalAfterSpeechMs: finalAt === null ? NaN : Math.round(finalAt - speechEnd),
      cpuOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 100) / 100,
      wer: errors(clip.text, text) / Math.max(1, norm(clip.text).length),
      words: norm(clip.text).length,
      text,
    };
  }

  await measure(clips[clips.length - 1]); // warm-up, discarded: the first decode after a load pays one-off costs
  const rows: ClipResult[] = [];
  for (const clip of clips) rows.push(await measure(clip));
  const rssMb = Math.round(process.memoryUsage().rss / 2 ** 20);
  await host.dispose();
  return { model: status.modelLabel, loadMs, rssMb, rows, freeMemMbBefore };
}

describe.skipIf(!ready)('on-device speech: measured on this machine', () => {
  it('reports latency, CPU, memory and accuracy for both models', async () => {
    const machine = { cpu: cpus()[0]?.model.trim(), logicalCores: cpus().length, totalMemGB: Math.round((totalmem() / 2 ** 30) * 10) / 10, freeMemMbAtStart: Math.round(freemem() / 2 ** 20), node: process.version };
    const out: Record<string, unknown> = { measuredAt: new Date().toISOString(), machine };
    for (const pref of ['light', 'accurate'] as LocalModelPreference[]) {
      const r = await runModel(pref);
      const synth = r.rows.filter((x) => !x.id.startsWith('real:') && x.id !== 'p01');
      const summary = {
        model: r.model,
        loadMs: r.loadMs,
        processRssMb: r.rssMb,
        firstWordMs: { median: median(synth.map((x) => x.firstWordMs)), p95: p95(synth.map((x) => x.firstWordMs)) },
        textCompleteAfterSpeechMs: { median: median(synth.map((x) => x.textCompleteAfterSpeechMs)), p95: p95(synth.map((x) => x.textCompleteAfterSpeechMs)) },
        finalAfterSpeechMs: { median: median(synth.map((x) => x.finalAfterSpeechMs)), p95: p95(synth.map((x) => x.finalAfterSpeechMs)) },
        cpuOfOneCore: { median: median(synth.map((x) => x.cpuOfOneCore)), max: Math.max(...synth.map((x) => x.cpuOfOneCore)) },
        syntheticWer: synth.reduce((n, x) => n + x.wer * x.words, 0) / synth.reduce((n, x) => n + x.words, 0),
        realClipWer: r.rows.find((x) => x.id.startsWith('real:'))?.wer ?? null,
      };
      console.log(`\n=== ${r.model} ===`);
      console.table(r.rows.map((x) => ({ clip: x.id, audioS: x.audioS, firstWordMs: x.firstWordMs, textCompleteAfterSpeechMs: x.textCompleteAfterSpeechMs, finalAfterSpeechMs: x.finalAfterSpeechMs, cpuOfOneCore: x.cpuOfOneCore, wer: `${Math.round(x.wer * 100)}%` })));
      console.log(JSON.stringify(summary, null, 2));
      out[pref] = { summary, rows: r.rows };
      // sanity, not thresholds: every clip produced text and a final result
      expect(r.rows.every((x) => Number.isFinite(x.firstWordMs) && Number.isFinite(x.finalAfterSpeechMs))).toBe(true);
      expect(summary.cpuOfOneCore.median).toBeLessThan(1);
    }
    const dir = resolve(__dirname, '../../bench-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stt-local.json'), JSON.stringify(out, null, 2));
  }, 900_000);
});
