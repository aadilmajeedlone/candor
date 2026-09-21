import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { detectQuestion } from '@core/question/detector';
import { buildAnswerPrompt, buildInterviewContext, retrieveForQuestion } from '@core/live/context';
import { LiveEngine, type EngineSettings } from '@core/live/engine';
import type { LlmGateway, LlmGenerateRequest, LlmGenerateResult } from '@core/live/types';
import { EnergyVad, VAD_FRAME_SAMPLES } from '@core/vad/vad';
import { percentile } from '@shared/util';
import { GoogleAdc } from '../../src/main/ai/googleAuth';
import { SAMPLE_STORIES } from '../fixtures/facts';
import { MockTokenServer } from '../helpers/mockTokenServer';
import { sampleInterview, sampleProfile, sampleResume } from '../fixtures/profile';

/**
 * Local-overhead benchmark. Everything measured here runs on this machine, in this process, with the real code:
 * no network, no model, no fake numbers. The network + model time (which dominates real latency) is measured
 * separately, against your own provider, by Settings → Performance → "Run benchmark".
 */

const QUESTIONS = [
  'Tell me about yourself.',
  'Can you walk me through your experience managing a team?',
  'Describe a time you handled a difficult stakeholder.',
  'What is your biggest weakness?',
  'Why do you want to work here?',
  'How do you prioritise when everything is urgent?',
  'Tell me about a time you improved a process.',
  'What experience do you have with SQL and dashboards?',
  'Where do you see yourself in five years?',
  'How would you handle an escalated customer complaint?',
  'What was the outcome, and what would you do differently?',
  'Walk me through how you would reduce handling time in a support team.',
  'Do you have experience with Power BI?',
  'Tell me about a time you failed.',
  'How do you motivate an underperforming agent?',
  'What are your salary expectations?',
];

const STATEMENTS = ['So thanks for joining us today.', 'We are a team of about forty people here.', 'Let me share my screen for a second.', 'Great, that is helpful.'];

function stats(samplesMs: number[]) {
  const s = [...samplesMs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: (percentile(s, 50) ?? 0),
    p90: (percentile(s, 90) ?? 0),
    p95: (percentile(s, 95) ?? 0),
    p99: (percentile(s, 99) ?? 0),
    max: s[s.length - 1] ?? 0,
  };
}
type Stats = ReturnType<typeof stats>;
const fmt = (n: number): string => (n < 1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(1)).padStart(8);

/** Time `fn` for `reps` repetitions after a warm-up, returning per-call milliseconds. */
function timeIt(reps: number, fn: (i: number) => void, warmup = 50): number[] {
  for (let i = 0; i < warmup; i++) fn(i);
  const out: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn(i);
    out.push(performance.now() - t0);
  }
  return out;
}

/** An LLM that answers instantly, so the engine's own overhead is what gets measured. */
class InstantLlm implements LlmGateway {
  warm(): Promise<void> {
    return Promise.resolve();
  }
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const text = 'In my role at Northwind I managed a team of 14 agents and cut handling time by 22%.';
    req.onToken?.('In my role at Northwind ');
    req.onToken?.('I managed a team of 14 agents and cut handling time by 22%.');
    return Promise.resolve({ text, finishReason: 'stop', model: 'instant', provider: 'instant', usedFallback: false });
  }
}

function makeContext() {
  return buildInterviewContext({
    interview: sampleInterview(),
    resume: sampleResume(),
    profile: sampleProfile(),
    stories: SAMPLE_STORIES.map((s) => ({ id: s.id, title: s.title, situation: s.text, task: 'task', action: 'action', result: 'result', skills: [], roles: [], tags: [], createdAt: 1, updatedAt: 1 })),
  });
}

const rows: { stage: string; note: string; s: Stats }[] = [];

describe('local pipeline overhead (measured on this machine)', () => {
  const ctx = makeContext();

  it('voice-activity detection per 20 ms audio frame', () => {
    const vad = new EnergyVad('medium');
    const frame = new Int16Array(VAD_FRAME_SAMPLES);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
    const s = stats(timeIt(5000, () => vad.push(frame), 500));
    rows.push({ stage: 'VAD, per 20 ms frame', note: 'runs for every frame of audio', s });
    expect(s.p95).toBeLessThan(2);
  });

  it('question detection on a partial transcript', () => {
    const all = [...QUESTIONS, ...STATEMENTS];
    const s = stats(timeIt(3000, (i) => detectQuestion(all[i % all.length], {}), 200));
    rows.push({ stage: 'question detection', note: 'runs on every transcript update', s });
    expect(s.p95).toBeLessThan(5);
  });

  it('local retrieval (BM25 + hashed embeddings + coverage) over the candidate corpus', () => {
    const s = stats(timeIt(2000, (i) => retrieveForQuestion(ctx, QUESTIONS[i % QUESTIONS.length], { mode: 'standard', kind: 'behavioral' }), 100));
    rows.push({ stage: 'retrieval', note: `${ctx.index.size} chunks, top facts + story`, s });
    expect(s.p95).toBeLessThan(25);
  });

  it('local retrieval as the corpus grows (synthetic 400-fact résumé)', () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const verbs = ['Led', 'Built', 'Reduced', 'Automated', 'Coordinated', 'Negotiated', 'Redesigned', 'Mentored', 'Forecasted', 'Audited', 'Launched', 'Resolved'];
    const objects = ['the returns workflow', 'a weekly KPI dashboard', 'vendor contracts', 'the onboarding programme', 'quarterly staffing forecasts', 'an escalation playbook', 'the QA scorecard', 'a ticketing migration', 'the billing reconciliation', 'a cross-team roadmap'];
    const tails = ['cutting handling time by 18%', 'across 6 client accounts', 'for a 40-person operation', 'saving 12 hours a week', 'while holding SLA at 96%', 'with engineering and product', 'using SQL and Power BI', 'after a peak-season surge'];
    const base = sampleResume();
    const facts = Array.from({ length: 400 }, (_, i) => ({ id: `syn${i}`, kind: 'achievement' as const, text: `${pick(verbs)} ${pick(objects)} ${pick(tails)} in ${2015 + (i % 10)}`, source: 'resume' as const, label: 'Synthetic', evidence: '', tags: [] }));
    const big = buildInterviewContext({ interview: sampleInterview(), resume: { ...base, facts: [...base.facts, ...facts] }, profile: sampleProfile(), stories: [] });
    const s = stats(timeIt(1000, (i) => retrieveForQuestion(big, QUESTIONS[i % QUESTIONS.length], { mode: 'standard', kind: 'behavioral' }), 50));
    rows.push({ stage: 'retrieval, larger corpus', note: `${big.index.size} chunks (synthetic, ~12 words each)`, s });
    expect(s.p95).toBeLessThan(50);
  });

  it('prompt assembly', () => {
    const retrieved = QUESTIONS.map((q) => retrieveForQuestion(ctx, q, { mode: 'standard', kind: 'behavioral' }));
    const s = stats(timeIt(2000, (i) => buildAnswerPrompt({ ctx, question: QUESTIONS[i % QUESTIONS.length], kind: 'behavioral', mode: 'standard', isFollowUp: false, retrieved: retrieved[i % retrieved.length], previous: [] }), 100));
    rows.push({ stage: 'prompt assembly', note: 'static profile first, so provider prefix caching applies', s });
    expect(s.p95).toBeLessThan(5);
  });

  it('Google sign-in (ADC): authorization headers for a request, token already cached', async () => {
    const tokens = await new MockTokenServer().start();
    try {
      const adc = new GoogleAdc({ env: {}, createAuth: () => new GoogleAuth({ authClient: new UserRefreshClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r', quotaProjectId: 'p', endpoints: { oauth2TokenUrl: tokens.url } }) }) });
      const cfg = { mode: 'adc' as const, backend: 'vertex' as const, project: 'p', location: 'global' };
      const url = 'https://aiplatform.googleapis.com/v1/x';
      await adc.headers(cfg, url); // the single token exchange (repeated about once an hour, off the hot path)
      const samples: number[] = [];
      for (let i = 0; i < 2500; i++) {
        const t0 = performance.now();
        await adc.headers(cfg, url);
        samples.push(performance.now() - t0);
      }
      const s = stats(samples.slice(200));
      rows.push({ stage: 'Google sign-in: auth headers', note: 'per request; token cached (one exchange per ~hour)', s });
      expect(tokens.bodies).toHaveLength(1);
      expect(s.p95).toBeLessThan(5);
    } finally {
      await tokens.stop();
    }
  });

  it('engine: question in → model request out → first token painted (instant model)', async () => {
    const settings: EngineSettings = { mode: 'standard', speculation: 'balanced', autoAnswer: true, answerHoldMs: 0, storeAnswers: false, storeTranscripts: false, prewarm: false };
    const events: LiveEvent[] = [];
    const engine = new LiveEngine({
      llm: new InstantLlm(),
      getContext: () => ctx,
      settings: () => settings,
      emit: (e) => events.push(e),
      clock: () => performance.now(),
      persistence: { saveAnswer: () => 'a', saveTranscript: () => undefined, updateFeedback: () => undefined },
    });
    engine.start();
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      events.length = 0;
      // Distinct text each time so the answer cache is never what is being measured.
      const q = `${QUESTIONS[i % QUESTIONS.length].replace(/[.?]$/, '')} (variant ${i})?`;
      const t0 = performance.now();
      engine.submitQuestion(q, { bypassCache: true });
      // The first token is emitted synchronously from inside the model call; the rest settle on microtasks.
      while (!events.some((e) => e.type === 'answer-token')) await Promise.resolve();
      samples.push(performance.now() - t0);
      while (!events.some((e) => e.type === 'answer-done')) await Promise.resolve();
    }
    engine.stop();
    const s = stats(samples.slice(30));
    rows.push({ stage: 'engine, question → first token', note: 'detection + retrieval + prompt + dispatch, instant model', s });
    expect(s.p95).toBeLessThan(50);
  });

  it('prints the table', () => {
    const line = '-'.repeat(96);
    const out = [
      '',
      `Local pipeline overhead — ${new Date().toISOString().slice(0, 10)} — node ${process.version} — ${process.platform}/${process.arch}`,
      line,
      `${'stage'.padEnd(34)}${'n'.padStart(6)}${'p50'.padStart(9)}${'p90'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}   (ms)`,
      line,
      ...rows.map((r) => `${r.stage.padEnd(34)}${String(r.s.n).padStart(6)}${fmt(r.s.p50)}${fmt(r.s.p90)}${fmt(r.s.p95)}${fmt(r.s.p99)}${fmt(r.s.max)}   ${r.note}`),
      line,
      'Network and model time is not included: measure it against your provider in Settings → Performance.',
      '',
    ].join('\n');
    console.log(out);
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', 'bench-local.json'), JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, at: new Date().toISOString(), stages: rows }, null, 2));
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});
