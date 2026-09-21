import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '../../src/shared/events';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { makeApp, type App } from '../helpers/appHarness';
import { llamaAvailable, startLlamaServer, type LlamaServer } from '../helpers/llamaServer';

/**
 * Candor with a REAL language model and nothing mocked: llama.cpp's `llama-server` running Qwen2.5-1.5B-Instruct
 * (Apache-2.0) on this PC's CPU, reached over the same OpenAI-compatible HTTP API a friend's GPU, Ollama or LM Studio
 * would offer. Free, offline, no key. Skipped when the server binary or the model file is not in .model-cache/llm.
 *
 * What this proves: the provider path (listing, connection test, streaming, timeouts, error wording) against a real
 * server. What it measures: how long a laptop CPU really takes. It does not judge answer quality: a 1.5-billion
 * parameter model is a fallback for offline use, not a replacement for a large model.
 */

const available = llamaAvailable();
if (!available) console.warn('local-llm: llama-server or the model is missing in .model-cache/llm — skipping the real-model tests.');

let server: LlamaServer;
let app: App;
let interviewId = '';
let modelId = '';
const events = (): LiveEvent[] => app.events('live.event');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(100);
  }
}

interface Turn {
  question: string;
  ttftMs: number | null;
  totalMs: number;
  words: number;
  streamedTokens: number;
  text: string;
}
const measured: Turn[] = [];

async function ask(question: string): Promise<Turn> {
  const from = events().length;
  const t0 = Date.now();
  await app.call('live.question', { text: question });
  await until(() => events().slice(from).some((e) => e.type === 'answer-done' || (e.type === 'notice' && e.level === 'error')), 180_000);
  const fresh = events().slice(from);
  const failure = fresh.find((e) => e.type === 'notice' && e.level === 'error');
  if (failure && failure.type === 'notice') throw new Error(`the answer failed: ${failure.message}`);
  const done = fresh.find((e) => e.type === 'answer-done') as Extract<LiveEvent, { type: 'answer-done' }>;
  const tokens = fresh.filter((e) => e.type === 'answer-token');
  const words = done.text.trim().split(/\s+/).filter(Boolean).length;
  return {
    question,
    ttftMs: done.latency.ttftMs ?? null,
    totalMs: Math.round(done.latency.totalMs ?? Date.now() - t0),
    words,
    streamedTokens: tokens.length,
    text: done.text,
  };
}

describe.skipIf(!available)('a real local language model, end to end', () => {
  beforeAll(async () => {
    server = await startLlamaServer({ ctx: 4096 });
    app = makeApp();
    const resume = await app.call('resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
    const interview = await app.call('interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, resumeId: resume.id });
    interviewId = interview.id;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await server?.stop();
    const dir = resolve(__dirname, '../../bench-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'llm-local.json'),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          server: 'llama.cpp llama-server (official Windows CPU build), 4 decode threads, 8 prompt threads, 4096-token context',
          model: 'Qwen2.5-1.5B-Instruct Q4_K_M (Apache-2.0)',
          loadMs: server?.loadMs,
          turns: measured.map(({ text, ...t }) => ({ ...t, sample: text.slice(0, 160) })),
        },
        null,
        2,
      ),
    );
  });

  it('is reached like any OpenAI-compatible server: no key, models listed, connection test passes', async () => {
    const provider = await app.call('providers.save', { name: 'llama.cpp (this PC)', kind: 'openai-compatible', baseUrl: server.url, enabled: true });
    expect(provider).toMatchObject({ scope: 'this-pc', keyOptional: true, keySource: 'none' });
    const models = await app.call('providers.listModels', { id: provider.id });
    expect(models.ok, models.error).toBe(true);
    expect(models.models.length).toBeGreaterThan(0);
    modelId = models.models[0]!;
    // Quick setup on a local server gives the model time to answer (a laptop CPU is not a datacentre).
    const { live } = await app.call('models.quickSetup', { providerId: provider.id, fastModel: modelId, qualityModel: modelId });
    expect(live.timeoutMs).toBe(180_000);
    const test = await app.call('models.test', { id: live.id });
    expect(test.ok, test.error?.message).toBe(true);
    console.log(`LOCAL LLM: connection test first word after ${test.latencyMs} ms (model load ${server.loadMs} ms)`);
    const active = await app.call('app.activeProviders');
    expect(active.live.primary).toMatchObject({ provider: 'llama.cpp (this PC)', scope: 'this-pc' });
  });

  it('answers a typed question from the résumé, streaming, with the real model (cold, then warm prompt cache)', async () => {
    // Concise answers: on a laptop CPU the model streams about 4 tokens a second, so a long answer takes a minute.
    await app.call('settings.update', { defaultMode: 'concise' });
    await app.call('live.start', { interviewId, audio: false });
    const questions = ['Tell me about your experience managing a team.', 'How do you handle a difficult stakeholder?', 'What is your biggest strength?'];
    for (const q of questions) {
      const t = await ask(q);
      measured.push(t);
      console.log(`LOCAL LLM turn: ttft ${t.ttftMs} ms, total ${t.totalMs} ms, ${t.words} words, ${t.streamedTokens} stream events — ${t.text.slice(0, 90).replace(/\s+/g, ' ')}…`);
      expect(t.text.trim().length).toBeGreaterThan(20);
      expect(t.streamedTokens).toBeGreaterThan(3); // it streamed, not one block
      expect(t.ttftMs).not.toBeNull();
    }
    await app.call('live.stop');
  }, 600_000);

  it('a server that is stopped mid-session is reported plainly, and nothing else is used behind the scenes', async () => {
    await app.call('live.start', { interviewId, audio: false });
    await server.stop();
    const from = events().length;
    await app.call('live.question', { text: 'Why do you want this role?' });
    await until(() => events().slice(from).some((e) => e.type === 'notice' && e.level === 'error'), 60_000);
    const err = events().slice(from).find((e) => e.type === 'notice' && e.level === 'error') as Extract<LiveEvent, { type: 'notice' }>;
    expect(err.message).toMatch(/Could not connect to llama\.cpp \(this PC\) on this PC\. Is it running\?/);
    expect(err.code).toBe('network');
    await app.call('live.stop');
  }, 120_000);
});
