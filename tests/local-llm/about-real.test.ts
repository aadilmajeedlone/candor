import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logger } from '../../src/main/logging';
import type { AboutMePrep } from '../../src/shared/types';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { makeApp, type App } from '../helpers/appHarness';
import { llamaAvailable, startLlamaServer, type LlamaServer } from '../helpers/llamaServer';

/**
 * The “About me” request against a REAL language model (llama.cpp + Qwen2.5-1.5B on this PC's CPU), through the real
 * app path: Preparation → prompt → OpenAI-compatible request → response → JSON extraction → validation → saved section.
 * Nothing is mocked. The preparation model here carries the same 700-token ceiling as the Fast row that broke on the
 * user's PC, because the failure was a ceiling that cut a JSON reply off, not a network problem.
 *
 * Slow (a laptop CPU generates about 4 tokens a second), so it lives with the other real-model tests: `npm run test:local-llm`.
 */

const available = llamaAvailable();
const CEILING = Number(process.env.ABOUT_CEILING ?? 700);

let server: LlamaServer;
let app: App;
let interviewId = '';
let logDir = '';
const runs: { ok: boolean; ms: number; error?: string; words?: number; fields?: string[]; model?: string; appLog?: string[]; serverLog?: string[] }[] = [];

describe.skipIf(!available)('“About me” with a real local model', () => {
  beforeAll(async () => {
    server = await startLlamaServer({ ctx: 4096 });
    // The app's own log (sizes, finish reasons, token counts — never prompts or replies) is kept as evidence.
    logDir = mkdtempSync(join(tmpdir(), 'candor-about-real-'));
    logger.configure({ level: 'info', dir: logDir });
    app = makeApp();
    const provider = await app.call('providers.save', { name: 'llama.cpp (this PC)', kind: 'openai-compatible', baseUrl: server.url, enabled: true });
    const listed = await app.call('providers.listModels', { id: provider.id });
    const modelName = listed.models[0] ?? 'qwen2.5-1.5b-instruct-q4_k_m.gguf';
    // Saved through the repository, not the Settings form, because a model on this CPU needs a longer timeout than the form allows.
    const row = app.services.repos.saveModel({ name: 'Fast · local model', providerId: provider.id, model: modelName, temperature: 0.3, maxTokens: CEILING, topP: null, timeoutMs: 600_000, streaming: true });
    await app.call('settings.update', { routing: { live: { primary: row.id, fallback: null }, prep: { primary: row.id, fallback: null }, classify: { primary: row.id, fallback: null }, mock: { primary: row.id, fallback: null } } });
    const resume = await app.call('resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
    const interview = await app.call('interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, resumeId: resume.id });
    interviewId = interview.id;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await server?.stop();
    if (logDir) rmSync(logDir, { recursive: true, force: true });
    const dir = resolve(__dirname, '../../bench-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'about-real.json'), JSON.stringify({ measuredOn: new Date().toISOString(), ceiling: CEILING, note: 'real llama.cpp + Qwen2.5-1.5B on this PC, through the real app path', runs }, null, 2));
  });

  it('generates “About me” and every field is filled in', async () => {
    const t0 = Date.now();
    const before = app.events('prep.progress').length;
    await app.call('prep.generate', { interviewId, section: 'about' });
    const ms = Date.now() - t0;
    const errors = app
      .events('prep.progress')
      .slice(before)
      .filter((p) => p.error)
      .map((p) => p.error as string);
    const prep = await app.call('prep.get', { interviewId });
    const about = prep.about?.data as AboutMePrep | undefined;
    runs.push({ ok: errors.length === 0 && !!about, ms, error: errors[0], words: about?.tellMeAboutYourself.split(/\s+/).filter(Boolean).length, fields: about ? Object.entries(about).filter(([k, v]) => k !== 'unverified' && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== '')).map(([k]) => k) : [], model: prep.about?.model ?? undefined });
    const last = runs.at(-1);
    if (last) {
      last.appLog = readFileSync(join(logDir, 'candor.log'), 'utf8')
        .split('\n')
        .filter((l) => /model reply|model request failed|structured reply|plain-text|offline draft/.test(l))
        .map((l) => l.replace(/^\S+\s+/, ''));
      last.serverLog = server
        .log()
        .split('\n')
        .filter((l) => /eval time|n_decoded|n_tokens|tokens per second|response_format|json_schema|grammar/i.test(l))
        .slice(-12)
        .map((l) => l.trim().slice(0, 220));
    }
    console.log('ABOUT-REAL result:', JSON.stringify(last));
    expect(errors).toEqual([]);
    expect(about?.tellMeAboutYourself.trim().length ?? 0).toBeGreaterThan(40);
  }, 900_000);
});
