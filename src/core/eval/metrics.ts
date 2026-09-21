import type { MockMetrics } from '@shared/ipc';
import { wordCount } from '@shared/util';
import { tokenize } from '../text/tokenize';

const FILLER_RE = /\b(um+|uh+|erm|er|ah+|hmm+|you know|i mean|sort of|kind of|basically|actually|literally|like)\b/gi;
/** "like" is a filler only when it is not doing real work ("like to", "looked like"); counted conservatively. */
const REAL_LIKE = /\b(?:i|we|would|do|did|don'?t|didn'?t|really|feel|looks?|looked|something|nothing|just|much|more|is|was|are)\s+like\b|\blike\s+(?:to|a|an|the|this|that|my|our|your|when|how)\b/gi;

const STAR = {
  situation: /\b(situation|context|background|at the time|when i (?:was|joined|started)|we had|there was|our team was|the problem|challenge was|faced with)\b/i,
  task: /\b(task|goal|objective|my (?:role|job|responsibility)|i (?:was|had been) (?:asked|responsible|tasked)|needed to|had to|aim was|target was)\b/i,
  action: /\b(i (?:decided|started|created|built|led|organi[sz]ed|implemented|introduced|reviewed|set up|worked|proposed|analy[sz]ed|redesigned|met|spoke|coached|mapped|automated)|so i|my approach|what i did|steps i took)\b/i,
  result: /\b(result|outcome|as a result|which (?:led|meant|saved|reduced|increased|improved)|ended up|in the end|we (?:saved|reduced|increased|improved|achieved)|\d+\s?%|by \d+)\b/i,
};

/**
 * Objective, reproducible measures of a spoken answer. These are counts and pattern checks, not judgements; the
 * mock-interview report shows them next to the AI's qualitative assessment.
 */
export function analyzeAnswer(question: string, answer: string, durationMs: number | null): MockMetrics {
  const words = wordCount(answer);
  const seconds = durationMs !== null && durationMs > 0 ? Math.round(durationMs / 100) / 10 : null;
  const wordsPerMinute = seconds && words > 0 ? Math.round((words / seconds) * 60) : null;

  const withoutRealLike = answer.replace(REAL_LIKE, ' ');
  const fillerList = [...withoutRealLike.matchAll(FILLER_RE)].map((m) => m[0].toLowerCase());

  const q = new Set(tokenize(question, { question: true }));
  const a = new Set(tokenize(answer));
  let hit = 0;
  for (const t of q) if (a.has(t)) hit++;

  return {
    words,
    seconds,
    wordsPerMinute,
    fillers: fillerList.length,
    fillerList: [...new Set(fillerList)].slice(0, 8),
    hasNumbers: /\d/.test(answer),
    star: {
      situation: STAR.situation.test(answer),
      task: STAR.task.test(answer),
      action: STAR.action.test(answer),
      result: STAR.result.test(answer),
    },
    questionCoverage: q.size === 0 ? 1 : Math.round((hit / q.size) * 100) / 100,
  };
}
