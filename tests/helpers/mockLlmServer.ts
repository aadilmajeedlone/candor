import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockBehavior {
  tokens: string[];
  firstTokenDelayMs: number;
  tokenDelayMs: number;
  /** Respond with this HTTP status (and errorBody) for the next `failCount` requests. */
  status?: number;
  errorBody?: unknown;
  retryAfter?: string;
  failCount: number;
  /** Accept the connection but never answer. */
  hang: boolean;
  /** Emit a broken SSE event (streaming only). */
  malformedStream: boolean;
  /** Drop the connection after this many tokens. */
  dropAfterTokens?: number;
  requireKey?: string;
  /** Require `Authorization: Bearer <token>` (Google sign-in / ADC). */
  requireBearer?: string;
  /** Body parameters to reject with a 400 "unsupported_parameter" (OpenAI style). */
  rejectParams: string[];
  finishReason: 'stop' | 'length';
  /** Google only: models that answer with this status and body instead of a reply (path /models/<name>:…). */
  perModel?: Record<string, { status: number; body: unknown }>;
  /** Google only: the model names the list endpoint returns (default: a small fixed list). */
  listModels?: string[];
  /** Produce the reply text from the request body (e.g. different JSON per prompt). Overrides `tokens`. */
  dynamic?: (body: Record<string, unknown> | null) => string;
  /** Cut a reply at the request's own output limit, as real servers do, and report why (MAX_TOKENS / length). Off by default. */
  honorMaxTokens?: boolean;
  /** Google only: hidden "thinking" tokens that are spent from the same output budget unless the request limits thinking. */
  thinkingTokens?: number;
  /** Google only: thinking parameters refused with a 400, like models that lack them ('budget' = thinkingBudget, 'level' = thinkingLevel). */
  rejectThinking?: ('budget' | 'level')[];
  /** Google only: refuse responseSchema / responseJsonSchema with a 400. */
  rejectSchema?: boolean;
  /** OpenAI only: response_format types refused with a 400 (for example 'json_schema' on a server without structured outputs). */
  rejectResponseFormat?: string[];
  /** Refuse (400) any request that asks for more output tokens than this, with the provider's own wording. */
  maxOutputLimit?: number;
  /** Streaming only: end the stream cleanly after this many tokens, with no finish reason (a proxy or server that gives up). */
  endStreamAfterTokens?: number;
  /** One entry per generate request, consumed in order; a request beyond the list behaves normally. */
  script?: ScriptedReply[];
  /** Number of generate requests that reached the reply stage (maintained by the server). */
  calls?: number;
}

/** What one scripted request does instead of the normal behaviour. */
export interface ScriptedReply {
  text?: string;
  finishReason?: 'stop' | 'length';
  status?: number;
  errorBody?: unknown;
  /** Hidden thinking tokens spent on this request (Google). */
  thoughts?: number;
  endStreamAfterTokens?: number;
}

const chunkText = (s: string): string[] => s.match(/[\s\S]{1,24}/g) ?? [];
/** Four characters per token: crude, but the same everywhere, so limits behave predictably in tests. */
const tokensOf = (s: string): number => Math.ceil(s.length / 4);

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  closedEarly: boolean;
}

const defaults = (): MockBehavior => ({
  tokens: ['In ', 'my ', 'current ', 'role ', 'I ', 'led ', 'a ', 'team.'],
  firstTokenDelayMs: 5,
  tokenDelayMs: 3,
  failCount: 0,
  hang: false,
  malformedStream: false,
  rejectParams: [],
  finishReason: 'stop',
});

/** One HTTP server that speaks the OpenAI, Anthropic and Google (Gemini) wire protocols. */
export class MockLlmServer {
  private server: Server;
  readonly requests: RecordedRequest[] = [];
  readonly openai = defaults();
  readonly anthropic = defaults();
  readonly google = defaults();
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  reset(): void {
    this.requests.length = 0;
    for (const b of [this.openai, this.anthropic, this.google] as unknown as Record<string, unknown>[]) {
      for (const k of Object.keys(b)) delete b[k]; // optional fields must not leak between tests
      Object.assign(b, defaults());
    }
  }

  get openaiUrl(): string {
    return `http://127.0.0.1:${this.port}/openai/v1`;
  }
  get anthropicUrl(): string {
    return `http://127.0.0.1:${this.port}/anthropic`;
  }
  get googleUrl(): string {
    return `http://127.0.0.1:${this.port}/google`;
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const body = await this.readBody(req);
    const rec: RecordedRequest = { method: req.method ?? 'GET', path: path + url.search, headers: req.headers, body, closedEarly: false };
    this.requests.push(rec);
    res.on('close', () => {
      if (!res.writableEnded) rec.closedEarly = true;
    });

    const which = path.startsWith('/anthropic') ? 'anthropic' : path.startsWith('/google') ? 'google' : 'openai';
    const b = this[which];

    // Model listing
    if (req.method === 'GET' && /\/models$/.test(path)) {
      if (!this.authorised(which, req, b)) return this.reject(res, which, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } });
      const json =
        which === 'openai'
          ? { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4.1' }, { id: 'text-embedding-3-small' }] }
          : which === 'anthropic'
            ? { data: [{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-sonnet-5' }] }
            : path.includes('/publishers/')
              ? { publisherModels: [{ name: 'publishers/google/models/gemini-2.5-flash' }, { name: 'publishers/google/models/gemini-2.5-pro' }, { name: 'publishers/google/models/gemini-2.5-flash-image' }, { name: 'publishers/google/models/gemini-embedding-001' }] }
              : { models: (b.listModels ?? ['gemini-2.5-flash', 'embedding-001']).map((n) => ({ name: `models/${n}`, supportedGenerationMethods: [/embed/.test(n) ? 'embedContent' : 'generateContent'] })) };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      return;
    }

    if (b.hang) return; // never respond

    if (b.failCount > 0 && b.status) {
      b.failCount--;
      return this.reject(res, which, b.status, b.errorBody ?? { error: { message: 'boom' } }, b.retryAfter);
    }
    if (!this.authorised(which, req, b)) return this.reject(res, which, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });

    if (which === 'google' && b.perModel) {
      const m = /\/models\/([^:/?]+):/.exec(path)?.[1];
      const spec = m ? b.perModel[m] : undefined;
      if (spec) return this.reject(res, which, spec.status, spec.body);
    }

    if (b.maxOutputLimit !== undefined && body) {
      const asked = this.outputLimit(which, body);
      if (asked !== undefined && asked > b.maxOutputLimit) {
        return this.reject(
          res,
          which,
          400,
          which === 'google'
            ? { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Unable to submit request because the requested max output tokens (${asked}) exceeds the model's limit (${b.maxOutputLimit}).` } }
            : { error: { message: `max_tokens is too large: ${asked}. This model supports at most ${b.maxOutputLimit} completion tokens, whereas you provided ${asked}.`, type: 'invalid_request_error', param: 'max_tokens' } },
        );
      }
    }

    if (which === 'google' && body) {
      const gc = body.generationConfig as { thinkingConfig?: Record<string, unknown>; responseSchema?: unknown; responseJsonSchema?: unknown } | undefined;
      const tc = gc?.thinkingConfig;
      for (const kind of b.rejectThinking ?? []) {
        if (tc && (kind === 'budget' ? 'thinkingBudget' : 'thinkingLevel') in tc) {
          return this.reject(res, which, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Unable to submit request because ${kind === 'budget' ? 'thinking_budget' : 'thinking_level'} is not supported by this model. Learn more: https://ai.google.dev/gemini-api/docs/thinking` } });
        }
      }
      if (b.rejectSchema && gc && (gc.responseSchema || gc.responseJsonSchema)) {
        return this.reject(res, which, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "responseSchema" at generation_config: Cannot find field.' } });
      }
    }

    if (which === 'openai' && body) {
      const rf = (body.response_format as { type?: string } | undefined)?.type;
      if (rf && (b.rejectResponseFormat ?? []).includes(rf)) {
        return this.reject(res, which, 400, { error: { message: `'response_format.type' must be one of the supported types; '${rf}' is not supported by this server.`, type: 'invalid_request_error', param: 'response_format', code: 'unsupported_value' } });
      }
      for (const p of b.rejectParams) {
        if (p in body) return this.reject(res, which, 400, { error: { message: `Unsupported parameter: '${p}' is not supported with this model.`, type: 'invalid_request_error', param: p, code: 'unsupported_parameter' } });
      }
    }

    const stream = which === 'google' ? path.includes('streamGenerateContent') : body?.stream === true;
    await this.respond(which, res, b, stream, req, body);
  }

  private authorised(which: 'openai' | 'anthropic' | 'google', req: IncomingMessage, b: MockBehavior): boolean {
    if (b.requireBearer !== undefined && String(req.headers.authorization ?? '') !== `Bearer ${b.requireBearer}`) return false;
    if (!b.requireKey) return true;
    const got = which === 'openai' ? String(req.headers.authorization ?? '').replace(/^Bearer /, '') : which === 'anthropic' ? String(req.headers['x-api-key'] ?? '') : String(req.headers['x-goog-api-key'] ?? '');
    return got === b.requireKey;
  }

  private reject(res: ServerResponse, _which: string, status: number, body: unknown, retryAfter?: string): void {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (retryAfter) headers['retry-after'] = retryAfter;
    res.writeHead(status, headers).end(JSON.stringify(body));
  }

  private async respond(which: 'openai' | 'anthropic' | 'google', res: ServerResponse, b0: MockBehavior, stream: boolean, req: IncomingMessage, body: Record<string, unknown> | null): Promise<void> {
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const call = (b0.calls = (b0.calls ?? 0) + 1);
    const scripted = b0.script?.[call - 1];
    if (scripted?.status) return this.reject(res, which, scripted.status, scripted.errorBody ?? { error: { message: 'boom' } });
    // A dynamic responder replaces the scripted tokens for this request (chunked so streaming still streams).
    let b: MockBehavior = b0.dynamic ? { ...b0, tokens: chunkText(b0.dynamic(body)) } : b0;
    if (scripted?.text !== undefined) b = { ...b, tokens: chunkText(scripted.text) };
    if (scripted?.finishReason) b = { ...b, finishReason: scripted.finishReason };
    let full = b.tokens.join('');
    let finishReason = b.finishReason;
    let thoughts = scripted?.thoughts ?? 0;
    if (b.honorMaxTokens) {
      if (which === 'google' && scripted?.thoughts === undefined) thoughts = this.thinkingSpent(b, body);
      const limit = this.outputLimit(which, body);
      if (limit !== undefined) {
        const room = Math.max(0, limit - thoughts);
        if (tokensOf(full) > room) {
          full = full.slice(0, room * 4);
          finishReason = 'length';
        }
      }
    }
    const tokens = full === b.tokens.join('') ? b.tokens : chunkText(full);
    const usage = { in: 50, out: tokensOf(full), thoughts };
    const rid = `mock-${which}-${call}`;
    if (!stream) {
      await wait(b.firstTokenDelayMs);
      const json =
        which === 'openai'
          ? { id: rid, choices: [{ message: { role: 'assistant', content: full }, finish_reason: finishReason }], usage: { prompt_tokens: usage.in, completion_tokens: usage.out, total_tokens: usage.in + usage.out } }
          : which === 'anthropic'
            ? { id: rid, content: [{ type: 'text', text: full }], stop_reason: finishReason === 'length' ? 'max_tokens' : 'end_turn', usage: { input_tokens: usage.in, output_tokens: usage.out } }
            : {
                candidates: [{ content: full ? { role: 'model', parts: [{ text: full }] } : { role: 'model' }, finishReason: finishReason === 'length' ? 'MAX_TOKENS' : 'STOP' }],
                usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out, thoughtsTokenCount: usage.thoughts, totalTokenCount: usage.in + usage.out + usage.thoughts },
                responseId: rid,
              };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (data: unknown, event?: string) => {
      if (res.destroyed) return;
      res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };
    let closed = false;
    req.on('close', () => (closed = true));
    await wait(b.firstTokenDelayMs);
    if (b.malformedStream) {
      res.write('data: {not json\n\n');
      res.end();
      return;
    }
    if (which === 'anthropic') send({ type: 'message_start', message: { id: 'm1' } }, 'message_start');
    let i = 0;
    const endAfter = scripted?.endStreamAfterTokens ?? b.endStreamAfterTokens;
    for (const t of tokens) {
      if (closed || res.destroyed) return;
      if (b.dropAfterTokens !== undefined && i >= b.dropAfterTokens) {
        res.destroy();
        return;
      }
      if (endAfter !== undefined && i >= endAfter) {
        res.end(); // a clean end with no finish reason: the reply is simply cut short
        return;
      }
      if (which === 'openai') send({ choices: [{ delta: { content: t }, finish_reason: null }] });
      else if (which === 'anthropic') send({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }, 'content_block_delta');
      else send({ candidates: [{ content: { parts: [{ text: t }] } }] });
      i++;
      await wait(b.tokenDelayMs);
    }
    if (which === 'openai') {
      send({ id: rid, choices: [{ delta: {}, finish_reason: finishReason }] });
      send('[DONE]');
    } else if (which === 'anthropic') {
      send({ type: 'message_delta', delta: { stop_reason: finishReason === 'length' ? 'max_tokens' : 'end_turn' } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
    } else {
      send({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: finishReason === 'length' ? 'MAX_TOKENS' : 'STOP' }],
        usageMetadata: { promptTokenCount: usage.in, candidatesTokenCount: usage.out, thoughtsTokenCount: usage.thoughts, totalTokenCount: usage.in + usage.out + usage.thoughts },
        responseId: rid,
      });
    }
    res.end();
  }

  /** The output limit the request asked for, in whatever field the protocol uses. */
  private outputLimit(which: 'openai' | 'anthropic' | 'google', body: Record<string, unknown> | null): number | undefined {
    if (!body) return undefined;
    const n = which === 'google' ? (body.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens : ((body.max_tokens ?? body.max_completion_tokens) as number | undefined);
    return typeof n === 'number' ? n : undefined;
  }

  /** Hidden thinking tokens a Gemini request would spend: all of them by default, fewer or none when the request limits thinking. */
  private thinkingSpent(b: MockBehavior, body: Record<string, unknown> | null): number {
    const all = b.thinkingTokens ?? 0;
    const tc = (body?.generationConfig as { thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string } } | undefined)?.thinkingConfig;
    if (!tc) return all;
    if (typeof tc.thinkingBudget === 'number') return Math.min(all, Math.max(0, tc.thinkingBudget));
    if (typeof tc.thinkingLevel === 'string') return /minimal|low/i.test(tc.thinkingLevel) ? Math.min(all, 64) : all;
    return all;
  }
}
