import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '@shared/errors';
import type { LiveEvent } from '@shared/events';
import { buildInterviewContext } from '@core/live/context';
import { LiveEngine, type EngineSettings } from '@core/live/engine';
import { FakeLlm } from '../helpers/fakeLlm';
import { sampleInterview, sampleProfile, sampleResume } from '../fixtures/profile';
import { SAMPLE_STORIES } from '../fixtures/facts';

const T = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function setup(over: Partial<EngineSettings> = {}) {
  const llm = new FakeLlm();
  const events: LiveEvent[] = [];
  const saved: unknown[] = [];
  const settings: EngineSettings = {
    mode: 'standard',
    speculation: 'balanced',
    autoAnswer: true,
    answerHoldMs: 6000,
    storeAnswers: true,
    storeTranscripts: true,
    prewarm: false,
    ...over,
  };
  const ctx = buildInterviewContext({
    interview: sampleInterview(),
    resume: sampleResume(),
    profile: sampleProfile(),
    stories: SAMPLE_STORIES.map((s) => ({
      id: s.id,
      title: s.title,
      situation: s.text.split('Task:')[0] ?? '',
      task: 'task',
      action: 'action',
      result: 'result',
      skills: [],
      roles: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    })),
  });
  const engine = new LiveEngine({
    llm,
    getContext: () => ctx,
    settings: () => settings,
    emit: (e) => events.push(e),
    clock: () => Date.now(),
    persistence: {
      saveAnswer: (r) => {
        saved.push(r);
        return `ans${saved.length}`;
      },
      saveTranscript: () => undefined,
      updateFeedback: () => undefined,
    },
  });
  engine.start();
  const of = <K extends LiveEvent['type']>(type: K) => events.filter((e): e is Extract<LiveEvent, { type: K }> => e.type === type);
  return { llm, events, engine, saved, settings, of };
}

describe('LiveEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers on the provider endpoint, streaming tokens and saving the result', async () => {
    const { engine, llm, of, saved } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'Tell me about a time you improved a process', isFinal: false });
    await T(1000);
    expect(llm.calls).toHaveLength(0); // speculation off: nothing until the endpoint
    engine.onTranscript({ source: 'interviewer', text: 'Tell me about a time you improved a process.', isFinal: true, speechFinal: true });
    expect(llm.calls).toHaveLength(1);
    await T(4000);
    expect(of('answer-token').length).toBeGreaterThan(5);
    const done = of('answer-done');
    expect(done).toHaveLength(1);
    expect(done[0].text).toContain('22%');
    expect(done[0].answerId).toBe('ans1');
    expect(saved).toHaveLength(1);
    expect(of('status').map((s) => s.status)).toEqual(expect.arrayContaining(['retrieving', 'generating', 'complete']));
  });

  it('starts speculatively once a complete question is stable, before the endpoint', async () => {
    const { engine, llm, of } = setup();
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: false });
    expect(llm.calls).toHaveLength(0);
    await T(500); // > stableMs
    expect(llm.calls).toHaveLength(1);
    expect(of('answer-start')[0].speculative).toBe(true);
    // Endpoint arrives with the same question: confirm, do not restart.
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: true, speechFinal: true });
    await T(4000);
    expect(llm.calls).toHaveLength(1);
    expect(of('answer-confirmed')).toHaveLength(1);
    expect(of('answer-cancelled')).toHaveLength(0);
    expect(of('answer-done')[0].answerId).toBe('ans1');
  });

  it('does not persist a speculative answer until it is confirmed', async () => {
    const { engine, saved } = setup();
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: false });
    await T(4000); // answer finished, still unconfirmed
    expect(saved).toHaveLength(0);
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: true, speechFinal: true });
    expect(saved).toHaveLength(1);
  });

  it('cancels and restarts when the question changes materially; stale tokens never reach the UI', async () => {
    const { engine, llm, of, events } = setup();
    llm.ignoreAbort = true; // the first request keeps "streaming" after being cancelled
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing teams?', isFinal: false });
    await T(500);
    expect(llm.calls).toHaveLength(1);
    const first = of('answer-start')[0].requestId;
    await T(100);
    engine.onTranscript({
      source: 'interviewer',
      text: 'Can you tell me about your experience managing teams? And how did you handle conflict inside a remote team during a reorganisation?',
      isFinal: false,
    });
    await T(500);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].signal.aborted).toBe(true);
    expect(of('answer-cancelled').map((c) => c.requestId)).toContain(first);
    await T(4000);
    const second = of('answer-start')[1].requestId;
    // Once the first request is cancelled, nothing more from it may reach the UI, even though the fake
    // provider kept streaming (ignoreAbort). Only the newest request may update the active answer.
    const cancelIdx = events.findIndex((e) => e.type === 'answer-cancelled' && e.requestId === first);
    expect(cancelIdx).toBeGreaterThan(-1);
    const staleAfterCancel = events.slice(cancelIdx + 1).filter((e) => 'requestId' in e && e.requestId === first && e.type !== 'answer-cancelled');
    expect(staleAfterCancel).toHaveLength(0);
    expect(of('answer-done').map((d) => d.requestId)).toEqual([second]);
  });

  it('does not restart for a trivial extension (added punctuation)', async () => {
    const { engine, llm } = setup();
    engine.onTranscript({ source: 'interviewer', text: 'tell me about yourself', isFinal: false });
    await T(500);
    expect(llm.calls).toHaveLength(1);
    engine.onTranscript({ source: 'interviewer', text: 'Tell me about yourself.', isFinal: true, speechFinal: true });
    await T(4000);
    expect(llm.calls).toHaveLength(1);
  });

  it('deduplicates repeated endpoint events for the same question', async () => {
    const { engine, llm } = setup({ speculation: 'off' });
    for (let i = 0; i < 3; i++) {
      engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: true, speechFinal: true });
    }
    await T(4000);
    expect(llm.calls).toHaveLength(1);
  });

  it('serves a repeated question from the semantic cache without calling the model', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'What are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(4000);
    expect(llm.calls).toHaveLength(1);
    await T(10_000); // past the answer-hold and merge windows: a fresh turn
    engine.onTranscript({ source: 'interviewer', text: 'So, what are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(50);
    expect(llm.calls).toHaveLength(1);
    const starts = of('answer-start');
    expect(starts).toHaveLength(2);
    expect(starts[1].source).toBe('cache');
    expect(of('answer-done')[1].latency.cacheHit).toBe(true);
  });

  it('never serves a cached answer for a different mode', async () => {
    const { engine, llm } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'What are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(4000);
    await T(10_000);
    engine.setMode('concise', { regenerate: false });
    engine.onTranscript({ source: 'interviewer', text: 'What are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(4000);
    expect(llm.calls).toHaveLength(2);
  });

  it('treats a short follow-up as a follow-up: short mode and the previous exchange in the prompt', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'Tell me about a difficult customer you handled.', isFinal: true, speechFinal: true });
    await T(4000);
    await T(10_000);
    engine.onTranscript({ source: 'interviewer', text: 'What did you personally do?', isFinal: true, speechFinal: true });
    await T(4000);
    expect(llm.calls).toHaveLength(2);
    const q2 = of('question')[1].question;
    expect(q2.isFollowUp).toBe(true);
    expect(of('answer-start')[1].mode).toBe('followup');
    expect(llm.calls[1].user).toContain('<recent_exchange>');
    expect(llm.calls[1].user).toContain('difficult customer');
    expect(llm.calls[1].maxTokens).toBeLessThan(200);
  });

  it('pausing discards an unconfirmed draft and ignores speech until resumed', async () => {
    const { engine, llm, of } = setup();
    engine.onTranscript({ source: 'interviewer', text: 'Can you walk me through your resume?', isFinal: false });
    await T(500);
    expect(llm.calls).toHaveLength(1);
    engine.setPaused(true);
    expect(of('answer-cancelled')).toHaveLength(1);
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want this job?', isFinal: true, speechFinal: true });
    await T(1000);
    expect(llm.calls).toHaveLength(1);
    engine.setPaused(false);
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want this job?', isFinal: true, speechFinal: true });
    expect(llm.calls).toHaveLength(2);
  });

  it('ignores the candidate’s own speech', async () => {
    const { engine, llm } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'candidate', text: 'How did I handle that? Well, I called the client.', isFinal: true, speechFinal: true });
    await T(1000);
    expect(llm.calls).toHaveLength(0);
  });

  it('holds back auto-answers right after an answer unless the signal is strong', async () => {
    const { engine, llm } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'What are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(4000);
    // Within the hold window (6 s from commit), a weak question-like utterance should not fire.
    engine.onTranscript({ source: 'interviewer', text: 'Could you speak about that a bit more', isFinal: true, speechFinal: true });
    await T(3000);
    expect(llm.calls).toHaveLength(1);
  });

  it('with auto-answer off it only surfaces the question; the shortcut generates', async () => {
    const { engine, llm, of } = setup({ autoAnswer: false });
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: true, speechFinal: true });
    await T(500);
    expect(llm.calls).toHaveLength(0);
    expect(of('question')[0].question.text).toContain('work here');
    engine.answerCurrent();
    await T(3000);
    expect(llm.calls).toHaveLength(1);
  });

  it('reports provider errors visibly instead of failing silently', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    llm.failWith = new AiError('auth', 'The API key was rejected.');
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: true, speechFinal: true });
    await T(200);
    const notice = of('notice').find((n) => n.level === 'error');
    expect(notice?.code).toBe('auth');
    expect(of('status').at(-1)?.status).toBe('error');
  });

  it('trims a length-capped answer back to a complete sentence', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    llm.answer = 'I led a team of 14 agents. We cut handling time by 22% and then we began to';
    llm.finishReason = 'length';
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: true, speechFinal: true });
    await T(3000);
    expect(of('answer-done')[0].text.endsWith('22% and then we began to')).toBe(false);
    expect(of('answer-done')[0].text.endsWith('.')).toBe(true);
  });

  it('flags details that are not in the candidate’s facts', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    llm.answer = 'At Northwind I cut handling time by 22%. I also saved the company $4.5 million and used Salesforce daily.';
    engine.onTranscript({ source: 'interviewer', text: 'Tell me about a time you improved a process.', isFinal: true, speechFinal: true });
    await T(4000);
    const g = of('answer-done')[0].grounding;
    expect(g.status).toBe('unverified-details');
    expect(g.unverified.join(' ')).toMatch(/4\.5|Salesforce/);
    expect(g.unverified.join(' ')).not.toMatch(/22/);
  });

  it('regenerates with a fresh timeline, bypassing the cache', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    engine.onTranscript({ source: 'interviewer', text: 'What are your greatest strengths?', isFinal: true, speechFinal: true });
    await T(4000);
    engine.regenerate();
    await T(4000);
    expect(llm.calls).toHaveLength(2);
    const d = of('answer-done');
    expect(d[1].latency.ttftMs).toBeGreaterThanOrEqual(100);
    // Perceived latency is measured from the click, not from the original speech.
    expect(d[1].latency.perceivedMs!).toBeLessThan(1000);
  });

  it('measures real latencies from the clock, not constants', async () => {
    const { engine, llm, of } = setup({ speculation: 'off' });
    llm.firstTokenDelay = 300;
    engine.onVad('interviewer', { type: 'speech_start', at: Date.now() });
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: false });
    await T(400);
    engine.onVad('interviewer', { type: 'speech_end', at: Date.now() });
    await T(200);
    engine.onTranscript({ source: 'interviewer', text: 'Why do you want to work here?', isFinal: true, speechFinal: true });
    await T(4000);
    const lat = of('answer-done')[0].latency;
    expect(lat.ttftMs).toBeGreaterThanOrEqual(300);
    expect(lat.ttftMs).toBeLessThan(340);
    expect(lat.sttFinalMs).toBeGreaterThanOrEqual(200);
    expect(lat.perceivedMs!).toBeGreaterThan(lat.ttftMs!);
  });

  it('shows a negative perceived latency when the answer started before the interviewer finished', async () => {
    const { engine, llm, of } = setup();
    llm.firstTokenDelay = 50;
    engine.onVad('interviewer', { type: 'speech_start', at: Date.now() });
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: false });
    await T(800); // speculative start + first token while they are still talking
    engine.onVad('interviewer', { type: 'speech_end', at: Date.now() });
    engine.onTranscript({ source: 'interviewer', text: 'Can you tell me about your experience managing a team?', isFinal: true, speechFinal: true });
    await T(4000);
    const lat = of('answer-done')[0].latency;
    expect(lat.speculative).toBe(true);
    expect(lat.perceivedMs!).toBeLessThan(0);
  });

  it('pre-warms the provider connection when the session starts', () => {
    const llm = new FakeLlm();
    const ctx = buildInterviewContext({ interview: null, resume: sampleResume(), profile: null, stories: [] });
    const engine = new LiveEngine({
      llm,
      getContext: () => ctx,
      settings: () => ({ mode: 'standard', speculation: 'balanced', autoAnswer: true, answerHoldMs: 0, storeAnswers: false, storeTranscripts: false, prewarm: true }),
      emit: () => undefined,
    });
    engine.start();
    expect(llm.warmed).toBe(1);
  });
});
