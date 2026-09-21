import { z } from 'zod';
import { list, obj, str as jstr, strList } from '../ai/schema';

/**
 * Schemas for everything a model returns. They are lenient about shape (models drift) but strict about types, and
 * every list is capped so a runaway reply cannot bloat storage or the UI.
 */
const str = z.string().trim();
/**
 * A list of strings that survives a model's habits: numbers become text, junk entries are dropped, and a list that is
 * one item too long keeps its first `max` items (it used to be discarded whole, leaving an empty section).
 */
const strs = (max = 40) =>
  z
    .preprocess((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : v), z.array(z.string().trim()).transform((a) => a.filter(Boolean).slice(0, max)))
    .default([])
    .catch([]);
/** A list of objects that keeps its first `max` items instead of discarding all of them. */
const capped = <S extends z.ZodType>(item: S, max: number) => z.array(item).transform((a) => a.slice(0, max)).default([]).catch([]);
const optStr = z.union([z.string().trim(), z.null()]).optional().catch(undefined);

export const RawResumeSchema = z.object({
  name: optStr,
  headline: optStr,
  summary: optStr,
  currentRole: optStr,
  yearsExperience: z.number().nullable().optional().catch(undefined),
  roles: z
    .array(
      z.object({
        title: z.string().default(''),
        company: z.string().default(''),
        location: optStr,
        start: optStr,
        end: optStr,
        current: z.boolean().optional().catch(false),
        responsibilities: strs(30),
        achievements: strs(30),
        metrics: strs(30),
        tools: strs(30),
        leadership: strs(20),
      }),
    )
    .max(30)
    .default([])
    .catch([]),
  skills: strs(80),
  tools: strs(60),
  technologies: strs(60),
  education: z
    .array(z.object({ institution: z.string().default(''), degree: optStr, field: optStr, year: optStr }))
    .max(10)
    .default([])
    .catch([]),
  certifications: strs(30),
  projects: z
    .array(z.object({ name: z.string().default(''), description: optStr, technologies: strs(20) }))
    .max(20)
    .default([])
    .catch([]),
  metrics: strs(40),
  leadership: strs(20),
  industries: strs(15),
  facts: z
    .array(z.object({ kind: z.string().default('note'), text: z.string().default(''), label: optStr, evidence: z.string().default(''), tags: strs(8) }))
    .max(120)
    .default([])
    .catch([]),
});

export const JdSchema = z.object({
  jobTitle: optStr,
  company: optStr,
  responsibilities: strs(25),
  requiredSkills: strs(30),
  preferredSkills: strs(20),
  yearsExperience: optStr,
  tools: strs(30),
  technologies: strs(30),
  behavioralRequirements: strs(15),
  leadershipRequirements: strs(15),
  domainKnowledge: strs(15),
  keywords: strs(30),
  kpis: strs(15),
  competencies: strs(20),
});

export const MatchEnrichSchema = z.object({
  transferable: capped(z.object({ requirement: str, fromFactIds: strs(6), explanation: str }), 12),
  likelyQuestions: strs(12),
  prepAreas: strs(10),
});

export const AboutSchema = z.object({
  tellMeAboutYourself: str.default(''),
  professionalSummary: str.default(''),
  careerJourney: str.default(''),
  currentRole: str.default(''),
  strengths: strs(10),
  relevantExperience: strs(10),
});

export const CompanySchema = z.object({
  summary: str.default(''),
  fromYourNotes: strs(12),
  toResearch: strs(12),
  questionsToAsk: strs(12),
});

export const RoleSchema = z.object({
  responsibilities: strs(15),
  skillsRequired: strs(20),
  likelyAreas: strs(12),
  terminology: capped(z.object({ term: str, meaning: str }), 12),
});

const CATS = ['hr', 'behavioral', 'technical', 'situational', 'role-specific', 'leadership', 'follow-up'] as const;
export const QuestionsSchema = z.object({
  questions: z
    .array(z.object({ category: z.enum(CATS).catch('role-specific'), text: str, why: optStr }))
    .min(1)
    .transform((a) => a.slice(0, 60)),
});

/** The same replies as JSON Schema, for providers that can enforce one. Flat and small on purpose. */
export const ABOUT_JSON_SCHEMA = obj({ tellMeAboutYourself: jstr(), professionalSummary: jstr(), careerJourney: jstr(), currentRole: jstr(), strengths: strList(), relevantExperience: strList() });
export const ABOUT_KEYS = ['tellMeAboutYourself', 'professionalSummary', 'careerJourney', 'currentRole', 'strengths', 'relevantExperience'];
export const COMPANY_JSON_SCHEMA = obj({ summary: jstr(), fromYourNotes: strList(), toResearch: strList(), questionsToAsk: strList() });
export const COMPANY_KEYS = ['summary', 'fromYourNotes', 'toResearch', 'questionsToAsk'];
export const ROLE_JSON_SCHEMA = obj({ responsibilities: strList(), skillsRequired: strList(), likelyAreas: strList(), terminology: list(obj({ term: jstr(), meaning: jstr() })) });
export const ROLE_KEYS = ['responsibilities', 'skillsRequired', 'likelyAreas', 'terminology'];
export const QUESTIONS_JSON_SCHEMA = obj({ questions: list(obj({ category: { type: 'string', enum: [...CATS] }, text: jstr(), why: jstr() }, ['why'])) });
export const QUESTIONS_KEYS = ['questions'];

const level = z.enum(['strong', 'adequate', 'weak']).catch('adequate');
const crit = z.object({ level, note: str.default('') });
export const EvaluationSchema = z.object({
  relevance: crit,
  completeness: crit,
  structure: crit,
  conciseness: crit,
  covered: strs(8),
  missing: strs(8),
  improvements: strs(8),
  improvedAnswer: str.default(''),
});

export const StoryDraftSchema = z.object({
  title: str.default(''),
  situation: str.default(''),
  task: str.default(''),
  action: str.default(''),
  result: str.default(''),
  skills: strs(12),
  tags: strs(12),
});
