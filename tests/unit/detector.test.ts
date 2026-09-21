import { describe, expect, it } from 'vitest';
import { detectQuestion, materiallyChanged, sameQuestion } from '@core/question/detector';

describe('detectQuestion', () => {
  const questions: [string, string?][] = [
    ['Can you tell me about your experience managing a team?'],
    ['Tell me about yourself.'],
    ['Tell me about a time you improved a process.', 'behavioral'],
    ['Walk me through your resume.'],
    ['What is the difference between a left join and an inner join?', 'technical'],
    ['How would you handle a customer who is angry about a delayed order?', 'situational'],
    ["Why do you want to work here?", 'hr'],
    ['So, what are your greatest strengths?', 'hr'],
    ["I'd like you to describe a time you disagreed with your manager.", 'behavioral'],
    ['Do you have any questions for me?', 'closing'],
    ['Okay great. Now, how do you prioritise when everything is urgent?'],
    ['Describe a situation where you had to lead without authority.'],
  ];
  for (const [q, kind] of questions) {
    it(`recognises: ${q}`, () => {
      const s = detectQuestion(q);
      expect(s.isQuestion, JSON.stringify(s)).toBe(true);
      expect(s.confidence).toBeGreaterThanOrEqual(0.5);
      if (kind) expect(s.kind).toBe(kind);
    });
  }

  const statements = [
    'Thanks for joining us today.',
    'Great, thank you.',
    'Okay.',
    "So our team is responsible for the whole fulfilment network.",
    "Let me tell you a bit about the company first.",
    "I'll share my screen in a moment.",
    'Mm-hmm.',
    'Right, that makes sense.',
  ];
  for (const s of statements) {
    it(`ignores: ${s}`, () => {
      const r = detectQuestion(s);
      expect(r.isQuestion, JSON.stringify(r)).toBe(false);
    });
  }

  it('never treats candidate speech as a question', () => {
    expect(detectQuestion('How did I handle that? Well, I called the client.', { speaker: 'candidate' }).isQuestion).toBe(false);
  });

  it('extracts the question from a multi-sentence turn', () => {
    const r = detectQuestion('Thanks for coming in today. We are a fast growing team. Can you walk me through a project you are proud of?');
    expect(r.isQuestion).toBe(true);
    expect(r.text).toContain('walk me through a project you are proud of');
    expect(r.text).not.toContain('fast growing');
  });

  it('handles unpunctuated run-on partials from streaming STT', () => {
    const r = detectQuestion('thanks for joining today so first of all can you tell me about your experience managing large teams');
    expect(r.isQuestion).toBe(true);
    expect(r.text.toLowerCase().startsWith('can you tell me')).toBe(true);
  });

  it('marks punctuated questions complete and unfinished partials incomplete', () => {
    expect(detectQuestion('Can you tell me about your experience managing teams?').complete).toBe(true);
    const partial = detectQuestion('Can you tell me about a time when');
    expect(partial.complete).toBe(false);
  });

  it('recognises complete canned prompts without punctuation', () => {
    expect(detectQuestion('tell me about yourself').complete).toBe(true);
  });

  it('does not fire on a two-word partial', () => {
    expect(detectQuestion('What did').isQuestion).toBe(false);
  });

  it('detects follow-ups using conversation state', () => {
    const ctx = { previousQuestion: 'Tell me about a difficult customer.', msSincePreviousAnswer: 20_000 };
    for (const q of ['What did you personally do?', 'And how did that turn out?', 'Can you elaborate on that?', 'Why?']) {
      const r = detectQuestion(q, ctx);
      expect(r.isQuestion, q).toBe(true);
      expect(r.isFollowUp, q).toBe(true);
      expect(r.kind).toBe('follow-up');
    }
  });

  it('does not flag a fresh standalone question as a follow-up', () => {
    const ctx = { previousQuestion: 'Tell me about a difficult customer.', msSincePreviousAnswer: 20_000 };
    const r = detectQuestion('Walk me through how you would build a dashboard for on-time delivery.', ctx);
    expect(r.isFollowUp).toBe(false);
  });

  it('does not use stale history for follow-ups', () => {
    const r = detectQuestion('What did you personally do?', { previousQuestion: 'Tell me about a customer.', msSincePreviousAnswer: 900_000 });
    expect(r.isFollowUp).toBe(false);
  });
});

describe('question similarity', () => {
  it('treats rephrasings with the same content as the same question', () => {
    expect(sameQuestion('Tell me about your experience managing a team', 'Can you tell me about your experience managing a team?')).toBe(true);
  });
  it('separates different questions', () => {
    expect(sameQuestion('Tell me about a time you failed', 'Why do you want to work here')).toBe(false);
  });
  it('detects material change vs a trivial extension', () => {
    expect(materiallyChanged('Can you tell me about your experience managing teams', 'Can you tell me about your experience managing teams?')).toBe(false);
    expect(
      materiallyChanged('Can you tell me about your experience managing teams', 'Can you tell me about your experience managing remote teams during a reorganisation?'),
    ).toBe(true);
  });
});
