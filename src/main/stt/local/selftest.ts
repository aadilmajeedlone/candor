import { readFileSync } from 'node:fs';
import type { SttTestResult } from '@shared/speech';
import type { SttState } from '../types';
import type { LocalSttHost } from './host';
import { parseWavPcm16 } from './wav';

/** What the bundled sample clip says (a public-domain LibriVox recording from the LibriSpeech corpus). */
export const SELFTEST_TEXT = 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels';

export interface SelfTestOptions {
  /** Path of the sample WAV (16 kHz, mono, 16-bit); null when it is not installed. */
  samplePath: string | null;
  /** Delay between 40 ms audio frames. 40 = real time (the honest latency figure); tests use 0. */
  paceMs?: number;
  endpointingMs?: number;
  clock?: () => number;
}

const FRAME_BYTES = 1280; // 40 ms

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Share of the reference's words that were heard (order-insensitive, forgiving). */
export function wordOverlap(reference: string, heard: string): number {
  const ref = words(reference);
  const got = new Set(words(heard));
  return ref.length === 0 ? 0 : ref.filter((w) => got.has(w)).length / ref.length;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * "Test speech recognition" without a microphone: loads the model if needed, plays the bundled sample through the
 * exact path live audio takes, and reports what was heard and how quickly.
 */
export async function runLocalSelfTest(host: LocalSttHost, o: SelfTestOptions): Promise<SttTestResult> {
  const clock = o.clock ?? (() => performance.now());
  if (!o.samplePath) return { ok: false, error: 'The built-in speech sample is missing, so the test cannot run. Reinstall Candor, or from the source folder run "npm run models".' };

  let audio;
  try {
    audio = parseWavPcm16(readFileSync(o.samplePath));
    if (audio.sampleRate !== 16_000 || audio.channels !== 1) throw new Error('The sample must be 16 kHz mono.');
  } catch (e) {
    return { ok: false, error: `The built-in speech sample could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }

  const wasReady = host.status().state === 'ready';
  const tLoad = clock();
  try {
    await host.ensureReady();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const loadMs = Math.round(clock() - tLoad);

  const conn: { state: SttState; message?: string } = { state: 'connecting' };
  const t: { firstWordAt: number | null; firstAudio: number } = { firstWordAt: null, firstAudio: 0 };
  let partial = '';
  const finals: string[] = [];
  let gotFinal = false;
  const stream = host.open(
    { language: 'en', model: '', endpointingMs: o.endpointingMs ?? 300, diarize: false },
    {
      onTranscript: (r) => {
        if (r.text && t.firstWordAt === null) t.firstWordAt = clock();
        if (r.isFinal) {
          if (r.text) finals.push(r.text);
          gotFinal = true;
        } else partial = r.text;
      },
      onState: (s, message) => {
        conn.state = s;
        conn.message = message;
      },
    },
  );
  try {
    const start = clock();
    while (conn.state !== 'connected' && conn.state !== 'error' && clock() - start < 10_000) await sleep(10);
    if (conn.state !== 'connected') return { ok: false, error: conn.message ?? 'The speech engine did not start.' };

    t.firstAudio = clock();
    const pace = o.paceMs ?? 40;
    for (let off = 0, k = 0; off < audio.bytes.byteLength; off += FRAME_BYTES, k++) {
      stream.sendAudio(audio.bytes.subarray(off, Math.min(audio.bytes.byteLength, off + FRAME_BYTES)));
      if (pace > 0) {
        const wait = t.firstAudio + (k + 1) * pace - clock();
        if (wait > 0) await sleep(wait);
      } else if (k % 25 === 0) await sleep(0);
    }
    stream.finalize();
    const deadline = clock() + 4000;
    while (!gotFinal && clock() < deadline) await sleep(20);
  } finally {
    await stream.close();
  }

  const heard = (finals.length ? finals.join(' ') : partial).trim();
  if (!heard) return { ok: false, error: 'The engine started but heard nothing in the sample clip. Try the other speech model in Settings → Speech.' };
  const score = wordOverlap(SELFTEST_TEXT, heard);
  const status = host.status();
  const firstWordMs = t.firstWordAt === null ? null : Math.round(t.firstWordAt - t.firstAudio);
  const detail = [
    `Heard: “${heard}”`,
    firstWordMs === null ? null : `First words appeared ${firstWordMs} ms after the audio began.`,
    wasReady ? 'Model was already loaded.' : `Model loaded in ${(loadMs / 1000).toFixed(1)} s.`,
    `${status.modelLabel}${status.rssMb ? `, ${status.rssMb} MB in use` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
  if (score < 0.6) return { ok: false, error: `The engine ran but the sample was transcribed poorly (${Math.round(score * 100)}% of the words). ${detail}`, latencyMs: firstWordMs ?? undefined, detail };
  return { ok: true, latencyMs: firstWordMs ?? undefined, detail };
}
