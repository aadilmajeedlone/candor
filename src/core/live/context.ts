import type { QuestionKind, RetrievalSummary } from '@shared/events';
import type { AnswerMode, AnswerStyle, Fact, Interview, ResumeProfile, Story, UserProfile } from '@shared/types';
import { defang, hashHex, truncate, uniq } from '@shared/util';
import { ANSWER_FORMATS, ANSWER_SYSTEM, KIND_HINTS, PROMPT_VERSION, STYLE_HINTS, withCustomInstructions } from '@prompts/index';
import { HybridIndex, chunkText } from '../retrieval';

/**
 * The compact, reusable interview context. Built once per interview/session from the parsed résumé, the JD
 * analysis, stories and profile; cached; and queried per question. The full résumé and JD are never sent to
 * the model on every request.
 */
export interface InterviewContext {
  interviewId: string | null;
  /** Hash of everything that affects answers. Part of the answer-cache key. */
  version: string;
  profileBlock: string;
  roleBlock: string;
  index: HybridIndex;
  factsById: Map<string, Fact>;
  storiesById: Map<string, Story>;
  /** Text the model may legitimately draw on. Used by the grounding check. */
  corpus: string[];
  style: AnswerStyle;
  customInstructions: string;
  hasCandidateMaterial: boolean;
}

export interface ContextInput {
  interview: Interview | null;
  resume: ResumeProfile | null;
  profile: UserProfile | null;
  stories: Story[];
  customInstructions?: string;
}

const MAX_SKILLS = 14;

function list(items: (string | undefined | null)[], max: number): string[] {
  return uniq(items.map((s) => s?.trim()).filter((s): s is string => !!s)).slice(0, max);
}

export function storyText(s: Story): string {
  return `${s.title}. Situation: ${s.situation} Task: ${s.task} Action: ${s.action} Result: ${s.result}`;
}

export function buildProfileBlock(resume: ResumeProfile | null, profile: UserProfile | null): string {
  const lines: string[] = [];
  const name = resume?.name || profile?.name;
  if (name) lines.push(`Name: ${name}`);
  const current = resume?.currentRole || resume?.roles[0] && `${resume.roles[0].title} at ${resume.roles[0].company}`;
  if (current) lines.push(`Current/most recent role: ${current}`);
  if (resume?.yearsExperience) lines.push(`Years of experience: about ${resume.yearsExperience}`);
  const summary = resume?.summary || profile?.summary;
  if (summary) lines.push(`Summary: ${truncate(summary, 320)}`);
  const skills = list([...(resume?.skills ?? []), ...(profile?.skills ?? []), ...(resume?.tools ?? [])], MAX_SKILLS);
  if (skills.length) lines.push(`Key skills and tools: ${skills.join(', ')}`);
  if (resume?.education.length) {
    lines.push(
      `Education: ${resume.education
        .slice(0, 3)
        .map((e) => [e.degree, e.field, e.institution, e.year].filter(Boolean).join(', '))
        .join('; ')}`,
    );
  } else if (profile?.education) lines.push(`Education: ${truncate(profile.education, 160)}`);
  if (resume?.certifications.length) lines.push(`Certifications: ${resume.certifications.slice(0, 5).join('; ')}`);
  if (profile?.preferredStyle) lines.push(STYLE_HINTS[profile.preferredStyle]);
  return defang(lines.join('\n'));
}

export function buildRoleBlock(interview: Interview | null): string {
  if (!interview) return '';
  const jd = interview.jdAnalysis;
  const lines: string[] = [];
  lines.push(`Target role: ${interview.jobTitle || jd?.jobTitle || 'not specified'}${interview.company ? ` at ${interview.company}` : ''}`);
  lines.push(`Interview type: ${interview.interviewType}`);
  const reqs = list([...(jd?.requiredSkills ?? []), ...(jd?.competencies ?? []), ...(jd?.responsibilities ?? [])], 8);
  if (reqs.length) lines.push(`What the role asks for: ${reqs.map((r) => truncate(r, 90)).join('; ')}`);
  if (interview.companyNotes.trim()) lines.push(`Company notes (from the candidate): ${truncate(interview.companyNotes.trim().replace(/\s+/g, ' '), 380)}`);
  return defang(lines.join('\n'));
}

export function buildInterviewContext(input: ContextInput): InterviewContext {
  const { interview, resume, profile, stories } = input;
  const index = new HybridIndex();
  const factsById = new Map<string, Fact>();
  const storiesById = new Map<string, Story>();
  const corpus: string[] = [];

  const facts: Fact[] = [...(resume?.facts ?? [])];
  for (const [i, text] of (profile?.extraFacts ?? []).entries()) {
    if (text.trim()) {
      facts.push({ id: `user${i}`, kind: 'note', text: text.trim(), source: 'user', label: 'Provided by the candidate', evidence: text.trim(), tags: [] });
    }
  }
  for (const f of facts) {
    factsById.set(f.id, f);
    index.add({ id: f.id, kind: f.source === 'user' ? 'note' : 'fact', text: f.label ? `${f.label}. ${f.text}` : f.text, refId: f.id, label: f.label, factKind: f.kind });
    corpus.push(f.text, f.label ?? '');
  }
  for (const s of stories) {
    storiesById.set(s.id, s);
    const text = storyText(s);
    index.add({ id: s.id, kind: 'story', text: `${text} ${s.skills.join(' ')} ${s.tags.join(' ')}`, refId: s.id, label: s.title });
    corpus.push(text, ...s.skills, ...s.tags);
  }
  // Job description + company notes are retrievable as role context, never as candidate experience.
  const jd = interview?.jobDescription.trim();
  if (jd) chunkText(jd, 45).slice(0, 40).forEach((c, i) => index.add({ id: `jd${i}`, kind: 'jd', text: c, label: 'Job description' }));
  const notes = interview?.companyNotes.trim();
  if (notes) chunkText(notes, 45).slice(0, 20).forEach((c, i) => index.add({ id: `co${i}`, kind: 'company', text: c, label: 'Company notes' }));

  const profileBlock = buildProfileBlock(resume, profile);
  const roleBlock = buildRoleBlock(interview);
  corpus.push(profileBlock, interview?.company ?? '', interview?.jobTitle ?? '');
  corpus.push(...(resume?.roles.map((r) => `${r.title} ${r.company}`) ?? []));

  const style = profile?.preferredStyle ?? 'conversational';
  const version = hashHex(
    [PROMPT_VERSION, profileBlock, roleBlock, facts.map((f) => f.id + f.text).join('|'), stories.map((s) => s.id + s.updatedAt).join('|'), input.customInstructions ?? ''].join(''),
  );
  return {
    interviewId: interview?.id ?? null,
    version,
    profileBlock,
    roleBlock,
    index,
    factsById,
    storiesById,
    corpus,
    style,
    customInstructions: input.customInstructions ?? '',
    hasCandidateMaterial: facts.length + stories.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Retrieval per question                                              */
/* ------------------------------------------------------------------ */

export interface RetrievedFact {
  id: string;
  label: string;
  text: string;
  score: number;
}

export interface RetrievedContext {
  facts: RetrievedFact[];
  story: { id: string; title: string; text: string; score: number } | null;
  roleLines: string[];
  confidence: number;
  summary: RetrievalSummary;
}

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

export interface RetrieveOptions {
  mode: AnswerMode;
  kind: QuestionKind;
  /** Fact ids that supported the previous answer; carried over for follow-ups. */
  carryFactIds?: string[];
  carryStoryId?: string | null;
}

const MIN_RELEVANT = 0.14;

export function retrieveForQuestion(ctx: InterviewContext, question: string, opts: RetrieveOptions): RetrievedContext {
  const behavioral = opts.kind === 'behavioral' || opts.mode === 'star';
  const maxFacts = opts.mode === 'detailed' || opts.mode === 'star' ? 6 : opts.mode === 'concise' || opts.mode === 'followup' ? 3 : 5;

  const hits = ctx.index.search(question, {
    k: 14,
    kinds: ['fact', 'story', 'note'],
    kindBoost: behavioral ? { story: 1.25 } : { story: 0.9 },
  });
  const factHits = hits.filter((h) => h.chunk.kind !== 'story' && h.score >= MIN_RELEVANT).slice(0, maxFacts);
  const storyHit = hits.find((h) => h.chunk.kind === 'story' && h.score >= 0.2) ?? null;
  const roleHits = ctx.index.search(question, { k: 2, kinds: ['jd', 'company'], minScore: 0.22 });

  const facts: RetrievedFact[] = [];
  const seen = new Set<string>();
  const push = (id: string, score: number) => {
    const f = ctx.factsById.get(id);
    if (!f || seen.has(id)) return;
    seen.add(id);
    facts.push({ id, label: f.label ?? '', text: f.text, score });
  };
  for (const id of opts.carryFactIds ?? []) push(id, 0.5);
  for (const h of factHits) if (h.chunk.refId) push(h.chunk.refId, h.score);

  // Generic questions ("What are your strengths?", "Tell me about yourself") share no words with any single fact,
  // yet are best answered from the candidate's signature material: summary, quantified achievements, leadership, skills.
  if (facts.length < 2 && ['hr', 'other', 'closing', 'leadership'].includes(opts.kind)) {
    const rank = (f: { kind: string; text: string }): number => (f.kind === 'summary' ? 0 : f.kind === 'achievement' && /\d/.test(f.text) ? 1 : f.kind === 'leadership' ? 2 : f.kind === 'achievement' ? 3 : f.kind === 'skill' ? 4 : 9);
    const signature = [...ctx.factsById.values()].filter((f) => rank(f) < 9).sort((a, b) => rank(a) - rank(b));
    for (const f of signature) {
      if (facts.length >= 3) break;
      push(f.id, 0.2);
    }
  }

  // Keep the fact block within a token budget so the prompt (and TTFT) stays small.
  let budget = 520;
  const kept: RetrievedFact[] = [];
  for (const f of facts) {
    const cost = approxTokens(f.text + f.label) + 4;
    if (budget - cost < 0 && kept.length > 0) break;
    budget -= cost;
    kept.push(f);
  }

  let story: RetrievedContext['story'] = null;
  const storyId = storyHit?.chunk.refId ?? opts.carryStoryId ?? null;
  const st = storyId ? ctx.storiesById.get(storyId) : undefined;
  if (st) story = { id: st.id, title: st.title, text: `Situation: ${st.situation}\nTask: ${st.task}\nAction: ${st.action}\nResult: ${st.result}`, score: storyHit?.score ?? 0.5 };

  const confidence = Math.max(factHits[0]?.score ?? 0, storyHit?.score ?? 0);
  const roleLines = roleHits.map((h) => h.chunk.text);
  const labels = uniq([...(story ? [story.title] : []), ...kept.map((f) => f.label).filter(Boolean)]).slice(0, 4);
  const tokens = kept.reduce((n, f) => n + approxTokens(f.text), 0) + (story ? approxTokens(story.text) : 0);
  return {
    facts: kept,
    story,
    roleLines,
    confidence,
    summary: {
      factIds: kept.map((f) => f.id),
      storyIds: story ? [story.id] : [],
      confidence: Math.round(confidence * 100) / 100,
      labels,
      usedResume: kept.some((f) => ctx.factsById.get(f.id)?.source === 'resume'),
      usedJd: roleLines.length > 0 || ctx.roleBlock.length > 0,
      usedStory: !!story,
      tokensApprox: tokens,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */

export interface PriorExchange {
  question: string;
  /** What the candidate actually said (if transcribed) or the suggested answer. */
  answer: string;
}

export interface PromptParams {
  ctx: InterviewContext;
  question: string;
  kind: QuestionKind;
  mode: AnswerMode;
  isFollowUp: boolean;
  retrieved: RetrievedContext;
  previous: PriorExchange[];
  adjustments?: string[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
  tokensApprox: number;
}

export function buildAnswerPrompt(p: PromptParams): BuiltPrompt {
  const { ctx, retrieved } = p;
  // Order matters: static material first so providers with automatic prefix caching can reuse it across
  // questions; everything that changes per question comes last.
  const parts: string[] = [];
  if (ctx.profileBlock) parts.push(`<candidate_profile>\n${ctx.profileBlock}\n</candidate_profile>`);
  if (ctx.roleBlock) parts.push(`<role>\n${ctx.roleBlock}\n</role>`);

  if (retrieved.facts.length > 0) {
    parts.push(`<candidate_facts>\n${defang(retrieved.facts.map((f) => `- ${f.label ? `[${f.label}] ` : ''}${f.text}`).join('\n'))}\n</candidate_facts>`);
  } else {
    parts.push('<candidate_facts>\n(no facts matched this question)\n</candidate_facts>');
  }
  if (retrieved.story) parts.push(`<story title="${defang(retrieved.story.title).replace(/"/g, "'")}">\n${defang(retrieved.story.text)}\n</story>`);
  if (retrieved.roleLines.length > 0) parts.push(`<role_context>\n${defang(retrieved.roleLines.map((l) => `- ${truncate(l, 220)}`).join('\n'))}\n</role_context>`);

  if (p.previous.length > 0) {
    if (p.isFollowUp) {
      const last = p.previous[p.previous.length - 1];
      parts.push(
        `<recent_exchange>\nInterviewer: ${defang(last.question)}\nCandidate: ${defang(truncate(last.answer, 700))}\n</recent_exchange>\nThe new question is a follow-up to this exchange; "you" and "that" refer to it.`,
      );
    } else {
      const earlier = p.previous.slice(-3).map((e) => `- ${defang(truncate(e.question, 140))}`);
      parts.push(`<earlier_questions>\n${earlier.join('\n')}\n</earlier_questions>\nAvoid reusing an example that was already used above unless asked about it.`);
    }
  }
  if (p.adjustments && p.adjustments.length > 0) parts.push(`<session_notes>\n${defang(p.adjustments.map((a) => `- ${a}`).join('\n'))}\n</session_notes>`);

  const kindHint = KIND_HINTS[p.kind];
  parts.push(`<question kind="${p.kind}">${defang(p.question)}</question>`);
  parts.push(`<format>${ANSWER_FORMATS[p.mode]}${kindHint ? `\n${kindHint}` : ''}</format>`);

  const user = parts.join('\n\n');
  const system = withCustomInstructions(ANSWER_SYSTEM, ctx.customInstructions);
  return { system, user, tokensApprox: approxTokens(system) + approxTokens(user) };
}

/** Text that must stay stable across requests: used to pre-warm provider-side prefix caches. */
export function staticPrefix(ctx: InterviewContext): string {
  return [ctx.profileBlock && `<candidate_profile>\n${ctx.profileBlock}\n</candidate_profile>`, ctx.roleBlock && `<role>\n${ctx.roleBlock}\n</role>`].filter(Boolean).join('\n\n');
}

/** Cut an answer that hit the token cap back to its last complete sentence. */
export function trimToSentence(text: string): string {
  const t = text.trimEnd();
  if (/[.!?…"”)\]]$/.test(t)) return t;
  const m = /^[\s\S]*[.!?…](?=\s|$)/.exec(t);
  return m && m[0].length > t.length * 0.3 ? m[0] : t;
}
