import type { JdAnalysis } from '@shared/types';
import { normalizeText, truncate, uniq } from '@shared/util';
import { tokenize } from '../text/tokenize';
import { KNOWN_COMPETENCIES, KNOWN_TOOLS, KPI_WORDS, LEADERSHIP_VERBS, TITLE_WORDS, findTerms } from './dictionary';

type Part = 'intro' | 'responsibilities' | 'required' | 'preferred' | 'ignore';

const HEAD: [Part, RegExp][] = [
  ['responsibilities', /^(key |main |core )?(responsibilit(y|ies)|duties|what you('|’)?ll do|what you will do|the role|your role|role overview|in this role|day[- ]to[- ]day|about the role|job summary|position summary)$/i],
  ['required', /^((basic|minimum|required|essential|key) )?(qualifications?|requirements?|skills( required)?|what you('|’)?ll bring|what you bring|what we('|’)?re looking for|who you are|you have|must[- ]haves?|about you|experience( required)?)$/i],
  ['preferred', /^(preferred|desired|nice[- ]to[- ]haves?|bonus|plus|good to have|additional)( qualifications?| skills)?( points)?$|^(nice to have|it would be great if you have)$/i],
  ['ignore', /^(benefits|perks|what we offer|compensation|salary|about (us|the company|the team)|who we are|our (values|culture|mission)|equal opportunity|how to apply|why join us|location)$/i],
];

const BULLET = /^\s*(?:[•·▪▫●○◦■□◆◇►▶✓✔➢➤*]|[-–—](?=\s)|\d{1,2}[.)](?=\s))\s*/;

function partOf(line: string): Part | null {
  const t = line
    .trim()
    .replace(/[:：]+$/, '')
    .replace(/^[\W_]+|[\W_]+$/g, '')
    .trim();
  if (!t || t.length > 50 || BULLET.test(line)) return null;
  for (const [p, re] of HEAD) if (re.test(t)) return p;
  return null;
}

const DOMAINS = ['logistics', 'supply chain', 'e-commerce', 'ecommerce', 'fintech', 'healthcare', 'saas', 'retail', 'banking', 'insurance', 'telecom', 'manufacturing', 'aviation', 'hospitality', 'education', 'energy', 'customer support', 'customer service', 'customer experience', 'fulfilment', 'fulfillment', 'warehouse', 'last-mile', 'payments', 'marketplace', 'consulting', 'advertising', 'media', 'gaming', 'pharma', 'real estate', 'automotive'];

const GENERIC = new Set(['experience', 'work', 'team', 'ability', 'skills', 'strong', 'role', 'years', 'including', 'support', 'business', 'company', 'looking', 'join', 'across', 'within', 'ensure', 'required', 'preferred', 'candidate', 'position', 'responsible', 'working', 'knowledge', 'understanding', 'excellent', 'related', 'etc', 'new', 'will', 'you', 'our', 'help', 'make', 'must']);

/** Break a section into bullet-level items. */
function items(lines: string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    if (!raw.trim()) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    if (BULLET.test(raw)) {
      if (cur) out.push(cur);
      cur = raw.replace(BULLET, '').trim();
    } else if (cur && /^[a-z(]/.test(raw.trim()) && !/[.!?]$/.test(cur)) cur += ` ${raw.trim()}`;
    else {
      if (cur) out.push(cur);
      cur = raw.trim();
    }
  }
  if (cur) out.push(cur);
  // A paragraph of sentences becomes one item per sentence.
  return out.flatMap((o) => (o.length > 220 ? o.split(/(?<=[.!?])\s+(?=[A-Z])/) : [o])).map((o) => truncate(o.trim(), 200)).filter((o) => o.length > 3);
}

const SKILL_LEAD = /(?:experience (?:with|in|using|of)|proficien\w+ (?:in|with)|knowledge of|familiar\w* with|expertise in|skilled in|background in|understanding of|hands-on (?:with|experience)|working knowledge of)\s+([^.;:\n]+)/gi;

function skillPhrases(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SKILL_LEAD)) {
    for (const piece of (m[1] ?? '').split(/,|\band\b|\bor\b|\/|;/)) {
      const p = piece.trim().replace(/^(a|an|the|of|in|with|using|strong|solid|deep|proven)\s+/i, '').replace(/\s+(is|are)\s+.*$/i, '');
      const words = p.split(/\s+/).length;
      if (p.length >= 2 && p.length <= 40 && words <= 5) out.push(p.replace(/[.)]$/, ''));
    }
  }
  return out;
}

export function analyzeJdHeuristic(rawText: string, hints: { jobTitle?: string; company?: string } = {}): JdAnalysis {
  const text = normalizeText(rawText);
  const lines = text.split('\n');

  const parts: Record<Part, string[]> = { intro: [], responsibilities: [], required: [], preferred: [], ignore: [] };
  let part: Part = 'intro';
  for (const line of lines) {
    const p = partOf(line);
    if (p) part = p;
    else parts[part].push(line);
  }
  // Unlabelled JD: treat bullets as responsibilities/requirements by their wording.
  const hasSections = parts.responsibilities.length + parts.required.length > 0;
  let responsibilities = items(parts.responsibilities);
  let required = items(parts.required);
  const preferred = items(parts.preferred);
  if (!hasSections) {
    const all = items(parts.intro);
    for (const it of all) {
      if (/\b(require[sd]?|must|minimum|degree|\d+\+?\s*years?|proficien|experience (?:with|in)|knowledge of)\b/i.test(it)) required.push(it);
      else responsibilities.push(it);
    }
  }
  responsibilities = uniq(responsibilities).slice(0, 16);
  required = uniq(required).slice(0, 16);

  let jobTitle = hints.jobTitle?.trim() || null;
  const titled = /^(?:job title|position|role|title)\s*[:\-–]\s*(.{3,80})$/im.exec(text);
  if (!jobTitle && titled) jobTitle = titled[1].trim();
  if (!jobTitle) {
    const first = lines.map((l) => l.trim()).find((l) => l.length > 3 && l.length <= 80 && TITLE_WORDS.test(l) && !BULLET.test(l));
    if (first) jobTitle = first.replace(/\s*[-–|@].*$/, '').trim();
  }
  let company = hints.company?.trim() || null;
  const co = /^(?:company|employer|organi[sz]ation)\s*[:\-–]\s*(.{2,60})$/im.exec(text) ?? /\b[Aa]bout ([A-Z][\w&.' -]{1,40}?)(?:\s*[:\n]|\s+is\b|\s+are\b)/.exec(text);
  if (!company && co) company = co[1].trim();
  // "Operations Manager — Contoso" in the title line.
  if (!company) {
    const head = lines.map((l) => l.trim()).find((l) => l.length > 3);
    const m = head ? /^(.{3,60}?)\s+(?:[-–—|@]|at)\s+([A-Z][\w&.' -]{1,40})$/.exec(head) : null;
    if (m && TITLE_WORDS.test(m[1])) company = m[2].trim();
  }

  const yr = /(\d{1,2})\s*(?:\+|-|–|to)?\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}(?:experience|exp)/i.exec(text) ?? /(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i.exec(text);
  const yearsExperience = yr ? (yr[2] ? `${yr[1]}-${yr[2]} years` : `${yr[1]}+ years`) : null;

  const toolsFound = findTerms(text, KNOWN_TOOLS);
  const reqText = required.join('\n');
  const prefText = preferred.join('\n');
  const requiredTools = findTerms(reqText, KNOWN_TOOLS);
  const preferredTools = findTerms(prefText, KNOWN_TOOLS).filter((t) => !requiredTools.includes(t));
  const requiredSkills = uniq([...skillPhrases(reqText), ...requiredTools, ...required.filter((r) => r.split(/\s+/).length <= 6)]).slice(0, 24);
  const preferredSkills = uniq([...skillPhrases(prefText), ...preferredTools, ...preferred.filter((r) => r.split(/\s+/).length <= 6)]).slice(0, 14);

  const competencies = uniq(findTerms(text, KNOWN_COMPETENCIES).map((c) => c.replace(/-/g, ' ')));
  const sentences = text.split(/\n|(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 10);
  const leadership = uniq(sentences.filter((s) => LEADERSHIP_VERBS.test(s) || /\b(mentor|coach|stakeholder|influence|people management|direct reports)\b/i.test(s))).map((s) => truncate(s.replace(BULLET, ''), 160)).slice(0, 6);
  const behavioral = uniq(sentences.filter((s) => /\b(ownership|collaborat|communicat|adaptab|initiative|customer[- ]focus|customer obsession|problem[- ]solving|attention to detail|fast[- ]paced|teamwork|accountab|integrity|resilien)/i.test(s))).map((s) => truncate(s.replace(BULLET, ''), 160)).slice(0, 6);
  const kpis = uniq([...text.matchAll(new RegExp(KPI_WORDS.source, 'gi'))].map((m) => m[0].toUpperCase().length <= 4 ? m[0].toUpperCase() : m[0].toLowerCase())).slice(0, 12);
  const lower = text.toLowerCase();
  const domainKnowledge = DOMAINS.filter((d) => lower.includes(d)).slice(0, 8);

  const freq = new Map<string, { n: number; word: string }>();
  for (const w of text.toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) ?? []) {
    const stem = tokenize(w)[0];
    if (!stem || GENERIC.has(w)) continue;
    const cur = freq.get(stem);
    if (cur) cur.n++;
    else freq.set(stem, { n: 1, word: w });
  }
  const keywords = uniq([...toolsFound, ...[...freq.values()].filter((v) => v.n >= 2).sort((a, b) => b.n - a.n).map((v) => v.word)]).slice(0, 18);

  return {
    jobTitle,
    company,
    responsibilities,
    requiredSkills,
    preferredSkills,
    yearsExperience,
    tools: toolsFound.filter((t) => !/^(python|java|javascript|typescript|c#|c\+\+|go|ruby|php|scala|kotlin|swift|sql)$/i.test(t)),
    technologies: toolsFound.filter((t) => /^(python|java|javascript|typescript|c#|c\+\+|go|ruby|php|scala|kotlin|swift|sql|react|angular|vue|node\.js|aws|azure|gcp|docker|kubernetes|snowflake|bigquery|spark|kafka)$/i.test(t)),
    behavioralRequirements: behavioral,
    leadershipRequirements: leadership,
    domainKnowledge,
    keywords,
    kpis,
    competencies,
    method: 'heuristic',
  };
}
