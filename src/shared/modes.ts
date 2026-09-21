import type { AnswerMode } from './types';

export interface AnswerModeSpec {
  label: string;
  /** One-line description shown in the UI. */
  blurb: string;
  /** Approximate spoken length. */
  spoken: string;
  /** Target word range for the generated answer (speech ≈ 2.5 words/second). */
  words: [number, number];
  /** Hard cap sent to the provider. Deliberately tight: shorter generations finish sooner. */
  maxTokens: number;
  /** In-window shortcut (Alt + n). */
  key: string;
}

export const ANSWER_MODES: Record<AnswerMode, AnswerModeSpec> = {
  concise: { label: 'Concise', blurb: '20–40 second answer', spoken: '20–40 s', words: [50, 95], maxTokens: 200, key: '1' },
  standard: { label: 'Standard', blurb: '45–90 second answer', spoken: '45–90 s', words: [110, 220], maxTokens: 380, key: '2' },
  detailed: { label: 'Detailed', blurb: '90–150 second answer', spoken: '90–150 s', words: [220, 370], maxTokens: 640, key: '3' },
  bullets: { label: 'Bullets', blurb: 'Short talking points', spoken: 'glanceable', words: [30, 90], maxTokens: 220, key: '4' },
  star: { label: 'STAR', blurb: 'Situation · Task · Action · Result', spoken: '60–120 s', words: [140, 260], maxTokens: 480, key: '5' },
  technical: { label: 'Technical', blurb: 'Explanation with key terminology', spoken: '45–90 s', words: [110, 230], maxTokens: 500, key: '6' },
  followup: { label: 'Follow-up', blurb: 'Short conversational reply', spoken: '10–25 s', words: [25, 60], maxTokens: 150, key: '7' },
};

export const MODE_ORDER: AnswerMode[] = ['concise', 'standard', 'detailed', 'bullets', 'star', 'technical', 'followup'];

export function nextMode(mode: AnswerMode): AnswerMode {
  const i = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(i + 1) % MODE_ORDER.length] ?? 'standard';
}

/** The mode one step shorter / longer on the length ladder, used by the Shorter / Expand controls. */
export function shorterMode(mode: AnswerMode): AnswerMode {
  switch (mode) {
    case 'detailed':
      return 'standard';
    case 'standard':
    case 'star':
    case 'technical':
      return 'concise';
    default:
      return mode === 'concise' ? 'bullets' : mode;
  }
}

export function longerMode(mode: AnswerMode): AnswerMode {
  switch (mode) {
    case 'concise':
    case 'bullets':
    case 'followup':
      return 'standard';
    case 'standard':
      return 'detailed';
    default:
      return mode;
  }
}
