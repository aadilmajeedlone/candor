import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTranscript, looksLikeQuestion } from '../../src/main/stt/local/format';
import { chooseModel, LOCAL_MODELS, lighterThan, locateModel, modelSearchRoots, type LocalModelId, type LocalModelSpec } from '../../src/main/stt/local/models';
import { buildRecognizerConfig, RecognizerCore, type CoreResult } from '../../src/main/stt/local/recognizer';
import { parseWavPcm16 } from '../../src/main/stt/local/wav';
import { wordOverlap } from '../../src/main/stt/local/selftest';
import { fakeSherpa, pcmFrame } from '../helpers/fakeSherpa';

describe('transcript formatting', () => {
  it('turns ALL CAPS output into sentence case with a proper "I"', () => {
    expect(formatTranscript("TELL ME ABOUT A TIME WHEN I'M LED A TEAM", { casing: 'upper', final: false })).toBe("Tell me about a time when I'm led a team");
    expect(formatTranscript('WHAT DO I DO IF I FAIL', { casing: 'upper', final: false })).toBe('What do I do if I fail');
  });

  it('leaves mixed-case output alone apart from the first letter', () => {
    expect(formatTranscript('tell me about Kubernetes and SQL', { casing: 'mixed', final: false })).toBe('Tell me about Kubernetes and SQL');
  });

  it('does not punctuate a partial result: it is rewritten on every update', () => {
    expect(formatTranscript('DO YOU HAVE ANY QUESTIONS FOR US', { casing: 'upper', final: false })).toBe('Do you have any questions for us');
  });

  it('ends a finished question with "?" and a finished instruction with "."', () => {
    expect(formatTranscript('DO YOU HAVE ANY QUESTIONS FOR US', { casing: 'upper', final: true })).toBe('Do you have any questions for us?');
    expect(formatTranscript('WHY DO YOU WANT THIS ROLE', { casing: 'upper', final: true })).toBe('Why do you want this role?');
    expect(formatTranscript('Tell me about a time you led a team', { casing: 'mixed', final: true })).toBe('Tell me about a time you led a team.');
  });

  it('keeps punctuation the model already wrote', () => {
    expect(formatTranscript('Is this a question?', { casing: 'mixed', final: true })).toBe('Is this a question?');
    expect(formatTranscript('That is all.', { casing: 'mixed', final: true })).toBe('That is all.');
  });

  it('does not finish a sentence the speaker paused in the middle of', () => {
    expect(formatTranscript('TELL ME ABOUT A TIME WHEN', { casing: 'upper', final: true })).toBe('Tell me about a time when');
    expect(formatTranscript('WHAT IS THE DIFFERENCE BETWEEN A', { casing: 'upper', final: true })).toBe('What is the difference between a');
    expect(formatTranscript('I WORKED ON THE', { casing: 'upper', final: true })).toBe('I worked on the');
  });

  it('returns nothing for empty input', () => {
    expect(formatTranscript('   ', { casing: 'upper', final: true })).toBe('');
  });

  it('recognises question openers', () => {
    expect(looksLikeQuestion('How would you design a cache')).toBe(true);
    expect(looksLikeQuestion('Can you walk me through it')).toBe(true);
    expect(looksLikeQuestion('Tell me about yourself')).toBe(false);
  });
});

describe('model choice', () => {
  it('auto picks the accurate model only when the PC has the cores and memory for it', () => {
    expect(chooseModel('auto', { cores: 8, totalMemGB: 14 })).toBe('x-asr-160');
    expect(chooseModel('auto', { cores: 4, totalMemGB: 16 })).toBe('zipformer-en-70m');
    expect(chooseModel('auto', { cores: 12, totalMemGB: 4 })).toBe('zipformer-en-70m');
  });

  it('an explicit choice wins over the hardware', () => {
    expect(chooseModel('light', { cores: 32, totalMemGB: 64 })).toBe('zipformer-en-70m');
    expect(chooseModel('accurate', { cores: 2, totalMemGB: 4 })).toBe('x-asr-160');
  });

  it('only the accurate model has a lighter one to step down to', () => {
    expect(lighterThan('x-asr-160')).toBe('zipformer-en-70m');
    expect(lighterThan('zipformer-en-70m')).toBeNull();
  });

  it('every model pins a size and a SHA-256 for each file', () => {
    for (const m of Object.values(LOCAL_MODELS)) {
      for (const f of Object.values(m.files)) {
        expect(f.bytes).toBeGreaterThan(1000);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(m.license).toBe('Apache-2.0');
    }
  });
});

describe('finding the model files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'candor-models-'));
    dirs.push(d);
    return d;
  };
  // The real models are hundreds of megabytes; these tests use the same layout with tiny files of a declared size.
  const TINY = 16;
  const tinySpecs = Object.fromEntries(
    Object.entries(LOCAL_MODELS).map(([id, spec]) => [id, { ...spec, files: Object.fromEntries(Object.entries(spec.files).map(([k, f]) => [k, { ...f, bytes: TINY }])) }]),
  ) as Record<LocalModelId, LocalModelSpec>;
  const writeModel = (root: string, id: LocalModelId, opts: { skip?: string; wrongSize?: string } = {}): void => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    for (const f of Object.values(LOCAL_MODELS[id].files)) {
      if (f.name === opts.skip) continue;
      writeFileSync(join(dir, f.name), Buffer.alloc(f.name === opts.wrongSize ? TINY - 1 : TINY));
    }
  };
  const locate = (id: LocalModelId, roots: string[]) => locateModel(id, roots, tinySpecs);

  it('lists the folders to search, most specific first', () => {
    expect(modelSearchRoots({ override: '/o', userData: '/u', resourcesPath: '/r', appRoot: '/a' }).map((p) => p.replace(/\\/g, '/'))).toEqual(['/o', '/u/models/stt', '/r/models/stt', '/a/resources/models/stt']);
    expect(modelSearchRoots({})).toEqual([]);
  });

  it('finds a complete model and returns absolute paths to its files', () => {
    const root = tmp();
    writeModel(root, 'zipformer-en-70m');
    const r = locate('zipformer-en-70m', [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.paths.encoder.replace(/\\/g, '/')).toContain('zipformer-en-70m/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx');
  });

  it('reports a model that is not installed anywhere', () => {
    const r = locate('x-asr-160', [tmp()]);
    expect(r).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('reports a model with a missing or truncated file instead of failing later inside the native library', () => {
    const missing = tmp();
    writeModel(missing, 'x-asr-160', { skip: 'joiner.int8.onnx' });
    const a = locate('x-asr-160', [missing]);
    expect(a).toMatchObject({ ok: false, reason: 'incomplete' });
    if (!a.ok) expect(a.problems.join(' ')).toContain('joiner.int8.onnx is missing');

    const truncated = tmp();
    writeModel(truncated, 'x-asr-160', { wrongSize: 'encoder.int8.onnx' });
    const b = locate('x-asr-160', [truncated]);
    expect(b).toMatchObject({ ok: false, reason: 'incomplete' });
    if (!b.ok) expect(b.problems.join(' ')).toContain('encoder.int8.onnx has');
  });

  it('a later folder can supply a model the first does not have', () => {
    const empty = tmp();
    const full = tmp();
    writeModel(full, 'zipformer-en-70m');
    expect(locate('zipformer-en-70m', [empty, full]).ok).toBe(true);
  });
});

describe('recogniser configuration', () => {
  it('asks the native library for a streaming transducer with the app’s endpointing and one thread', () => {
    const cfg = buildRecognizerConfig({ encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't', numThreads: 1, endpointSilenceSec: 0.8, casing: 'mixed' }) as {
      modelConfig: { transducer: Record<string, string>; numThreads: number; provider: string };
      enableEndpoint: number;
      rule2MinTrailingSilence: number;
      decodingMethod: string;
    };
    expect(cfg.modelConfig.transducer).toEqual({ encoder: 'e', decoder: 'd', joiner: 'j' });
    expect(cfg.modelConfig.numThreads).toBe(1);
    expect(cfg.modelConfig.provider).toBe('cpu'); // never a GPU/cloud provider
    expect(cfg.enableEndpoint).toBe(1);
    expect(cfg.rule2MinTrailingSilence).toBe(0.8);
    expect(cfg.decodingMethod).toBe('greedy_search');
  });
});

describe('recogniser core (scripted library)', () => {
  const init = { encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't', numThreads: 1, endpointSilenceSec: 0.8, casing: 'upper' as const };
  const feed = (core: RecognizerCore, id: number, kind: 'speech' | 'silence', ms: number): void => {
    for (let t = 0; t < ms; t += 40) core.push(id, new Int16Array(pcmFrame(kind).buffer));
  };

  it('emits a growing partial result while the speaker is still talking', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa(), init, (r) => out.push(r));
    core.open(1);
    feed(core, 1, 'speech', 480);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => !r.isFinal)).toBe(true);
    const texts = out.map((r) => r.text);
    expect(texts[0]).toBe('Tell'); // sentence-cased
    for (let i = 1; i < texts.length; i++) expect(texts[i].length).toBeGreaterThan(texts[i - 1].length); // strictly growing: no duplicates
  });

  it('does not repeat an unchanged partial result', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa({ words: ['hello'] }), init, (r) => out.push(r));
    core.open(1);
    feed(core, 1, 'speech', 1200);
    expect(out.map((r) => r.text)).toEqual(['Hello']);
  });

  it('ends the segment itself after enough trailing silence, with a punctuated final result', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa({ words: ['do', 'you', 'have', 'any', 'questions'] }), init, (r) => out.push(r));
    core.open(1);
    feed(core, 1, 'speech', 1000);
    feed(core, 1, 'silence', 1200);
    const final = out.filter((r) => r.isFinal);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ text: 'Do you have any questions?', isFinal: true, speechFinal: true });
    // after the endpoint the next utterance starts from nothing
    feed(core, 1, 'speech', 400);
    expect(out.at(-1)!.text.split(' ').length).toBeLessThanOrEqual(3); // restarted from the first word, not "…questions" again
  });

  it('flushes on request: pending words become a final result at once', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa({ words: ['tell', 'me', 'about', 'yourself'] }), init, (r) => out.push(r));
    core.open(1);
    feed(core, 1, 'speech', 480);
    expect(out.some((r) => r.isFinal)).toBe(false);
    core.finalize(1);
    const final = out.filter((r) => r.isFinal);
    expect(final).toHaveLength(1);
    expect(final[0].speechFinal).toBe(true);
    expect(final[0].text.startsWith('Tell me')).toBe(true);
  });

  it('flushing when nothing was said produces nothing', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa(), init, (r) => out.push(r));
    core.open(1);
    feed(core, 1, 'silence', 400);
    core.finalize(1);
    expect(out).toEqual([]);
  });

  it('keeps two audio streams (microphone and computer audio) apart', () => {
    const out: CoreResult[] = [];
    const core = new RecognizerCore(fakeSherpa({ words: ['one', 'two', 'three'] }), init, (r) => out.push(r));
    core.open(1);
    core.open(2);
    feed(core, 1, 'speech', 480);
    feed(core, 2, 'silence', 480);
    expect(out.every((r) => r.id === 1)).toBe(true);
    core.close(1);
    core.push(1, new Int16Array(pcmFrame('speech').buffer)); // a closed stream is ignored, not an error
    expect(core.openStreams).toBe(1);
  });

  it('counts audio and decoding so the host can tell whether it keeps up with real time', () => {
    const core = new RecognizerCore(fakeSherpa(), init, () => undefined);
    core.open(1);
    feed(core, 1, 'speech', 1000);
    const stats = core.stats();
    expect(stats.audioMs).toBe(1000);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(core.processedMs(1)).toBe(1000);
  });
});

describe('WAV reader', () => {
  const wav = (samples: Int16Array, rate = 16000, channels = 1): Uint8Array => {
    const data = new Uint8Array(samples.buffer);
    const b = new DataView(new ArrayBuffer(44 + data.length));
    const w = (o: number, s: string): void => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    b.setUint32(4, 36 + data.length, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    b.setUint32(16, 16, true);
    b.setUint16(20, 1, true);
    b.setUint16(22, channels, true);
    b.setUint32(24, rate, true);
    b.setUint32(28, rate * channels * 2, true);
    b.setUint16(32, channels * 2, true);
    b.setUint16(34, 16, true);
    w(36, 'data');
    b.setUint32(40, data.length, true);
    const out = new Uint8Array(b.buffer);
    out.set(data, 44);
    return out;
  };

  it('reads 16 kHz mono PCM16', () => {
    const a = parseWavPcm16(wav(new Int16Array(16000)));
    expect(a).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(a.seconds).toBeCloseTo(1, 5);
    expect(a.bytes.byteLength).toBe(32000);
  });

  it('rejects things that are not PCM16 WAV files with a clear message', () => {
    expect(() => parseWavPcm16(new Uint8Array(10))).toThrow('Not a WAV file');
    const bad = wav(new Int16Array(10));
    new DataView(bad.buffer).setUint16(34, 8, true); // 8-bit
    expect(() => parseWavPcm16(bad)).toThrow('16-bit PCM');
  });
});

describe('self-test scoring', () => {
  it('scores how many of the sample’s words were heard, ignoring case and punctuation', () => {
    const ref = 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels';
    expect(wordOverlap(ref, 'After early nightfall, the yellow lamps would light up here and there. The squalid quarter of the brothels.')).toBe(1);
    expect(wordOverlap(ref, 'after early nightfall the yellow')).toBeCloseTo(7 / 18, 5); // "the" appears three times in the sample
    expect(wordOverlap(ref, '')).toBe(0);
  });
});
