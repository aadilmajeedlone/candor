/**
 * Tokenisation, light stemming and a tiny synonym map.
 * This is the vocabulary layer under both the BM25 index and the hashed embedder. It is deliberately
 * small and deterministic so that it can run on the live critical path in well under a millisecond.
 */

const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'+#./-]*[\p{L}\p{N}+#])?/gu;

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at for with by from as into onto over under about above below up down out off ' +
    'is are was were be been being am do does did done doing have has had having will would shall should can could may might must ' +
    'i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these those ' +
    'there here what which who whom whose when where why how not no nor so than too very just also only own same such ' +
    'both each few more most other some any all any while during before after again further once ' +
    'am pm etc via per s t d ll re ve m'
  ).split(' '),
);

/** Words that dominate interview questions but carry no retrieval signal ("tell me about a time when you…"). */
const QUESTION_STOPWORDS = new Set(
  (
    'tell talk walk describe explain give share example examples time times think thought recall remember please ' +
    'like want love hear curious interested know understand say things thing way ways kind sort little bit lot ' +
    'us ask asked question questions go goes went get got getting make makes made take took'
  ).split(' '),
);

const SYNONYM_GROUPS: string[][] = [
  ['manage', 'lead', 'supervise', 'oversee', 'direct', 'head', 'run', 'own', 'leadership', 'manager', 'leader'],
  ['improve', 'optimize', 'optimise', 'enhance', 'streamline', 'increase', 'boost', 'reduce', 'cut', 'lower', 'raise', 'grow'],
  ['conflict', 'disagreement', 'dispute', 'friction', 'tension', 'clash', 'escalation', 'escalate', 'complaint'],
  ['customer', 'client', 'user', 'stakeholder', 'partner', 'account'],
  ['team', 'group', 'squad', 'department', 'staff', 'people', 'report'],
  ['deadline', 'timeline', 'schedule', 'delivery', 'due', 'sla', 'turnaround'],
  ['fail', 'failure', 'mistake', 'error', 'setback', 'misstep', 'wrong', 'lesson'],
  ['challenge', 'difficult', 'hard', 'tough', 'obstacle', 'problem', 'issue', 'complex', 'crisis'],
  ['result', 'outcome', 'impact', 'achievement', 'accomplishment', 'success', 'win', 'delivered'],
  ['process', 'workflow', 'procedure', 'operation', 'operational', 'sop', 'system'],
  ['analyze', 'analyse', 'analysis', 'analytics', 'data', 'insight', 'metric', 'kpi', 'report', 'dashboard', 'measure'],
  ['communicate', 'communication', 'present', 'presentation', 'explain', 'articulate', 'stakeholder'],
  ['prioritize', 'prioritise', 'priority', 'triage', 'tradeoff', 'trade-off'],
  ['collaborate', 'cooperate', 'crossfunctional', 'cross-functional', 'teamwork', 'coordinate', 'align'],
  ['mentor', 'coach', 'train', 'training', 'develop', 'onboard', 'upskill', 'teach'],
  ['quality', 'qa', 'audit', 'compliance', 'accuracy', 'defect', 'standard'],
  ['change', 'transform', 'transformation', 'transition', 'migrate', 'migration', 'adapt', 'ambiguity'],
  ['decision', 'decide', 'judgment', 'judgement', 'choose', 'choice'],
  ['budget', 'cost', 'saving', 'savings', 'spend', 'financial', 'revenue', 'profit'],
  ['automate', 'automation', 'script', 'macro', 'tool', 'tooling'],
  ['innovate', 'innovation', 'idea', 'creative', 'initiative', 'proactive'],
];

let synonymIndex: Map<string, number> | null = null;

function getSynonymIndex(): Map<string, number> {
  if (synonymIndex) return synonymIndex;
  const map = new Map<string, number>();
  SYNONYM_GROUPS.forEach((group, i) => {
    for (const word of group) {
      const s = stem(word.toLowerCase());
      if (!map.has(s)) map.set(s, i);
    }
  });
  synonymIndex = map;
  return map;
}

const SUFFIXES = [
  'ization',
  'isation',
  'ational',
  'fulness',
  'ousness',
  'iveness',
  'ations',
  'ation',
  'ement',
  'ments',
  'ment',
  'ings',
  'ing',
  'edly',
  'ship',
  'ers',
  'er',
  'ed',
  'ly',
  'ity',
  'ive',
  'ize',
  'ise',
  'al',
  'ness',
];

/** Light suffix-stripping stemmer. Not linguistically perfect; consistent, which is what retrieval needs. */
export function stem(word: string): string {
  let s = word;
  if (s.length <= 3 || /^\d/.test(s)) return s;
  if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (!s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is') && s.endsWith('s')) s = s.slice(0, -1);

  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const suf of SUFFIXES) {
      if (s.length - suf.length >= 3 && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  // Undouble consonants (planning → plann → plan) but keep ss / ll / zz (process, skill).
  if (s.length > 3 && /([b-df-hj-km-rt-vx-y])\1$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('y')) s = s.slice(0, -1) + 'i';
  return s;
}

export interface TokenizeOptions {
  /** Drop interview-question boilerplate ("tell me about a time…"). */
  question?: boolean;
  keepStopwords?: boolean;
}

/** Lowercased word tokens (unstemmed). */
export function words(text: string): string[] {
  const matches = text.toLowerCase().match(WORD_RE);
  if (!matches) return [];
  return matches.map((w) => w.replace(/['’]s$/, '').replace(/^[.'’/-]+|[.'’/-]+$/g, '')).filter(Boolean);
}

/** Stemmed content tokens with stopwords removed. */
export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (!opts.keepStopwords && STOPWORDS.has(w)) continue;
    if (opts.question && QUESTION_STOPWORDS.has(w)) continue;
    if (w.length === 1 && !/[\d]/.test(w) && w !== 'c' && w !== 'r') continue;
    out.push(stem(w));
  }
  return out;
}

/** Synonym group tag for a stemmed token, or null. */
export function synonymTag(stemmed: string): string | null {
  const g = getSynonymIndex().get(stemmed);
  return g === undefined ? null : `~${g}`;
}

/** Jaccard similarity over stemmed content tokens: a cheap "is this the same question?" signal. */
export function tokenJaccard(a: string, b: string): number {
  const A = new Set(tokenize(a, { question: true }));
  const B = new Set(tokenize(b, { question: true }));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Number of content tokens in `b` that are absent from `a`. */
export function newTokenCount(a: string, b: string): number {
  const A = new Set(tokenize(a, { question: true }));
  let n = 0;
  for (const t of new Set(tokenize(b, { question: true }))) if (!A.has(t)) n++;
  return n;
}
