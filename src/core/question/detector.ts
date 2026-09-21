import type { QuestionKind } from '@shared/events';
import { normalizeText, wordCount } from '@shared/util';
import { tokenJaccard, tokenize } from '../text/tokenize';

/**
 * Local question detector. It must be fast (it runs on every partial transcript) and must never call the
 * network, so it is a transparent feature scorer rather than a model. Every decision carries `reasons`
 * so the debug panel can show why an utterance was (not) treated as a question.
 */

export interface DetectorContext {
  speaker?: 'interviewer' | 'candidate' | 'unknown';
  previousQuestion?: string | null;
  /** Milliseconds since the previous answer was shown; used for follow-up detection. */
  msSincePreviousAnswer?: number | null;
}

export interface QuestionSignal {
  /** The extracted question (may include one line of setup). Empty when nothing question-like was found. */
  text: string;
  isQuestion: boolean;
  /** 0..1 */
  confidence: number;
  /** Syntactically finished: ends with ?/./! or matches a known complete prompt. */
  complete: boolean;
  kind: QuestionKind;
  isFollowUp: boolean;
  words: number;
  reasons: string[];
}

const DISCOURSE_LEAD = /^(?:(?:so|okay|ok|now|and|but|well|alright|all right|right|great|cool|nice|perfect|good|awesome|thanks|thank you|sure|yeah|yes|um|uh|hmm|then|next|last|finally|just)[,.]?\s+)+/i;

const INTERROGATIVE = /^(what|why|how|when|where|who|whom|whose|which)\b/i;
const AUX_START =
  /^(do|does|did|can|could|would|will|should|have|has|had|are|is|was|were|may|might|shall)\s+(you|we|i|they|he|she|it|your|the|a|an|there|this|that|those|these|anyone|someone|any)\b/i;
const IMPERATIVE =
  /^(tell me|tell us|walk me through|walk us through|take me through|take us through|describe|explain|give me|give us|share|talk (?:me |us )?(?:through|about)|think of|think about|recall|discuss|outline|elaborate|detail|name|list|introduce yourself|pitch)\b/i;
const DESIRE =
  /\b(?:i'?d like (?:you )?to|i would like (?:you )?to|i want (?:you )?to|i'?m (?:curious|interested|wondering)|i wanted to (?:ask|know|hear)|i was wondering|would you mind|could you please|can you please|please (?:tell|describe|explain|walk|share))\b/i;
/** A polite/desire prefix in front of the real prompt: "I'd like you to describe…", "could you please tell me…". */
const DESIRE_LEAD =
  /^(?:i'?d like (?:you )?to|i would like (?:you )?to|i want (?:you )?to|i wanted (?:you )?to|could you please|can you please|would you please|would you mind|please)\s+/i;
const BACKCHANNEL =/^(?:okay|ok|great|thanks|thank you|got it|sure|right|nice|awesome|cool|perfect|interesting|mm-?hmm|mhm|yeah|yes|no problem|makes sense|i see|understood|good|alright|all right|excellent|wonderful|fantastic|sounds good)\b[.!, ]*$/i;
const STATEMENT_LEAD = /^(?:let me|i'?ll|i will|we'?ll|we will|we are|we're|our team|our company|my name|i'm |i am |i work|we have|we use|the role|this role|the team|the position|today we|so today|just to)\b/i;

const COMPLETE_PHRASES: RegExp[] = [
  /tell (?:me|us) about (?:yourself|your background|your experience)$/i,
  /walk (?:me|us) through your (?:resume|cv|background|experience)$/i,
  /introduce yourself$/i,
  /what (?:are|were) your (?:strengths?|weaknesses?)$/i,
  /where do you see yourself(?: in (?:the next )?(?:five|5|three|3|ten|10) years)?$/i,
  /why (?:do you want|are you interested in) (?:this|the) (?:role|job|position|company)$/i,
  /why should we hire you$/i,
  /do you have any questions(?: for (?:me|us))?$/i,
];

const FOLLOWUP_PATTERNS: RegExp[] = [
  /\byou personally\b/i,
  /\bwhat (?:was|were) your (?:role|part|contribution|responsibility)\b/i,
  /^(?:and )?(?:what|how|why|when|where|who) (?:did|do|does|was|were|is|are|would|could|will|had|has) (?:you|that|it|this|they|he|she|the|those)\b/i,
  /^(?:can|could|would) you (?:elaborate|expand|say more|go (?:in)?to (?:more )?detail|give (?:me )?more|walk me through that|tell me more|explain that|clarify)/i,
  /^tell (?:me|us) more\b/i,
  /^(?:and )?(?:what|how) about\b/i,
  /^(?:and )?then what\b/i,
  /^(?:and )?(?:why|how come)\??$/i,
  /^how (?:long|many|much|big|large|often)\b/i,
  /\b(?:that|this) (?:situation|project|experience|example|process|decision|time|scenario|initiative)\b/i,
  /^what (?:was|were) the (?:result|outcome|impact|takeaway|lesson)/i,
  /^what (?:happened|did you learn)\b/i,
];
const ANAPHORA = /\b(?:that|this|those|these|it|them|there|then|you personally)\b/i;

const KIND_CLOSING = /\b(?:any questions (?:for (?:me|us))?|do you have (?:any )?questions|anything else (?:you'?d like|to add)|last question|final question)\b/i;
const KIND_HR =
  /\b(?:tell me about yourself|walk me through your (?:resume|cv|background)|introduce yourself|why (?:do you want|are you interested|this (?:role|company|job|position)|should we hire|are you leaving|did you leave)|strengths?|weakness(?:es)?|where do you see yourself|five years|salary|compensation|expectations|notice period|relocat\w+|availability|employment gap|work style|what motivates|company culture|work environment)\b/i;
const KIND_BEHAVIORAL =
  /\b(?:tell me about a time|time when|a time (?:you|that|when)|an example (?:of|when|where)|situation (?:where|in which|when)|describe a (?:time|situation|project|challenge|conflict)|give me an example|have you ever|when have you|share (?:an|a) (?:example|experience|story)|failure|mistake|conflict|disagree(?:d|ment)?|difficult (?:coworker|colleague|customer|client|stakeholder|manager|boss|situation|person)|tight deadline|went wrong|proud of|biggest (?:challenge|accomplishment|achievement|failure|weakness))\b/i;
const KIND_SITUATIONAL =
  /\b(?:how would you|what would you do|what will you do|if you (?:were|had|found|discovered|saw)|imagine|suppose|say (?:that )?you|let'?s say|hypothetical|scenario|how do you (?:handle|deal|approach|prioriti[sz]e))\b/i;
const KIND_LEADERSHIP =
  /\b(?:lead|led|leading|leadership|manage[ds]?|managing|mentor(?:ed|ing)?|coach(?:ed|ing)?|delegat\w+|motivat\w+|direct reports|team of|build(?:ing)? a team|hir(?:e|ing)|underperform\w*|performance review|influence|stakeholders?)\b/i;
const KIND_TECHNICAL =
  /\b(?:difference between|how does .{2,40} work|what is (?:a|an|the) [a-z]|define|algorithm|complexity|sql|python|excel|pivot|vlookup|regression|api|database|query|architecture|debug|code|coding|implement|dashboard|power ?bi|tableau|javascript|typescript|java|c\+\+|cloud|aws|azure|kubernetes|docker|machine learning|statistic\w*|forecast\w*|a\/b test\w*|etl|pipeline|data model\w*|normali[sz]ation|latency|throughput|scalab\w+)\b/i;

const FILLERS = /\b(?:um+|uh+|erm|er|ah+|hmm+|mm+|mhm)\b[,.]?\s*/gi;

/** Strip fillers and collapse spacing, without changing meaning. */
export function cleanUtterance(text: string): string {
  return normalizeText(text.replace(FILLERS, ' ')).replace(/\s+([,.?!])/g, '$1');
}

/** Lowercased, punctuation-free key for exact-ish comparison and cache keys. */
export function questionKey(text: string): string {
  return tokenize(text, { question: true }).join(' ');
}

export function sameQuestion(a: string, b: string, threshold = 0.8): boolean {
  if (!a || !b) return false;
  return questionKey(a) === questionKey(b) || tokenJaccard(a, b) >= threshold;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** For unpunctuated run-ons, find where the question most plausibly starts. */
function trimRunOn(sentence: string): string {
  const w = sentence.split(/\s+/);
  if (w.length <= 16) return sentence;
  const starter =
    /\b(?:(?:can|could|would|will|do|does|did) you\b|tell me\b|tell us\b|walk me through\b|walk us through\b|describe\b|explain\b|give me\b|how would you\b|how did you\b|how do you\b|what (?:is|was|are|were|would|did|do) (?:your|the|you)\b|why (?:did|do|are|would) you\b|i'?d like you to\b|talk me through\b)/gi;
  const cutoff = Math.max(0, w.length - 45);
  const startChar = w.slice(0, cutoff).join(' ').length;
  let earliest = -1;
  for (const m of sentence.matchAll(starter)) {
    if (m.index !== undefined && m.index >= startChar) {
      earliest = m.index;
      break;
    }
  }
  return earliest > 0 ? sentence.slice(earliest) : sentence;
}

interface SentenceScore {
  score: number;
  reasons: string[];
  complete: boolean;
}

function scoreSentence(raw: string, isLast: boolean): SentenceScore {
  const reasons: string[] = [];
  const s = raw.trim();
  const stripped = s.replace(DISCOURSE_LEAD, '').trim();
  const withDesire = stripped || s;
  const desireLead = DESIRE_LEAD.exec(withDesire);
  const body = desireLead ? withDesire.slice(desireLead[0].length) : withDesire;
  const wc = wordCount(body);
  let score = 0;

  const endsQ = /\?\s*$/.test(s);
  const endsPeriod = /[.!]\s*$/.test(s);
  if (endsQ) {
    score += 0.45;
    reasons.push('ends with "?"');
  }
  const imperative = IMPERATIVE.test(body);
  const interrogative = INTERROGATIVE.test(body);
  const aux = AUX_START.test(body);
  if (imperative) {
    score += 0.6;
    reasons.push('imperative prompt');
  } else if (interrogative) {
    score += 0.4;
    reasons.push('interrogative word');
  } else if (aux) {
    score += 0.4;
    reasons.push('auxiliary-first');
  }
  if (desireLead || DESIRE.test(body)) {
    score += 0.15;
    reasons.push('"I\'d like you to…"');
  }
  if (/\b(?:you|your|yourself)\b/i.test(body)) score += 0.1;
  if (wc < 3) {
    score -= 0.35;
    reasons.push('very short');
  } else if (wc < 5) score -= 0.1;
  else if (wc >= 6) score += 0.05;

  if (BACKCHANNEL.test(body)) {
    score -= 0.6;
    reasons.push('backchannel');
  } else if (STATEMENT_LEAD.test(body) && !endsQ && !imperative && !interrogative && !aux) {
    score -= 0.25;
    reasons.push('statement');
  }
  if (KIND_CLOSING.test(body)) score += 0.3;

  const canned = COMPLETE_PHRASES.some((re) => re.test(body.replace(/[.?!]+$/, '')));
  // Well-known interview prompts are near-certain questions even though they are short.
  if (canned) score += 0.25;
  const complete = endsQ || canned || (endsPeriod && (imperative || interrogative || aux) && wc >= 4);
  void isLast;
  return { score: Math.max(0, Math.min(1, score)), reasons, complete };
}

function classify(text: string, isFollowUp: boolean): QuestionKind {
  if (KIND_CLOSING.test(text)) return 'closing';
  if (isFollowUp) return 'follow-up';
  if (KIND_HR.test(text)) return 'hr';
  if (KIND_BEHAVIORAL.test(text)) return 'behavioral';
  if (KIND_SITUATIONAL.test(text)) return 'situational';
  if (KIND_TECHNICAL.test(text)) return 'technical';
  if (KIND_LEADERSHIP.test(text)) return 'leadership';
  return 'other';
}

const EMPTY: QuestionSignal = {
  text: '',
  isQuestion: false,
  confidence: 0,
  complete: false,
  kind: 'other',
  isFollowUp: false,
  words: 0,
  reasons: [],
};

/** Analyse (possibly partial) interviewer speech and extract the question, if any. */
export function detectQuestion(rawText: string, ctx: DetectorContext = {}): QuestionSignal {
  if (ctx.speaker === 'candidate') return { ...EMPTY, reasons: ['candidate speech'] };
  const text = cleanUtterance(rawText);
  if (!text) return { ...EMPTY };

  const sentences = splitSentences(text).map((s, i, arr) => (i === arr.length - 1 ? trimRunOn(s) : s));
  if (sentences.length === 0) return { ...EMPTY };

  // Find the last sentence that looks like a question.
  let best = -1;
  let bestScore: SentenceScore | null = null;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sc = scoreSentence(sentences[i] ?? '', i === sentences.length - 1);
    if (sc.score >= 0.5) {
      best = i;
      bestScore = sc;
      break;
    }
    if (!bestScore || sc.score > bestScore.score) bestScore = sc;
  }

  const pick = best >= 0 ? best : sentences.length - 1;
  const chosen = sentences[pick] ?? '';
  const sc = bestScore ?? scoreSentence(chosen, true);
  let questionText = chosen;

  // A trailing fragment ("And", "So…") after a complete question shouldn't lower confidence; the question itself stands.
  // Include one line of setup when the question leans on it ("You mentioned the migration. What was your role in it?").
  if (best > 0) {
    const prev = sentences[best - 1] ?? '';
    const prevWords = wordCount(prev);
    if (prevWords > 0 && prevWords <= 25 && (ANAPHORA.test(chosen) || wordCount(chosen) < 6) && scoreSentence(prev, false).score < 0.5) {
      questionText = `${prev} ${chosen}`;
    }
  }
  const trimmedWords = questionText.split(/\s+/);
  if (trimmedWords.length > 70) questionText = trimmedWords.slice(-70).join(' ');

  const words = wordCount(questionText);
  const reasons = [...sc.reasons];
  let confidence = sc.score;

  // Follow-up detection needs conversational history.
  let isFollowUp = false;
  if (ctx.previousQuestion && (ctx.msSincePreviousAnswer ?? 0) < 180_000) {
    const body = chosen.replace(DISCOURSE_LEAD, '');
    const short = wordCount(body) <= 12;
    const pattern = FOLLOWUP_PATTERNS.some((re) => re.test(body));
    const anaphoric = ANAPHORA.test(body) && tokenize(body, { question: true }).length <= 4;
    if ((short && pattern) || (wordCount(body) <= 8 && anaphoric)) {
      isFollowUp = true;
      reasons.push('follow-up of previous question');
      // Short follow-ups ("Why?") are legitimate questions even though they score low in isolation.
      confidence = Math.max(confidence, 0.62);
    }
  }

  const kind = classify(questionText, isFollowUp);
  if (kind === 'closing') confidence = Math.max(confidence, 0.85);

  const isQuestion = confidence >= 0.5;
  return {
    text: isQuestion ? questionText : '',
    isQuestion,
    confidence: Math.round(confidence * 100) / 100,
    complete: isQuestion && (sc.complete || (isFollowUp && /[?.!]\s*$/.test(chosen))),
    kind,
    isFollowUp,
    words,
    reasons,
  };
}

/** Did the question change enough that a speculative answer for `before` should be discarded? */
export function materiallyChanged(before: string, after: string): boolean {
  if (sameQuestion(before, after, 0.85)) return false;
  const a = new Set(tokenize(before, { question: true }));
  const b = tokenize(after, { question: true });
  let added = 0;
  for (const t of new Set(b)) if (!a.has(t)) added++;
  // Pure extension by ≤1 new content word (e.g. "…managing teams" → "…managing teams?") is not material.
  return added >= 2 || tokenJaccard(before, after) < 0.6;
}
