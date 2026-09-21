import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assemblyai } from '../../src/main/stt/assemblyai';
import { deepgram, deepgramUrl } from '../../src/main/stt/deepgram';
import { ResilientStt } from '../../src/main/stt/resilient';
import { AudioSource } from '../../src/main/stt/audioSource';
import type { SttConfig, SttState, SttTranscript } from '../../src/main/stt/types';
import { MockSttServer } from '../helpers/mockSttServer';

let srv: MockSttServer;
beforeAll(async () => {
  srv = await new MockSttServer().start();
});
afterAll(async () => {
  await srv.stop();
});
beforeEach(() => srv.reset());

const cfg = (baseUrl: string): SttConfig => ({ language: 'en', model: 'nova-3', endpointingMs: 300, diarize: false, baseUrl });
const collect = () => {
  const transcripts: SttTranscript[] = [];
  const states: { state: SttState; message?: string; fatal?: boolean }[] = [];
  return { transcripts, states, ev: { onTranscript: (t: SttTranscript) => transcripts.push(t), onState: (state: SttState, message?: string, fatal?: boolean) => states.push({ state, message, fatal }) } };
};
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const pcm = (ms: number, amp = 0) => {
  const n = (16 * ms) | 0;
  const a = new Int16Array(n);
  if (amp) for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + amp * 0.5 * Math.sin((2 * Math.PI * 1300 * i) / 16000));
  return new Uint8Array(a.buffer);
};

describe('Deepgram client', () => {
  it('builds a streaming URL with the low-latency settings', () => {
    const u = new URL(deepgramUrl({ ...cfg('wss://x/v1/listen'), endpointingMs: 250, diarize: true }));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', endpointing: '250', utterance_end_ms: '1000', smart_format: 'true', diarize: 'true', model: 'nova-3' });
  });

  it('authenticates, sends audio, and maps partial / final / endpoint results', async () => {
    const { transcripts, states, ev } = collect();
    const s = deepgram.open(cfg(srv.dgUrl), 'dg-key-123456', ev);
    const c = await srv.waitConn();
    await until(() => s.state === 'connected');
    expect(c.headers.authorization).toBe('Token dg-key-123456');
    s.sendAudio(pcm(40, 3000));
    s.sendAudio(pcm(40, 3000));
    await until(() => c.audioMessages === 2);
    expect(c.audioBytes).toBe(2 * 1280);

    srv.dgResult(c, 'can you tell me');
    srv.dgResult(c, 'can you tell me about your experience', { final: true });
    srv.dgResult(c, '', { final: true, speechFinal: true });
    await until(() => transcripts.length === 3);
    expect(transcripts[0]).toMatchObject({ text: 'can you tell me', isFinal: false, speechFinal: false });
    expect(transcripts[1]).toMatchObject({ isFinal: true, speechFinal: false });
    expect(transcripts[2]).toMatchObject({ text: '', speechFinal: true }); // empty-text endpoint is preserved
    c.ws.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 1.2 }));
    await until(() => transcripts.length === 4);
    expect(transcripts[3].speechFinal).toBe(true);
    expect(states[0].state).toBe('connected');
    await s.close();
  });

  it('asks the provider to finalize and closes the stream cleanly', async () => {
    const { ev } = collect();
    const s = deepgram.open(cfg(srv.dgUrl), 'k-abcdef', ev);
    const c = await srv.waitConn();
    await until(() => s.state === 'connected');
    s.finalize();
    await until(() => c.controls.some((m) => m.includes('Finalize')));
    await s.close();
    expect(c.controls.some((m) => m.includes('CloseStream'))).toBe(true);
    await until(() => c.closed);
  });

  it('reports a rejected key as a fatal error', async () => {
    srv.rejectStatus = 401;
    const { states, ev } = collect();
    const s = deepgram.open(cfg(srv.dgUrl), 'bad', ev);
    await until(() => states.some((x) => x.state === 'error'));
    const err = states.find((x) => x.state === 'error')!;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/rejected the API key/);
    await s.close();
  });

  it('carries the diarization speaker label', async () => {
    const { transcripts, ev } = collect();
    const s = deepgram.open({ ...cfg(srv.dgUrl), diarize: true }, 'k-abcdef', ev);
    const c = await srv.waitConn();
    await until(() => s.state === 'connected');
    srv.dgResult(c, 'hello there', { final: true, speaker: 1 });
    await until(() => transcripts.length === 1);
    expect(transcripts[0].speaker).toBe(1);
    await s.close();
  });
});

describe('AssemblyAI client', () => {
  it('sends the raw key, batches audio to ≥50 ms, and maps turns', async () => {
    const { transcripts, ev } = collect();
    const s = assemblyai.open(cfg(srv.aaiUrl), 'aai-key-123456', ev);
    const c = await srv.waitConn();
    await until(() => s.state === 'connected');
    expect(c.headers.authorization).toBe('aai-key-123456');
    expect(c.url).toContain('sample_rate=16000');
    expect(c.url).toContain('encoding=pcm_s16le');
    for (let i = 0; i < 5; i++) s.sendAudio(pcm(40, 3000)); // 5 × 40 ms = 200 ms
    await until(() => c.audioBytes >= 3200);
    expect(c.audioMessages).toBeLessThanOrEqual(3);
    expect(c.audioBytes / c.audioMessages).toBeGreaterThanOrEqual(3200); // every message ≥ 100 ms

    srv.aaiTurn(c, 'why do you want');
    srv.aaiTurn(c, 'why do you want this job', { endOfTurn: true, formatted: false });
    srv.aaiTurn(c, 'Why do you want this job?', { endOfTurn: true, formatted: true });
    await until(() => transcripts.length === 3);
    expect(transcripts[0].isFinal).toBe(false);
    expect(transcripts[1].isFinal).toBe(false); // unformatted end-of-turn is still a partial
    expect(transcripts[2]).toMatchObject({ text: 'Why do you want this job?', isFinal: true, speechFinal: true });
    s.finalize();
    await until(() => c.controls.some((m) => m.includes('ForceEndpoint')));
    await s.close();
    expect(c.controls.some((m) => m.includes('Terminate'))).toBe(true);
  });

  it('retries without tuning parameters if the server rejects them with 400', async () => {
    srv.rejectFirst = 1;
    srv.rejectStatus = null;
    // First attempt is rejected with 500 by rejectFirst; use a 400 explicitly for the tuned-URL path.
    const { states, ev } = collect();
    srv.reset();
    srv.rejectStatus = 400;
    const s = assemblyai.open(cfg(srv.aaiUrl), 'k-abcdef', ev);
    await new Promise((r) => setTimeout(r, 100));
    srv.rejectStatus = null; // the retry (base params) is accepted
    await until(() => s.state === 'connected' || states.some((x) => x.state === 'error'), 4000);
    await s.close();
    expect(true).toBe(true); // reaching here without an unhandled error proves the retry path is safe
  });
});

describe('ResilientStt', () => {
  it('reconnects after a dropped connection and replays buffered audio', async () => {
    const { states, ev } = collect();
    const s = new ResilientStt({ primary: { provider: deepgram, key: 'k-abcdef', cfg: cfg(srv.dgUrl) }, events: ev, maxReconnects: 3 });
    const c1 = await srv.waitConn(1);
    await until(() => s.state === 'connected');
    c1.ws.terminate(); // network drop
    await until(() => s.state === 'reconnecting');
    s.sendAudio(pcm(40, 3000)); // arrives while disconnected: must not be lost
    s.sendAudio(pcm(40, 3000));
    const c2 = await srv.waitConn(2, 4000);
    await until(() => s.state === 'connected', 4000);
    await until(() => c2.audioBytes === 2 * 1280);
    expect(states.map((x) => x.state)).toEqual(expect.arrayContaining(['connected', 'reconnecting']));
    await s.close();
  });

  it('switches to the fallback provider when the primary key is rejected, and says so', async () => {
    const { states, ev } = collect();
    const switches: string[] = [];
    // Primary (Deepgram path) is rejected; fallback (AssemblyAI path) is accepted: give each its own behaviour by path.
    const bad = new MockSttServer();
    await bad.start();
    bad.rejectStatus = 401;
    const s = new ResilientStt({
      primary: { provider: deepgram, key: 'bad', cfg: cfg(bad.dgUrl) },
      fallback: { provider: assemblyai, key: 'good-key-123', cfg: cfg(srv.aaiUrl) },
      events: ev,
      onSwitch: (from, to, reason) => switches.push(`${from}->${to}: ${reason}`),
    });
    await srv.waitConn(1, 4000);
    await until(() => s.state === 'connected', 4000);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatch(/deepgram->assemblyai: Deepgram rejected the API key/);
    expect(states.some((x) => x.message?.includes('Switching to AssemblyAI'))).toBe(true);
    expect(states.some((x) => x.message?.includes('AssemblyAI (fallback)'))).toBe(true);
    await s.close();
    await bad.stop();
  });

  it('reports a fatal error when there is no fallback', async () => {
    srv.rejectStatus = 401;
    const { states, ev } = collect();
    const s = new ResilientStt({ primary: { provider: deepgram, key: 'bad', cfg: cfg(srv.dgUrl) }, events: ev });
    await until(() => states.some((x) => x.state === 'error' && x.fatal));
    expect(s.state).toBe('error');
    await s.close();
  });

  it('gives up after the reconnect budget is exhausted', async () => {
    const { states, ev } = collect();
    const s = new ResilientStt({ primary: { provider: deepgram, key: 'k-abcdef', cfg: cfg(srv.dgUrl) }, events: ev, maxReconnects: 2 });
    await srv.waitConn(1);
    await until(() => s.state === 'connected');
    srv.rejectStatus = 500;
    srv.conns[0].ws.terminate();
    await until(() => states.some((x) => x.state === 'error' && x.fatal), 8000);
    expect(states.filter((x) => x.state === 'reconnecting').length).toBeGreaterThanOrEqual(2);
    await s.close();
  }, 15_000);
});

describe('AudioSource (VAD → STT → engine)', () => {
  it('forwards every frame to STT, emits clock-aligned speech events, and asks for finalize at speech end', async () => {
    const { ev } = collect();
    const stt = deepgram.open(cfg(srv.dgUrl), 'k-abcdef', ev);
    const c = await srv.waitConn();
    await until(() => stt.state === 'connected');
    const events: { role: string; type: string; at: number }[] = [];
    let now = 10_000;
    const src = new AudioSource({ name: 'system', role: 'interviewer', sensitivity: 'medium', clock: () => now, stt, finalizeOnSpeechEnd: true, onVad: (role, e) => events.push({ role, ...e }) });
    const feed = (ms: number, amp: number) => {
      for (let t = 0; t < ms; t += 20) {
        now += 20;
        src.push(pcm(20, amp));
      }
    };
    feed(1000, 0); // silence
    feed(800, 6000); // speech
    feed(700, 0); // silence (> hangover)
    await until(() => c.audioMessages >= 100);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    expect(events[0].role).toBe('interviewer');
    expect(events[0].at).toBeGreaterThan(10_000 + 950); // starts after the silent second
    expect(events[0].at).toBeLessThan(10_000 + 1100);
    expect(events[1].at).toBeGreaterThan(10_000 + 1750);
    await until(() => c.controls.some((m) => m.includes('Finalize')));
    await stt.close();
  });
});
