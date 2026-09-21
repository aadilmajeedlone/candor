import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSttHost, LocalSttError, type HostDeps, type WorkerPort } from '../../src/main/stt/local/host';
import { LOCAL_MODELS, type LocalModelId, type LocalModelPreference } from '../../src/main/stt/local/models';
import { runLocalSelfTest, SELFTEST_TEXT } from '../../src/main/stt/local/selftest';
import { createLocalProvider } from '../../src/main/stt/local/provider';
import { createSttRegistry } from '../../src/main/stt/registry';
import { ResilientStt } from '../../src/main/stt/resilient';
import type { SttConfig, SttEvents, SttProvider, SttState, SttStream, SttTranscript } from '../../src/main/stt/types';
import type { SecretStore } from '../../src/main/security/secrets';
import { fakeSherpa, inProcessWorker, pcmFrame, tinyModelRoot, tinySpecs, type FakeSherpaOptions, type InProcessWorker } from '../helpers/fakeSherpa';

/**
 * The speech host against a scripted native library: everything about starting, sharing, restarting and failing the
 * worker, without loading a real model. (The real model is exercised in stt-local-real.test.ts.)
 */

const TINY = 16;

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const cfg: SttConfig = { language: 'en', model: '', endpointingMs: 300, diarize: false };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for a condition');
    await wait(5);
  }
}

let dirs: string[] = [];
function modelRoot(ids: LocalModelId[] = ['x-asr-160', 'zipformer-en-70m']): string {
  const root = tinyModelRoot(ids);
  dirs.push(root);
  return root;
}

interface Rig {
  host: LocalSttHost;
  workers: InProcessWorker[];
  events: { transcripts: SttTranscript[]; states: { state: SttState; message?: string; fatal?: boolean }[]; notices: { level: string; message: string }[] };
  ev: SttEvents;
  setPreference(p: LocalModelPreference): void;
  clockMs: { now: number };
}

function rig(o: { root?: string; sherpa?: FakeSherpaOptions; loadSherpa?: () => never; deps?: Partial<HostDeps>; workerFor?: (n: number) => InProcessWorker; preference?: LocalModelPreference } = {}): Rig {
  const workers: InProcessWorker[] = [];
  const clockMs = { now: 1_000_000 };
  let preference: LocalModelPreference = o.preference ?? 'auto';
  const events: Rig['events'] = { transcripts: [], states: [], notices: [] };
  const host = new LocalSttHost({
    createWorker: () => {
      const w = o.workerFor ? o.workerFor(workers.length) : inProcessWorker(o.loadSherpa ?? (() => fakeSherpa(o.sherpa)));
      workers.push(w);
      return w;
    },
    roots: () => [o.root ?? modelRoot()],
    hardware: { cores: 8, totalMemGB: 14 },
    preference: () => preference,
    endpointingMs: () => 300,
    log: silentLog,
    now: () => clockMs.now,
    idleUnloadMs: 0,
    specs: tinySpecs,
    ...o.deps,
  });
  const ev: SttEvents = {
    onTranscript: (t) => events.transcripts.push(t),
    onState: (state, message, fatal) => events.states.push({ state, message, fatal }),
    onNotice: (level, message) => events.notices.push({ level, message }),
  };
  return { host, workers, events, ev, setPreference: (p) => (preference = p), clockMs };
}

beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('starting and sharing the worker', () => {
  it('loads nothing until a stream is opened, then loads the model once', async () => {
    const r = rig();
    expect(r.workers).toHaveLength(0);
    expect(r.host.status()).toMatchObject({ state: 'idle', modelId: 'x-asr-160', tier: 'accurate' });

    const stream = r.host.open(cfg, r.ev);
    expect(stream.state).toBe('connecting');
    await until(() => stream.state === 'connected');
    expect(r.workers).toHaveLength(1);
    expect(r.host.status()).toMatchObject({ state: 'ready', openStreams: 1 });
    expect(r.host.status().loadMs).toBeGreaterThanOrEqual(0);
    const init = r.workers[0].received.find((m) => m.t === 'init');
    expect(init).toBeTruthy();
    if (init?.t === 'init') {
      expect(init.cfg.numThreads).toBe(1);
      expect(init.cfg.casing).toBe('mixed');
      expect(init.cfg.encoder).toContain('encoder.int8.onnx');
    }
    await stream.close();
  });

  it('keeps the model loaded for the next session instead of reloading it', async () => {
    const r = rig();
    const a = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected');
    await a.close();
    const b = r.host.open(cfg, r.ev);
    await until(() => b.state === 'connected');
    expect(r.workers).toHaveLength(1); // same worker, same loaded model
    expect(r.workers[0].received.filter((m) => m.t === 'init')).toHaveLength(1);
    await b.close();
  });

  it('two streams opened together share one load (microphone + computer audio)', async () => {
    const r = rig();
    const a = r.host.open(cfg, r.ev);
    const b = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected' && b.state === 'connected');
    expect(r.workers).toHaveLength(1);
    expect(r.host.status().openStreams).toBe(2);
    await Promise.all([a.close(), b.close()]);
  });

  it('streams partial results while audio arrives, and a final one when asked', async () => {
    const r = rig({ sherpa: { words: ['tell', 'me', 'about', 'yourself'] }, preference: 'light' }); // the light model writes ALL CAPS
    const stream = r.host.open(cfg, r.ev);
    await until(() => stream.state === 'connected');
    for (let i = 0; i < 20; i++) stream.sendAudio(pcmFrame('speech')); // 800 ms of speech
    await until(() => r.events.transcripts.length >= 2);
    const partials = r.events.transcripts.filter((t) => !t.isFinal);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(partials[0].text).toBe('Tell');
    expect(partials.at(-1)!.text.length).toBeGreaterThan(partials[0].text.length);
    stream.finalize();
    await until(() => r.events.transcripts.some((t) => t.isFinal));
    expect(r.events.transcripts.find((t) => t.isFinal)).toMatchObject({ isFinal: true, speechFinal: true });
    await stream.close();
  });

  it('keeps audio for each stream separate', async () => {
    const r = rig({ sherpa: { words: ['one', 'two', 'three'] } });
    const heard: Record<string, string[]> = { a: [], b: [] };
    const a = r.host.open(cfg, { ...r.ev, onTranscript: (t) => heard.a.push(t.text) });
    const b = r.host.open(cfg, { ...r.ev, onTranscript: (t) => heard.b.push(t.text) });
    await until(() => a.state === 'connected' && b.state === 'connected');
    for (let i = 0; i < 20; i++) {
      a.sendAudio(pcmFrame('speech'));
      b.sendAudio(pcmFrame('silence'));
    }
    await until(() => heard.a.length > 0);
    await wait(30);
    expect(heard.b).toEqual([]);
    await Promise.all([a.close(), b.close()]);
  });

  it('ignores audio sent before the stream is connected or after it is closed', async () => {
    const r = rig();
    const stream = r.host.open(cfg, r.ev);
    stream.sendAudio(pcmFrame('speech')); // still connecting: dropped, never queued unbounded
    await until(() => stream.state === 'connected');
    await stream.close();
    stream.sendAudio(pcmFrame('speech'));
    expect(r.workers[0].received.filter((m) => m.t === 'audio')).toHaveLength(0);
  });

  it('sends whole samples only (an odd trailing byte is not passed on)', async () => {
    const r = rig();
    const stream = r.host.open(cfg, r.ev);
    await until(() => stream.state === 'connected');
    stream.sendAudio(new Uint8Array(1281));
    const audio = r.workers[0].received.find((m) => m.t === 'audio');
    expect(audio && audio.t === 'audio' ? audio.pcm.byteLength : -1).toBe(1280);
    await stream.close();
  });
});

describe('when the model cannot be used', () => {
  it('a model that is not installed is a clear, fatal error and no worker is started', async () => {
    const r = rig({ root: modelRoot([]) });
    const stream = r.host.open(cfg, r.ev);
    await until(() => r.events.states.some((s) => s.state === 'error'));
    const err = r.events.states.find((s) => s.state === 'error')!;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/not installed/);
    expect(err.message).toMatch(/npm run models|Reinstall/);
    expect(r.workers).toHaveLength(0);
    expect(r.host.status()).toMatchObject({ state: 'failed', code: 'model_missing' });
    await stream.close();
  });

  it('a truncated model file is reported as incomplete, naming the file', async () => {
    const root = modelRoot();
    writeFileSync(join(root, 'x-asr-160', LOCAL_MODELS['x-asr-160'].files.encoder.name), Buffer.alloc(TINY - 1));
    // "auto" falls back to the light model when it is complete…
    const auto = rig({ root });
    const s1 = auto.host.open(cfg, auto.ev);
    await until(() => s1.state === 'connected');
    expect(auto.host.status().modelId).toBe('zipformer-en-70m');
    await s1.close();
    // …but an explicit choice of the accurate model is not silently changed
    const forced = rig({ root });
    forced.setPreference('accurate');
    const s2 = forced.host.open(cfg, forced.ev);
    await until(() => forced.events.states.some((s) => s.state === 'error'));
    expect(forced.events.states.find((s) => s.state === 'error')!.message).toMatch(/damaged or incomplete/);
    expect(forced.host.status().code).toBe('model_incomplete');
    await s2.close();
  });

  it('a speech engine that cannot start on this PC says so, and points at the alternatives', async () => {
    const r = rig({
      loadSherpa: () => {
        throw new Error('The specified module could not be found: onnxruntime.dll');
      },
    });
    const stream = r.host.open(cfg, r.ev);
    await until(() => r.events.states.some((s) => s.state === 'error'));
    const err = r.events.states.find((s) => s.state === 'error')!;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/could not start on this PC/);
    expect(err.message).toMatch(/Security software/);
    expect(err.message).toMatch(/Settings → Speech/);
    expect(r.host.status().code).toBe('runtime_missing');
    await stream.close();
  });

  it('a model the library refuses to load is reported with the reason, and can be retried', async () => {
    const r = rig({ sherpa: { failOnCreate: 'Failed to load the encoder' } });
    const stream = r.host.open(cfg, r.ev);
    await until(() => r.events.states.some((s) => s.state === 'error'));
    const err = r.events.states.find((s) => s.state === 'error')!;
    expect(err.fatal).toBe(false); // may be transient (memory pressure): worth a retry
    expect(err.message).toContain('Failed to load the encoder');
    expect(r.host.status().code).toBe('model_load_failed');
    await stream.close();
  });

  it('gives up on a load that never finishes', async () => {
    const silent: WorkerPort & { terminated: boolean } = {
      terminated: false,
      post: () => undefined,
      onMessage: () => undefined,
      onError: () => undefined,
      onExit: () => undefined,
      terminate: async () => {
        silent.terminated = true;
      },
    };
    const r = rig({ workerFor: () => silent as unknown as InProcessWorker, deps: { loadTimeoutMs: 40 } });
    const stream = r.host.open(cfg, r.ev);
    await until(() => r.events.states.some((s) => s.state === 'error'));
    expect(r.events.states.find((s) => s.state === 'error')!.message).toMatch(/took longer than/);
    expect(silent.terminated).toBe(true);
    await stream.close();
  });

  it('check() tells the settings screen whether the model is present without loading it', () => {
    expect(rig({ root: modelRoot() }).host.check().ok).toBe(true);
    const missing = rig({ root: modelRoot([]) }).host.check();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBeInstanceOf(LocalSttError);
  });
});

describe('recovering when the worker dies', () => {
  it('the resilient wrapper restarts the engine and replays the audio it kept, without losing the sentence', async () => {
    const r = rig({ sherpa: { words: ['tell', 'me', 'about', 'a', 'time'] } });
    const heard: string[] = [];
    const states: SttState[] = [];
    const resilient = new ResilientStt({
      primary: { provider: createLocalProvider(r.host), key: '', cfg },
      events: { onTranscript: (t) => heard.push(t.text), onState: (s) => states.push(s) },
      replayMs: 4000,
    });
    await until(() => resilient.state === 'connected');
    for (let i = 0; i < 10; i++) resilient.sendAudio(pcmFrame('speech'));
    await until(() => heard.length > 0);

    r.workers[0].crash('native crash');
    await until(() => states.includes('reconnecting'));
    // audio keeps arriving while the engine restarts: it is kept, not lost
    for (let i = 0; i < 10; i++) resilient.sendAudio(pcmFrame('speech'));
    await until(() => resilient.state === 'connected', 5000);
    expect(r.workers).toHaveLength(2); // a fresh worker
    const audioToNew = r.workers[1].received.filter((m) => m.t === 'audio');
    expect(audioToNew.length).toBeGreaterThanOrEqual(10); // the buffered audio was replayed into the new engine
    await resilient.close();
  }, 10_000);

  it('a crash that keeps repeating becomes a clear failure instead of an endless restart loop', async () => {
    const r = rig();
    const streams: SttStream[] = [];
    let last: SttState = 'connecting';
    let fatal = false;
    for (let i = 0; i < 3; i++) {
      const s = r.host.open(cfg, { ...r.ev, onState: (state, _m, f) => ((last = state), (fatal = !!f)) });
      streams.push(s);
      await until(() => s.state === 'connected');
      r.workers[i].crash('again');
      await until(() => last === 'error');
      await s.close();
    }
    expect(fatal).toBe(true);
    expect(r.events.states.length).toBe(0); // (per-stream handler above captured them)
    expect(r.host.status()).toMatchObject({ state: 'failed', code: 'worker_crashed' });
  });

  it('fails over to the configured cloud provider when the on-device model is missing', async () => {
    const r = rig({ root: modelRoot([]) });
    const cloud: SttProvider & { opened: number } = {
      id: 'deepgram',
      label: 'Deepgram',
      needsKey: true,
      opened: 0,
      open(_c, _k, events) {
        cloud.opened++;
        queueMicrotask(() => events.onState('connected'));
        return { state: 'connected', sendAudio: () => undefined, finalize: () => undefined, close: async () => undefined };
      },
    };
    const switches: string[] = [];
    const resilient = new ResilientStt({
      primary: { provider: createLocalProvider(r.host), key: '', cfg },
      fallback: { provider: cloud, key: 'k', cfg },
      onSwitch: (from, to, reason) => switches.push(`${from}->${to}: ${reason}`),
      events: { onTranscript: () => undefined, onState: () => undefined },
    });
    await until(() => resilient.state === 'connected');
    expect(cloud.opened).toBe(1);
    expect(switches[0]).toMatch(/^local->deepgram: The speech model .* is not installed/);
    await resilient.close();
  });
});

describe('keeping up with real time', () => {
  it('warns once when recognition falls behind the microphone, and says when it has caught up', async () => {
    // A worker that accepts audio but never reports progress: the backlog only grows.
    const posted: string[] = [];
    const stuck = inProcessWorker(() => fakeSherpa());
    const realPost = stuck.post.bind(stuck);
    stuck.post = (m, t) => {
      posted.push(m.t);
      if (m.t === 'audio') return; // swallow audio: nothing is ever processed
      realPost(m, t);
    };
    const r = rig({ workerFor: () => stuck });
    const stream = r.host.open(cfg, r.ev);
    await until(() => stream.state === 'connected');
    // 2 s of audio sent, none processed: 2000 ms behind
    for (let i = 0; i < 50; i++) stream.sendAudio(pcmFrame('speech'));
    // The worker reports progress (as it does every 250 ms) — but only for the first 200 ms.
    const inner = (r.host as unknown as { streams: Map<number, { onProgress(ms: number): void }> }).streams.get(1)!;
    inner.onProgress(200);
    r.clockMs.now += 2500;
    inner.onProgress(220);
    expect(r.events.notices).toHaveLength(1);
    expect(r.events.notices[0]).toMatchObject({ level: 'warn' });
    expect(r.events.notices[0].message).toMatch(/behind real time/);
    r.clockMs.now += 1000;
    inner.onProgress(240); // still behind: no repeated warning
    expect(r.events.notices).toHaveLength(1);
    inner.onProgress(2000); // caught up
    expect(r.events.notices).toHaveLength(2);
    expect(r.events.notices[1]).toMatchObject({ level: 'info', message: 'Speech recognition has caught up.' });
    await stream.close();
  });

  it('reports the current backlog in the status shown in Settings', async () => {
    const stuck = inProcessWorker(() => fakeSherpa());
    const realPost = stuck.post.bind(stuck);
    stuck.post = (m, t) => (m.t === 'audio' ? undefined : realPost(m, t));
    const r = rig({ workerFor: () => stuck });
    const stream = r.host.open(cfg, r.ev);
    await until(() => stream.state === 'connected');
    for (let i = 0; i < 25; i++) stream.sendAudio(pcmFrame('speech')); // 1 s
    expect(r.host.status().lagMs).toBe(1000);
    await stream.close();
  });
});

describe('memory and shutdown', () => {
  it('frees the model after a long idle period and loads it again on the next use', async () => {
    const r = rig({ deps: { idleUnloadMs: 40 } });
    const a = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected');
    await a.close();
    await until(() => r.host.status().state === 'idle', 1000);
    expect(r.workers[0].terminated).toBe(true);
    const b = r.host.open(cfg, r.ev);
    await until(() => b.state === 'connected');
    expect(r.workers).toHaveLength(2);
    await b.close();
  });

  it('does not unload while a stream is open', async () => {
    const r = rig({ deps: { idleUnloadMs: 30 } });
    const a = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected');
    await wait(120);
    expect(r.host.status().state).toBe('ready');
    await a.close();
  });

  it('switches to another model between sessions when the preference changes', async () => {
    const r = rig();
    r.setPreference('light');
    const a = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected');
    expect(r.host.status().modelId).toBe('zipformer-en-70m');
    await a.close();
    r.setPreference('accurate');
    const b = r.host.open(cfg, r.ev);
    await until(() => b.state === 'connected');
    expect(r.host.status().modelId).toBe('x-asr-160');
    expect(r.workers).toHaveLength(2);
    await b.close();
  });

  it('dispose() closes every stream and stops the worker', async () => {
    const r = rig();
    const a = r.host.open(cfg, r.ev);
    await until(() => a.state === 'connected');
    await r.host.dispose();
    expect(a.state).toBe('closed');
    expect(r.workers[0].terminated).toBe(true);
    expect(r.host.status().state).toBe('idle');
  });
});

describe('the speech provider registry', () => {
  const secrets = { get: vi.fn(() => null) } as unknown as SecretStore;

  it('the on-device engine needs no key: it is available exactly when the model is installed', () => {
    const ok = createSttRegistry(rig({ root: modelRoot() }).host);
    expect(ok.access('local', secrets)).toEqual({ ok: true, key: '' });
    expect(ok.provider('local')).toMatchObject({ id: 'local', needsKey: false });
    const missing = createSttRegistry(rig({ root: modelRoot([]) }).host).access('local', secrets);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/not installed/);
  });

  it('a cloud service without a key is unavailable, and the message offers the free on-device engine', () => {
    const reg = createSttRegistry(rig().host);
    const a = reg.access('deepgram', secrets);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.message).toMatch(/No Deepgram API key/);
      expect(a.message).toMatch(/free on-device speech engine/);
    }
    expect(reg.provider('deepgram').needsKey).toBe(true);
    expect(reg.provider('assemblyai').needsKey).toBe(true);
  });

  it('a stored cloud key makes the cloud service available', () => {
    const reg = createSttRegistry(rig().host);
    const withKey = { get: () => 'dg-key' } as unknown as SecretStore;
    expect(reg.access('deepgram', withKey)).toEqual({ ok: true, key: 'dg-key' });
  });
});

describe('"Test speech recognition"', () => {
  function sampleWav(): string {
    const dir = mkdtempSync(join(tmpdir(), 'candor-sample-'));
    dirs.push(dir);
    const data = new Int16Array(16000 * 2).fill(3000); // 2 s of "speech" for the scripted library
    const bytes = new Uint8Array(data.buffer);
    const b = new DataView(new ArrayBuffer(44 + bytes.length));
    const w = (o: number, s: string): void => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    b.setUint32(4, 36 + bytes.length, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    b.setUint32(16, 16, true);
    b.setUint16(20, 1, true);
    b.setUint16(22, 1, true);
    b.setUint32(24, 16000, true);
    b.setUint32(28, 32000, true);
    b.setUint16(32, 2, true);
    b.setUint16(34, 16, true);
    w(36, 'data');
    b.setUint32(40, bytes.length, true);
    const out = new Uint8Array(b.buffer);
    out.set(bytes, 44);
    const path = join(dir, 'selftest.wav');
    writeFileSync(path, out);
    return path;
  }

  it('passes when the sample is transcribed, and reports what was heard and how fast', async () => {
    const r = rig({ sherpa: { words: SELFTEST_TEXT.split(' '), chunkSamples: 1280 }, preference: 'light' });
    const result = await runLocalSelfTest(r.host, { samplePath: sampleWav(), paceMs: 0 });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Heard: “After early nightfall');
    expect(result.detail).toMatch(/First words appeared \d+ ms/);
    expect(result.detail).toMatch(/Model loaded in/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.host.status().openStreams).toBe(0); // the test cleans up after itself
  });

  it('fails, with what it heard, when the engine transcribes the sample poorly', async () => {
    const r = rig({ sherpa: { words: ['completely', 'different', 'words'], chunkSamples: 1280 }, preference: 'light' });
    const result = await runLocalSelfTest(r.host, { samplePath: sampleWav(), paceMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transcribed poorly/);
    expect(result.error).toContain('Completely different');
  });

  it('fails clearly when there is no sample or no model', async () => {
    const noSample = await runLocalSelfTest(rig().host, { samplePath: null });
    expect(noSample).toMatchObject({ ok: false });
    expect(noSample.error).toMatch(/sample is missing/);
    const noModel = await runLocalSelfTest(rig({ root: modelRoot([]) }).host, { samplePath: sampleWav(), paceMs: 0 });
    expect(noModel.ok).toBe(false);
    expect(noModel.error).toMatch(/not installed/);
  });
});
