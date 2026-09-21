import type { JdAnalysis, MatchAnalysis, MatchItem, ResumeProfile } from '@shared/types';
import { truncate, uniq } from '@shared/util';
import { HybridIndex } from '../retrieval';
import { escapeRe } from './util';

interface Requirement {
  text: string;
  category: MatchItem['category'];
  weight: number;
}

/** Local résumé↔JD comparison. Every "strong" or "partial" verdict cites the résumé facts that justify it. */
export function matchResumeToJd(resume: ResumeProfile, jd: JdAnalysis, resumeText: string): MatchAnalysis {
  const index = new HybridIndex();
  for (const f of resume.facts) index.add({ id: f.id, kind: 'fact', text: f.label ? `${f.label}. ${f.text}` : f.text, refId: f.id, label: f.label });

  const reqs: Requirement[] = [];
  const seen = new Set<string>();
  const add = (text: string, category: Requirement['category'], weight = 1): void => {
    const t = text.trim();
    const key = t.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
    if (t.length < 2 || seen.has(key)) return;
    seen.add(key);
    reqs.push({ text: truncate(t, 140), category, weight });
  };
  jd.requiredSkills.forEach((r) => add(r, 'skill'));
  jd.tools.forEach((r) => add(r, 'tool'));
  jd.technologies.forEach((r) => add(r, 'tool'));
  jd.responsibilities.forEach((r) => add(r, 'responsibility', 0.85));
  jd.competencies.forEach((r) => add(r, 'competency', 0.8));
  jd.leadershipRequirements.forEach((r) => add(r, 'experience', 0.8));
  jd.preferredSkills.forEach((r) => add(r, 'skill', 0.5));
  const limited = reqs.slice(0, 40);

  const haystackTerms = [...resume.skills, ...resume.tools, ...resume.technologies, ...resume.certifications].map((s) => s.toLowerCase());
  const lowerText = resumeText.toLowerCase();

  const items: MatchItem[] = limited.map((r) => {
    const words = r.text.split(/\s+/).length;
    // Short literal requirements (a tool, a named skill) are matched by presence, which is more reliable than similarity.
    if (words <= 3) {
      const re = new RegExp(`(^|[^a-z0-9+#])${escapeRe(r.text.toLowerCase())}(?![a-z0-9+#])`);
      const literal = re.test(lowerText) || haystackTerms.some((t) => t === r.text.toLowerCase());
      if (literal) {
        const cited = resume.facts.filter((f) => re.test(f.text.toLowerCase())).slice(0, 2);
        return {
          requirement: r.text,
          category: r.category,
          strength: 'strong',
          score: 1,
          evidence: cited.length ? cited.map((f) => ({ factId: f.id, text: truncate(f.text, 160) })) : [],
          note: cited.length ? undefined : 'Listed in your skills.',
        };
      }
    }
    const hits = index.search(r.text, { k: 2, kinds: ['fact'] });
    const best = hits[0]?.score ?? 0;
    const strength: MatchItem['strength'] = best >= 0.42 ? 'strong' : best >= 0.22 ? 'partial' : 'missing';
    return {
      requirement: r.text,
      category: r.category,
      strength,
      score: Math.round(Math.min(1, best) * 100) / 100,
      evidence: strength === 'missing' ? [] : hits.filter((h) => h.score >= 0.18).map((h) => ({ factId: h.chunk.refId ?? h.chunk.id, text: truncate(h.chunk.text, 160) })),
    };
  });

  const strong = items.filter((i) => i.strength === 'strong');
  const partial = items.filter((i) => i.strength === 'partial');
  const missing = items.filter((i) => i.strength === 'missing');

  const likelyQuestions = uniq([
    ...missing.slice(0, 3).map((m) => `Can you tell me about your experience with ${m.requirement.toLowerCase()}?`),
    ...partial.slice(0, 2).map((m) => `How have you applied ${m.requirement.toLowerCase()} in your work?`),
    ...strong.filter((s) => s.category === 'responsibility').slice(0, 2).map((s) => `Walk me through how you have handled: ${s.requirement.toLowerCase()}.`),
    'Tell me about yourself and why this role.',
    'Tell me about a time you improved a process.',
    'Describe a situation where you had to influence a stakeholder without authority.',
  ]).slice(0, 8);
  const prepAreas = uniq([
    ...missing.slice(0, 4).map((m) => `Prepare an honest answer for "${m.requirement}" — say what you have done that is closest, or how you would learn it.`),
    ...partial.slice(0, 2).map((m) => `Strengthen your example for "${m.requirement}" with a concrete result.`),
  ]).slice(0, 6);

  return { strong, partial, missing, transferable: [], likelyQuestions, prepAreas, method: 'local', generatedAt: Date.now() };
}
