import type { GroundingReport } from '@shared/types';

/**
 * Post-hoc hallucination check. It cannot prove an answer is true, but it can reliably flag specific
 * details (numbers, named things) that appear in the answer yet nowhere in the candidate's facts, stories,
 * profile or the question itself. Those are exactly the details a model tends to invent.
 */

const COMMON_CAPITALIZED = new Set(
  (
    'I I\'m I\'ve I\'d I\'ll The A An And But So Then Also In On At For With By From As It Its My Our We They He She This That These Those ' +
    'When While After Before During Because If Since Once What Why How Who Where Which There Here Yes No Not One Two Three ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December ' +
    'Situation Task Action Result STAR Note Add Here Example First Second Third Finally Overall Ultimately Additionally Instead However Today Currently ' +
    'English Q1 Q2 Q3 Q4 Thanks Thank Sure Well Honestly Personally Basically Generally Typically Usually Often Sometimes Maybe Definitely Absolutely Really Actually ' +
    'Interviewer Candidate Team Manager Lead Senior Junior Director Head Chief Yes'
  ).split(/\s+/),
);

const NUMBER_RE = /([$€£₹]\s?)?(\d[\d,]*(?:\.\d+)?)(\s?(?:%|percent\b|k\b|m\b|million\b|billion\b|crore\b|lakh\b|x\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|yrs?\b|people\b|agents\b|members\b|users\b|clients\b|customers\b|accounts\b|tickets\b))?/gi;

type NumKind = 'pct' | 'money' | 'plain';

/** "9%", "$9 million" and "9 agents" are different claims even though they share a digit. */
function numKind(prefix: string | undefined, suffix: string | undefined): NumKind {
  if (prefix) return 'money';
  const s = (suffix ?? '').trim().toLowerCase();
  if (s === '%' || s === 'percent') return 'pct';
  if (['k', 'm', 'million', 'billion', 'crore', 'lakh'].includes(s)) return 'money';
  return 'plain';
}
const ENTITY_RE = /\b[A-Z][A-Za-z0-9&'.+#-]*(?:\s+[A-Z][A-Za-z0-9&'.+#-]*)*/g;

export interface GroundingInput {
  answer: string;
  question: string;
  /** Every text the model was allowed to draw on. */
  corpus: string[];
  usedFactIds: string[];
  usedStoryIds: string[];
  retrievalConfidence: number;
}

function digits(s: string): string {
  return s.replace(/[^\d.]/g, '').replace(/\.$/, '');
}

function normalizeCorpus(texts: string[]): { lower: string; numSet: Set<string> } {
  const lower = texts.join(' \n ').toLowerCase().replace(/[’']/g, "'");
  const numSet = new Set<string>();
  for (const m of lower.matchAll(NUMBER_RE)) numSet.add(`${digits(m[2] ?? '')}|${numKind(m[1], m[3])}`);
  return { lower, numSet };
}

export function checkGrounding(input: GroundingInput): GroundingReport {
  const { lower, numSet } = normalizeCorpus([...input.corpus, input.question]);
  const unverified: string[] = [];
  const seen = new Set<string>();

  // Numbers with units or magnitude: the classic fabricated metric. Compared by value AND kind.
  for (const m of input.answer.matchAll(NUMBER_RE)) {
    const raw = m[0].trim();
    const d = digits(m[2] ?? '');
    if (!d || seen.has(raw.toLowerCase())) continue;
    const kind = numKind(m[1], m[3]);
    const hasUnit = !!m[1] || !!m[3];
    const big = Number(d) >= 10;
    if (!hasUnit && !big) continue;
    if (!numSet.has(`${d}|${kind}`)) {
      seen.add(raw.toLowerCase());
      unverified.push(raw);
    }
  }

  // Capitalised names that are not sentence starters: employers, tools, certifications.
  const sentences = input.answer.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const text = sentence.replace(/^[-•*\d.)\s]+/, '');
    for (const m of text.matchAll(ENTITY_RE)) {
      const idx = m.index ?? 0;
      let ent = m[0].trim();
      // Drop a leading sentence-initial word ("Managing Northwind..." -> "Northwind...").
      if (idx === 0) {
        const parts = ent.split(/\s+/);
        if (parts.length === 1) continue;
        ent = parts.slice(1).join(' ');
      }
      const words = ent.split(/\s+/).filter((w) => !COMMON_CAPITALIZED.has(w));
      if (words.length === 0) continue;
      const cleaned = words.join(' ').replace(/[.,;:]+$/, '');
      if (cleaned.length < 3 || /^[A-Z]{1,2}$/.test(cleaned)) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      if (!lower.includes(key)) {
        // Allow partial words: each token individually present (e.g. "Power BI" vs "power bi dashboards").
        const allTokensKnown = cleaned
          .toLowerCase()
          .split(/\s+/)
          .every((t) => lower.includes(t));
        if (allTokensKnown && cleaned.split(/\s+/).length > 1) continue;
        seen.add(key);
        unverified.push(cleaned);
      }
    }
  }

  const hasContext = input.usedFactIds.length + input.usedStoryIds.length > 0;
  return {
    status: !hasContext ? 'no-context' : unverified.length > 0 ? 'unverified-details' : 'grounded',
    unverified: unverified.slice(0, 8),
    retrievalConfidence: Math.round(input.retrievalConfidence * 100) / 100,
    usedFactIds: input.usedFactIds,
    usedStoryIds: input.usedStoryIds,
  };
}
