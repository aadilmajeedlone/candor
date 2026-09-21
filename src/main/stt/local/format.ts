/**
 * Turns a local recogniser's raw text into what the rest of the app expects from a speech provider.
 *
 * Streaming zipformer models trained on LibriSpeech print ALL CAPS with no punctuation; others print mixed case with
 * sparse punctuation. Cloud providers return "Tell me about a time when you led a team." — sentence case, end
 * punctuation, "I" — so the transcript view, the question detector and the answer cache see the same shape from every
 * provider. Partial results are only cased (they are rewritten constantly); a FINAL result also gets end punctuation,
 * unless it stops on a word no sentence can end on ("…a time when"), which means the speaker paused mid-question.
 */

export type Casing = 'upper' | 'mixed';

const CONTRACTIONS: Record<string, string> = { "i'm": "I'm", "i'll": "I'll", "i've": "I've", "i'd": "I'd" };

const QUESTION_OPENER = /^(?:what|why|how|when|where|who|whom|whose|which)\b/i;
const AUX_OPENER = /^(?:do|does|did|can|could|would|will|should|have|has|had|are|is|was|were|may|might|shall)\s+(?:you|we|i|they|he|she|it|your|the|a|an|there|this|that|these|those|anyone|someone|any)\b/i;

/** Words a finished sentence does not end on: articles, prepositions, conjunctions, auxiliaries, possessives. */
const DANGLING = new Set(
  (
    'a an the this that these those my your our their his her its some any each every no ' +
    'to of in on at by for with from into onto about over under between through during after before than as like per via without within ' +
    'and or but so if when while because although though unless until whether which who whom whose where whereby ' +
    'is are was were be been being am have has had do does did will would can could shall should may might must not ' +
    'um uh er ah'
  ).split(' '),
);

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fixPronoun(text: string): string {
  return text.replace(/\bi'(?:m|ll|ve|d)\b/gi, (m) => CONTRACTIONS[m.toLowerCase()] ?? m).replace(/\bi\b/g, 'I');
}

/** Does a sentence read as a question (so a final result gets "?")? Imperatives such as "Tell me about…" get ".". */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return QUESTION_OPENER.test(t) || AUX_OPENER.test(t);
}

function endsOnDanglingWord(text: string): boolean {
  const last = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .pop();
  return !last || DANGLING.has(last);
}

export function formatTranscript(raw: string, o: { casing: Casing; final: boolean }): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (o.casing === 'upper') text = fixPronoun(text.toLowerCase());
  text = sentenceCase(text);
  if (!o.final || /[.?!]["')\]]?$/.test(text)) return text;
  if (endsOnDanglingWord(text)) return text; // paused mid-sentence: not a finished thought
  return `${text}${looksLikeQuestion(text) ? '?' : '.'}`;
}
