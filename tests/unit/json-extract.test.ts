import { describe, expect, it } from 'vitest';
import { outputCapFrom } from '../../src/main/ai/errors';
import { extractJson, extractJsonObjects } from '../../src/main/ai/jsonExtract';

const first = (text: string) => extractJsonObjects(text).objects[0]?.value;

const ABOUT = {
  tellMeAboutYourself: 'I am an operations manager with seven years in logistics. I run a 40-person operation.',
  professionalSummary: 'Operations manager with seven years of experience.',
  careerJourney: 'I began in support, moved into team leadership and now run operations.',
  currentRole: 'I manage 14 agents and three team leads at Northwind Logistics.',
  strengths: ['Process redesign', 'People leadership', 'Data fluency', 'Coaching'],
  relevantExperience: ['Ran a 40-person operation', 'Cut handling time by 22%', 'Built Power BI reporting'],
};
const ABOUT_TEXT = JSON.stringify(ABOUT);

describe('A. valid JSON', () => {
  it('parses compact and pretty-printed objects directly', () => {
    expect(extractJsonObjects(ABOUT_TEXT)).toMatchObject({ objects: [{ value: ABOUT, how: 'direct', repairs: [] }], truncated: false });
    expect(first(JSON.stringify(ABOUT, null, 2))).toEqual(ABOUT);
    expect(first('  \n\t' + ABOUT_TEXT + '\n\n')).toEqual(ABOUT);
  });
});

describe('B. markdown-wrapped JSON', () => {
  it('strips ```json fences', () => {
    const r = extractJsonObjects('```json\n' + ABOUT_TEXT + '\n```');
    expect(r.objects[0]).toMatchObject({ value: ABOUT, how: 'fenced' });
  });
  it('strips plain fences, upper-case tags and CRLF line endings', () => {
    expect(first('```\n' + ABOUT_TEXT + '\n```')).toEqual(ABOUT);
    expect(first('```JSON\r\n' + ABOUT_TEXT + '\r\n```')).toEqual(ABOUT);
    expect(first('```json' + ABOUT_TEXT + '```')).toEqual(ABOUT);
  });
  it('finds the object in a fence surrounded by prose', () => {
    expect(first('Sure! Here it is:\n```json\n' + ABOUT_TEXT + '\n```\nLet me know if you want changes.')).toEqual(ABOUT);
  });
  it('treats a fence that was never closed as the start of the object (a cut-off reply)', () => {
    const cut = '```json\n' + ABOUT_TEXT.slice(0, 200);
    const r = extractJsonObjects(cut);
    expect(r.failure).toBe('truncated');
    expect(r.truncated).toBe(true);
  });
  it('is not confused by backticks inside a raw JSON reply', () => {
    const v = { code: 'use ```sql``` blocks', n: 1 };
    expect(first(JSON.stringify(v))).toEqual(v);
  });
});

describe('C./D. explanatory text before and after', () => {
  it('extracts the object after an introduction, even one that contains a colon and a brace-like word', () => {
    expect(first('Here is the JSON you asked for: ' + ABOUT_TEXT)).toEqual(ABOUT);
    expect(first('I will use the {name} placeholder style.\n' + ABOUT_TEXT)).toEqual(ABOUT);
  });
  it('extracts the object before a closing remark, even one that contains braces', () => {
    expect(first(ABOUT_TEXT + '\n\nHope this helps! Let me know if you need {anything} else.')).toEqual(ABOUT);
    expect(first('Result: ' + ABOUT_TEXT + ' — done.')).toEqual(ABOUT);
  });
  it('ignores a stray unmatched brace in the introduction', () => {
    expect(first('An opening brace { in the prose, then the object: ' + ABOUT_TEXT)).toEqual(ABOUT);
  });
  it('skips an example object that cannot be read and returns the real one', () => {
    expect(first('The shape is {"name": ...}. Now the answer: {"name": "Riya"}')).toEqual({ name: 'Riya' });
  });
});

describe('E. truncated JSON', () => {
  it('reports truncation instead of failing with a vague error', () => {
    const r = extractJsonObjects(ABOUT_TEXT.slice(0, 300));
    expect(r.failure).toBe('truncated');
    expect(r.truncated).toBe(true);
    expect(r.objects).toEqual([]);
  });

  it('salvages only what was written in full: a string cut in the middle is dropped, not completed', () => {
    const cutInsideCareer = ABOUT_TEXT.slice(0, ABOUT_TEXT.indexOf('"careerJourney"') + 40);
    const r = extractJsonObjects(cutInsideCareer);
    expect(r.salvage?.value).toEqual({ tellMeAboutYourself: ABOUT.tellMeAboutYourself, professionalSummary: ABOUT.professionalSummary });
    expect(r.salvage?.completeKeys).toEqual(['tellMeAboutYourself', 'professionalSummary']);
    expect(r.salvage?.partialKey).toBeUndefined();
  });

  it('keeps the complete items of a list that was cut, and says which key was cut', () => {
    const at = ABOUT_TEXT.indexOf('"Data fluency"') + 6;
    const r = extractJsonObjects(ABOUT_TEXT.slice(0, at));
    expect(r.salvage?.value.strengths).toEqual(['Process redesign', 'People leadership']);
    expect(r.salvage?.partialKey).toBe('strengths');
    expect(r.salvage?.completeKeys).not.toContain('strengths');
    expect(r.salvage?.completeKeys).toContain('currentRole');
  });

  it('a reply that lacks only its final brace is fully recovered', () => {
    const r = extractJsonObjects(ABOUT_TEXT.slice(0, -1));
    expect(r.failure).toBe('truncated');
    expect(r.salvage?.value).toEqual(ABOUT);
    expect(r.salvage?.completeKeys).toEqual(Object.keys(ABOUT));
  });

  it('never returns an inner object of a cut-off reply as if it were the answer', () => {
    const cut = '{"questions":[{"category":"hr","text":"Tell me about yourself"},{"category":"technical","text":"Explain SQL joins';
    const r = extractJsonObjects(cut);
    expect(r.objects).toEqual([]);
    expect(r.failure).toBe('truncated');
    expect(r.salvage?.value).toEqual({ questions: [{ category: 'hr', text: 'Tell me about yourself' }] });
    expect(r.salvage?.partialKey).toBe('questions');
  });

  it('has nothing to salvage when the reply stopped before the first value finished', () => {
    const r = extractJsonObjects('{"tellMeAboutYourself": "I am an operations mana');
    expect(r.failure).toBe('truncated');
    expect(r.salvage).toBeUndefined();
  });
});

describe('F. nested JSON', () => {
  it('handles objects in arrays in objects', () => {
    const v = { a: { b: { c: [{ d: 1 }, { e: [1, 2, { f: 'g' }] }] } }, h: [] };
    expect(first('Result: ' + JSON.stringify(v) + ' — ok')).toEqual(v);
    expect(first('```json\n' + JSON.stringify(v, null, 2) + '\n```')).toEqual(v);
  });
  it('handles very deep nesting without recursion problems', () => {
    let s = '"leaf"';
    for (let i = 0; i < 60; i++) s = `{"k${i}": ${s}}`;
    expect(first('x ' + s + ' y')).toBeTruthy();
  });
});

describe('G. braces and brackets inside strings', () => {
  it('does not count them', () => {
    const v = { a: 'closing } and opening { braces', b: 'a ] bracket [ pair', 'we}ird{key': 'x', c: '{"looks": "like json"}' };
    expect(first('Note: ' + JSON.stringify(v) + ' thanks')).toEqual(v);
  });
  it('does not mistake such a string for the end of a cut-off reply', () => {
    const r = extractJsonObjects('{"a": "text with } inside", "b": "and { too", "c": "cut o');
    expect(r.failure).toBe('truncated');
    expect(r.salvage?.value).toEqual({ a: 'text with } inside', b: 'and { too' });
  });
});

describe('H. escaped quotes, backslashes and unicode', () => {
  it('reads them exactly', () => {
    const v = { a: 'He said "hello" to me', b: 'path C:\\Users\\me', c: 'tab\there\nnew line', d: 'emoji 🚀 and ünïcödé and \u2603', e: 'slash / and \\/' };
    expect(first('```json\n' + JSON.stringify(v) + '\n```')).toEqual(v);
  });
  it('keeps an escaped quote from ending the string early', () => {
    expect(first('{"a": "one \\" two \\" three", "b": 2}')).toEqual({ a: 'one " two " three', b: 2 });
  });
});

describe('I. empty and useless replies', () => {
  it('reports each precisely and never throws', () => {
    for (const [text, failure] of [
      ['', 'empty'],
      ['   \n\t ', 'empty'],
      ['\uFEFF', 'empty'],
      ['Sorry, I cannot help with that.', 'no-json'],
      ['null', 'no-json'],
      ['[1, 2, 3]', 'no-json'],
      ['```json\n```', 'no-json'],
      ['{ this is not json }', 'no-json'],
    ] as const) {
      const r = extractJsonObjects(text);
      expect(r.objects).toEqual([]);
      expect(r.failure).toBe(failure);
    }
  });
  it('the compatibility wrapper still throws with the old wording', () => {
    expect(() => extractJson('')).toThrow('no JSON object found');
    expect(() => extractJson('{"a": "b')).toThrow('unterminated JSON object');
    expect(extractJson('Sure!\n```json\n{"a": [1,2,], "b": {"c": "x}"}}\n```\nDone')).toEqual({ a: [1, 2], b: { c: 'x}' } });
  });
});

describe('mechanical repairs (punctuation only)', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['trailing commas', '{"a": [1, 2, 3,], "b": {"c": 1,},}', { a: [1, 2, 3], b: { c: 1 } }],
    ['line comments', '{"a": 1, // the first\n "b": 2}', { a: 1, b: 2 }],
    ['block comments', '{"a": /* note */ 1, "b": 2}', { a: 1, b: 2 }],
    ['single quotes', "{'a': 'it\\'s fine', 'b': 'x'}", { a: "it's fine", b: 'x' }],
    ['unquoted keys', '{a: 1, b_2: "x"}', { a: 1, b_2: 'x' }],
    ['a raw line break inside a string', '{"a": "line one\nline two", "b": 1}', { a: 'line one\nline two', b: 1 }],
    ['a raw tab inside a string', '{"a": "x\ty", "b": 1}', { a: 'x\ty', b: 1 }],
    ['an unescaped quote inside a sentence', '{"a": "He said "hello" to me", "b": "ok"}', { a: 'He said "hello" to me', b: 'ok' }],
    ['a missing comma between members', '{"a": "x"\n  "b": "y"}', { a: 'x', b: 'y' }],
    ['a missing comma after a number', '{"a": 1\n "b": 2}', { a: 1, b: 2 }],
    ['a missing comma after a list', '{"a": [1, 2]\n "b": 2}', { a: [1, 2], b: 2 }],
    ['a list that was never closed', '{"a": [1, 2, 3}', { a: [1, 2, 3] }],
    ['a list that was never closed after a comma', '{"a": [1, 2,}', { a: [1, 2] }],
    ['Python and JS literals', '{"a": True, "b": None, "c": NaN, "d": False}', { a: true, b: null, c: null, d: false }],
    ['a broken escape', '{"a": "bad \\q escape"}', { a: 'bad q escape' }],
    ['repeated commas', '{"a": 1,, "b": 2}', { a: 1, b: 2 }],
  ];
  it.each(cases)('%s', (_name, text, expected) => {
    const r = extractJsonObjects(text);
    expect(r.objects[0]?.value).toEqual(expected);
    expect(r.objects[0]?.repairs.length).toBeGreaterThan(0);
  });

  it('a // inside a string is text, not a comment', () => {
    expect(first('{"a": "https://example.com/x//y", "b": 2,}')).toEqual({ a: 'https://example.com/x//y', b: 2 });
  });

  it('a stray closing bracket is ignored', () => {
    expect(first('{"a": 1}, "b": 2}')).toEqual({ a: 1 });
  });

  it('reports what was repaired, and nothing when nothing was', () => {
    expect(extractJsonObjects('{"a": 1,}').objects[0]?.repairs).toEqual(['removed a trailing comma']);
    expect(extractJsonObjects('{"a": 1}').objects[0]?.repairs).toEqual([]);
  });
});

describe('several objects and odd shapes', () => {
  it('returns every top-level object in order and lets the caller choose', () => {
    const r = extractJsonObjects('First {"a": 1} then {"b": 2} finally {"c": {"d": 3}}');
    expect(r.objects.map((o) => o.value)).toEqual([{ a: 1 }, { b: 2 }, { c: { d: 3 } }]);
  });
  it('an array of objects yields its elements as candidates (the caller validates them against its schema)', () => {
    expect(extractJsonObjects('[{"a": 1}, {"a": 2}]').objects.map((o) => o.value)).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('ignores a byte order mark and zero-width characters', () => {
    expect(first('\uFEFF\u200B' + ABOUT_TEXT)).toEqual(ABOUT);
  });
});

describe('the parser cannot be made to fail, hang or lie', () => {
  it('never throws on arbitrary text', () => {
    const alphabet = ['{', '}', '[', ']', '"', "'", ',', ':', '\\', '/', '*', '\n', ' ', 'a', '1', 'true', 'null', '```', '\uD83D', '\u0000', '-'];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const len = Math.floor(rnd() * 80);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(() => extractJsonObjects(s)).not.toThrow();
    }
  });

  it('is consistent for every possible cut point of a real reply: a salvage only ever contains what was written', () => {
    const originals = ABOUT as Record<string, unknown>;
    for (let p = 0; p <= ABOUT_TEXT.length; p++) {
      const r = extractJsonObjects(ABOUT_TEXT.slice(0, p));
      if (p === ABOUT_TEXT.length) {
        expect(r.objects[0]?.value).toEqual(ABOUT);
        continue;
      }
      expect(r.objects).toEqual([]); // a cut-off reply is never mistaken for a complete one
      const s = r.salvage;
      if (!s) continue;
      for (const [key, value] of Object.entries(s.value)) {
        const original = originals[key];
        if (key === s.partialKey) {
          expect(Array.isArray(value)).toBe(true);
          expect(original).toEqual(expect.arrayContaining(value as unknown[]));
          expect((original as unknown[]).slice(0, (value as unknown[]).length)).toEqual(value);
        } else expect(value).toEqual(original);
      }
      // every key reported complete is present, whole, and in the original
      for (const key of s.completeKeys) expect(s.value[key]).toEqual(originals[key]);
    }
  });

  it('every prefix of a pretty-printed, fenced reply behaves the same way', () => {
    const text = '```json\n' + JSON.stringify(ABOUT, null, 2) + '\n```';
    for (let p = 0; p < text.length; p += 7) {
      const r = extractJsonObjects(text.slice(0, p));
      for (const obj of r.objects) expect(obj.value).toEqual(ABOUT);
    }
  });

  it('is fast on a million characters, on thousands of stray braces and on absurd nesting', () => {
    const big = { list: Array.from({ length: 20_000 }, (_, i) => ({ id: i, text: `item number ${i} with some words` })) };
    const bigText = JSON.stringify(big).replace(/}]}$/, '},]}'); // a trailing comma forces the tolerant path
    let t = performance.now();
    expect((first(bigText) as { list: unknown[] }).list).toHaveLength(20_000);
    expect(performance.now() - t).toBeLessThan(3000);

    t = performance.now();
    expect(extractJsonObjects('{"a":'.repeat(50_000)).failure).toBe('truncated');
    expect(extractJsonObjects('{'.repeat(100_000)).failure).toBeDefined();
    expect(extractJsonObjects('['.repeat(200_000) + '{"a": 1}').objects[0]?.value).toEqual({ a: 1 });
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('refuses absurdly large input instead of scanning it', () => {
    expect(extractJsonObjects('x'.repeat(2_000_000)).failure).toBe('invalid');
  });
});

describe('outputCapFrom: reading the output limit out of a provider refusal', () => {
  it('finds the limit in the wording providers actually use', () => {
    expect(outputCapFrom('max_tokens is too large: 6400. This model supports at most 4096 completion tokens, whereas you provided 6400.', 6400)).toBe(4096);
    expect(outputCapFrom("Unable to submit request because the requested max output tokens (20000) exceeds the model's limit (8192).", 20_000)).toBe(8192);
    expect(outputCapFrom('The maximum output tokens for this model is 8,192', 12_000)).toBe(8192);
  });
  it('does not mistake other refusals for an output limit', () => {
    expect(outputCapFrom("This model's maximum context length is 8192 tokens. However, you requested 12000 tokens (10000 in the messages, 2000 in the completion).", 2000)).toBeNull();
    expect(outputCapFrom("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", 800)).toBeNull();
    expect(outputCapFrom('Invalid API key', 800)).toBeNull();
    expect(outputCapFrom('max_tokens must be at least 1', 800)).toBeNull();
  });
  it('never returns a limit that is not below what was asked for', () => {
    expect(outputCapFrom('max_tokens is too large: 4096. This model supports at most 8192 completion tokens', 4096)).toBeNull();
  });
});
