import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '../../src/shared/events';
import type { MockEvent } from '../../src/shared/ipc';
import { RESUME_TEXT, JD_TEXT } from '../fixtures/documents';
import { makeApp, type App } from '../helpers/appHarness';
import { fakeSherpa, inProcessWorker, tinyModelRoot, tinySpecs, type InProcessWorker } from '../helpers/fakeSherpa';
import { makeDocx, makePdf } from '../helpers/makeDocs';
import { MockLlmServer } from '../helpers/mockLlmServer';
import { MockSttServer } from '../helpers/mockSttServer';

let llm: MockLlmServer;
let stt: MockSttServer;
let app: App;
// Speech on this PC: a scripted stand-in for the native library, and tiny stand-in model files.
let makeWorker: () => InProcessWorker = () => inProcessWorker(() => fakeSherpa());
let modelsInstalled = true;
let modelRoot = '';

import { ANSWER, respond } from '../helpers/llmScript';
void ANSWER;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(15);
  }
};
const liveEvents = () => app.events('live.event');
const pcm = (ms: number, amp: number) => {
  const n = 16 * ms;
  const a = new Int16Array(n);
  if (amp) for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000) + amp * 0.5 * Math.sin((2 * Math.PI * 1300 * i) / 16000));
  return new Uint8Array(a.buffer);
};

let interviewId = '';
let resumeId = '';

beforeAll(async () => {
  llm = await new MockLlmServer().start();
  stt = await new MockSttServer().start();
  llm.openai.dynamic = respond;
  modelRoot = tinyModelRoot();
  app = makeApp({ sttUrls: { deepgram: stt.dgUrl }, localSpeech: { createWorker: () => makeWorker(), modelRoots: () => (modelsInstalled ? [modelRoot] : []), specs: tinySpecs, idleUnloadMs: 0 } });
});
afterAll(async () => {
  await app.close();
  rmSync(modelRoot, { recursive: true, force: true });
  await llm.stop();
  await stt.stop();
});

describe('first run', () => {
  it('starts with defaults and a seeded question bank', async () => {
    const s = await app.call('settings.get');
    expect(s.theme).toBe('dark');
    expect(s.live.speculation).toBe('balanced');
    expect(s.onboarding.completed).toBe(false);
    const bank = await app.call('questions.list', {});
    expect(bank.length).toBeGreaterThan(120);
    const cats = new Set(bank.map((q) => q.category));
    for (const c of ['behavioral', 'hr', 'technical', 'leadership', 'management', 'analytics', 'operations', 'customer-service', 'sales', 'product', 'finance', 'marketing', 'software', 'data', 'case-study']) expect(cats.has(c as never)).toBe(true);
  });

  it('rejects malformed requests at the trust boundary', async () => {
    await expect(app.call('settings.update', { theme: 'neon' } as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('settings.update', { notAKey: 1 } as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('settings.update', { hotkeys: { copy: 'rm -rf /; $(x)' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('interviews.get', { id: 'x'.repeat(500) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('resumes.create', { name: 'a', source: 'pdf', text: 'short', useAi: false })).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('app.openExternal', { url: 'file:///etc/passwd' })).rejects.toThrow(/allowed sites/);
    await expect(app.call('app.openExternal', { url: 'https://evil.example.com/' })).rejects.toThrow(/allowed sites/);
  });

  it('says clearly when no model is configured (missing configuration)', async () => {
    await app.call('live.start', { interviewId: null, audio: false });
    await app.call('live.question', { text: 'Tell me about yourself.' });
    await wait(50);
    const err = liveEvents().find((e) => e.type === 'notice' && e.level === 'error');
    expect(err).toMatchObject({ code: 'not_configured' });
    await app.call('live.stop');
    await expect(app.call('interviews.analyze', { id: 'nope', useAi: true })).rejects.toThrow(/not found/i);
  });
});

describe('providers and models', () => {
  it('stores API keys encrypted, never returns them, and lists a hint only', async () => {
    const p = await app.call('providers.save', { name: 'OpenAI-compatible (mock)', kind: 'openai-compatible', baseUrl: llm.openaiUrl, enabled: true, apiKey: 'sk-test-supersecret-1234567890' });
    expect(p.keySource).toBe('stored');
    expect(p.keyHint).toBe('…7890');
    expect(JSON.stringify(p)).not.toContain('supersecret');
    const rows = app.services.db.all<{ ciphertext: string }>('SELECT ciphertext FROM secrets');
    expect(rows).toHaveLength(1);
    expect(rows[0].ciphertext).not.toContain('supersecret');
    const all = JSON.stringify(await app.call('providers.list'));
    expect(all).not.toContain('supersecret');
    providerId = p.id;
  });

  let providerId = '';
  it('refuses insecure provider URLs but allows local servers', async () => {
    await expect(app.call('providers.save', { name: 'x', kind: 'openai-compatible', baseUrl: 'http://api.example.com/v1', enabled: true })).rejects.toThrow(/https/);
    await expect(app.call('providers.save', { name: 'x', kind: 'openai-compatible', baseUrl: 'https://user:pw@api.example.com/v1', enabled: true })).rejects.toThrow(/credentials/);
    const local = await app.call('providers.save', { name: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', enabled: true });
    expect(local.keyOptional).toBe(true);
    await app.call('providers.delete', { id: local.id });
  });

  it('lists models, quick-sets routing, and measures real connection latency', async () => {
    const models = await app.call('providers.listModels', { id: providerId });
    expect(models.ok).toBe(true);
    expect(models.models).toContain('gpt-4o-mini');
    const { live, prep } = await app.call('models.quickSetup', { providerId, fastModel: 'gpt-4o-mini', qualityModel: 'gpt-4.1' });
    const s = await app.call('settings.get');
    expect(s.routing.live).toEqual({ primary: live.id, fallback: prep.id });
    expect(s.routing.prep.primary).toBe(prep.id);
    const t = await app.call('models.test', { id: live.id });
    expect(t.ok).toBe(true);
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces an invalid API key as a clear error', async () => {
    const wrong = await app.call('providers.save', { name: 'Wrong key', kind: 'openai-compatible', baseUrl: llm.openaiUrl, enabled: true, apiKey: 'sk-wrong-key-1234567890' });
    llm.openai.requireKey = 'sk-test-supersecret-1234567890';
    const m = await app.call('models.save', { name: 'wrong', providerId: wrong.id, model: 'gpt-4o-mini', temperature: 0.3, maxTokens: 300, topP: null, timeoutMs: 5000, streaming: true });
    const r = await app.call('models.test', { id: m.id });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('auth');
    expect(r.error?.message).not.toContain('sk-wrong');
    llm.openai.requireKey = undefined;
    await app.call('providers.delete', { id: wrong.id });
  });
});

describe('documents and résumé', () => {
  it('reads PDF, DOCX and TXT uploads', async () => {
    const pdf = makePdf([[{ x: 72, y: 720, text: 'Riya Sharma - Operations Manager' }, { x: 72, y: 700, text: 'Managed a team of 14 agents at Northwind Logistics.' }]]);
    const a = await app.call('documents.extract', { name: 'cv.pdf', data: pdf.buffer.slice(0) as ArrayBuffer });
    expect(a.source).toBe('pdf');
    expect(a.text).toContain('Northwind Logistics');
    const b = await app.call('documents.extract', { name: 'cv.docx', data: makeDocx({ paragraphs: ['Riya Sharma', 'Operations Manager at Northwind Logistics with 7 years of experience'] }).buffer.slice(0) as ArrayBuffer });
    expect(b.source).toBe('docx');
    const c = await app.call('documents.extract', { name: 'jd.txt', data: new TextEncoder().encode(JD_TEXT).buffer });
    expect(c.text).toContain('Contoso');
  });

  it('rejects invalid files with useful messages', async () => {
    const bad = async (name: string, bytes: Uint8Array) => app.call('documents.extract', { name, data: bytes.buffer.slice(0) as ArrayBuffer }).catch((e: Error) => e.message);
    expect(await bad('x.exe', new Uint8Array([0x4d, 0x5a, 0, 0]))).toMatch(/Unsupported/);
    expect(await bad('x.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]))).toMatch(/\.docx or PDF/);
    expect(await bad('x.pdf', new TextEncoder().encode('%PDF-1.4 broken'))).toMatch(/corrupted/);
    expect(await bad('x.pdf', makePdf([[]]))).toMatch(/scan/i);
    expect(await bad('x.txt', new Uint8Array(0))).toMatch(/empty/i);
  });

  it('parses offline first, then upgrades with AI while discarding invented content', async () => {
    const offline = await app.call('resumes.create', { name: 'offline.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
    expect(offline.parseMethod).toBe('heuristic');
    expect(offline.profile.roles).toHaveLength(2);
    const ai = await app.call('resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: true });
    resumeId = ai.id;
    expect(ai.parseMethod).toBe('llm');
    const blob = JSON.stringify(ai.profile);
    expect(blob).not.toMatch(/Globex|Chief Executive|Kubernetes|PMP|300%/); // fabrications never enter the knowledge base
    expect(ai.profile.roles.map((r) => r.company)).toContain('Northwind Logistics');
    expect(ai.warnings.join(' ')).toMatch(/could not be found in your résumé/);
    expect(ai.profile.facts.length).toBeGreaterThanOrEqual(offline.profile.facts.length - 2); // verbatim facts from the offline pass are retained
  });
});

describe('interview, analysis and preparation', () => {
  it('creates an interview and analyses the JD against the résumé', async () => {
    const i = await app.call('interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, companyNotes: 'Contoso runs same-day delivery in 12 cities.', resumeId });
    interviewId = i.id;
    expect(i.status).toBe('draft');
    const a = await app.call('interviews.analyze', { id: i.id, useAi: true });
    expect(a.status).toBe('ready');
    expect(a.jdAnalysis?.method).toBe('llm');
    expect(a.match?.method).toBe('local+llm');
    const strong = a.match!.strong.map((m) => m.requirement);
    expect(strong).toEqual(expect.arrayContaining(['SQL', 'Power BI']));
    expect(a.match!.missing.map((m) => m.requirement)).toContain('Salesforce');
    // Transferable experience is only kept when it cites real résumé facts.
    expect(a.match!.transferable.map((t) => t.requirement)).toEqual(['Salesforce']);
    expect(a.match!.transferable[0].fromFactIds).not.toContain('invented-id');
  });

  it('works without any AI (offline analysis) and labels the method', async () => {
    const i = await app.call('interviews.create', { jobTitle: 'Ops', company: 'X', interviewType: 'general', jobDescription: JD_TEXT, resumeId });
    const a = await app.call('interviews.analyze', { id: i.id, useAi: false });
    expect(a.jdAnalysis?.method).toBe('heuristic');
    expect(a.match?.method).toBe('local');
    await app.call('interviews.delete', { id: i.id });
  });

  it('generates every preparation section, flagging unverified details', async () => {
    await app.call('prep.generate', { interviewId, section: 'all' });
    const prep = await app.call('prep.get', { interviewId });
    expect(Object.keys(prep).sort()).toEqual(['about', 'company', 'questions', 'role']);
    const about = prep.about!.data as { tellMeAboutYourself: string; unverified?: string[] };
    expect(about.tellMeAboutYourself).toContain('operations manager');
    expect(about.unverified?.join(' ')).toMatch(/\$9/); // the invented "$9 million" is flagged, not silently accepted
    expect((prep.questions!.data as { questions: unknown[] }).questions).toHaveLength(2);
    const progress = app.events('prep.progress');
    expect(progress.at(-1)?.step).toBe('complete');
  });

  it('streams a prepared answer, saves it, and uses it for later live questions', async () => {
    const before = app.events('gen.event').length;
    const { requestId } = await app.call('prep.answer', { interviewId, question: 'Tell me about a time you improved a process.', mode: 'standard', save: true });
    await until(() => (app.events('gen.event')).some((e) => e.requestId === requestId && e.type === 'done'));
    const evs = (app.events('gen.event')).slice(before).filter((e) => e.requestId === requestId);
    expect(evs.filter((e) => e.type === 'token').length).toBeGreaterThan(3);
    expect(evs.at(-1)).toMatchObject({ type: 'done', model: 'gpt-4.1' });
    const saved = await app.call('prep.answers', { interviewId });
    expect(saved).toHaveLength(1);
    expect(saved[0].grounding?.status).toBe('grounded');
  });
});

describe('live session (typed questions)', () => {
  let sessionId = '';
  it('answers with streaming, caches, handles follow-ups, and persists everything', async () => {
    llm.reset();
    llm.openai.dynamic = respond;
    const start = await app.call('live.start', { interviewId, audio: false });
    sessionId = start.sessionId;
    expect(start.sources).toEqual([]);
    const from = liveEvents().length;

    await app.call('live.question', { text: 'Tell me about a time you improved a process.' });
    await until(() => liveEvents().slice(from).some((e) => e.type === 'answer-done'));
    let evs = liveEvents().slice(from);
    const first = evs.find((e) => e.type === 'answer-start');
    // The prepared answer for this exact question is served instantly from cache: no model call.
    expect(first).toMatchObject({ type: 'answer-start', source: 'cache' });
    const doneA = evs.find((e) => e.type === 'answer-done');
    expect(doneA).toMatchObject({ latency: { cacheHit: true } });

    // A question that is not prepared streams from the model, with measured TTFT.
    const mark = liveEvents().length;
    await app.call('live.question', { text: 'What are your greatest strengths?' });
    await until(() => liveEvents().slice(mark).some((e) => e.type === 'answer-done'));
    evs = liveEvents().slice(mark);
    expect(evs.filter((e) => e.type === 'answer-token').length).toBeGreaterThan(3);
    const done = evs.find((e) => e.type === 'answer-done') as Extract<LiveEvent, { type: 'answer-done' }>;
    expect(done.latency.ttftMs).toBeGreaterThan(0);
    expect(done.latency.retrievalMs).toBeDefined();
    expect(done.grounding.status).toMatch(/grounded|unverified-details/);
    expect(done.answerId).toBeTruthy();

    // Follow-up understood in context.
    const mark2 = liveEvents().length;
    await wait(20);
    await app.call('live.question', { text: 'What did you personally do?' });
    await until(() => liveEvents().slice(mark2).some((e) => e.type === 'answer-done'));
    const q = liveEvents().slice(mark2).find((e) => e.type === 'question') as Extract<LiveEvent, { type: 'question' }>;
    expect(q.question.isFollowUp).toBe(true);
    const lastBody = llm.requests.filter((r) => r.path.includes('/chat/completions')).at(-1)!.body as { messages: { content: string }[] };
    expect(lastBody.messages[1].content).toContain('<recent_exchange>');
    expect(lastBody.messages[1].content).toContain('greatest strengths');
    expect((lastBody.messages[1].content.match(/candidate_facts/g) ?? []).length).toBeGreaterThan(0);
    // The full résumé is never sent: only compact, retrieved facts.
    expect(lastBody.messages[1].content.length).toBeLessThan(RESUME_TEXT.length * 3);
    expect(lastBody.messages[1].content).not.toContain('linkedin.com');

    expect((await app.call('live.snapshot'))?.running).toBe(true);
    const ended = await app.call('live.stop');
    expect(ended?.stats?.turns).toBeGreaterThanOrEqual(3);
  });

  it('is browsable in history: transcript, answers, search, notes, feedback, deletion', async () => {
    const detail = await app.call('sessions.get', { id: sessionId });
    expect(detail.answers.length).toBeGreaterThanOrEqual(3);
    expect(detail.transcript.map((t) => t.text)).toContain('What are your greatest strengths?');
    const hits = await app.call('sessions.list', { search: 'strengths' });
    expect(hits.map((h) => h.id)).toContain(sessionId);
    expect((await app.call('sessions.list', { search: 'zebra' })).length).toBe(0);
    await app.call('sessions.notes', { id: sessionId, notes: 'Went well; mention the dashboard next time.' });
    expect((await app.call('sessions.list', { search: 'dashboard' })).map((h) => h.id)).toContain(sessionId);
    const a = detail.answers.find((x) => x.source === 'live')!;
    await app.call('answers.feedback', { id: a.id, tags: ['too-long', 'useful'] });
    await app.call('answers.edit', { id: a.id, text: 'Edited answer.' });
    const after = await app.call('sessions.get', { id: sessionId });
    const edited = after.answers.find((x) => x.id === a.id)!;
    expect(edited.feedback).toEqual(['too-long', 'useful']);
    expect(edited.edited).toBe(true);
    await app.call('sessions.delete', { id: sessionId });
    await expect(app.call('sessions.get', { id: sessionId })).rejects.toThrow(/not found/i);
    expect((await app.call('sessions.list', { search: 'strengths' })).map((h) => h.id)).not.toContain(sessionId);
  });
});

describe('live session (audio → cloud STT → VAD → speculative answer)', () => {
  beforeAll(async () => {
    await app.call('settings.update', { stt: { provider: 'deepgram' } }); // the cloud path is opt-in: the default is the on-device engine
  });
  afterAll(async () => {
    await app.call('settings.update', { stt: { provider: 'local' } });
  });

  it('requires consent before any audio is captured', async () => {
    await expect(app.call('live.start', { interviewId, audio: true })).rejects.toThrow(/accept the audio/i);
  });

  it('reports a missing speech key instead of pretending to listen', async () => {
    await app.call('settings.update', { live: { consentAcceptedAt: Date.now() }, audio: { interviewerSource: 'mic' } });
    const r = await app.call('live.start', { interviewId, audio: true });
    expect(r.sttConfigured).toBe(false);
    expect(r.sources).toEqual([]);
    expect(r.notices[0]).toMatch(/API key/);
    expect(r.notices[0]).toMatch(/free on-device speech engine/); // the way out is the free option, not another paid one
    await app.call('live.stop');
  });

  it('answers speculatively before the interviewer finishes, then confirms; nothing is sent while paused', async () => {
    llm.reset();
    llm.openai.dynamic = respond;
    llm.openai.firstTokenDelayMs = 40;
    stt.reset();
    const key = await app.call('stt.setKey', { provider: 'deepgram', apiKey: 'dg-test-key-123456' });
    expect(key.keySource).toBe('stored');
    expect(JSON.stringify(key)).not.toContain('dg-test-key');
    const test = await app.call('stt.test', { provider: 'deepgram' });
    expect(test.ok).toBe(true);
    stt.reset();

    const start = await app.call('live.start', { interviewId, audio: true });
    expect(start.sources).toEqual(['mic']);
    const c = await stt.waitConn(1, 4000);
    expect(c.headers.authorization).toBe('Token dg-test-key-123456');
    const from = liveEvents().length;
    const feed = (ms: number, amp: number) => {
      for (let t = 0; t < ms; t += 20) app.services.live.audio('mic', pcm(20, amp));
    };

    feed(600, 0);
    feed(900, 6000); // the interviewer speaks
    stt.dgResult(c, 'can you tell me about your experience managing a team?'); // partial result with a complete question
    await until(() => liveEvents().slice(from).some((e) => e.type === 'answer-start'), 4000);
    const started = liveEvents().slice(from).find((e) => e.type === 'answer-start') as Extract<LiveEvent, { type: 'answer-start' }>;
    expect(started.speculative).toBe(true); // started while the interviewer may still be talking

    feed(700, 0); // silence → local VAD ends the speech and asks the provider to finalize
    await until(() => c.controls.some((m) => m.includes('Finalize')), 3000);
    stt.dgResult(c, 'Can you tell me about your experience managing a team?', { final: true, speechFinal: true });
    await until(() => liveEvents().slice(from).some((e) => e.type === 'answer-done'), 5000);
    await until(() => liveEvents().slice(from).some((e) => e.type === 'answer-confirmed'), 3000);
    const done = liveEvents().slice(from).find((e) => e.type === 'answer-done') as Extract<LiveEvent, { type: 'answer-done' }>;
    expect(done.latency.speculative).toBe(true);
    expect(done.latency.ttftMs).toBeGreaterThan(0);
    expect(done.latency.perceivedMs).toBeDefined();
    expect(llm.requests.filter((r) => r.path.includes('/chat/completions') && (r.body as { stream?: boolean }).stream).length).toBe(1); // confirmed, not restarted

    // Pausing stops audio leaving the device.
    const bytes = c.audioBytes;
    await app.call('live.pause', { paused: true });
    feed(400, 6000);
    await wait(80);
    expect(c.audioBytes).toBe(bytes);
    await app.call('live.pause', { paused: false });
    const dbg = await app.call('live.debug');
    expect(dbg?.audio[0]?.name).toBe('mic');
    expect(dbg?.sttStates[0]?.state).toBe('connected');
    await app.call('live.stop');
  });

  it('tags voices from provider diarization only when asked for (single microphone)', async () => {
    llm.reset();
    llm.openai.dynamic = respond;
    const run = async (diarize: boolean) => {
      stt.reset();
      await app.call('settings.update', { stt: { diarize } });
      const from = liveEvents().length;
      await app.call('live.start', { interviewId, audio: true });
      const c = await stt.waitConn(1, 4000);
      stt.dgResult(c, 'so tell me a little about the team', { speaker: 1 });
      await until(() => liveEvents().slice(from).some((e) => e.type === 'transcript'), 3000);
      const t = liveEvents().slice(from).find((e) => e.type === 'transcript') as Extract<LiveEvent, { type: 'transcript' }>;
      await app.call('live.stop');
      return { url: c.url, label: t.label, speaker: t.speaker };
    };
    const on = await run(true);
    expect(on.url).toContain('diarize=true');
    expect(on.label).toBe('Speaker 2');
    expect(on.speaker).toBe('unknown'); // a tag is a hint; the engine never treats it as identity
    const off = await run(false);
    expect(off.url).not.toContain('diarize');
    expect(off.label).toBeUndefined();
  });
});

describe('live session on this PC (audio → on-device speech → VAD → answer)', () => {
  const question = 'tell me about a time you managed a team of engineers'.split(' ');
  const speak = (ms: number) => {
    for (let t = 0; t < ms; t += 20) app.services.live.audio('mic', pcm(20, 6000));
  };
  const silence = (ms: number) => {
    for (let t = 0; t < ms; t += 20) app.services.live.audio('mic', pcm(20, 0));
  };
  const transcripts = (from: number) => liveEvents().slice(from).filter((e): e is Extract<LiveEvent, { type: 'transcript' }> => e.type === 'transcript');
  /** Each test scripts its own "native library"; the loaded engine is kept between sessions, so start from a clean one. */
  const freshEngine = async (words: string[] = question, extra: { endpointSamples?: number } = {}) => {
    await app.services.stt.local.unload();
    makeWorker = () => inProcessWorker(() => fakeSherpa({ words, chunkSamples: 640, ...extra }));
  };
  const sttStates = (from: number) => liveEvents().slice(from).filter((e): e is Extract<LiveEvent, { type: 'stt' }> => e.type === 'stt').map((e) => e.status);

  beforeAll(async () => {
    llm.reset();
    llm.openai.dynamic = respond;
    // The default engine, the light model (writes ALL CAPS, which the app sentence-cases), no key anywhere.
    await app.call('settings.update', { stt: { provider: 'local', localModel: 'light', fallbackProvider: 'none' }, live: { consentAcceptedAt: Date.now() }, audio: { interviewerSource: 'mic' } });
  });

  it('is the default speech engine and needs no key, account or network', async () => {
    const fresh = makeApp();
    try {
      expect((await fresh.call('settings.get')).stt).toMatchObject({ provider: 'local', fallbackProvider: 'none', localModel: 'auto' });
      expect(await fresh.call('stt.keys')).toEqual([expect.objectContaining({ provider: 'deepgram', keySource: 'none' }), expect.objectContaining({ provider: 'assemblyai', keySource: 'none' })]);
    } finally {
      await fresh.close();
    }
  });

  it('starts listening without any speech key, and says which engine is doing the work', async () => {
    await freshEngine(question, { endpointSamples: 16000 * 5 });
    const from = liveEvents().length;
    const r = await app.call('live.start', { interviewId, audio: true });
    expect(r.sttConfigured).toBe(true);
    expect(r.sources).toEqual(['mic']);
    expect(r.notices).toEqual([]);
    await until(() => sttStates(from).some((s) => s.state === 'connected'));
    expect(sttStates(from).every((s) => s.provider === 'local')).toBe(true);
    const status = await app.call('stt.localStatus');
    expect(status).toMatchObject({ state: 'ready', openStreams: 1, tier: 'light' });
    await app.call('live.stop');
    expect((await app.call('stt.localStatus')).openStreams).toBe(0);
  });

  it('shows words as they are spoken, then answers as soon as the interviewer stops', async () => {
    await freshEngine(question, { endpointSamples: 16000 * 5 });
    const from = liveEvents().length;
    await app.call('live.start', { interviewId, audio: true });
    await until(() => sttStates(from).some((s) => s.state === 'connected'));

    silence(600);
    speak(900); // the interviewer asks
    await until(() => transcripts(from).some((t) => !t.isFinal && /^Tell me about a time/.test(t.text)), 3000);
    const partials = transcripts(from).filter((t) => !t.isFinal).map((t) => t.text);
    expect(partials.length).toBeGreaterThanOrEqual(3); // a running transcript, one growing line
    expect(partials[0]).toMatch(/^Tell/);
    for (let i = 1; i < partials.length; i++) expect(partials[i].length).toBeGreaterThanOrEqual(partials[i - 1].length);

    silence(700); // the interviewer stops: local VAD ends the speech and asks the engine to flush
    await until(() => transcripts(from).some((t) => t.isFinal), 3000);
    expect(transcripts(from).find((t) => t.isFinal)!.text).toBe('Tell me about a time you managed a team of engineers.');
    await until(() => liveEvents().slice(from).some((e) => e.type === 'answer-done'), 5000);
    const done = liveEvents().slice(from).find((e) => e.type === 'answer-done') as Extract<LiveEvent, { type: 'answer-done' }>;
    expect(done.latency.ttftMs).toBeGreaterThan(0);
    expect(llm.requests.filter((q) => q.path.includes('/chat/completions') && (q.body as { stream?: boolean }).stream).length).toBeGreaterThanOrEqual(1);
    await app.call('live.stop');
  });

  it('sends nothing to the engine while paused', async () => {
    let worker: InProcessWorker | null = null;
    await app.services.stt.local.unload();
    makeWorker = () => (worker = inProcessWorker(() => fakeSherpa({ words: question, chunkSamples: 640 })));
    const from = liveEvents().length;
    await app.call('live.start', { interviewId, audio: true });
    await until(() => sttStates(from).some((s) => s.state === 'connected'));
    speak(200);
    await wait(30);
    const before = worker!.received.filter((m) => m.t === 'audio').length;
    expect(before).toBeGreaterThan(0);
    await app.call('live.pause', { paused: true });
    speak(400);
    await wait(60);
    expect(worker!.received.filter((m) => m.t === 'audio').length).toBe(before);
    await app.call('live.stop');
  });

  it('a model that is not installed is reported plainly, with no pretend listening', async () => {
    modelsInstalled = false;
    try {
      const r = await app.call('live.start', { interviewId, audio: true });
      expect(r.sttConfigured).toBe(false);
      expect(r.sources).toEqual([]);
      expect(r.notices[0]).toMatch(/not installed/);
      expect(r.notices[0]).toMatch(/you can still type questions/);
      expect((await app.call('stt.localStatus')).openStreams).toBe(0); // nothing was started
      expect((await app.call('stt.test', { provider: 'local' })).error).toMatch(/not installed|sample is missing/);
      await app.call('live.stop');
    } finally {
      modelsInstalled = true;
    }
  });

  it('uses the configured cloud fallback when the on-device model is missing, and says so', async () => {
    stt.reset();
    await app.call('stt.setKey', { provider: 'deepgram', apiKey: 'dg-fallback-key-123456' });
    await app.call('settings.update', { stt: { fallbackProvider: 'deepgram' } });
    modelsInstalled = false;
    try {
      const from = liveEvents().length;
      const r = await app.call('live.start', { interviewId, audio: true });
      expect(r.sttConfigured).toBe(true);
      expect(r.notices[0]).toMatch(/The on-device speech engine is unavailable/);
      expect(r.notices[0]).toMatch(/Using Deepgram instead/);
      const c = await stt.waitConn(1, 4000);
      expect(c.headers.authorization).toBe('Token dg-fallback-key-123456');
      await until(() => sttStates(from).some((s) => s.provider === 'deepgram' && s.state === 'connected'));
      expect((await app.call('live.debug'))?.sttStates[0]?.provider).toBe('deepgram');
      await app.call('live.stop');
    } finally {
      modelsInstalled = true;
      await app.call('stt.clearKey', { provider: 'deepgram' });
      await app.call('settings.update', { stt: { fallbackProvider: 'none' } });
    }
  });

  it('never falls back to a cloud service that has no key', async () => {
    await app.call('settings.update', { stt: { fallbackProvider: 'deepgram' } }); // chosen, but no key stored
    modelsInstalled = false;
    try {
      const r = await app.call('live.start', { interviewId, audio: true });
      expect(r.sttConfigured).toBe(false);
      expect(r.notices[0]).toMatch(/not installed/);
      await app.call('live.stop');
    } finally {
      modelsInstalled = true;
      await app.call('settings.update', { stt: { fallbackProvider: 'none' } });
    }
  });

  it('a speech engine that dies mid-session recovers by itself and keeps transcribing', async () => {
    const workers: InProcessWorker[] = [];
    await app.services.stt.local.unload();
    makeWorker = () => {
      const w = inProcessWorker(() => fakeSherpa({ words: question, chunkSamples: 640, endpointSamples: 16000 * 5 }));
      workers.push(w);
      return w;
    };
    const from = liveEvents().length;
    await app.call('live.start', { interviewId, audio: true });
    await until(() => sttStates(from).some((s) => s.state === 'connected'));
    workers[0].crash('native crash');
    await until(() => sttStates(from).some((s) => s.state === 'reconnecting'), 3000);
    await until(() => workers.length === 2 && sttStates(from).filter((s) => s.state === 'connected').length >= 2, 6000);
    const before = transcripts(from).length;
    speak(500);
    await until(() => transcripts(from).length > before, 3000); // words flow again through the new engine
    await app.call('live.stop');
  }, 15_000);

  it('the built-in test transcribes its sample through the same path (no microphone)', async () => {
    // A tiny WAV standing in for the sample; the scripted library "hears" the reference sentence.
    const dir = mkdtempSync(join(tmpdir(), 'candor-sample-'));
    try {
      const data = new Int16Array(16000).fill(3000);
      const bytes = new Uint8Array(data.buffer);
      const h = new DataView(new ArrayBuffer(44));
      const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); h.setUint32(4, 36 + bytes.length, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
      h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, bytes.length, true);
      const file = new Uint8Array(44 + bytes.length);
      file.set(new Uint8Array(h.buffer), 0);
      file.set(bytes, 44);
      writeFileSync(join(dir, 'selftest.wav'), file);
      writeFileSync(join(modelRoot, 'selftest.wav'), file); // the app looks for it next to the models
      await freshEngine('after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels'.split(' '));
      const result = await app.call('stt.test', { provider: 'local' });
      expect(result.ok, result.error).toBe(true);
      expect(result.detail).toMatch(/Heard: “After early nightfall/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('mock interview', () => {
  it('asks questions, evaluates answers with measured statistics, and summarises', async () => {
    const events: MockEvent[] = [];
    void events;
    const { sessionId, question } = await app.call('mock.start', { interviewId, questionCount: 2, kind: 'mock' });
    expect(question).toMatch(/improved a process/);
    const t1 = await app.call('mock.answer', { sessionId, answer: 'Um, so I noticed the returns queue was slow. I mapped the process, removed two approval steps and handling time fell by 22% in a month.', durationMs: 20_000 });
    expect(t1.turn.metrics.words).toBeGreaterThan(20);
    expect(t1.turn.metrics.fillers).toBeGreaterThanOrEqual(1);
    expect(t1.turn.metrics.hasNumbers).toBe(true);
    expect(t1.turn.metrics.wordsPerMinute).toBeGreaterThan(0);
    expect(t1.turn.evaluation?.relevance.level).toBe('strong');
    expect(t1.next).toBeTruthy();
    const t2 = await app.call('mock.answer', { sessionId, answer: 'I would start by understanding the customer and the root cause before deciding anything.', durationMs: null });
    expect(t2.next).toBeNull();
    const sum = await app.call('mock.finish', { sessionId });
    expect(sum.turns).toHaveLength(2);
    expect(sum.tally.relevance.strong).toBe(2);
    // Stored with history, including the evaluation.
    const detail = await app.call('sessions.get', { id: sessionId });
    expect(detail.answers.every((a) => a.source === 'mock' && a.mock)).toBe(true);
    expect((await app.call('mock.summary', { sessionId }))?.turns).toHaveLength(2);
  });

  it('still measures the answer when no model is available for evaluation', async () => {
    const saved = await app.call('settings.get');
    await app.call('settings.update', { routing: { live: { primary: null, fallback: null }, prep: { primary: null, fallback: null }, mock: { primary: null, fallback: null }, classify: { primary: null, fallback: null } } });
    const { sessionId } = await app.call('mock.start', { interviewId, questionCount: 1, kind: 'mock' });
    const t = await app.call('mock.answer', { sessionId, answer: 'I would investigate the root cause and then fix the process.', durationMs: 8000 });
    expect(t.turn.evaluation).toBeNull();
    expect(t.turn.evaluationError).toMatch(/No AI model/);
    expect(t.turn.metrics.words).toBeGreaterThan(5);
    await app.call('settings.update', { routing: saved.routing });
  });
});

describe('story bank, question bank, benchmark', () => {
  it('saves stories that are retrieved for matching questions', async () => {
    const draft = await app.call('stories.assist', { notes: 'Returns queue was slow, I removed two approval steps and handling time fell 22%.' });
    expect(draft.result).toMatch(/22%/);
    const story = await app.call('stories.save', { ...draft, title: 'Returns redesign' });
    expect((await app.call('stories.list')).map((s) => s.id)).toContain(story.id);
    llm.reset();
    llm.openai.dynamic = respond;
    await app.call('live.start', { interviewId, audio: false });
    await app.call('live.question', { text: 'Tell me about a time you improved a process with a measurable result.', mode: 'concise' });
    await until(() => liveEvents().some((e) => e.type === 'answer-done' && (e as { text: string }).text.length > 0));
    const body = llm.requests.filter((r) => r.path.includes('/chat/completions')).at(-1)?.body as { messages: { content: string }[] } | undefined;
    if (body) expect(body.messages[1].content).toContain('Returns redesign');
    await app.call('live.stop');
    await app.call('stories.delete', { id: story.id });
  });

  it('favourites and filters questions', async () => {
    const [first] = await app.call('questions.list', { category: 'behavioral' });
    const fav = await app.call('questions.favorite', { id: first.id });
    expect(fav?.favorite).toBe(true);
    expect((await app.call('questions.list', { favorite: true })).map((q) => q.id)).toContain(first.id);
    expect((await app.call('questions.list', { search: 'tight deadline' })).length).toBeGreaterThan(0);
    const added = await app.call('questions.add', { text: 'How would you handle a warehouse strike?', category: 'operations' });
    expect(added.length).toBeGreaterThan(0);
  });

  it('benchmarks the real pipeline and reports median / p90 / p95 from measured runs', async () => {
    llm.reset();
    llm.openai.dynamic = respond;
    llm.openai.firstTokenDelayMs = 30;
    llm.openai.tokenDelayMs = 2;
    const r = await app.call('bench.run', { runs: 5, mode: 'concise' });
    expect(r.runs).toHaveLength(5);
    expect(r.failures).toBe(0);
    expect(r.ttft.count).toBe(5);
    expect(r.ttft.median).toBeGreaterThanOrEqual(30);
    expect(r.ttft.median).toBeLessThan(400);
    expect(r.ttft.p95!).toBeGreaterThanOrEqual(r.ttft.median!);
    expect(r.total.median!).toBeGreaterThanOrEqual(r.ttft.median!);
    expect(r.notes.join(' ')).toMatch(/excluded from the statistics/);
    expect((await app.call('bench.history'))[0]?.id).toBe(r.id);
    expect(app.events('bench.progress').length).toBeGreaterThanOrEqual(5);
  });

  it('reports failures honestly in the benchmark', async () => {
    llm.reset();
    llm.openai.status = 500;
    llm.openai.failCount = 999;
    const r = await app.call('bench.run', { runs: 2, mode: 'concise' });
    expect(r.failures).toBe(2);
    expect(r.ttft.count).toBe(0);
    expect(r.ttft.median).toBeNull(); // no fabricated numbers
    llm.reset();
    llm.openai.dynamic = respond;
  });
});

describe('privacy: export and purge', () => {
  it('exports data without secrets, then purges everything', async () => {
    const out = await app.call('data.export');
    expect(out?.path).toContain('candor-export-');
    const text = app.files.at(-1)!.contents;
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('dg-test-key');
    expect(text).not.toMatch(/"ciphertext"/);
    const parsed = JSON.parse(text) as { data: Record<string, unknown[]> };
    expect(parsed.data.resumes.length).toBeGreaterThan(0);
    expect(parsed.data.secrets).toBeUndefined();

    const before = await app.call('data.storage');
    expect(before.counts.interviews).toBeGreaterThan(0);
    await app.call('data.purge', { scope: 'all' });
    const after = await app.call('data.storage');
    expect(after.counts).toEqual({ interviews: 0, liveSessions: 0, mockSessions: 0, stories: 0, answers: 0 });
    expect(await app.call('resumes.list')).toHaveLength(0);
    expect(await app.call('providers.list')).toHaveLength(0);
    expect(app.services.db.all('SELECT * FROM secrets')).toHaveLength(0);
    expect((await app.call('stt.keys')).every((k) => k.keySource === 'none')).toBe(true);
  });
});
