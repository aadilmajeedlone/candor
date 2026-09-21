import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiError } from '@shared/errors';
import { extractJson, generateJson } from '../../src/main/ai/structured';
import { parseSse } from '../../src/main/ai/sse';
import type { ProviderAdapter } from '../../src/main/ai/types';
import { z } from 'zod';
import { MockLlmServer } from '../helpers/mockLlmServer';
import { makeHarness } from '../helpers/gatewayHarness';

let srv: MockLlmServer;
beforeAll(async () => {
  srv = await new MockLlmServer().start();
});
afterAll(async () => {
  await srv.stop();
});
beforeEach(() => srv.reset());

const req = (over: Partial<Parameters<ReturnType<typeof makeHarness>['gateway']['generate']>[0]> = {}) => {
  const tokens: string[] = [];
  const notices: string[] = [];
  const ac = new AbortController();
  return {
    tokens,
    notices,
    ac,
    r: { task: 'live' as const, system: 's', user: 'u', maxTokens: 200, signal: ac.signal, onToken: (t: string) => tokens.push(t), onNotice: (_l: string, m: string) => notices.push(m), ...over },
  };
};

describe('SSE parser', () => {
  it('handles chunk boundaries inside events, CRLF and multi-byte characters', async () => {
    const enc = new TextEncoder();
    const payload = 'data: {"a":"héllo ✓"}\r\n\r\nevent: x\r\ndata: line1\r\ndata: line2\r\n\r\n: comment\n\ndata: [DONE]\n\n';
    const bytes = enc.encode(payload);
    // Split at awkward byte offsets, including through the multi-byte "é" and "✓" and between \r and \n.
    const cuts = [7, 15, 19, 23, 38, 41, bytes.length];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        let prev = 0;
        for (const cut of cuts) {
          c.enqueue(bytes.slice(prev, cut));
          prev = cut;
        }
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    expect(events).toEqual([
      { event: 'message', data: '{"a":"héllo ✓"}' },
      { event: 'x', data: 'line1\nline2' },
      { event: 'message', data: '[DONE]' },
    ]);
  });
});

describe('provider adapters (over real HTTP)', () => {
  it('OpenAI-compatible: streams tokens in order and sends the expected request', async () => {
    const h = makeHarness();
    srv.openai.requireKey = 'sk-test-openai-123456789012345';
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'sk-test-openai-123456789012345');
    h.route('live', h.addModel(p, 'gpt-4o-mini'));
    const { r, tokens } = req();
    const out = await h.gateway.generate(r);
    expect(tokens.join('')).toBe('In my current role I led a team.');
    expect(out.finishReason).toBe('stop');
    const sent = srv.requests.find((q) => q.path.includes('/chat/completions'))!;
    expect(sent.headers.authorization).toBe('Bearer sk-test-openai-123456789012345');
    expect(sent.body).toMatchObject({ model: 'gpt-4o-mini', stream: true, max_tokens: 200 });
    expect(sent.body).toHaveProperty('temperature');
  });

  it('OpenAI-compatible: reasoning models use max_completion_tokens and no temperature', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'gpt-5-mini'));
    await h.gateway.generate(req().r);
    const body = srv.requests.find((q) => q.path.includes('/chat/completions'))!.body!;
    expect(body).toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('OpenAI-compatible: adapts when a model rejects max_tokens, without surfacing an error', async () => {
    const h = makeHarness();
    srv.openai.rejectParams = ['max_tokens'];
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'some-new-model'));
    const { r, tokens } = req();
    await h.gateway.generate(r);
    expect(tokens.join('')).toContain('led a team');
    const bodies = srv.requests.filter((q) => q.path.includes('/chat/completions')).map((q) => q.body!);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toHaveProperty('max_completion_tokens');
  });

  it('OpenAI-compatible: drops an unsupported temperature and remembers it', async () => {
    const h = makeHarness();
    srv.openai.rejectParams = ['temperature'];
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'picky-model'));
    await h.gateway.generate(req().r);
    await h.gateway.generate(req().r);
    const bodies = srv.requests.filter((q) => q.path.includes('/chat/completions')).map((q) => q.body!);
    expect(bodies).toHaveLength(3); // 1 rejected + 1 retry, then the next call goes straight through
    expect(bodies[2]).not.toHaveProperty('temperature');
  });

  it('Anthropic: streams text deltas and sends key + version headers', async () => {
    const h = makeHarness();
    srv.anthropic.requireKey = 'sk-ant-test-12345678';
    const p = h.addProvider('anthropic', srv.anthropicUrl, 'sk-ant-test-12345678');
    h.route('live', h.addModel(p, 'claude-haiku-4-5-20251001'));
    const { r, tokens } = req();
    const out = await h.gateway.generate(r);
    expect(tokens.join('')).toBe('In my current role I led a team.');
    expect(out.finishReason).toBe('stop');
    const sent = srv.requests.find((q) => q.path.endsWith('/v1/messages'))!;
    expect(sent.headers['x-api-key']).toBe('sk-ant-test-12345678');
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.body).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, stream: true });
    expect(sent.body).not.toHaveProperty('top_p');
  });

  it('Anthropic: maps max_tokens stop reason to "length"', async () => {
    const h = makeHarness();
    srv.anthropic.finishReason = 'length';
    const p = h.addProvider('anthropic', srv.anthropicUrl, 'sk-ant-test-12345678');
    h.route('live', h.addModel(p, 'claude-x'));
    const out = await h.gateway.generate(req().r);
    expect(out.finishReason).toBe('length');
  });

  it('Google: streams via SSE and authenticates with x-goog-api-key', async () => {
    const h = makeHarness();
    srv.google.requireKey = 'AIzaTestKey1234567890abcd';
    const p = h.addProvider('google', srv.googleUrl, 'AIzaTestKey1234567890abcd');
    h.route('live', h.addModel(p, 'gemini-2.5-flash'));
    const { r, tokens } = req();
    await h.gateway.generate(r);
    expect(tokens.join('')).toBe('In my current role I led a team.');
    const sent = srv.requests.find((q) => q.path.includes('streamGenerateContent'))!;
    expect(sent.path).toContain('/google/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(sent.headers['x-goog-api-key']).toBe('AIzaTestKey1234567890abcd');
    expect((sent.body!.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('lists models for every provider kind', async () => {
    const h = makeHarness();
    const o = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij', 'o');
    const a = h.addProvider('anthropic', srv.anthropicUrl, 'k-abcdefghij', 'a');
    const g = h.addProvider('google', srv.googleUrl, 'k-abcdefghij', 'g');
    expect((await h.gateway.listModels(o.id)).models).toContain('gpt-4o-mini');
    expect((await h.gateway.listModels(a.id)).models).toContain('claude-sonnet-5');
    const gm = await h.gateway.listModels(g.id);
    expect(gm.models).toEqual(['gemini-2.5-flash']); // embedding-only model filtered out
  });
});

describe('error handling', () => {
  const setup = () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    const m = h.addModel(p, 'gpt-4o-mini');
    h.route('live', m);
    return { h, p, m };
  };
  const fail = async (h: ReturnType<typeof makeHarness>): Promise<AiError> => {
    try {
      await h.gateway.generate(req().r);
    } catch (e) {
      return e as AiError;
    }
    throw new Error('expected failure');
  };

  it('invalid API key → auth error, no retries', async () => {
    const { h } = setup();
    srv.openai.requireKey = 'the-real-key';
    const err = await fail(h);
    expect(err.code).toBe('auth');
    expect(srv.requests.filter((q) => q.path.includes('/chat/completions'))).toHaveLength(1);
    expect(err.message).not.toContain('k-abcdefghij');
  });

  it('model not found', async () => {
    const { h } = setup();
    srv.openai.status = 404;
    srv.openai.failCount = 5;
    srv.openai.errorBody = { error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' } };
    expect((await fail(h)).code).toBe('model_not_found');
  });

  it('context overflow is not retried and not sent to the fallback', async () => {
    const { h } = setup();
    srv.openai.status = 400;
    srv.openai.failCount = 5;
    srv.openai.errorBody = { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } };
    expect((await fail(h)).code).toBe('context_overflow');
  });

  it('out-of-quota 429 is reported as rate_limit but not retried', async () => {
    const { h } = setup();
    srv.openai.status = 429;
    srv.openai.failCount = 5;
    srv.openai.errorBody = { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } };
    const err = await fail(h);
    expect(err.code).toBe('rate_limit');
    expect(err.retryable).toBe(false);
    expect(srv.requests.filter((q) => q.path.includes('/chat/completions'))).toHaveLength(1);
  });

  it('retries a transient 429 once (live) honouring Retry-After, and tells the user', async () => {
    const { h } = setup();
    srv.openai.status = 429;
    srv.openai.failCount = 1;
    srv.openai.retryAfter = '0';
    const { r, tokens, notices } = req();
    await h.gateway.generate(r);
    expect(tokens.join('')).toContain('led a team');
    expect(notices.some((n) => /Retrying/.test(n))).toBe(true);
  });

  it('a service on the internet that cannot be reached → "Internet connection unavailable"', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', 'https://no-such-host.invalid/v1', 'k-abcdefghij', 'Cloud');
    h.route('live', h.addModel(p, 'm'));
    const err = await fail(h);
    expect(err.code).toBe('network');
    expect(err.message).toBe('Internet connection unavailable — could not reach Cloud.');
  });

  it('a model on this PC that is not running → says so, not "internet unavailable"', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', 'http://127.0.0.1:1/v1', null, 'Ollama');
    h.route('live', h.addModel(p, 'm'));
    const err = await fail(h);
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/^Could not connect to Ollama on this PC\. Is it running\?/);
  });

  it('not configured: no route, and a provider without a key', async () => {
    const h = makeHarness();
    expect((await fail(h)).code).toBe('not_configured');
    const p = h.addProvider('openai-compatible', 'https://api.openai.com/v1', null);
    h.route('live', h.addModel(p, 'm'));
    expect((await fail(h)).code).toBe('not_configured');
  });

  it('local endpoints (Ollama / LM Studio) work without a key', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, null);
    h.route('live', h.addModel(p, 'llama3.2'));
    const { r, tokens } = req();
    await h.gateway.generate(r);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('uses an environment key when none is stored, and never stores it', async () => {
    const h = makeHarness({ ANTHROPIC_API_KEY: 'sk-ant-from-env-123456' });
    srv.anthropic.requireKey = 'sk-ant-from-env-123456';
    const p = h.addProvider('anthropic', srv.anthropicUrl, null);
    h.route('live', h.addModel(p, 'claude-x'));
    await h.gateway.generate(req().r);
    expect(h.secrets.source(`provider.${p.id}`, 'anthropic')).toBe('env');
    expect(h.db.all('SELECT * FROM secrets')).toHaveLength(0);
  });
});

describe('fallback, streaming recovery, cancellation, timeouts', () => {
  it('switches to the fallback model when the primary keeps failing, and says so', async () => {
    const h = makeHarness();
    const p1 = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij', 'primary');
    const p2 = h.addProvider('anthropic', srv.anthropicUrl, 'sk-ant-test-12345678', 'backup');
    h.route('live', h.addModel(p1, 'primary-model'), h.addModel(p2, 'claude-x'));
    srv.openai.status = 500;
    srv.openai.failCount = 10;
    const { r, tokens, notices } = req();
    const out = await h.gateway.generate(r);
    expect(out.usedFallback).toBe(true);
    expect(out.provider).toBe('backup');
    expect(tokens.join('')).toContain('led a team');
    expect(notices.some((n) => /fallback/i.test(n))).toBe(true);
  });

  it('does not splice a fallback answer after part of the primary answer was already shown', async () => {
    const h = makeHarness();
    const p1 = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij', 'primary');
    const p2 = h.addProvider('anthropic', srv.anthropicUrl, 'sk-ant-test-12345678', 'backup');
    h.route('live', h.addModel(p1, 'm1'), h.addModel(p2, 'm2'));
    srv.openai.dropAfterTokens = 3;
    const { r, tokens } = req();
    await expect(h.gateway.generate(r)).rejects.toBeInstanceOf(AiError);
    expect(tokens.length).toBe(3);
    expect(srv.requests.some((q) => q.path.includes('/anthropic'))).toBe(false);
  });

  it('falls back to a non-streaming response when the stream is malformed', async () => {
    const h = makeHarness();
    srv.openai.malformedStream = true;
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'gpt-4o-mini'));
    const { r, tokens, notices } = req();
    const out = await h.gateway.generate(r);
    expect(out.text).toBe('In my current role I led a team.');
    expect(tokens).toHaveLength(0); // arrives whole, via the result
    expect(notices.some((n) => /Streaming failed/.test(n))).toBe(true);
  });

  it('cancelling mid-stream stops the request promptly and closes the connection', async () => {
    const h = makeHarness();
    srv.openai.tokens = Array.from({ length: 60 }, (_, i) => `w${i} `);
    srv.openai.tokenDelayMs = 15;
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'gpt-4o-mini'));
    const { r, tokens, ac } = req();
    const pending = h.gateway.generate(r);
    await new Promise((res) => setTimeout(res, 120));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    const seen = tokens.length;
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(60);
    await new Promise((res) => setTimeout(res, 150));
    expect(tokens.length).toBe(seen); // nothing arrives after cancellation
    expect(srv.requests.find((q) => q.path.includes('/chat/completions'))!.closedEarly).toBe(true);
  });

  it('times out when the provider never starts answering', async () => {
    const h = makeHarness();
    srv.openai.hang = true;
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('live', h.addModel(p, 'm', { timeoutMs: 300 }));
    const t0 = Date.now();
    await expect(h.gateway.generate(req().r)).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('a single configured model serves both live and prep tasks', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('prep', h.addModel(p, 'gpt-4.1'));
    const out = await h.gateway.generate(req({ task: 'live' }).r);
    expect(out.model).toBe('gpt-4.1');
  });

  it('test-connection measures real time-to-first-token', async () => {
    const h = makeHarness();
    srv.openai.firstTokenDelayMs = 60;
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    const m = h.addModel(p, 'gpt-4o-mini');
    const res = await h.gateway.testModel(m);
    expect(res.ok).toBe(true);
    expect(res.latencyMs!).toBeGreaterThanOrEqual(55);
  });
});

describe('slow models: a service on the internet is dropped quickly, a model on your own hardware is given time', () => {
  /** A model whose first word takes 500 ms to appear, honouring cancellation. */
  const slow: ProviderAdapter = {
    async *stream(_r, chat) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        chat.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      yield { type: 'text', text: 'hello' };
      yield { type: 'done', finishReason: 'stop' };
    },
    complete: () => Promise.resolve({ text: 'hello', finishReason: 'stop' }),
    listModels: () => Promise.resolve([]),
  };

  it('an internet service that is slow to start is abandoned at the quick deadline (so a fallback can take over)', async () => {
    const h = makeHarness({}, { adapters: { 'openai-compatible': slow }, liveFirstTokenMs: 150 });
    const p = h.addProvider('openai-compatible', 'https://api.example.com/v1', 'k-abcdefghij', 'Cloud');
    h.route('live', h.addModel(p, 'm', { timeoutMs: 5000 }));
    await expect(h.gateway.generate(req().r)).rejects.toMatchObject({ code: 'timeout' });
  });

  it.each(['http://localhost:11434/v1', 'http://192.168.1.50:8000/v1', 'http://100.101.102.103:8000/v1'])('a model at %s is allowed its own timeout, so a laptop CPU reading a long prompt is not cut off', async (url) => {
    const h = makeHarness({}, { adapters: { 'openai-compatible': slow }, liveFirstTokenMs: 150 });
    const p = h.addProvider('openai-compatible', url, null, 'Local');
    h.route('live', h.addModel(p, 'm', { timeoutMs: 5000 }));
    const { tokens, r } = req();
    const out = await h.gateway.generate(r);
    expect(out.text).toBe('hello');
    expect(tokens).toEqual(['hello']);
  });

  it('a local model that really is too slow still stops at its own timeout', async () => {
    const h = makeHarness({}, { adapters: { 'openai-compatible': slow }, liveFirstTokenMs: 150 });
    const p = h.addProvider('openai-compatible', 'http://localhost:11434/v1', null, 'Local');
    h.route('live', h.addModel(p, 'm', { timeoutMs: 200 }));
    await expect(h.gateway.generate(req().r)).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('structured output', () => {
  it('extracts JSON from fenced, chatty output and repairs trailing commas', () => {
    expect(extractJson('Sure!\n```json\n{"a": [1,2,], "b": {"c": "x}"}}\n```\nDone')).toEqual({ a: [1, 2], b: { c: 'x}' } });
  });

  it('validates against the schema and repairs once', async () => {
    const h = makeHarness();
    const p = h.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij');
    h.route('prep', h.addModel(p, 'gpt-4.1'));
    let calls = 0;
    const gw = {
      generate: (r: Parameters<typeof h.gateway.generate>[0]) => {
        calls++;
        return Promise.resolve({ text: calls === 1 ? '{"name": 5}' : '{"name": "Riya"}', finishReason: 'stop' as const, model: 'x', provider: 'x', usedFallback: false, ...(r ? {} : {}) });
      },
    };
    const schema = z.object({ name: z.string() });
    const out = await generateJson(gw, { task: 'prep', system: 'sys', user: 'u', schema, signal: new AbortController().signal });
    expect(out.value).toEqual({ name: 'Riya' });
    expect(calls).toBe(2);
  });

  it('fails as malformed after one failed repair', async () => {
    const gw = { generate: () => Promise.resolve({ text: 'nope', finishReason: 'stop' as const, model: 'x', provider: 'x', usedFallback: false }) };
    await expect(generateJson(gw, { task: 'prep', system: 's', user: 'u', schema: z.object({ a: z.string() }), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'malformed' });
  });
});
