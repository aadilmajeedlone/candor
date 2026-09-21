import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../../src/main/ai/types';
import { makeHarness } from '../helpers/gatewayHarness';

/**
 * Streaming replies, accumulated whole and only then judged. These tests give the gateway a scripted transport, so a
 * stream can be cut at any byte, carry empty or tool-call events, end without a finish reason, or die half way.
 * The rule under test: no chunk is ever parsed as the answer on its own; text is accumulated, the stream's own
 * account of how it ended is kept, and every abnormal ending is either recovered or reported — never a crash.
 */

const enc = new TextEncoder();
const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const delta = (content: string | null, finish: string | null = null, extra: Record<string, unknown> = {}) => ({ id: 'cmpl-1', choices: [{ delta: { ...(content === null ? {} : { content }), ...extra }, finish_reason: finish }] });

/** A stream that delivers `body` in pieces of `size` bytes, then ends cleanly (or fails). */
function streamOf(body: string, size: number, end: 'close' | 'error' = 'close'): ReadableStream<Uint8Array> {
  const bytes = enc.encode(body);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        if (end === 'error') controller.error(new TypeError('terminated'));
        else controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

/** Answer a streaming request with `body`, and a non-streaming one with a plain completion. */
function transport(body: string, opts: { size?: number; end?: 'close' | 'error'; plain?: string } = {}): { http: HttpClient; calls: { stream: boolean }[] } {
  const calls: { stream: boolean }[] = [];
  const http: HttpClient = {
    fetch: (_url, init) => {
      const stream = (JSON.parse(init.body ?? '{}') as { stream?: boolean }).stream === true;
      calls.push({ stream });
      if (!stream) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: opts.plain ?? 'plain answer' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      return Promise.resolve(new Response(streamOf(body, opts.size ?? 1_000_000, opts.end), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    },
  };
  return { http, calls };
}

function run(body: string, opts: { size?: number; end?: 'close' | 'error'; plain?: string } = {}) {
  const t = transport(body, opts);
  const h = makeHarness({}, { http: t.http });
  const p = h.addProvider('openai-compatible', 'http://127.0.0.1:9/v1', 'k-abcdefghij');
  h.route('prep', h.addModel(p, 'm'));
  const tokens: string[] = [];
  const notices: string[] = [];
  const result = h.gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: new AbortController().signal, onToken: (x) => tokens.push(x), onNotice: (_l, m) => notices.push(m) });
  return { result, tokens, notices, calls: t.calls };
}

const HELLO = sse(delta('Hel'), delta('lo, '), delta('wor'), delta('ld'), delta(null, 'stop'), '[DONE]');

describe('partial chunks', () => {
  it('the answer is the same however the bytes are split — down to one byte at a time', async () => {
    for (const size of [1, 2, 3, 5, 7, 16, 64, 1_000_000]) {
      const { result, tokens } = run(HELLO, { size });
      const res = await result;
      expect(res.text, `size ${size}`).toBe('Hello, world');
      expect(res.finishReason).toBe('stop');
      expect(res.meta).toMatchObject({ completed: true, streamed: true });
      expect(tokens.join('')).toBe('Hello, world');
    }
  });

  it('multi-byte characters split across chunks are not corrupted', async () => {
    const body = sse(delta('café '), delta('☃ and 🚀'), delta(null, 'stop'), '[DONE]');
    for (const size of [1, 2, 3]) expect((await run(body, { size }).result).text).toBe('café ☃ and 🚀');
  });

  it('CRLF line endings and comment lines are fine', async () => {
    const body = ': keep-alive\r\n\r\ndata: ' + JSON.stringify(delta('ok')) + '\r\n\r\ndata: ' + JSON.stringify(delta(null, 'stop')) + '\r\n\r\ndata: [DONE]\r\n\r\n';
    for (const size of [1, 4, 1000]) expect((await run(body, { size }).result).text).toBe('ok');
  });
});

describe('empty chunks and chunks that carry no text', () => {
  it('empty deltas, role-only deltas and heartbeat events are ignored, not treated as the end', async () => {
    const body = sse(delta(''), delta(null, null, { role: 'assistant' }), delta('A'), delta(''), { id: 'x', choices: [] }, delta('B'), delta(null, 'stop'), '[DONE]');
    const { result, tokens } = run(body);
    expect((await result).text).toBe('AB');
    expect(tokens).toEqual(['A', 'B']); // nothing was shown for the empty ones
  });

  it('a stream that says it is done but wrote nothing is reported as empty, and the plain-response fallback is tried', async () => {
    const { result, notices, calls } = run(sse(delta(null, 'stop'), '[DONE]'), { plain: 'recovered in full' });
    expect((await result).text).toBe('recovered in full');
    expect(notices.some((n) => /without streaming/.test(n))).toBe(true);
    expect(calls.map((c) => c.stream)).toEqual([true, false]);
  });
});

describe('tool-call chunks (Candor sends no tools, but a server may still emit them)', () => {
  it('tool-call deltas next to real text are ignored; the text is kept', async () => {
    const call = { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] };
    const body = sse(delta('Answer: ', null, call), delta('42', null, { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }), delta(null, 'stop'), '[DONE]');
    expect((await run(body).result).text).toBe('Answer: 42');
  });

  it('a reply that is only a tool call has no text: that is reported plainly, then the plain response is tried', async () => {
    const body = sse(delta(null, null, { tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] }), delta(null, 'tool_calls'), '[DONE]');
    const { result, calls } = run(body, { plain: 'a real answer' });
    expect((await result).text).toBe('a real answer');
    expect(calls.map((c) => c.stream)).toEqual([true, false]);
  });
});

describe('finish reasons', () => {
  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'other'],
  ] as const)('%s is reported as %s, with the provider’s own word kept', async (raw, normalised) => {
    const res = await run(sse(delta('partial answer'), delta(null, raw), '[DONE]')).result;
    expect(res.finishReason).toBe(normalised);
    expect(res.meta?.rawFinishReason).toBe(raw);
    expect(res.text).toBe('partial answer');
  });
});

describe('connection termination', () => {
  it('a stream that just stops, with no finish reason and no [DONE], is reported as possibly cut off', async () => {
    const { result, notices } = run(sse(delta('The answer was going to be'), delta(' long and')));
    const res = await result;
    expect(res.text).toBe('The answer was going to be long and');
    expect(res.finishReason).toBe('other');
    expect(res.meta?.completed).toBe(false);
    expect(notices.some((n) => /may be cut off/.test(n))).toBe(true);
  });

  it('[DONE] without a finish reason still counts as a proper end', async () => {
    const res = await run(sse(delta('done properly'), '[DONE]')).result;
    expect(res.meta?.completed).toBe(true);
    expect(res.text).toBe('done properly');
  });

  it('a connection that dies mid-answer surfaces as a network error — the partial text was already shown, nothing is spliced', async () => {
    const { result, tokens, calls } = run(sse(delta('Half of an ans')), { end: 'error' });
    await expect(result).rejects.toMatchObject({ code: 'network' });
    expect(tokens.join('')).toBe('Half of an ans');
    expect(calls).toHaveLength(1); // not silently retried as a second answer after tokens were shown
  });

  it('a connection that dies before any text is retried as a plain response', async () => {
    const { result, calls } = run('', { end: 'error', plain: 'plain after a dead stream' });
    expect((await result).text).toBe('plain after a dead stream');
    expect(calls.map((c) => c.stream)).toEqual([true, false]);
  });
});

describe('malformed final output', () => {
  it('a broken event before any text falls back to a plain response', async () => {
    const { result, calls } = run('data: {not json\n\n', { plain: 'plain after a broken event' });
    expect((await result).text).toBe('plain after a broken event');
    expect(calls.map((c) => c.stream)).toEqual([true, false]);
  });

  it('a broken event after text was shown is an error, never a second answer', async () => {
    const { result, tokens } = run(sse(delta('Shown so far')) + 'data: {broken\n\n');
    await expect(result).rejects.toMatchObject({ code: 'malformed' });
    expect(tokens.join('')).toBe('Shown so far');
  });

  it('an in-stream provider error is reported with its message', async () => {
    const { result } = run(sse(delta('ok so far'), { error: { message: 'The server had a problem' } }));
    await expect(result).rejects.toMatchObject({ code: 'server', message: expect.stringContaining('The server had a problem') as string });
  });
});

describe('Gemini streams', () => {
  const g = (text: string | null, finish?: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ ...(text === null ? {} : { content: { parts: [{ text }] } }), ...(finish ? { finishReason: finish } : {}) }], ...extra });
  function gemini(body: string, size: number) {
    const http: HttpClient = { fetch: () => Promise.resolve(new Response(streamOf(body, size), { status: 200, headers: { 'content-type': 'text/event-stream' } })) };
    const h = makeHarness({}, { http });
    const p = h.addProvider('google', 'https://generativelanguage.googleapis.com', 'AIza-test-key-123456');
    h.route('prep', h.addModel(p, 'gemini-2.5-flash'));
    return h.gateway.generate({ task: 'prep', system: 's', user: 'u', maxTokens: 300, signal: new AbortController().signal, onToken: () => undefined });
  }

  it('reassembles a stream cut at any byte, keeps usage and the reply id, ignores empty parts', async () => {
    const body = sse(g('Hel'), g(''), g('lo'), g(null), g(' there', 'STOP', { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 }, responseId: 'resp-9' }));
    for (const size of [1, 3, 11, 10_000]) {
      const res = await gemini(body, size);
      expect(res.text, `size ${size}`).toBe('Hello there');
      expect(res.meta).toMatchObject({ completed: true, rawFinishReason: 'STOP', responseId: 'resp-9', usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2 } });
    }
  });

  it('MAX_TOKENS is a cut-off reply, and a stream with no finish reason is flagged as incomplete', async () => {
    expect((await gemini(sse(g('cut off mid-sentence and', 'MAX_TOKENS')), 5)).finishReason).toBe('length');
    const res = await gemini(sse(g('no finish reason here')), 5);
    expect(res.meta?.completed).toBe(false);
  });

  it('a stream in which reasoning used the whole output limit and nothing visible was written is an output-limit error', async () => {
    await expect(gemini(sse(g(null, 'MAX_TOKENS')), 7)).rejects.toMatchObject({ code: 'malformed', reason: 'output-limit' });
  });
});
