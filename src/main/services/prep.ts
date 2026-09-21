import { AiError, isAiError } from '@shared/errors';
import type { GenEvent, PrepProgress } from '@shared/events';
import { ANSWER_MODES } from '@shared/modes';
import type {
  AboutMePrep,
  AnswerMode,
  CompanyPrep,
  Fact,
  Interview,
  PrepSectionKey,
  PreparedQuestion,
  QuestionsPrep,
  RolePrep,
} from '@shared/types';
import { defang, truncate, uid } from '@shared/util';
import { PREP_ABOUT_COMPACT_SYSTEM, PREP_ABOUT_PLAIN_SYSTEM, PREP_ABOUT_SYSTEM, PREP_COMPANY_SYSTEM, PREP_QUESTIONS_SYSTEM, PREP_ROLE_SYSTEM, withCustomInstructions } from '@prompts/index';
import { buildAnswerPrompt, retrieveForQuestion, trimToSentence } from '@core/live/context';
import { checkGrounding } from '@core/live/grounding';
import type { LlmGateway } from '@core/live/types';
import { detectQuestion } from '@core/question/detector';
import { chunkText } from '@core/retrieval';
import { generateJson } from '../ai/structured';
import type { Repos } from '../db/repos';
import { SEED_QUESTIONS } from '../db/seedQuestions';
import type { ScopedLogger } from '../logging';
import { loadContext, loadMaterial, type LoadedMaterial } from './context';
import { draftAbout } from './aboutDraft';
import {
  ABOUT_JSON_SCHEMA,
  ABOUT_KEYS,
  AboutSchema,
  COMPANY_JSON_SCHEMA,
  COMPANY_KEYS,
  CompanySchema,
  QUESTIONS_JSON_SCHEMA,
  QUESTIONS_KEYS,
  QuestionsSchema,
  ROLE_JSON_SCHEMA,
  ROLE_KEYS,
  RoleSchema,
} from './schemas';

export interface PrepDeps {
  repos: Repos;
  gateway: LlmGateway;
  log: ScopedLogger;
  emitProgress: (p: PrepProgress) => void;
  emitGen: (e: GenEvent) => void;
  aiAvailable: () => boolean;
  /** Something the person should know that is not tied to one section (the reply was cut off, an offline draft was used). */
  emitNotice?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const KIND_ORDER: Fact['kind'][] = ['achievement', 'leadership', 'responsibility', 'project', 'certification', 'education', 'skill', 'summary', 'metric', 'tool', 'industry', 'note'];

/** Compact, ordered slice of the candidate's facts for a prompt (most useful kinds first). */
function factsBlock(m: LoadedMaterial, max = 40): string {
  const facts = [...(m.resume?.facts ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const extra = m.profile.extraFacts.map((t) => `- [Provided by the candidate] ${t}`);
  const lines = facts.slice(0, max).map((f) => `- ${f.label ? `[${f.label}] ` : ''}${truncate(f.text, 260)}`);
  return defang([...lines, ...extra].join('\n')) || '(no résumé facts available)';
}

function profileLines(m: LoadedMaterial): string {
  const r = m.resume;
  const out: string[] = [];
  const name = r?.name || m.profile.name;
  if (name) out.push(`Name: ${name}`);
  if (r?.currentRole) out.push(`Current/most recent role: ${r.currentRole}`);
  if (r?.yearsExperience) out.push(`Years of experience: about ${r.yearsExperience}`);
  if (r?.summary) out.push(`Summary: ${truncate(r.summary, 400)}`);
  if (m.profile.targetRoles.length) out.push(`Target roles: ${m.profile.targetRoles.join(', ')}`);
  return defang(out.join('\n'));
}

function roleLines(i: Interview | null): string {
  if (!i) return '(no specific interview selected)';
  const jd = i.jdAnalysis;
  const out = [`Role: ${i.jobTitle}${i.company ? ` at ${i.company}` : ''}`, `Interview type: ${i.interviewType}`];
  if (jd?.requiredSkills.length) out.push(`Required skills: ${jd.requiredSkills.slice(0, 12).join('; ')}`);
  if (jd?.competencies.length) out.push(`Competencies: ${jd.competencies.slice(0, 10).join('; ')}`);
  return defang(out.join('\n'));
}

/** The model answered but its reply could not be used (cut off, or not the expected data): an offline draft is better than nothing. */
const isReplyProblem = (err: unknown): err is AiError => isAiError(err) && err.code === 'malformed';

const OFFLINE_NOTE = 'The AI’s reply could not be used, so this is an offline draft built from your résumé and the job description. Press Regenerate to try the AI again.';
const PARTIAL_NOTE = 'The AI’s reply could not be completed, so some fields here were drafted from your résumé instead of written by the AI. Press Regenerate to try again.';

export class PrepService {
  private active = new Map<string, AbortController>();
  private readonly told = new Map<string, number>();

  constructor(private readonly d: PrepDeps) {}

  cancel(requestId: string): void {
    this.active.get(requestId)?.abort();
  }

  cancelAll(): void {
    for (const ac of this.active.values()) ac.abort();
  }

  /* ---------------------------------------------------------------- */
  /* Sections                                                          */
  /* ---------------------------------------------------------------- */

  async generate(interviewId: string, section: PrepSectionKey | 'all'): Promise<void> {
    const interview = this.d.repos.getInterview(interviewId);
    if (!interview) throw new Error('Interview not found.');
    const sections: PrepSectionKey[] = section === 'all' ? ['about', 'role', 'company', 'questions'] : [section];
    const ac = new AbortController();
    const id = uid('prep');
    this.active.set(id, ac);
    let done = 0;
    const progress = (step: string, error?: string) => this.d.emitProgress({ interviewId, step, done, total: sections.length, error });
    try {
      progress('starting');
      await Promise.all(
        sections.map(async (s) => {
          try {
            progress(s);
            await this.generateOne(interview, s, ac.signal);
          } catch (err) {
            if (ac.signal.aborted) return;
            const msg = isAiError(err) ? err.message : err instanceof Error ? err.message : 'Failed';
            this.d.log.warn('prep section failed', { section: s, code: isAiError(err) ? err.code : 'unknown' });
            done++;
            progress(s, msg);
            return;
          }
          done++;
          progress(s);
        }),
      );
      progress('complete');
    } finally {
      this.active.delete(id);
    }
  }

  /** Tell the person once, however many sections are running at the same time. */
  private notify(level: 'info' | 'warn' | 'error', message: string): void {
    const last = this.told.get(message);
    if (last !== undefined && Date.now() - last < 60_000) return;
    this.told.set(message, Date.now());
    this.d.emitNotice?.(level, message);
  }

  /** Save an offline draft after the model's reply could not be used, and say so. */
  private offlineInstead(interview: Interview, key: PrepSectionKey, draft: object, err: AiError): void {
    this.d.log.warn('prep section fell back to an offline draft', { section: key, code: err.code, reason: err.reason });
    this.d.repos.savePrep(interview.id, key, { ...draft, note: OFFLINE_NOTE }, null);
    this.notify('warn', `“${key}”: ${OFFLINE_NOTE}`);
  }

  private async generateOne(interview: Interview, key: PrepSectionKey, signal: AbortSignal): Promise<void> {
    const material = loadMaterial(this.d.repos, interview.id);
    const custom = this.d.repos.getSettings().customInstructions;
    const ai = this.d.aiAvailable();
    const jd = defang(truncate(interview.jobDescription, 3500));
    const onNotice = (level: 'info' | 'warn' | 'error', message: string) => this.notify(level, message);

    if (key === 'about') {
      if (!ai) throw new AiError('not_configured', 'Set up an AI model to draft “Tell me about yourself” and your career story.', { retryable: false });
      const user = `<candidate_profile>\n${profileLines(material)}\n</candidate_profile>\n<candidate_facts>\n${factsBlock(material)}\n</candidate_facts>\n<role>\n${roleLines(interview)}\n</role>`;
      try {
        const { value, model, path } = await generateJson(this.d.gateway, {
          task: 'prep',
          system: withCustomInstructions(PREP_ABOUT_SYSTEM, custom),
          user,
          schema: AboutSchema,
          jsonSchema: ABOUT_JSON_SCHEMA,
          requiredKeys: ABOUT_KEYS,
          maxTokens: 1800,
          signal,
          onNotice,
          compact: { system: withCustomInstructions(PREP_ABOUT_COMPACT_SYSTEM, custom), maxTokens: 2400 },
          plainFallback: { system: PREP_ABOUT_PLAIN_SYSTEM, user, maxTokens: 600, build: (text, salvaged) => this.aboutFromPlainText(interview, material, text, salvaged) },
        });
        const { ctx } = loadContext(this.d.repos, interview.id);
        const text = [value.tellMeAboutYourself, value.professionalSummary, value.careerJourney, value.currentRole, ...value.strengths, ...value.relevantExperience].join(' \n ');
        const g = checkGrounding({ answer: text, question: '', corpus: ctx.corpus, usedFactIds: ['x'], usedStoryIds: [], retrievalConfidence: 1 });
        const data: AboutMePrep = { ...value, unverified: g.unverified.length ? g.unverified : undefined, note: path === 'partial' ? PARTIAL_NOTE : undefined };
        this.d.repos.savePrep(interview.id, 'about', data, model);
        if (path === 'partial') this.notify('warn', `“about”: ${PARTIAL_NOTE}`);
      } catch (err) {
        if (!isReplyProblem(err)) throw err;
        this.offlineInstead(interview, 'about', draftAbout(interview, material), err);
      }
      return;
    }

    if (key === 'company') {
      if (!ai) {
        this.d.repos.savePrep(interview.id, 'company', this.localCompany(interview), null);
        return;
      }
      try {
        const { value, model } = await generateJson(this.d.gateway, {
          task: 'prep',
          system: withCustomInstructions(PREP_COMPANY_SYSTEM, custom),
          user: `<company>${defang(interview.company || 'unknown')}</company>\n<company_notes>\n${defang(interview.companyNotes.trim()) || '(none provided)'}\n</company_notes>\n<job_description>\n${jd}\n</job_description>\n<interviewer>${defang(interview.interviewerInfo.trim()) || 'unknown'}</interviewer>`,
          schema: CompanySchema,
          jsonSchema: COMPANY_JSON_SCHEMA,
          requiredKeys: COMPANY_KEYS,
          maxTokens: 1400,
          signal,
          onNotice,
        });
        this.d.repos.savePrep(interview.id, 'company', value satisfies CompanyPrep, model);
      } catch (err) {
        if (!isReplyProblem(err)) throw err;
        this.offlineInstead(interview, 'company', this.localCompany(interview), err);
      }
      return;
    }

    if (key === 'role') {
      if (!ai) {
        this.d.repos.savePrep(interview.id, 'role', this.localRole(interview), null);
        return;
      }
      try {
        const { value, model } = await generateJson(this.d.gateway, {
          task: 'prep',
          system: withCustomInstructions(PREP_ROLE_SYSTEM, custom),
          user: `<job_description>\n${jd}\n</job_description>\n<role>\n${roleLines(interview)}\n</role>\n<candidate_facts>\n${factsBlock(material, 20)}\n</candidate_facts>`,
          schema: RoleSchema,
          jsonSchema: ROLE_JSON_SCHEMA,
          requiredKeys: ROLE_KEYS,
          maxTokens: 1600,
          signal,
          onNotice,
        });
        this.d.repos.savePrep(interview.id, 'role', value satisfies RolePrep, model);
      } catch (err) {
        if (!isReplyProblem(err)) throw err;
        this.offlineInstead(interview, 'role', this.localRole(interview), err);
      }
      return;
    }

    // questions
    if (!ai) {
      this.d.repos.savePrep(interview.id, 'questions', this.localQuestions(interview), null);
      return;
    }
    const gaps = [...(interview.match?.missing ?? []), ...(interview.match?.partial ?? [])].slice(0, 8).map((m) => `- ${m.requirement}`);
    try {
      const { value, model } = await generateJson(this.d.gateway, {
        task: 'prep',
        system: withCustomInstructions(PREP_QUESTIONS_SYSTEM, custom),
        user: `<job_description>\n${truncate(jd, 2200)}\n</job_description>\n<role>\n${roleLines(interview)}\n</role>\n<gaps_in_candidate_profile>\n${defang(gaps.join('\n')) || '(none identified)'}\n</gaps_in_candidate_profile>\n<candidate_facts>\n${factsBlock(material, 18)}\n</candidate_facts>`,
        schema: QuestionsSchema,
        jsonSchema: QUESTIONS_JSON_SCHEMA,
        requiredKeys: QUESTIONS_KEYS,
        maxTokens: 3200,
        signal,
        onNotice,
      });
      const seen = new Set<string>();
      const questions: PreparedQuestion[] = [];
      for (const q of value.questions) {
        const k = q.text.toLowerCase();
        if (seen.has(k) || q.text.length < 8) continue;
        seen.add(k);
        questions.push({ id: uid('pq'), category: q.category, text: q.text, why: q.why ?? undefined });
      }
      this.d.repos.savePrep(interview.id, 'questions', { questions } satisfies QuestionsPrep, model);
    } catch (err) {
      if (!isReplyProblem(err)) throw err;
      this.offlineInstead(interview, 'questions', this.localQuestions(interview), err);
    }
  }

  /**
   * Last resort for "About me": the model wrote the spoken answer as plain text (or an earlier reply wrote some fields in
   * full). Whatever the model wrote is kept as it is; every other field comes from the résumé, never from guesswork.
   */
  private aboutFromPlainText(interview: Interview, m: LoadedMaterial, text: string, salvaged: Record<string, unknown> | null): AboutMePrep | null {
    const prose = text
      .replace(/```[a-z]*/gi, '')
      .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const parsed = AboutSchema.safeParse(salvaged ?? {});
    const written = parsed.success ? parsed.data : null;
    const tell = written?.tellMeAboutYourself || prose;
    if (tell.length < 40) return null;
    const draft = draftAbout(interview, m);
    const kept = written ? Object.fromEntries(Object.entries(written).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : String(v).trim() !== ''))) : {};
    return { ...draft, ...kept, tellMeAboutYourself: tell };
  }

  /* Offline drafts, clearly labelled as such in the UI (model === null). */

  private localRole(i: Interview): RolePrep {
    const jd = i.jdAnalysis;
    return {
      responsibilities: jd?.responsibilities.slice(0, 10) ?? chunkText(i.jobDescription, 30).slice(0, 8),
      skillsRequired: [...(jd?.requiredSkills ?? []), ...(jd?.preferredSkills ?? [])].slice(0, 16),
      likelyAreas: [...(jd?.competencies ?? []), ...(jd?.kpis ?? []).map((k) => `Metrics: ${k}`)].slice(0, 10),
      terminology: (jd?.keywords ?? []).slice(0, 8).map((term) => ({ term, meaning: 'Appears repeatedly in the job description — be ready to explain your experience with it.' })),
    };
  }

  private localCompany(i: Interview): CompanyPrep {
    const notes = i.companyNotes.trim();
    return {
      summary: notes ? truncate(notes.replace(/\s+/g, ' '), 400) : 'No company notes were provided. Add what you know about the company in the interview details.',
      fromYourNotes: notes ? chunkText(notes, 30).slice(0, 8) : [],
      toResearch: ['What the company sells and to whom', 'Recent news, launches or announcements', 'The team you would join and who leads it', 'How the company describes its culture and values', 'Competitors and how the company differs', 'Anything in the job description you do not fully understand'],
      questionsToAsk: ['What does success look like in the first 90 days?', 'What are the biggest challenges the team is facing right now?', 'How is performance measured for this role?', 'How does the team work with other departments?', 'What do you enjoy most about working here?'],
    };
  }

  private localQuestions(i: Interview): QuestionsPrep {
    const out: PreparedQuestion[] = [];
    for (const q of i.match?.likelyQuestions ?? []) out.push({ id: uid('pq'), category: 'role-specific', text: q, why: 'Based on gaps and strengths in your résumé vs the job description.' });
    const byType: Record<string, (keyof typeof SEED_QUESTIONS)[]> = {
      hr: ['hr'], behavioral: ['behavioral'], technical: ['technical', 'software', 'data'], managerial: ['management', 'leadership'], 'case-study': ['case-study'], coding: ['software'],
      'customer-service': ['customer-service'], sales: ['sales'], analytics: ['analytics', 'data'], operations: ['operations'], leadership: ['leadership'], general: ['hr', 'behavioral'],
    };
    for (const cat of byType[i.interviewType] ?? ['hr', 'behavioral']) {
      for (const q of SEED_QUESTIONS[cat].slice(0, 5)) out.push({ id: uid('pq'), category: cat === 'hr' || cat === 'leadership' ? cat : cat === 'behavioral' ? 'behavioral' : 'technical', text: q });
    }
    return { questions: out.slice(0, 24) };
  }

  /* ---------------------------------------------------------------- */
  /* Prepared / practice answers (streamed)                            */
  /* ---------------------------------------------------------------- */

  answer(req: { interviewId: string | null; question: string; mode: AnswerMode; save: boolean }): { requestId: string } {
    const requestId = uid('gen');
    const ac = new AbortController();
    this.active.set(requestId, ac);
    void (async () => {
      const t0 = performance.now();
      let first: number | null = null;
      try {
        const { ctx } = loadContext(this.d.repos, req.interviewId);
        const kind = detectQuestion(req.question).kind;
        const retrieved = retrieveForQuestion(ctx, req.question, { mode: req.mode, kind });
        const prompt = buildAnswerPrompt({ ctx, question: req.question, kind, mode: req.mode, isFollowUp: false, retrieved, previous: [] });
        const res = await this.d.gateway.generate({
          task: 'prep',
          system: prompt.system,
          user: prompt.user,
          maxTokens: ANSWER_MODES[req.mode].maxTokens,
          signal: ac.signal,
          onToken: (text) => {
            first ??= performance.now() - t0;
            this.d.emitGen({ requestId, type: 'token', text });
          },
          onNotice: (_l, message) => this.d.emitGen({ requestId, type: 'notice', message }),
        });
        const text = res.finishReason === 'length' ? trimToSentence(res.text) : res.text;
        if (req.save && req.interviewId) {
          const g = checkGrounding({ answer: text, question: req.question, corpus: ctx.corpus, usedFactIds: retrieved.summary.factIds, usedStoryIds: retrieved.summary.storyIds, retrievalConfidence: retrieved.confidence });
          this.d.repos.saveAnswer({ sessionId: null, interviewId: req.interviewId, questionText: req.question, questionKind: kind, answerText: text, mode: req.mode, source: 'prepared', model: res.model, grounding: g, feedback: [], edited: false });
        }
        this.d.emitGen({ requestId, type: 'done', text, model: res.model, ttftMs: first, totalMs: Math.round(performance.now() - t0) });
      } catch (err) {
        if (ac.signal.aborted) {
          this.d.emitGen({ requestId, type: 'error', code: 'aborted', message: 'Cancelled' });
        } else {
          const ai = isAiError(err) ? err : new AiError('unknown', err instanceof Error ? err.message : 'Failed');
          this.d.emitGen({ requestId, type: 'error', code: ai.code, message: ai.message });
        }
      } finally {
        this.active.delete(requestId);
      }
    })();
    return { requestId };
  }
}
