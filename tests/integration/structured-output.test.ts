import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiDebug } from '../../src/main/ai/diagnostics';
import { obj, str, strList } from '../../src/main/ai/schema';
import { generateJson, type JsonRequest } from '../../src/main/ai/structured';
import { logger } from '../../src/main/logging';
import { makeHarness } from '../helpers/gatewayHarness';
import { MockLlmServer, type ScriptedReply } from '../helpers/mockLlmServer';

/**
 * Structured (JSON) replies against real HTTP servers speaking the OpenAI and Gemini wire formats: what happens when
 * the reply is fine, wrapped, chatty, cut off, empty or refused, and what the pipeline asks the provider for.
 * The guarantee under test: a malformed or truncated reply is read tolerantly, then answered with a DIFFERENT request
 * (never the same one again), in at most two model requests, and the error that finally surfaces says what happened.
 */

let srv: MockLlmServer;
beforeAll(async () => {
  srv = await new MockLlmServer().start();
});
afterAll(async () => {
  await srv.stop();
});
beforeEach(() => srv.reset());

const Schema = z.object({ title: z.string().default(''), items: z.array(z.string()).default([]) });
const JSON_SCHEMA = obj({ title: str(), items: strList() });
const OK = { title: 'Plan {1}', items: ['an "escaped" quote', 'a closing } brace', 'a plain item', 'path C:\\temp'] };
const OK_TEXT = JSON.stringify(OK);
const posts = () => srv.requests.filter((r) => r.method === 'POST');
const bodyOf = (i: number) => posts()[i]?.body as Record<string, unknown>;
const controller = () => new AbortController().signal;

function openai(model = 'gpt-4.1', ceiling = 700) {
  const h = makeHarness();
  const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij', 'OpenAI-compatible');
  h.route('prep', h.addModel(p, model, { maxTokens: ceiling }));
  return h;
}
function google(model = 'gemini-3.5-flash', ceiling = 700) {
  const h = makeHarness();
  const p = h.addProvider('google', srv.googleUrl, 'AIza-test-key-123456', 'Google');
  h.route('prep', h.addModel(p, model, { maxTokens: ceiling }));
  return h;
}
const json = (h: ReturnType<typeof openai>, over: Partial<JsonRequest<z.infer<typeof Schema>>> = {}) => {
  const notices: string[] = [];
  const run = generateJson(h.gateway, { task: 'prep', system: 'SYSTEM', user: 'USER', schema: Schema, maxTokens: 1800, signal: controller(), onNotice: (_l, m) => notices.push(m), ...over });
  return { run, notices };
};

describe('A–D. a reply that is fine, wrapped, or surrounded by chat is used as it is, in one request', () => {
  it.each([
    ['valid JSON', OK_TEXT],
    ['pretty-printed JSON', JSON.stringify(OK, null, 2)],
    ['markdown fence', '```json\n' + OK_TEXT + '\n```'],
    ['a bare fence', '```\n' + OK_TEXT + '\n```'],
    ['explanatory text before', 'Sure! Here is the JSON you asked for: ' + OK_TEXT],
    ['explanatory text after', OK_TEXT + '\n\nLet me know if you would like {anything} changed.'],
    ['text before and after, inside a fence', 'Here you go:\n```json\n' + OK_TEXT + '\n```\nAnything else?'],
  ])('%s', async (_name, text) => {
    srv.openai.script = [{ text }];
    const { run, notices } = json(openai());
    const out = await run;
    expect(out.value).toEqual(OK);
    expect(out.path).toBe('first');
    expect(posts()).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('nested objects, braces inside strings and escaped quotes survive', async () => {
    const Nested = z.object({ a: z.object({ b: z.array(z.object({ c: z.string() })) }), s: z.string() });
    const value = { a: { b: [{ c: 'x } y { z' }, { c: 'say "hi"' }] }, s: '\\ and \n and \u00e9 and \ud83d\ude80' };
    srv.openai.script = [{ text: 'Result: ```json\n' + JSON.stringify(value) + '\n``` done {ok}' }];
    const out = await generateJson(openai().gateway, { task: 'prep', system: 's', user: 'u', schema: Nested, signal: controller() });
    expect(out.value).toEqual(value);
    expect(posts()).toHaveLength(1);
  });

  it('punctuation slips are repaired locally, with no second request', async () => {
    srv.openai.script = [{ text: "{'title': 'Plan', 'items': ['a', 'b',],}" }];
    const out = await json(openai()).run;
    expect(out.value).toEqual({ title: 'Plan', items: ['a', 'b'] });
    expect(posts()).toHaveLength(1);
  });
});

describe('E. a reply that was cut off is not repeated: it gets a different, shorter request', () => {
  const requiredKeys = ['title', 'items'];

  it('asks again with more room, and says so — without asking for a worse (shorter) answer', async () => {
    srv.openai.script = [{ text: OK_TEXT.slice(0, 30), finishReason: 'length' }, { text: OK_TEXT }];
    const { run, notices } = json(openai(), { requiredKeys });
    const out = await run;
    expect(out.value).toEqual(OK);
    expect(out.path).toBe('retry');
    expect(posts()).toHaveLength(2);
    // not the same request again: the budget doubled
    expect(bodyOf(0).max_tokens).toBe(1800);
    expect(bodyOf(1).max_tokens).toBe(3600);
    // the instructions are unchanged: extraction tasks must not be told to write less
    expect(JSON.stringify(bodyOf(1).messages)).toBe(JSON.stringify(bodyOf(0).messages));
    expect(notices.some((n) => /cut off.*more room/.test(n))).toBe(true);
  });

  it('when the budget cannot grow any more, the retry asks for brevity instead', async () => {
    srv.openai.script = [{ text: '{"title": "T', finishReason: 'length' }, { text: OK_TEXT }];
    await json(openai(), { maxTokens: 8192 }).run;
    expect(bodyOf(1).max_tokens).toBe(8192);
    expect(JSON.stringify(bodyOf(1).messages)).toContain('Your previous reply was cut off');
    expect(JSON.stringify(bodyOf(0).messages)).not.toContain('Your previous reply was cut off');
  });

  it('a retry does not repeat the native schema that just failed to give a usable reply: it uses plain JSON mode', async () => {
    srv.openai.script = [{ text: '{"title": 5, "items": "no"}' }, { text: OK_TEXT }];
    const out = await json(openai(), { jsonSchema: JSON_SCHEMA }).run;
    expect(out.value).toEqual(OK);
    expect((bodyOf(0).response_format as { type: string }).type).toBe('json_schema');
    expect(bodyOf(1).response_format).toEqual({ type: 'json_object' });
  });

  it('uses the caller’s own compact request when it has one', async () => {
    srv.openai.script = [{ text: OK_TEXT.slice(0, 30), finishReason: 'length' }, { text: OK_TEXT }];
    await json(openai(), { requiredKeys, compact: { system: 'COMPACT SYSTEM', maxTokens: 2222 } }).run;
    expect(JSON.stringify(bodyOf(1).messages)).toContain('COMPACT SYSTEM');
    expect(bodyOf(1).max_tokens).toBe(2222);
  });

  it('a reply that lacks only its closing brace is complete, with no second request', async () => {
    srv.openai.script = [{ text: OK_TEXT.slice(0, -1), finishReason: 'length' }];
    const out = await json(openai(), { requiredKeys }).run;
    expect(out.value).toEqual(OK);
    expect(out.path).toBe('first');
    expect(posts()).toHaveLength(1);
  });

  it('two partial replies that between them wrote every field are combined, with no third request', async () => {
    const Three = z.object({ a: z.string().default(''), b: z.string().default(''), c: z.string().default('') });
    srv.openai.script = [
      { text: '{"a": "1", "b": "2", "c": "3', finishReason: 'length' },
      { text: '{"c": "3", "a": "1", "b', finishReason: 'length' },
    ];
    const out = await generateJson(openai().gateway, { task: 'prep', system: 's', user: 'u', schema: Three, requiredKeys: ['a', 'b', 'c'], signal: controller() });
    expect(out.value).toEqual({ a: '1', b: '2', c: '3' });
    expect(posts()).toHaveLength(2);
  });

  it('when both replies are cut off the error says so — after exactly two different requests', async () => {
    srv.openai.script = [
      { text: '{"title": "T", "items": ["one", "two', finishReason: 'length' },
      { text: '{"title": "T", "items": ["one"', finishReason: 'length' },
    ];
    await expect(json(openai(), { requiredKeys }).run).rejects.toMatchObject({ code: 'malformed', reason: 'output-limit', message: expect.stringMatching(/cut off.*output limit/i) as string });
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1).max_tokens).not.toBe(bodyOf(0).max_tokens);
  });

  it('never raises the budget past the sanity ceiling', async () => {
    srv.openai.script = [{ text: '{"title": "T', finishReason: 'length' }, { text: OK_TEXT }];
    await json(openai(), { maxTokens: 6000 }).run;
    expect(bodyOf(1).max_tokens).toBe(8192);
  });
});

describe('I. empty or unusable replies', () => {
  it('an empty reply gets one different request', async () => {
    srv.openai.script = [{ text: '' }, { text: OK_TEXT }];
    const out = await json(openai()).run;
    expect(out.value).toEqual(OK);
    expect(posts()).toHaveLength(2);
  });

  it('two empty replies fail with a plain message, after two requests', async () => {
    srv.openai.script = [{ text: '' }, { text: '' }];
    await expect(json(openai()).run).rejects.toMatchObject({ code: 'malformed', message: expect.stringMatching(/empty reply twice/) as string });
    expect(posts()).toHaveLength(2);
  });

  it('prose with no JSON at all is asked again, then reported as unreadable', async () => {
    srv.openai.script = [{ text: 'I am sorry, I cannot do that.' }, { text: 'Still no.' }];
    await expect(json(openai()).run).rejects.toMatchObject({ code: 'malformed', message: expect.stringMatching(/could not be read/) as string });
    expect(posts()).toHaveLength(2);
  });

  it('valid JSON of the wrong shape gets one stricter request', async () => {
    const Strict = z.object({ name: z.string() });
    srv.openai.script = [{ text: '{"name": 5}' }, { text: '{"name": "Riya"}' }];
    const out = await generateJson(openai().gateway, { task: 'prep', system: 's', user: 'u', schema: Strict, signal: controller() });
    expect(out.value).toEqual({ name: 'Riya' });
    expect(bodyOf(1).temperature).toBe(0);
    expect(JSON.stringify(bodyOf(1).messages)).toContain('could not be read');
    expect(JSON.stringify(bodyOf(0).messages)).not.toContain('could not be read');
  });

  const Two = z.object({ a: z.string().default(''), b: z.string().default('') });
  const builder = (text: string, salvaged: Record<string, unknown> | null) => {
    const s = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
    const b = s(salvaged?.b, text);
    return b ? { a: s(salvaged?.a), b } : null;
  };
  const withFallback = (h: ReturnType<typeof openai>) =>
    generateJson(h.gateway, { task: 'prep', system: 's', user: 'u', schema: Two, requiredKeys: ['a', 'b'], signal: controller(), plainFallback: { system: 'PLAIN', user: 'u', maxTokens: 300, build: builder } });

  it('the last resort, when the caller allows one, is a plain-text request built with what was written in full', async () => {
    srv.openai.script = [
      { text: '{"a": "kept", "b": "cut off', finishReason: 'length' },
      { text: '{"a": "kept", "b": "cut off again', finishReason: 'length' },
      { text: 'A plain sentence long enough to be used as the main text of the answer.' },
    ];
    const out = await withFallback(openai());
    expect(out.value).toEqual({ a: 'kept', b: 'A plain sentence long enough to be used as the main text of the answer.' });
    expect(out.path).toBe('partial');
    expect(posts()).toHaveLength(3);
    expect(bodyOf(2).response_format).toBeUndefined(); // the plain request is not a JSON request
  });

  it('…and no third request is made when the earlier replies already wrote enough', async () => {
    srv.openai.script = [
      { text: '{"a": "kept", "b": "the second field, written in full", "c": "cut o', finishReason: 'length' },
      { text: '{"x": "cut', finishReason: 'length' },
    ];
    // the first reply wrote both required keys in full, so it is accepted directly (no fallback needed at all)
    const out = await withFallback(openai());
    expect(out.value).toEqual({ a: 'kept', b: 'the second field, written in full' });
    expect(posts()).toHaveLength(1);
  });

  it('…and none is made when the salvage of the two attempts is already usable by the caller', async () => {
    srv.openai.script = [
      { text: '{"a": "kept", "b": "cut', finishReason: 'length' }, // only "a" was completed
      { text: '{"b": "the second field, written in full", "a', finishReason: 'length' }, // only "b" was completed
    ];
    const out = await withFallback(openai());
    expect(out.value).toEqual({ a: 'kept', b: 'the second field, written in full' });
    expect(posts()).toHaveLength(2);
  });
});

describe('J. a stream that ends unexpectedly', () => {
  it('is reported as possibly cut off; the partial text is kept and nothing throws', async () => {
    srv.openai.endStreamAfterTokens = 3;
    const h = openai();
    const tokens: string[] = [];
    const notices: string[] = [];
    const res = await h.gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: controller(), onToken: (t) => tokens.push(t), onNotice: (_l, m) => notices.push(m) });
    expect(res.text).toBe('In my current ');
    expect(res.finishReason).toBe('other');
    expect(res.meta?.completed).toBe(false);
    expect(notices.some((n) => /may be cut off/.test(n))).toBe(true);
  });

  it('a clean stream reports itself complete', async () => {
    const res = await openai().gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: controller(), onToken: () => undefined });
    expect(res.meta).toMatchObject({ completed: true, streamed: true, rawFinishReason: 'stop' });
  });
});

describe('K. provider errors are errors, never disguised as unreadable replies', () => {
  it('an invalid key fails at once, with no second request', async () => {
    srv.openai.requireKey = 'sk-other-key-000000';
    await expect(json(openai()).run).rejects.toMatchObject({ code: 'auth' });
    expect(posts()).toHaveLength(1);
  });

  it('a failing server is retried by the gateway (with back-off), not asked a second question', async () => {
    srv.openai.status = 500;
    srv.openai.failCount = 99;
    srv.openai.retryAfter = '0';
    await expect(json(openai()).run).rejects.toMatchObject({ code: 'server' });
    expect(posts()).toHaveLength(3); // the first try and two retries, once — not once per JSON attempt
  });

  it('a rate limit that persists is reported as one', async () => {
    srv.openai.status = 429;
    srv.openai.failCount = 99;
    srv.openai.retryAfter = '0';
    srv.openai.errorBody = { error: { message: 'Too many requests', type: 'rate_limit_error' } };
    await expect(json(openai()).run).rejects.toMatchObject({ code: 'rate_limit' });
    expect(posts()).toHaveLength(3);
  });
});

describe('L. a model without JSON mode or structured outputs is not sent what it cannot accept', () => {
  it('steps down from a schema, to JSON mode, to a plain prompt — and remembers', async () => {
    srv.openai.rejectResponseFormat = ['json_schema', 'json_object'];
    srv.openai.dynamic = () => OK_TEXT;
    const h = openai();
    const first = await json(h, { jsonSchema: JSON_SCHEMA }).run;
    expect(first.value).toEqual(OK);
    const types = posts().map((r) => (r.body?.response_format as { type?: string } | undefined)?.type);
    expect(types).toEqual(['json_schema', 'json_object', undefined]);

    srv.requests.length = 0;
    await json(h, { jsonSchema: JSON_SCHEMA }).run;
    expect(posts()).toHaveLength(1);
    expect(bodyOf(0).response_format).toBeUndefined();
  });

  it('a server that refuses response_format altogether is handled the same way', async () => {
    srv.openai.rejectParams = ['response_format'];
    srv.openai.dynamic = () => OK_TEXT;
    const out = await json(openai(), { jsonSchema: JSON_SCHEMA }).run;
    expect(out.value).toEqual(OK);
    expect(bodyOf(posts().length - 1).response_format).toBeUndefined();
  });

  it('a server that supports json_schema is given the schema', async () => {
    srv.openai.script = [{ text: OK_TEXT }];
    await json(openai(), { jsonSchema: JSON_SCHEMA }).run;
    const rf = bodyOf(0).response_format as { type: string; json_schema: { name: string; schema: { required: string[] } } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.schema.required).toEqual(['title', 'items']);
  });

  it('JSON mode is used when no schema is given', async () => {
    srv.openai.script = [{ text: OK_TEXT }];
    await json(openai()).run;
    expect(bodyOf(0).response_format).toEqual({ type: 'json_object' });
  });

  it('Gemini: a refused response schema is dropped and remembered', async () => {
    srv.google.rejectSchema = true;
    srv.google.dynamic = () => OK_TEXT;
    const h = google();
    const out = await json(h, { jsonSchema: JSON_SCHEMA }).run;
    expect(out.value).toEqual(OK);
    const cfgs = posts().map((r) => (r.body?.generationConfig ?? {}) as Record<string, unknown>);
    expect(cfgs.map((c) => !!c.responseSchema)).toEqual([true, false]);
    expect(cfgs[1]?.responseMimeType).toBe('application/json');
    srv.requests.length = 0;
    await json(h, { jsonSchema: JSON_SCHEMA }).run;
    expect(posts()).toHaveLength(1);
  });

  it('Gemini: the schema is sent in the form Gemini accepts', async () => {
    srv.google.script = [{ text: OK_TEXT }];
    await json(google(), { jsonSchema: JSON_SCHEMA }).run;
    const schema = ((bodyOf(0).generationConfig as Record<string, unknown>).responseSchema ?? {}) as Record<string, unknown>;
    expect(schema).toMatchObject({ type: 'OBJECT', required: ['title', 'items'], propertyOrdering: ['title', 'items'], properties: { title: { type: 'STRING' }, items: { type: 'ARRAY', items: { type: 'STRING' } } } });
    expect(JSON.stringify(schema)).not.toMatch(/additionalProperties|\$schema|default/);
  });
});

describe('M. a model that does not stream still works', () => {
  it('answers in full, and the reply says it was not streamed', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('prep', h.addModel(p, 'no-stream', { streaming: false }));
    const tokens: string[] = [];
    const res = await h.gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: controller(), onToken: (t) => tokens.push(t) });
    expect(res.text).toBe('In my current role I led a team.');
    expect(res.meta?.streamed).toBe(false);
    expect(posts().every((r) => r.body?.stream === false)).toBe(true);
  });

  it('a stream with a broken event falls back to a plain response (existing behaviour, kept)', async () => {
    srv.openai.malformedStream = true;
    const notices: string[] = [];
    const res = await openai().gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: controller(), onToken: () => undefined, onNotice: (_l, m) => notices.push(m) });
    expect(res.text).toContain('In my current role');
    expect(notices.some((n) => /without streaming/.test(n))).toBe(true);
  });
});

describe('the output budget: the root cause of the “unterminated JSON object” failure', () => {
  it('a structured request keeps its own budget even when the model row has a small “max tokens”', async () => {
    srv.openai.script = [{ text: OK_TEXT }];
    await json(openai('gpt-4.1', 700), { maxTokens: 1800 }).run;
    expect(bodyOf(0).max_tokens).toBe(1800);
  });

  it('a spoken answer is still held to the model’s cap', async () => {
    await openai('gpt-4.1', 700).gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 1800, signal: controller() });
    expect(bodyOf(0).max_tokens).toBe(700);
  });

  it('a JSON request that names no budget falls back to the model’s cap, as before', async () => {
    srv.openai.script = [{ text: OK_TEXT }];
    await generateJson(openai('gpt-4.1', 700).gateway, { task: 'prep', system: 's', user: 'u', schema: Schema, signal: controller() });
    expect(bodyOf(0).max_tokens).toBe(2000);
  });
});

describe('a provider with a smaller output limit than the retry asks for', () => {
  it('OpenAI-style refusal: the limit is learned from the message and used at once, and again next time', async () => {
    srv.openai.maxOutputLimit = 4096;
    srv.openai.script = [{ text: '{"title": "T', finishReason: 'length' }, { text: OK_TEXT }];
    const h = openai();
    const out = await json(h, { maxTokens: 3200, requiredKeys: ['title', 'items'] }).run;
    expect(out.value).toEqual(OK);
    expect(posts().map((r) => r.body?.max_tokens)).toEqual([3200, 6400, 4096]); // the 6400 was refused, so 4096 was sent
    srv.requests.length = 0;
    srv.openai.dynamic = () => OK_TEXT;
    await json(h, { maxTokens: 6400 }).run;
    expect(posts().map((r) => r.body?.max_tokens)).toEqual([4096]);
  });

  it('Gemini-style refusal likewise', async () => {
    srv.google.maxOutputLimit = 8192;
    srv.google.script = [{ text: '{"title": "T', finishReason: 'length' }, { text: OK_TEXT }];
    const out = await json(google('gemini-2.0-flash'), { maxTokens: 6000, requiredKeys: ['title', 'items'] }).run;
    expect(out.value).toEqual(OK);
    const asked = posts().map((r) => (r.body?.generationConfig as { maxOutputTokens: number }).maxOutputTokens);
    expect(asked).toEqual([6000, 8192]); // 12000 would have been refused; the ceiling for a retry is 8192
  });
});

describe('hidden reasoning shares the output limit, so structured requests keep it small', () => {
  const thinking = (i: number) => (bodyOf(i).generationConfig as { thinkingConfig?: unknown }).thinkingConfig;

  it.each([
    ['gemini-2.5-flash', { thinkingBudget: 0 }],
    ['gemini-2.5-flash-lite', { thinkingBudget: 0 }],
    ['gemini-2.5-pro', { thinkingBudget: 128 }],
    ['gemini-3.5-flash', { thinkingLevel: 'low' }],
    ['gemini-3.8-flash', { thinkingLevel: 'low' }],
    ['gemini-2.0-flash', undefined],
  ])('%s', async (model, expected) => {
    srv.google.script = [{ text: OK_TEXT }];
    await json(google(model)).run;
    expect(thinking(0)).toEqual(expected);
  });

  it('a spoken prepared answer on a Gemini model is left alone (no thinking parameter)', async () => {
    await google('gemini-3.5-flash').gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: controller() });
    expect(thinking(0)).toBeUndefined();
  });

  it('live answers on a Gemini 3 model get it too (latency), not only Gemini 2.5', async () => {
    const h = makeHarness();
    const p = h.addProvider('google', srv.googleUrl, 'AIza-test-key-123456');
    h.route('live', h.addModel(p, 'gemini-3.5-flash'));
    await h.gateway.generate({ task: 'live', system: 's', user: 'u', maxTokens: 200, signal: controller() });
    expect(thinking(0)).toEqual({ thinkingLevel: 'low' });
  });

  it('a model that refuses one parameter is moved to the next, and remembered', async () => {
    srv.google.rejectThinking = ['level'];
    srv.google.dynamic = () => OK_TEXT;
    const h = google('gemini-3.5-flash');
    await json(h).run;
    expect(posts().map((r) => (r.body?.generationConfig as { thinkingConfig?: unknown }).thinkingConfig)).toEqual([{ thinkingLevel: 'low' }, { thinkingBudget: 0 }]);
    srv.requests.length = 0;
    await json(h).run;
    expect(posts()).toHaveLength(1);
    expect(thinking(0)).toEqual({ thinkingBudget: 0 });
  });

  it('a model that refuses every parameter simply gets none, and the reply arrives', async () => {
    srv.google.rejectThinking = ['level', 'budget'];
    srv.google.script = [{ text: OK_TEXT }];
    const out = await json(google('gemini-3.5-flash')).run;
    expect(out.value).toEqual(OK);
    expect(thinking(posts().length - 1)).toBeUndefined();
  });

  it('with the limit in place the reply is not eaten by thinking (the mock spends thinking tokens from the same limit)', async () => {
    srv.google.honorMaxTokens = true;
    srv.google.thinkingTokens = 900;
    srv.google.dynamic = () => OK_TEXT;
    const out = await json(google('gemini-3.5-flash'), { maxTokens: 1000 }).run;
    expect(out.value).toEqual(OK);
    expect(out.path).toBe('first');
  });

  it('without the limit it would have been (and a real Gemini 2.5/3 model does exactly this)', async () => {
    srv.google.honorMaxTokens = true;
    srv.google.thinkingTokens = 990;
    srv.google.dynamic = () => OK_TEXT;
    // an older Gemini model has no thinking parameter to send, so the mock spends the thinking budget regardless
    const res = await google('gemini-2.0-flash').gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 1000, signal: controller(), json: true });
    expect(res.finishReason).toBe('length');
    expect(res.text.length).toBeLessThan(OK_TEXT.length);
  });

  it('a reply eaten whole by thinking is reported as an output-limit problem and retried with more room', async () => {
    srv.google.script = [{ text: '', finishReason: 'length' }, { text: OK_TEXT }];
    const out = await json(google('gemini-2.0-flash'), { maxTokens: 500 }).run;
    expect(out.value).toEqual(OK);
    expect(posts()).toHaveLength(2);
    expect((bodyOf(1).generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(1000);
  });
});

describe('a server that is failing is not retried again and again', () => {
  const setup = () => {
    const h = makeHarness();
    const p = h.addProvider('google', srv.googleUrl, 'AIza-test-key-123456');
    const fast = h.addModel(p, 'model-fast');
    const quality = h.addModel(p, 'model-quality');
    h.route('prep', quality, fast);
    srv.google.retryAfter = '0';
    srv.google.perModel = { 'model-quality': { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } } } };
    return h;
  };
  const to = (model: string) => posts().filter((r) => r.path.includes(`/models/${model}:`)).length;
  const req = () => ({ task: 'prep' as const, system: 's', user: 'u', maxTokens: 200, signal: controller() });

  it('the next request goes straight to the fallback', async () => {
    const h = setup();
    const first = await h.gateway.generate(req());
    expect(first.usedFallback).toBe(true);
    expect(to('model-quality')).toBe(2); // two failures are enough to rest it (not the full three attempts)
    const before = to('model-quality');
    const second = await h.gateway.generate(req());
    expect(second.usedFallback).toBe(true);
    expect(to('model-quality')).toBe(before); // not asked again
    expect(to('model-fast')).toBe(2);
  });

  it('several requests at once do not each go through a retry cycle of their own', async () => {
    const h = setup();
    const results = await Promise.all([1, 2, 3, 4].map(() => h.gateway.generate(req())));
    expect(results.every((r) => r.usedFallback)).toBe(true);
    expect(to('model-quality')).toBeLessThanOrEqual(6); // it used to be 12 (four requests × three attempts)
  });

  it('the model is preferred again once the rest is over', async () => {
    const h = setup();
    await h.gateway.generate(req());
    srv.google.perModel = {};
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    try {
      const res = await h.gateway.generate(req());
      expect(res.usedFallback).toBe(false);
      expect(res.model).toBe('model-quality');
    } finally {
      spy.mockRestore();
    }
  });

  it('a single hiccup is still retried on the same model (nothing is rested after one failure)', async () => {
    const h = makeHarness();
    const p = h.addProvider('google', srv.googleUrl, 'AIza-test-key-123456');
    h.route('prep', h.addModel(p, 'model-quality'), h.addModel(p, 'model-fast'));
    srv.google.status = 503;
    srv.google.failCount = 1;
    srv.google.retryAfter = '0';
    const res = await h.gateway.generate(req());
    expect(res.usedFallback).toBe(false);
    expect(res.model).toBe('model-quality');
  });

  it('when both models are down the error is reported, once, after a bounded number of attempts', async () => {
    const h = setup();
    srv.google.perModel = { 'model-quality': { status: 503, body: {} }, 'model-fast': { status: 503, body: {} } };
    await expect(h.gateway.generate(req())).rejects.toMatchObject({ code: 'server' });
    expect(posts().length).toBeLessThanOrEqual(5);
  });
});

describe('what is logged: enough to diagnose, never a key, a prompt or a reply', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'candor-log-'));
    logger.configure({ level: 'info', dir });
  });
  afterEach(() => {
    aiDebug.configure({ mode: undefined, dir });
    rmSync(dir, { recursive: true, force: true });
  });
  const log = () => readFileSync(join(dir, 'candor.log'), 'utf8');
  const SECRET_REPLY = 'REPLY-CONTENT-THAT-MUST-NOT-BE-LOGGED';
  const reply = JSON.stringify({ title: SECRET_REPLY, items: ['x'] });

  it('records provider, host, model, output limit, finish reason, size, tokens, timing and outcome', async () => {
    srv.openai.honorMaxTokens = true;
    srv.openai.script = [{ text: reply }];
    await json(openai(), { user: 'PROMPT-CONTENT-THAT-MUST-NOT-BE-LOGGED', jsonSchema: JSON_SCHEMA }).run;
    const text = log();
    expect(text).toMatch(/model reply .*"provider":"openai-compatible"/);
    expect(text).toMatch(/"host":"127\.0\.0\.1:\d+"/);
    expect(text).toMatch(/"model":"gpt-4\.1"/);
    expect(text).toMatch(/"maxTokens":1800/);
    expect(text).toMatch(/"finish":"stop"/);
    expect(text).toMatch(/"completed":true/);
    expect(text).toMatch(/"structured":"schema"/);
    expect(text).toMatch(/"chars":\d+/);
    expect(text).toMatch(/"id":"mock-openai-1"/);
    expect(text).toMatch(/structured reply accepted .*"attempt":1/);
    expect(text).not.toContain(SECRET_REPLY);
    expect(text).not.toContain('PROMPT-CONTENT');
    expect(text).not.toContain('k-abcdefghij');
  });

  it('records why a reply was not usable, and how many attempts there were', async () => {
    srv.openai.script = [{ text: OK_TEXT.slice(0, 20), finishReason: 'length' }, { text: OK_TEXT }];
    await json(openai(), { requiredKeys: ['title', 'items'] }).run;
    const text = log();
    expect(text).toMatch(/structured reply not usable .*"attempt":1.*"outcome":"truncated".*"truncated":true/);
    expect(text).toMatch(/"finish":"length"/);
    expect(text).toMatch(/structured reply accepted .*"attempt":2/);
  });

  it('records a failed request with its HTTP status, error class and attempt — not its body', async () => {
    srv.openai.status = 503;
    srv.openai.failCount = 99;
    srv.openai.retryAfter = '0';
    srv.openai.errorBody = { error: { message: 'The model is overloaded', type: 'server_error' } };
    await json(openai()).run.catch(() => undefined);
    const text = log();
    expect(text).toMatch(/model request failed .*"code":"server","status":503,"attempt":1,"retrying":true/);
    expect(text).toMatch(/"attempt":3,"retrying":false/);
  });

  it('raw capture is OFF by default and never writes a file', async () => {
    srv.openai.script = [{ text: reply }];
    await json(openai()).run;
    expect(aiDebug.enabled).toBe(false);
    expect(() => readFileSync(join(dir, 'ai-debug.jsonl'), 'utf8')).toThrow();
  });

  it('CANDOR_DEBUG_AI=1 captures raw replies (not prompts), with credentials masked and the file still valid JSON lines', async () => {
    aiDebug.configure({ mode: '1', dir });
    const leaky = JSON.stringify({ title: 'note: api_key=AIzaSyA-1234567890123456789012345 and Bearer abcdefghijklmnopqrstuvwxyz', items: ['x'] });
    srv.openai.script = [{ text: leaky }];
    await json(openai(), { user: 'PROMPT-CONTENT-NOT-CAPTURED-WITHOUT-FULL' }).run;
    const lines = readFileSync(join(dir, 'ai-debug.jsonl'), 'utf8').trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>); // every line parses
    const replyEntry = entries.find((e) => e.event === 'reply');
    expect(String(replyEntry?.reply)).toContain('note:');
    expect(String(replyEntry?.reply)).not.toMatch(/AIzaSyA-1234567890/);
    expect(String(replyEntry?.reply)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(readFileSync(join(dir, 'ai-debug.jsonl'), 'utf8')).not.toContain('PROMPT-CONTENT');
    expect(replyEntry?.promptChars).toBeTruthy();
    expect(readFileSync(join(dir, 'ai-debug.jsonl'), 'utf8')).not.toContain('k-abcdefghij');
  });

  it('CANDOR_DEBUG_AI=full also captures the prompt', async () => {
    aiDebug.configure({ mode: 'full', dir });
    srv.openai.script = [{ text: OK_TEXT }];
    await json(openai(), { user: 'PROMPT-CONTENT-FULL' }).run;
    expect(readFileSync(join(dir, 'ai-debug.jsonl'), 'utf8')).toContain('PROMPT-CONTENT-FULL');
  });

  it('any other value leaves capture off', () => {
    for (const mode of [undefined, '', '0', 'false', 'no', 'yes please?']) {
      aiDebug.configure({ mode, dir });
      expect(aiDebug.enabled).toBe(mode === 'yes please?' ? false : false);
    }
  });
});

describe('scripted replies are consumed in order (the mock itself)', () => {
  it('a request beyond the script behaves normally', async () => {
    const s: ScriptedReply[] = [{ text: '{"title": "first"}' }];
    srv.openai.script = s;
    const h = openai();
    const a = await json(h).run;
    const b = await json(h).run.catch(() => null);
    expect(a.value.title).toBe('first');
    expect(b).toBeNull(); // the default reply is ordinary prose, not JSON
  });
});
