import { AiError, isAiError } from '@shared/errors';
import type { LlmGateway } from '@core/live/types';
import { analyzeAnswer } from '@core/eval/metrics';
import { retrieveForQuestion } from '@core/live/context';
import type { MockEvent, MockSummary, MockTurnRecord } from '@shared/ipc';
import type { Level, MockEvaluation, Speaker } from '@shared/types';
import { defang, truncate, uid } from '@shared/util';
import { MOCK_EVALUATE_SYSTEM, MOCK_INTERVIEWER_SYSTEM, withCustomInstructions } from '@prompts/index';
import { generateJson } from '../ai/structured';
import type { Repos } from '../db/repos';
import { SEED_QUESTIONS } from '../db/seedQuestions';
import type { ScopedLogger } from '../logging';
import type { SecretStore } from '../security/secrets';
import type { SttRegistry } from '../stt/registry';
import { ResilientStt } from '../stt/resilient';
import { loadContext, type LoadedMaterial } from './context';
import { EvaluationSchema } from './schemas';
import type { InterviewContext } from '@core/live/context';
import type { SttProviderId } from '@shared/types';

interface MockState {
  id: string;
  interviewId: string | null;
  kind: 'mock' | 'practice';
  total: number;
  turns: MockTurnRecord[];
  current: string;
  asked: string[];
  pool: string[];
  ctx: InterviewContext;
  material: LoadedMaterial;
  useAi: boolean;
}

export interface MockDeps {
  repos: Repos;
  gateway: LlmGateway;
  secrets: SecretStore;
  stt: SttRegistry;
  log: ScopedLogger;
  emit: (e: MockEvent) => void;
  aiAvailable: () => boolean;
  sttUrls?: Partial<Record<SttProviderId, string>>;
}

const LEVELS: Level[] = ['strong', 'adequate', 'weak'];

export class MockService {
  private sessions = new Map<string, MockState>();
  private stt: ResilientStt | null = null;
  private listeningSession: string | null = null;

  constructor(private readonly d: MockDeps) {}

  get listening(): boolean {
    return this.stt !== null;
  }

  /** Offline question pool for when no AI interviewer is available. */
  private pool(interviewId: string | null, material: LoadedMaterial): string[] {
    const out: string[] = [];
    if (interviewId) {
      const prep = this.d.repos.getPrep(interviewId).questions?.data as { questions?: { text: string }[] } | undefined;
      for (const q of prep?.questions ?? []) out.push(q.text);
      for (const q of material.interview?.match?.likelyQuestions ?? []) out.push(q);
    }
    const type = material.interview?.interviewType ?? 'general';
    const cats = ({ hr: ['hr'], behavioral: ['behavioral'], technical: ['technical', 'software', 'data'], managerial: ['management', 'leadership'], 'case-study': ['case-study'], coding: ['software'], 'customer-service': ['customer-service', 'behavioral'], sales: ['sales'], analytics: ['analytics', 'data'], operations: ['operations'], leadership: ['leadership'], general: ['hr', 'behavioral'] } as const)[type] ?? ['hr', 'behavioral'];
    for (const c of cats) out.push(...SEED_QUESTIONS[c]);
    out.push(...SEED_QUESTIONS.hr.slice(0, 3), ...SEED_QUESTIONS.behavioral.slice(0, 4));
    return [...new Set(out)];
  }

  async start(req: { interviewId: string | null; questionCount: number; kind: 'mock' | 'practice'; firstQuestion?: string }, signal: AbortSignal): Promise<{ sessionId: string; question: string }> {
    const { ctx, material } = loadContext(this.d.repos, req.interviewId);
    const session = this.d.repos.createSession({ kind: req.kind, interview: material.interview, title: req.kind === 'practice' ? 'Practice' : undefined });
    const state: MockState = {
      id: session.id,
      interviewId: req.interviewId,
      kind: req.kind,
      total: req.kind === 'practice' ? 1 : Math.max(1, Math.min(15, req.questionCount)),
      turns: [],
      current: '',
      asked: [],
      pool: this.pool(req.interviewId, material),
      ctx,
      material,
      useAi: this.d.aiAvailable(),
    };
    this.sessions.set(session.id, state);
    state.current = req.firstQuestion?.trim() || (await this.nextQuestion(state, signal));
    state.asked.push(state.current);
    return { sessionId: session.id, question: state.current };
  }

  private async nextQuestion(s: MockState, signal: AbortSignal): Promise<string> {
    const n = s.turns.length + 1;
    if (s.useAi) {
      try {
        const last = s.turns[s.turns.length - 1];
        const facts = s.ctx.profileBlock;
        const res = await this.d.gateway.generate({
          task: 'mock',
          system: withCustomInstructions(MOCK_INTERVIEWER_SYSTEM, ''),
          user: [
            `<interview_type>${s.material.interview?.interviewType ?? 'general'}</interview_type>`,
            `<role>\n${s.ctx.roleBlock || 'General interview'}\n</role>`,
            `<candidate_profile>\n${facts}\n</candidate_profile>`,
            s.asked.length ? `<asked_so_far>\n${defang(s.asked.map((q) => `- ${q}`).join('\n'))}\n</asked_so_far>` : '',
            last ? `<last_exchange>\nQuestion: ${defang(last.question)}\nCandidate answer: ${defang(truncate(last.answer, 700))}\n</last_exchange>` : '',
            `<instruction>Ask question ${n} of ${s.total}. Output only the question.</instruction>`,
          ]
            .filter(Boolean)
            .join('\n'),
          maxTokens: 140,
          temperature: 0.7,
          signal,
        });
        const q = res.text.trim().replace(/^["“]|["”]$/g, '').split('\n')[0]?.trim();
        if (q && q.length > 6) return q;
      } catch (err) {
        if (signal.aborted) throw err;
        this.d.log.warn('AI interviewer failed; using offline questions', { code: isAiError(err) ? err.code : 'unknown' });
        this.d.emit({ type: 'status', state: 'notice', message: `The AI interviewer was unavailable (${isAiError(err) ? err.message : 'error'}); using questions from your bank instead.` });
      }
    }
    const fresh = s.pool.find((q) => !s.asked.includes(q));
    return fresh ?? s.pool[s.asked.length % Math.max(1, s.pool.length)] ?? 'Tell me about yourself.';
  }

  async answer(req: { sessionId: string; answer: string; durationMs: number | null }, signal: AbortSignal): Promise<{ turn: MockTurnRecord; next: string | null }> {
    const s = this.sessions.get(req.sessionId);
    if (!s) throw new Error('This practice session is no longer active.');
    const question = s.current;
    const answer = req.answer.trim();
    const metrics = analyzeAnswer(question, answer, req.durationMs);
    let evaluation: MockEvaluation | null = null;
    let evaluationError: string | undefined;

    if (answer.length < 8) {
      evaluationError = 'The answer was too short to evaluate.';
    } else if (!s.useAi) {
      evaluationError = 'No AI model is set up, so only the measured statistics are shown. Add a provider in Settings for a full evaluation.';
    } else {
      try {
        const retrieved = retrieveForQuestion(s.ctx, question, { mode: 'standard', kind: 'other' });
        const { value } = await generateJson(this.d.gateway, {
          task: 'mock',
          system: MOCK_EVALUATE_SYSTEM,
          user: `<question>${defang(question)}</question>\n<candidate_answer>\n${defang(answer)}\n</candidate_answer>\n<candidate_facts>\n${defang(retrieved.facts.map((f) => `- ${f.text}`).join('\n')) || '(none)'}\n</candidate_facts>\n<measured>\n${JSON.stringify({ words: metrics.words, seconds: metrics.seconds, fillers: metrics.fillers, star: metrics.star, questionCoverage: metrics.questionCoverage })}\n</measured>`,
          schema: EvaluationSchema,
          maxTokens: 1400,
          signal,
        });
        evaluation = value;
      } catch (err) {
        if (signal.aborted) throw err;
        const ai = isAiError(err) ? err : new AiError('unknown', 'Evaluation failed');
        evaluationError = `The AI evaluation failed: ${ai.message}`;
      }
    }

    const turn: MockTurnRecord = { index: s.turns.length, question, answer, durationMs: req.durationMs, metrics, evaluation, evaluationError };
    s.turns.push(turn);
    this.d.repos.saveAnswer({
      sessionId: s.id,
      interviewId: s.interviewId,
      questionText: question,
      answerText: answer,
      mode: 'standard',
      source: s.kind === 'practice' ? 'practice' : 'mock',
      feedback: [],
      edited: false,
      mock: { durationMs: req.durationMs, metrics, evaluation, evaluationError },
    });
    if (answer) this.d.repos.addTranscript(s.id, s.turns.length * 2 - 1, 'interviewer', question, Date.now());
    if (answer) this.d.repos.addTranscript(s.id, s.turns.length * 2, 'candidate', answer, Date.now());

    let next: string | null = null;
    if (s.turns.length < s.total) {
      next = await this.nextQuestion(s, signal);
      s.current = next;
      s.asked.push(next);
    }
    return { turn, next };
  }

  summary(sessionId: string): MockSummary | null {
    const s = this.sessions.get(sessionId);
    if (s) return this.summarize(s);
    // After a restart, rebuild from the stored answers.
    const answers = this.d.repos.listAnswers({ sessionId }).filter((a) => a.mock);
    if (answers.length === 0) return null;
    const turns: MockTurnRecord[] = answers.map((a, i) => ({ index: i, question: a.questionText, answer: a.answerText, durationMs: a.mock!.durationMs, metrics: a.mock!.metrics, evaluation: a.mock!.evaluation, evaluationError: a.mock!.evaluationError }));
    return this.build(sessionId, turns);
  }

  private summarize(s: MockState): MockSummary {
    return this.build(s.id, s.turns);
  }

  private build(sessionId: string, turns: MockTurnRecord[]): MockSummary {
    const tally = { relevance: zero(), completeness: zero(), structure: zero(), conciseness: zero() };
    for (const t of turns) {
      if (!t.evaluation) continue;
      for (const k of ['relevance', 'completeness', 'structure', 'conciseness'] as const) tally[k][t.evaluation[k].level]++;
    }
    const words = turns.map((t) => t.metrics.words).filter((w) => w > 0);
    return { sessionId, turns, tally, avgWords: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : null };
  }

  finish(sessionId: string): MockSummary {
    const s = this.sessions.get(sessionId);
    const summary = this.summary(sessionId) ?? { sessionId, turns: [], tally: { relevance: zero(), completeness: zero(), structure: zero(), conciseness: zero() }, avgWords: null };
    if (s) {
      this.d.repos.endSession(sessionId, { turns: s.turns.length, cacheHits: 0 });
      this.sessions.delete(sessionId);
    }
    void this.listen(sessionId, false);
    return summary;
  }

  /* --------------------------- spoken answers --------------------------- */

  async listen(sessionId: string, on: boolean): Promise<'mic'[]> {
    if (!on) {
      const stt = this.stt;
      this.stt = null;
      this.listeningSession = null;
      if (stt) await stt.close().catch(() => undefined);
      return [];
    }
    if (this.stt) return ['mic'];
    const settings = this.d.repos.getSettings();
    const provider = settings.stt.provider;
    const access = this.d.stt.access(provider, this.d.secrets);
    if (!access.ok) throw new Error(`${access.message} Type your answer instead.`);
    this.listeningSession = sessionId;
    const role: Speaker = 'candidate';
    let text = '';
    this.stt = new ResilientStt({
      primary: { provider: this.d.stt.provider(provider), key: access.key, cfg: { language: settings.stt.language, model: settings.stt.model, endpointingMs: 700, diarize: false, baseUrl: this.d.sttUrls?.[provider] } },
      events: {
        onTranscript: (t) => {
          if (!t.text) return;
          if (t.isFinal) {
            text = `${text} ${t.text}`.trim();
            this.d.emit({ type: 'transcript', text, isFinal: true });
          } else this.d.emit({ type: 'transcript', text: `${text} ${t.text}`.trim(), isFinal: false });
        },
        onState: (state, message) => this.d.emit({ type: 'status', state, message }),
      },
    });
    void role;
    return ['mic'];
  }

  audio(bytes: Uint8Array): void {
    this.stt?.sendAudio(bytes);
  }

  get activeSession(): string | null {
    return this.listeningSession;
  }
}

function zero(): Record<Level, number> {
  return Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
}

export function newSessionId(): string {
  return uid('mock');
}
