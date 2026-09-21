import { isAiError } from '@shared/errors';
import type { DocumentSource, Fact, Interview, JdAnalysis, MatchAnalysis, ResumeProfile } from '@shared/types';
import { defang, hashHex, truncate } from '@shared/util';
import { JD_ANALYZE_SYSTEM, MATCH_ENRICH_SYSTEM, RESUME_ANALYZE_SYSTEM } from '@prompts/index';
import type { LlmGateway } from '@core/live/types';
import { groundProfile } from '@core/prep/groundResume';
import { analyzeJdHeuristic } from '@core/prep/jdHeuristic';
import { matchResumeToJd } from '@core/prep/matcher';
import { parseResumeHeuristic } from '@core/prep/resumeHeuristic';
import { tokenJaccard } from '@core/text/tokenize';
import { generateJson } from '../ai/structured';
import type { Repos } from '../db/repos';
import type { ScopedLogger } from '../logging';
import { JdSchema, MatchEnrichSchema, RawResumeSchema } from './schemas';

const MAX_AI_RESUME_CHARS = 24_000;
const MAX_AI_JD_CHARS = 12_000;

export interface AnalysisDeps {
  repos: Repos;
  gateway: LlmGateway;
  log: ScopedLogger;
}

/** Whether an AI model is set up for a task; used to decide if "Use AI" can be honoured. */
export type AiAvailability = () => boolean;

function mergeFacts(primary: Fact[], secondary: Fact[]): Fact[] {
  const out = [...primary];
  for (const f of secondary) {
    if (!out.some((o) => o.id === f.id || tokenJaccard(o.text, f.text) >= 0.7)) out.push(f);
  }
  return out;
}

export class AnalysisService {
  constructor(
    private readonly d: AnalysisDeps,
    private readonly aiAvailable: AiAvailability,
  ) {}

  /** Parse a résumé: offline parser always; AI structured extraction on top when available, grounded against the text. */
  async parseResume(
    text: string,
    opts: { useAi: boolean; signal: AbortSignal },
  ): Promise<{ profile: ResumeProfile; method: 'llm' | 'heuristic'; warnings: string[] }> {
    const heuristic = parseResumeHeuristic(text);
    const warnings: string[] = [];
    if (!opts.useAi) return { profile: heuristic, method: 'heuristic', warnings };
    if (!this.aiAvailable()) {
      warnings.push('No AI model is set up, so the offline parser was used. Add a provider in Settings for richer analysis.');
      return { profile: heuristic, method: 'heuristic', warnings };
    }
    try {
      const body = text.length > MAX_AI_RESUME_CHARS ? text.slice(0, MAX_AI_RESUME_CHARS) : text;
      if (body.length < text.length) warnings.push('The résumé is long; AI analysis used the first part only.');
      const { value } = await generateJson(this.d.gateway, {
        task: 'prep',
        system: RESUME_ANALYZE_SYSTEM,
        user: `<resume>\n${defang(body)}\n</resume>`,
        schema: RawResumeSchema,
        maxTokens: 4000,
        signal: opts.signal,
      });
      const grounded = groundProfile(value, text);
      warnings.push(...grounded.warnings);
      const ai = grounded.profile;
      // The AI gives better structure; the offline parser guarantees nothing verbatim is missed. Keep both, de-duplicated.
      const merged: ResumeProfile = {
        ...ai,
        name: ai.name ?? heuristic.name,
        headline: ai.headline ?? heuristic.headline,
        summary: ai.summary ?? heuristic.summary,
        currentRole: ai.currentRole ?? heuristic.currentRole,
        yearsExperience: ai.yearsExperience ?? heuristic.yearsExperience,
        roles: ai.roles.length > 0 ? ai.roles : heuristic.roles,
        skills: ai.skills.length > 0 ? ai.skills : heuristic.skills,
        tools: ai.tools.length > 0 ? ai.tools : heuristic.tools,
        technologies: ai.technologies.length > 0 ? ai.technologies : heuristic.technologies,
        education: ai.education.length > 0 ? ai.education : heuristic.education,
        certifications: ai.certifications.length > 0 ? ai.certifications : heuristic.certifications,
        facts: mergeFacts(ai.facts, heuristic.facts),
      };
      return { profile: merged, method: 'llm', warnings };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      const reason = isAiError(err) ? err.message : 'unexpected error';
      this.d.log.warn('AI résumé analysis failed; using offline parser', { code: isAiError(err) ? err.code : 'unknown' });
      warnings.push(`AI analysis was unavailable (${truncate(reason, 140)}). The offline parser was used instead.`);
      return { profile: heuristic, method: 'heuristic', warnings };
    }
  }

  async analyzeJd(text: string, hints: { jobTitle?: string; company?: string }, opts: { useAi: boolean; signal: AbortSignal }): Promise<JdAnalysis> {
    const heuristic = analyzeJdHeuristic(text, hints);
    if (!opts.useAi || !this.aiAvailable() || text.trim().length < 40) return heuristic;
    try {
      const { value } = await generateJson(this.d.gateway, {
        task: 'prep',
        system: JD_ANALYZE_SYSTEM,
        user: `<job_description>\n${defang(text.slice(0, MAX_AI_JD_CHARS))}\n</job_description>`,
        schema: JdSchema,
        maxTokens: 2500,
        signal: opts.signal,
      });
      const v = value;
      return {
        jobTitle: hints.jobTitle?.trim() || v.jobTitle || heuristic.jobTitle,
        company: hints.company?.trim() || v.company || heuristic.company,
        responsibilities: v.responsibilities.length ? v.responsibilities : heuristic.responsibilities,
        requiredSkills: v.requiredSkills.length ? v.requiredSkills : heuristic.requiredSkills,
        preferredSkills: v.preferredSkills.length ? v.preferredSkills : heuristic.preferredSkills,
        yearsExperience: v.yearsExperience ?? heuristic.yearsExperience,
        tools: v.tools.length ? v.tools : heuristic.tools,
        technologies: v.technologies.length ? v.technologies : heuristic.technologies,
        behavioralRequirements: v.behavioralRequirements.length ? v.behavioralRequirements : heuristic.behavioralRequirements,
        leadershipRequirements: v.leadershipRequirements.length ? v.leadershipRequirements : heuristic.leadershipRequirements,
        domainKnowledge: v.domainKnowledge.length ? v.domainKnowledge : heuristic.domainKnowledge,
        keywords: v.keywords.length ? v.keywords : heuristic.keywords,
        kpis: v.kpis.length ? v.kpis : heuristic.kpis,
        competencies: v.competencies.length ? v.competencies : heuristic.competencies,
        method: 'llm',
      };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      this.d.log.warn('AI JD analysis failed; using offline analysis', { code: isAiError(err) ? err.code : 'unknown' });
      return heuristic;
    }
  }

  /** Local résumé↔JD comparison, optionally enriched by the model (transferable experience, likely questions). */
  async match(resume: ResumeProfile, resumeText: string, jd: JdAnalysis, opts: { useAi: boolean; signal: AbortSignal }): Promise<MatchAnalysis> {
    const local = matchResumeToJd(resume, jd, resumeText);
    if (!opts.useAi || !this.aiAvailable() || resume.facts.length === 0) return local;
    try {
      const gaps = [...local.missing, ...local.partial].slice(0, 12).map((m) => `- ${m.requirement} (${m.strength})`);
      const facts = resume.facts.slice(0, 60).map((f) => `[${f.id}] ${f.label ? f.label + ': ' : ''}${truncate(f.text, 200)}`);
      const { value } = await generateJson(this.d.gateway, {
        task: 'prep',
        system: MATCH_ENRICH_SYSTEM,
        user: `<candidate_facts>\n${defang(facts.join('\n'))}\n</candidate_facts>\n<requirements_not_fully_met>\n${defang(gaps.join('\n')) || '(none)'}\n</requirements_not_fully_met>\n<role>${defang(jd.jobTitle ?? '')}</role>`,
        schema: MatchEnrichSchema,
        maxTokens: 1800,
        signal: opts.signal,
      });
      const ids = new Set(resume.facts.map((f) => f.id));
      // Every citation must be a real fact; transfers with no valid support are discarded.
      const transferable = value.transferable
        .map((t) => ({ ...t, fromFactIds: t.fromFactIds.filter((id) => ids.has(id)) }))
        .filter((t) => t.fromFactIds.length > 0 && t.explanation);
      return {
        ...local,
        transferable,
        likelyQuestions: [...new Set([...value.likelyQuestions, ...local.likelyQuestions])].slice(0, 12),
        prepAreas: [...new Set([...value.prepAreas, ...local.prepAreas])].slice(0, 10),
        method: 'local+llm',
      };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      this.d.log.warn('AI match enrichment failed; using local match', { code: isAiError(err) ? err.code : 'unknown' });
      return local;
    }
  }

  /** Create + parse a résumé record from raw text. */
  async createResume(name: string, source: DocumentSource, text: string, opts: { useAi: boolean; signal: AbortSignal }) {
    const parsed = await this.parseResume(text, opts);
    return this.d.repos.saveResume({ name, source, rawText: text, profile: parsed.profile, parseMethod: parsed.method, warnings: parsed.warnings });
  }

  async reparseResume(id: string, opts: { useAi: boolean; signal: AbortSignal }) {
    const rec = this.d.repos.getResume(id);
    if (!rec) throw new Error('Résumé not found.');
    const parsed = await this.parseResume(rec.rawText, opts);
    return this.d.repos.saveResume({ id, name: rec.name, source: rec.source, rawText: rec.rawText, profile: parsed.profile, parseMethod: parsed.method, warnings: parsed.warnings });
  }

  /** Full analysis for an interview: JD analysis + résumé match. */
  async analyzeInterview(interview: Interview, opts: { useAi: boolean; signal: AbortSignal }): Promise<Interview> {
    const jd = await this.analyzeJd(interview.jobDescription, { jobTitle: interview.jobTitle, company: interview.company }, opts);
    let match: MatchAnalysis | null = null;
    const resume = interview.resumeId ? this.d.repos.getResume(interview.resumeId) : null;
    if (resume) match = await this.match(resume.profile, resume.rawText, jd, opts);
    return this.d.repos.updateInterview(interview.id, { jdAnalysis: jd, match, status: 'ready' });
  }
}

export function contentHash(...parts: string[]): string {
  return hashHex(parts.join(''));
}
