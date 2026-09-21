import type { LlmGateway } from '@core/live/types';
import { LiveEngine } from '@core/live/engine';
import { buildInterviewContext } from '@core/live/context';
import { summarize } from '@core/live/latency';
import { parseResumeHeuristic } from '@core/prep/resumeHeuristic';
import type { LiveEvent } from '@shared/events';
import type { BenchResult, BenchRun } from '@shared/ipc';
import type { AnswerMode, ResumeProfile } from '@shared/types';
import { uid, wordCount } from '@shared/util';
import type { Repos } from '../db/repos';
import { loadMaterial } from './context';

/** Questions used for the benchmark: a fixed, representative mix so runs are comparable over time. */
export const BENCH_QUESTIONS = [
  'Tell me about yourself.',
  'Tell me about a time you improved a process.',
  'How do you handle a difficult stakeholder?',
  'What are your greatest strengths?',
  'Describe a time you had to meet a tight deadline.',
  'Why do you want to work here?',
  'How do you prioritise when everything is urgent?',
  'Tell me about a time you led a team through change.',
];

const SAMPLE_RESUME = `SAMPLE CANDIDATE
Operations Manager

SUMMARY
Operations manager with 6 years running support and fulfilment teams.

EXPERIENCE
Example Co | Operations Manager | Jan 2021 – Present
• Managed a team of 12 agents and 2 team leads.
• Redesigned the returns workflow, cutting handling time by 20%.
• Built weekly SLA dashboards in Excel and SQL.

SKILLS
Excel, SQL, process mapping, coaching
`;

/**
 * Measures the real pipeline (question → retrieval → prompt → provider → first token → complete answer) for
 * the configured live model. Timings come from the same TurnTimeline the live screen uses; nothing is simulated.
 */
export class BenchService {
  constructor(
    private readonly d: { repos: Repos; gateway: LlmGateway; emit: (done: number, total: number, ttft: number | null, total2: number | null, runId: string) => void; providerLabel: () => { provider: string; model: string } },
  ) {}

  async run(opts: { runs: number; mode: AnswerMode; signal: AbortSignal }): Promise<BenchResult> {
    const material = loadMaterial(this.d.repos, null);
    const usingSample = !material.resume || material.resume.facts.length === 0;
    const resume: ResumeProfile = usingSample ? parseResumeHeuristic(SAMPLE_RESUME) : material.resume!;
    const ctx = buildInterviewContext({ interview: null, resume, profile: null, stories: [] });
    const runId = uid('bench');
    const total = Math.max(1, Math.min(30, opts.runs));
    const runs: BenchRun[] = [];
    const notes: string[] = [];
    if (usingSample) notes.push('No résumé is loaded, so a small built-in sample profile was used. Latency is unaffected, but answers are generic.');

    // One un-timed warm-up so TLS/connection setup is not blamed on the model (it is shown separately as note).
    const first = await this.one(ctx, BENCH_QUESTIONS[0], opts.mode, opts.signal);
    if (first.ttftMs !== null) notes.push(`First request (includes connection setup): ${Math.round(first.ttftMs)} ms to first token — excluded from the statistics.`);

    for (let i = 0; i < total; i++) {
      if (opts.signal.aborted) break;
      const q = BENCH_QUESTIONS[i % BENCH_QUESTIONS.length];
      const r = await this.one(ctx, q, opts.mode, opts.signal);
      runs.push(r);
      this.d.emit(i + 1, total, r.ttftMs, r.totalMs, runId);
    }

    const ok = runs.filter((r) => r.ok);
    const label = this.d.providerLabel();
    const result: BenchResult = {
      id: runId,
      createdAt: Date.now(),
      provider: label.provider,
      model: label.model,
      mode: opts.mode,
      runs,
      ttft: summarize(ok.map((r) => r.ttftMs).filter((v): v is number => v !== null)),
      total: summarize(ok.map((r) => r.totalMs).filter((v): v is number => v !== null)),
      failures: runs.length - ok.length,
      notes,
    };
    this.d.repos.saveBenchRun(label.provider, label.model, result);
    return result;
  }

  private one(ctx: ReturnType<typeof buildInterviewContext>, question: string, mode: AnswerMode, signal: AbortSignal): Promise<BenchRun> {
    return new Promise((resolve) => {
      let answer = '';
      const engine: LiveEngine = new LiveEngine({
        llm: this.d.gateway,
        getContext: () => ctx,
        settings: () => ({ mode, speculation: 'off', autoAnswer: true, answerHoldMs: 0, storeAnswers: false, storeTranscripts: false, prewarm: false }),
        emit: (e: LiveEvent) => {
          if (e.type === 'answer-token') answer += e.text;
          if (e.type === 'answer-replace') answer = e.text;
          if (e.type === 'answer-done') {
            engine.stop();
            resolve({ scenario: question, ttftMs: e.latency.ttftMs ?? null, totalMs: e.latency.totalMs ?? null, words: wordCount(e.text), ok: true, cacheHit: !!e.latency.cacheHit });
          }
          if (e.type === 'notice' && e.level === 'error') {
            engine.stop();
            resolve({ scenario: question, ttftMs: null, totalMs: null, words: wordCount(answer), ok: false, error: e.message, cacheHit: false });
          }
        },
      });
      signal.addEventListener('abort', () => {
        engine.stop();
        resolve({ scenario: question, ttftMs: null, totalMs: null, words: 0, ok: false, error: 'Cancelled', cacheHit: false });
      }, { once: true });
      engine.start();
      engine.submitQuestion(question, { bypassCache: true });
    });
  }
}
