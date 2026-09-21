import type { Fact, FactKind, ResumeEducation, ResumeProfile, ResumeRole } from '@shared/types';
import { hashHex, normalizeText, truncate, uniq } from '@shared/util';
import { ACHIEVEMENT_VERBS, KNOWN_TOOLS, LEADERSHIP_VERBS, NUMBER_UNIT, TITLE_WORDS, findTerms } from './dictionary';

/**
 * Offline résumé parser. It reads section headings, role headers and bullets and produces the same
 * `ResumeProfile` the AI parser does, so the app is useful before any provider is configured and the AI result
 * can be checked against it. Every fact carries the exact source line as its evidence.
 */

type Section = 'header' | 'summary' | 'experience' | 'education' | 'skills' | 'certifications' | 'projects' | 'achievements' | 'leadership' | 'ignore';

const HEADINGS: [Section, RegExp][] = [
  ['summary', /^(professional |career |executive )?(summary|profile|profile summary|about me|about|objective|career objective|overview)$/i],
  ['experience', /^((professional|relevant|work|employment|career) )?(experience|history)( summary)?$|^employment( history)?$|^work history$/i],
  ['education', /^(education|academics?|academic (background|qualifications)|education (and|&) training|qualifications)$/i],
  ['skills', /^((technical|key|core|professional|soft) )?(skills|competencies)( (and|&) (tools|technologies|competencies))?$|^(core competencies|areas of expertise|expertise|tools( (and|&) technologies)?|technologies|technical proficiencies)$/i],
  ['certifications', /^((professional|training) (and|&) )?(certifications?|licen[sc]es|certificates|courses|training)( (and|&) (training|certifications?))?$/i],
  ['projects', /^((key|selected|notable) )?projects$/i],
  ['achievements', /^(achievements?|accomplishments?|recognition|awards?|honou?rs|awards (and|&) recognition|key achievements|education recognition)$/i],
  ['leadership', /^(leadership|volunteer(ing)?( experience)?|extracurricular(s)?|activities)$/i],
  ['ignore', /^(languages?|interests?|hobbies|references?|personal (details|information)|declaration)$/i],
];

const BULLET = /^\s*(?:[•·▪▫●○◦■□◆◇►▶✓✔➢➤*]|[-–—](?=\s)|\d{1,2}[.)](?=\s))\s*/;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE = `(?:${MONTH}\\.?\\s*,?\\s*(?:19|20)\\d{2}|(?:0?[1-9]|1[0-2])/(?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const RANGE_RE = new RegExp(`(${DATE})\\s*(?:-|–|—|to|until)\\s*(${DATE}|present|current|now|ongoing|today)`, 'i');
const EMAIL_PHONE_URL = /@|https?:\/\/|www\.|linkedin\.com|github\.com|\+?\d[\d\s().-]{7,}\d/i;

function headingOf(line: string): Section | null {
  const t = line
    .trim()
    .replace(/[:：]+$/, '')
    .replace(/^[\W_]+|[\W_]+$/g, '')
    .trim();
  if (!t || t.length > 42 || BULLET.test(line)) return null;
  for (const [section, re] of HEADINGS) if (re.test(t)) return section;
  return null;
}

function yearOf(s: string): number | null {
  const m = /(?:19|20)\d{2}/.exec(s);
  return m ? Number(m[0]) : null;
}

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

function looksLikeName(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40 || EMAIL_PHONE_URL.test(t) || /\d/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((w) => /^[\p{L}][\p{L}.'’-]*$/u.test(w)) && !headingOf(t) && !TITLE_WORDS.test(t);
}

interface Draft {
  role: ResumeRole;
  headerLines: string[];
  bullets: string[];
}

function splitHeader(line: string): { parts: string[]; start?: string; end?: string; current: boolean } {
  let rest = line;
  let start: string | undefined;
  let end: string | undefined;
  let current = false;
  const m = RANGE_RE.exec(rest);
  if (m) {
    start = m[1];
    end = m[2];
    current = /present|current|now|ongoing|today/i.test(m[2] ?? '');
    rest = rest.replace(m[0], ' ').replace(/[()[\]]/g, ' ');
  }
  const parts = rest
    .split(/\s+[|•·@]\s+|\s+[-–—]\s+|\s+at\s+|\s*\|\s*|\s*,\s+(?=[A-Z])/)
    .map((p) => p.replace(/^[\s,;:()-]+|[\s,;:()-]+$/g, ''))
    .filter(Boolean);
  return { parts, start, end, current };
}

/** Split on commas/semicolons/bullets, but not inside parentheses: "Excel (pivot tables, VLOOKUP), SQL" → 2 items. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|•·\t]/.test(ch)) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.flatMap((p) => (/\s{3,}/.test(p) ? p.split(/\s{3,}/) : [p]));
}

/** Numbers that carry meaning: percentages, currency, magnitudes, quantities with a unit. Bare small numbers are noise. */
function metricsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_UNIT)) {
    const v = m[0].trim();
    if (/^(19|20)\d{2}$/.test(v)) continue;
    if (/[%$€£₹]|percent|\dk$|\dm$|million|billion|crore|lakh|\dx$|hours?|hrs?|days?|weeks?|months?|agents|people|members|clients|customers|accounts|tickets|users|stores|sites|countries|cities|reports/i.test(v) || /\d{3,}/.test(v)) out.push(v);
  }
  return uniq(out).slice(0, 6);
}

/** A line that opens a new role rather than continuing the previous bullet. */
function looksLikeHeader(line: string): boolean {
  if (RANGE_RE.test(line)) return true;
  const t = line.trim();
  if (t.length > 90 || /[.!?]$/.test(t)) return false;
  return /^[A-Z]/.test(t) && (/\s[|—–]\s|\s-\s|\sat\s/.test(t) || TITLE_WORDS.test(t)) && !/^[A-Z][a-z]+ (?:by|to|and|the|in|for|with)\b/.test(t);
}

function factId(kind: string, text: string): string {
  return `f_${hashHex(kind + '|' + text).slice(0, 10)}`;
}

export function parseResumeHeuristic(rawText: string): ResumeProfile {
  const text = normalizeText(rawText);
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const profile: ResumeProfile = {
    roles: [],
    skills: [],
    tools: [],
    technologies: [],
    education: [],
    certifications: [],
    projects: [],
    metrics: [],
    leadership: [],
    industries: [],
    facts: [],
  };
  const facts: Fact[] = [];
  const addFact = (kind: FactKind, factText: string, evidence: string, label?: string, tags: string[] = []): void => {
    const t = factText.trim();
    if (t.length < 4) return;
    const id = factId(kind, `${label ?? ''}${t}`);
    if (facts.some((f) => f.id === id)) return;
    facts.push({ id, kind, text: t, source: 'resume', label, evidence: evidence.trim(), tags });
  };

  // ---- split into sections ----
  const sections: { type: Section; lines: string[] }[] = [{ type: 'header', lines: [] }];
  for (const line of lines) {
    const h = headingOf(line);
    if (h) sections.push({ type: h, lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }

  // ---- header: name, headline ----
  const header = sections.find((s) => s.type === 'header')!.lines.filter((l) => l.trim());
  const nameLine = header.find(looksLikeName);
  if (nameLine) {
    const n = nameLine.trim();
    profile.name = n === n.toUpperCase() ? titleCase(n) : n;
  }
  const headline = header.find((l) => l !== nameLine && !EMAIL_PHONE_URL.test(l) && l.length <= 140 && TITLE_WORDS.test(l));
  if (headline) profile.headline = headline.replace(/\s*[|•·]\s*/g, ' · ').trim();

  for (const sec of sections) {
    const body = sec.lines;
    switch (sec.type) {
      case 'summary': {
        const para = body.map((l) => l.trim()).filter(Boolean).join(' ');
        if (para) {
          profile.summary = truncate(para, 700);
          addFact('summary', truncate(para, 500), para.slice(0, 220), 'Summary');
        }
        break;
      }
      case 'skills': {
        for (const raw of body) {
          const line = raw.replace(BULLET, '').trim();
          if (!line) continue;
          const cat = /^([A-Za-z][A-Za-z &/]{1,28}):\s*(.+)$/.exec(line);
          const items = splitTopLevel(cat ? cat[2] : line).map((s) => s.trim().replace(/[.]$/, '')).filter((s) => s.length > 1 && s.length <= 48);
          profile.skills.push(...items);
        }
        break;
      }
      case 'certifications': {
        for (const raw of body) {
          const line = raw.replace(BULLET, '').trim();
          if (line.length < 4) continue;
          profile.certifications.push(line);
          addFact('certification', line, line, 'Certifications');
        }
        break;
      }
      case 'education': {
        const entries: string[][] = [];
        let cur: string[] = [];
        for (const raw of body) {
          const line = raw.trim();
          if (!line) {
            if (cur.length) {
              entries.push(cur);
              cur = [];
            }
            continue;
          }
          cur.push(line);
        }
        if (cur.length) entries.push(cur);
        for (const e of entries) {
          const joined = e.join(' · ');
          const degree = /\b(b\.?\s?(?:sc|a|com|tech|e|s|ba|bba)\.?|m\.?\s?(?:sc|a|com|tech|s|ba|ba)\.?|mba|bachelor(?:'s)?(?: of [A-Za-z &]+)?|master(?:'s)?(?: of [A-Za-z &]+)?|ph\.?d\.?|diploma(?: in [A-Za-z &]+)?|associate(?:'s)?(?: degree)?|high school|12th|10th|hsc|ssc|pgdm?)\b/i.exec(joined);
          const inst = /((?:[A-Z][\p{L}&.'’-]*\s+){0,4}(?:University|College|Institute|School|Academy|Polytechnic)(?:\s+(?:of|for|and|&|in)\s+[A-Z][\p{L}&.'’-]*(?:\s+[A-Z][\p{L}&.'’-]*){0,3}|\s+[A-Z][\p{L}&.'’-]*){0,3})/u.exec(joined);
          const edu: ResumeEducation = { institution: (inst?.[1] ?? e[0] ?? '').trim(), degree: degree?.[0]?.trim(), year: String(yearOf(joined) ?? '') || undefined };
          profile.education.push(edu);
          addFact('education', joined, joined, 'Education');
        }
        break;
      }
      case 'achievements':
      case 'leadership': {
        for (const raw of body) {
          const line = raw.replace(BULLET, '').trim();
          if (line.length < 8) continue;
          if (sec.type === 'leadership') profile.leadership.push(line);
          addFact(sec.type === 'leadership' ? 'leadership' : 'achievement', line, line, sec.type === 'leadership' ? 'Leadership' : 'Recognition');
        }
        break;
      }
      case 'projects': {
        for (const raw of body) {
          const line = raw.replace(BULLET, '').trim();
          if (line.length < 6) continue;
          const [name, ...rest] = line.split(/\s+[-–—:]\s+/);
          profile.projects.push({ name: (name ?? line).trim(), description: rest.join(' – ') || undefined, technologies: findTerms(line, KNOWN_TOOLS) });
          addFact('project', line, line, 'Projects');
        }
        break;
      }
      case 'experience': {
        parseExperience(body, profile, addFact);
        break;
      }
      default:
        break;
    }
  }

  // If no sections were recognised (plain paragraph résumé), fall back to line-level facts.
  if (facts.length === 0) {
    for (const raw of lines) {
      const line = raw.replace(BULLET, '').trim();
      if (line.length >= 25 && line.split(/\s+/).length >= 5) addFact(ACHIEVEMENT_VERBS.test(line) ? 'achievement' : 'responsibility', line, line);
    }
  }

  profile.skills = uniq(profile.skills).slice(0, 60);
  profile.tools = uniq([...findTerms(text, KNOWN_TOOLS)]).slice(0, 50);
  profile.technologies = profile.tools.filter((t) => /^(python|java|javascript|typescript|c#|c\+\+|go|ruby|php|scala|kotlin|swift|react|angular|vue|node\.js|django|flask|spring|\.net|sql|mysql|postgresql|mongodb|aws|azure|gcp|docker|kubernetes|terraform|snowflake|bigquery|spark|kafka|airflow|dbt)$/i.test(t));
  profile.metrics = uniq(profile.roles.flatMap((r) => r.metrics)).slice(0, 20);
  profile.leadership = uniq([...profile.leadership, ...profile.roles.flatMap((r) => r.leadership)]).slice(0, 12);
  if (profile.skills.length > 0) {
    for (let i = 0; i < profile.skills.length; i += 14) {
      const chunk = profile.skills.slice(i, i + 14);
      addFact('skill', `Skills: ${chunk.join(', ')}`, chunk.join(', '), 'Skills');
    }
  }

  // Current role + years of experience from the dates that were read.
  const first = profile.roles[0];
  if (first) profile.currentRole = [first.title, first.company].filter(Boolean).join(' at ');
  // The candidate's own statement ("7+ years") wins; otherwise derive it from the dates that were read.
  const said = /(\d{1,2})\+?\s*(?:years?|yrs?)\b/i.exec(profile.summary ?? '');
  if (said) profile.yearsExperience = Number(said[1]);
  else {
    const years = profile.roles.flatMap((r) => [yearOf(r.start ?? ''), yearOf(r.end ?? '')]).filter((y): y is number => y !== null);
    const anyCurrent = profile.roles.some((r) => r.current);
    if (years.length > 0) {
      const min = Math.min(...years);
      const max = anyCurrent ? new Date().getFullYear() : Math.max(...years);
      if (max >= min && max - min < 60) profile.yearsExperience = Math.max(1, max - min);
    }
  }

  profile.facts = facts;
  return profile;
}

function parseExperience(body: string[], profile: ResumeProfile, addFact: (k: FactKind, t: string, e: string, label?: string, tags?: string[]) => void): void {
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let pendingHeader: string[] = [];

  const newRole = (headerLines: string[]): Draft => {
    const d: Draft = { role: { title: '', company: '', responsibilities: [], achievements: [], metrics: [], tools: [], leadership: [] }, headerLines, bullets: [] };
    drafts.push(d);
    return d;
  };

  for (let i = 0; i < body.length; i++) {
    const raw = body[i] ?? '';
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (BULLET.test(raw)) {
      const text = raw.replace(BULLET, '').trim();
      if (pendingHeader.length && !cur?.bullets.length) {
        cur = newRole(pendingHeader);
        pendingHeader = [];
      } else if (pendingHeader.length) {
        cur = newRole(pendingHeader);
        pendingHeader = [];
      }
      if (!cur) cur = newRole([]);
      cur.bullets.push(text);
      continue;
    }
    // Non-bullet line: header text, or a wrapped continuation of the previous bullet.
    const prev = cur?.bullets[cur.bullets.length - 1];
    const hasDate = RANGE_RE.test(line);
    // A wrapped bullet: the previous bullet has no closing punctuation and this line does not look like a new role header.
    const continuation = !!prev && !hasDate && !/[.!?:;]$/.test(prev) && !looksLikeHeader(line) && pendingHeader.length === 0;
    if (continuation && cur) {
      cur.bullets[cur.bullets.length - 1] = `${prev} ${line}`;
      continue;
    }
    // A long sentence-like line right under a role (no bullet markers used) is a responsibility line.
    const sentenceLike = line.length > 110 || (/[.!?]$/.test(line) && line.split(/\s+/).length > 12);
    if (sentenceLike && (cur || pendingHeader.length)) {
      if (pendingHeader.length) {
        cur = newRole(pendingHeader);
        pendingHeader = [];
      }
      cur!.bullets.push(line);
      continue;
    }
    // New header lines start a new role once the previous role already has content.
    if (cur && cur.bullets.length > 0 && pendingHeader.length === 0) cur = null;
    pendingHeader.push(line);
    if (hasDate || pendingHeader.length >= 2) {
      // Enough header information: open the role now so bullets attach to it.
      const d = newRole(pendingHeader);
      pendingHeader = [];
      cur = d;
    }
  }
  if (pendingHeader.length && !cur) newRole(pendingHeader);

  for (const d of drafts) {
    const headerText = d.headerLines.join(' | ');
    const { parts, start, end, current } = splitHeader(headerText);
    const titleIdx = parts.findIndex((p) => TITLE_WORDS.test(p));
    const title = titleIdx >= 0 ? parts[titleIdx] : '';
    const others = parts.filter((_, i) => i !== titleIdx && !/^(remote|hybrid|on-?site)$/i.test(parts[i] ?? ''));
    const company = others[0] ?? (title ? '' : (parts[0] ?? ''));
    const location = others.find((p, i) => i > 0 && /,|remote|india|usa|uk|canada|australia/i.test(p));
    const role = d.role;
    role.title = title || (titleIdx < 0 && parts.length > 1 ? (parts[1] ?? '') : '');
    role.company = company;
    role.location = location;
    role.start = start;
    role.end = end;
    role.current = current;
    if (!role.title && !role.company && d.bullets.length === 0) continue;

    const label = [role.company, role.title].filter(Boolean).join(' — ') || 'Experience';
    for (const b of d.bullets) {
      if (b.length < 8) continue;
      const isAchievement = ACHIEVEMENT_VERBS.test(b) || metricsIn(b).length > 0;
      const isLeader = LEADERSHIP_VERBS.test(b);
      (isAchievement ? role.achievements : role.responsibilities).push(b);
      if (isLeader) role.leadership.push(b);
      role.metrics.push(...metricsIn(b));
      role.tools.push(...findTerms(b, KNOWN_TOOLS));
      addFact(isLeader && !isAchievement ? 'leadership' : isAchievement ? 'achievement' : 'responsibility', b, b, label, isLeader ? ['leadership'] : []);
    }
    role.metrics = uniq(role.metrics);
    role.tools = uniq(role.tools);
    profile.roles.push(role);
  }
}
