import type { Fact, FactKind, ResumeProfile } from '@shared/types';
import { hashHex, uniq } from '@shared/util';
import { contentTokens, norm, tokenCoverage } from './util';

/** What the model returns for résumé analysis (loosely typed: it is untrusted until grounded). */
export interface RawResumeAnalysis {
  name?: string | null;
  headline?: string | null;
  summary?: string | null;
  currentRole?: string | null;
  yearsExperience?: number | null;
  roles?: {
    title?: string;
    company?: string;
    location?: string | null;
    start?: string | null;
    end?: string | null;
    current?: boolean;
    responsibilities?: string[];
    achievements?: string[];
    metrics?: string[];
    tools?: string[];
    leadership?: string[];
  }[];
  skills?: string[];
  tools?: string[];
  technologies?: string[];
  education?: { institution?: string; degree?: string | null; field?: string | null; year?: string | null }[];
  certifications?: string[];
  projects?: { name?: string; description?: string | null; technologies?: string[] }[];
  metrics?: string[];
  leadership?: string[];
  industries?: string[];
  facts?: { kind?: string; text?: string; label?: string | null; evidence?: string; tags?: string[] }[];
}

const FACT_KINDS = new Set<FactKind>(['summary', 'achievement', 'responsibility', 'skill', 'tool', 'education', 'certification', 'project', 'leadership', 'metric', 'industry', 'note']);

export interface GroundingResult {
  profile: ResumeProfile;
  dropped: number;
  warnings: string[];
}

/**
 * Anti-hallucination gate for AI résumé parsing. Nothing the model returns enters the knowledge base unless the
 * résumé text supports it: names, employers, titles, skills and every fact's evidence must be findable in the
 * source, and any number in a fact must appear in the source.
 */
export function groundProfile(raw: RawResumeAnalysis, sourceText: string): GroundingResult {
  const hay = ` ${norm(sourceText)} `;
  const srcLines = sourceText.split('\n').map((l) => norm(l)).filter((l) => l.length > 3);
  const srcDigits = new Set((sourceText.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((d) => d.replace(/,/g, '')));
  let dropped = 0;

  const has = (s: string | null | undefined): boolean => {
    const n = norm(s ?? '');
    return n.length >= 2 && hay.includes(` ${n} `);
  };
  const near = (s: string | null | undefined, min = 0.8): boolean => {
    const t = (s ?? '').trim();
    if (t.length < 4) return false;
    if (hay.includes(` ${norm(t)} `)) return true;
    return srcLines.some((l) => tokenCoverage(t, l) >= min) || tokenCoverage(t, sourceText) >= 0.98;
  };
  const keep = (list: string[] | undefined, strict = true): string[] => {
    const out: string[] = [];
    for (const item of list ?? []) {
      if (typeof item !== 'string') continue;
      if (strict ? has(item) : near(item, 0.7)) out.push(item.trim());
      else dropped++;
    }
    return uniq(out);
  };

  // Title and company must both be real AND appear together in the source: "Google" appearing in a certificate
  // name must not legitimise an invented "Senior Director at Google".
  const windows: string[] = [];
  for (let i = 0; i < srcLines.length; i++) windows.push(` ${srcLines.slice(i, i + 3).join(' ')} `);
  const coLocated = (a: string, b: string): boolean => {
    const na = ` ${norm(a)} `;
    const nb = ` ${norm(b)} `;
    return windows.some((w) => w.includes(na) && w.includes(nb));
  };

  const roles: ResumeProfile['roles'] = [];
  for (const r of raw.roles ?? []) {
    const title = (r.title ?? '').trim();
    const company = (r.company ?? '').trim();
    const ok = (title || company) && (!title || has(title)) && (!company || has(company)) && (!title || !company || coLocated(title, company));
    if (!ok) {
      dropped++;
      continue;
    }
    roles.push({
      title,
      company,
      location: r.location && has(r.location) ? r.location : undefined,
      start: r.start ?? undefined,
      end: r.end ?? undefined,
      current: !!r.current,
      responsibilities: keep(r.responsibilities, false),
      achievements: keep(r.achievements, false),
      metrics: keep(r.metrics),
      tools: keep(r.tools),
      leadership: keep(r.leadership, false),
    });
  }

  const facts: Fact[] = [];
  for (const f of raw.facts ?? []) {
    const text = (f.text ?? '').trim();
    const evidence = (f.evidence ?? '').trim();
    const kind = (FACT_KINDS.has(f.kind as FactKind) ? f.kind : 'note') as FactKind;
    if (!text || !evidence || !near(evidence, 0.9)) {
      dropped++;
      continue;
    }
    // The statement must stay within its evidence: numbers must exist in the source, and wording must overlap.
    const numbers = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((d) => d.replace(/,/g, ''));
    if (numbers.some((n) => !srcDigits.has(n))) {
      dropped++;
      continue;
    }
    if (contentTokens(text).length >= 4 && tokenCoverage(text, evidence + ' ' + sourceText.slice(0, 0)) < 0.55 && tokenCoverage(text, sourceText) < 0.7) {
      dropped++;
      continue;
    }
    const id = `f_${hashHex(kind + '|' + (f.label ?? '') + text).slice(0, 10)}`;
    if (facts.some((x) => x.id === id)) continue;
    facts.push({ id, kind, text, source: 'resume', label: f.label ?? undefined, evidence, tags: (f.tags ?? []).filter((t): t is string => typeof t === 'string').slice(0, 6) });
  }

  const profile: ResumeProfile = {
    name: raw.name && has(raw.name) ? raw.name : undefined,
    headline: raw.headline && near(raw.headline, 0.7) ? raw.headline : undefined,
    summary: raw.summary && near(raw.summary, 0.6) ? raw.summary : undefined,
    currentRole: raw.currentRole && (has(raw.currentRole) || raw.currentRole.split(/\s+(?:at|@|,|-|–)\s+/).some((p) => has(p))) ? raw.currentRole : undefined,
    yearsExperience: typeof raw.yearsExperience === 'number' && raw.yearsExperience > 0 && raw.yearsExperience < 60 ? Math.round(raw.yearsExperience) : undefined,
    roles,
    skills: keep(raw.skills),
    tools: keep(raw.tools),
    technologies: keep(raw.technologies),
    education: (raw.education ?? []).filter((e) => (has(e.institution) ? true : (dropped++, false))).map((e) => ({ institution: (e.institution ?? '').trim(), degree: e.degree ?? undefined, field: e.field ?? undefined, year: e.year ?? undefined })),
    certifications: keep(raw.certifications, false),
    projects: (raw.projects ?? []).filter((p) => (has(p.name) ? true : (dropped++, false))).map((p) => ({ name: (p.name ?? '').trim(), description: p.description ?? undefined, technologies: keep(p.technologies) })),
    metrics: keep(raw.metrics),
    leadership: keep(raw.leadership, false),
    industries: keep(raw.industries, false),
    facts,
  };
  const warnings = dropped > 0 ? [`${dropped} item${dropped === 1 ? '' : 's'} returned by the AI could not be found in your résumé text and were discarded.`] : [];
  return { profile, dropped, warnings };
}
