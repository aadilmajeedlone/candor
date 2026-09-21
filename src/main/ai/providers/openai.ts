import type { ProviderMeta } from '@core/live/types';
import { AiError } from '@shared/errors';
import type { ProviderConfig } from '@shared/types';
import { mapHttpError, mapNetworkError, outputCapFrom, parseErrorBody } from '../errors';
import { toResponseFormat } from '../schema';
import { parseEventJson, parseSse } from '../sse';
import type { ChatRequest, CompleteResult, HttpClient, ProviderAdapter, ResolvedModel, StreamChunk } from '../types';

interface Quirks {
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  noTemperature?: boolean;
  noTopP?: boolean;
  noReasoningEffort?: boolean;
  /** How structured output was last accepted or refused: 'schema' (json_schema), 'json' (json_object) or 'none'. Unset = not learned yet. */
  structured?: 'schema' | 'json' | 'none';
  /** The most output tokens the model accepts, learned from a refusal that named it. */
  maxOut?: number;
}

interface Plan {
  maxTokens: number;
  structured: 'schema' | 'json' | 'none';
  reasoning: 'default' | 'limited';
  adapted: string[];
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

const usageOf = (u: OpenAiUsage | undefined): ProviderMeta['usage'] =>
  u ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, reasoningTokens: u.completion_tokens_details?.reasoning_tokens } : undefined;

/** The reply was cut off before any visible text (hidden reasoning shares the output limit on reasoning models). */
const outputLimit = (name: string): AiError =>
  new AiError('malformed', `${name} used its whole output limit before it wrote any visible reply (hidden reasoning counts toward that limit).`, { retryable: false, reason: 'output-limit' });

const isReasoning = (model: string): boolean => /^(o\d|gpt-5)/i.test(model);

export function normalizeBase(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '');
  return /^https?:\/\/api\.openai\.com$/i.test(u) ? `${u}/v1` : u;
}

function finish(reason: unknown): 'stop' | 'length' | 'other' {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return 'other';
}

/**
 * OpenAI Chat Completions protocol. Also serves every OpenAI-compatible endpoint: Groq, OpenRouter, Together,
 * Fireworks, Mistral, DeepSeek and local servers such as Ollama or LM Studio (via their base URL).
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  private quirks = new Map<string, Quirks>();

  private q(base: string, model: string): Quirks {
    const k = `${base}|${model}`;
    let v = this.quirks.get(k);
    if (!v) this.quirks.set(k, (v = {}));
    return v;
  }

  private headers(apiKey: string | null): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    return h;
  }

  private body(model: string, req: ChatRequest, quirks: Quirks, stream: boolean, plan: Plan, base: string): Record<string, unknown> {
    const reasoning = isReasoning(model);
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      stream,
    };
    const tokenParam = quirks.tokenParam ?? (reasoning ? 'max_completion_tokens' : 'max_tokens');
    // Reasoning models spend part of the budget on hidden reasoning; leave headroom so the answer is not starved.
    body[tokenParam] = reasoning ? plan.maxTokens + 512 : plan.maxTokens;
    if (!reasoning && !quirks.noTemperature && req.temperature !== undefined) body.temperature = req.temperature;
    if (!reasoning && !quirks.noTopP && req.topP !== null && req.topP !== undefined) body.top_p = req.topP;
    if (plan.reasoning === 'limited') body.reasoning_effort = /^gpt-5/i.test(model) ? 'minimal' : 'low';
    if (plan.structured === 'schema' && req.schema) body.response_format = toResponseFormat(req.schema, 'reply', /^https?:\/\/api\.openai\.com/i.test(base));
    else if (plan.structured !== 'none' && req.json) body.response_format = { type: 'json_object' };
    return body;
  }

  /** What to ask of this model for this request, given what it has already refused. */
  private plan(model: string, req: ChatRequest, quirks: Quirks, adapted: string[]): Plan {
    const structured: Plan['structured'] = !req.json ? 'none' : (quirks.structured ?? (req.schema ? 'schema' : 'json'));
    // Reasoning models spend hidden tokens from the same output limit: keep them small when the reply must arrive whole.
    const effort = !quirks.noReasoningEffort && ((/^gpt-5/i.test(model) && (req.fast || req.minimalReasoning)) || (/^o\d/i.test(model) && req.minimalReasoning));
    return { maxTokens: Math.min(req.maxTokens, quirks.maxOut ?? req.maxTokens), structured, reasoning: effort ? 'limited' : 'default', adapted };
  }

  /** POST with automatic adaptation to parameters a given model refuses (max_tokens vs max_completion_tokens, temperature…). */
  private async post(r: ResolvedModel, req: ChatRequest, http: HttpClient, stream: boolean): Promise<{ res: Response; plan: Plan }> {
    const base = normalizeBase(r.provider.baseUrl);
    const quirks = this.q(base, r.model.model);
    const adapted: string[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const plan = this.plan(r.model.model, req, quirks, adapted);
      let res: Response;
      try {
        res = await http.fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: this.headers(r.apiKey),
          body: JSON.stringify(this.body(r.model.model, req, quirks, stream, plan, base)),
          signal: req.signal,
        });
      } catch (err) {
        throw mapNetworkError(err, r.provider);
      }
      if (res.ok) return { res, plan };
      const text = await res.text().catch(() => '');
      if (res.status === 400 && attempt < 6) {
        const b = parseErrorBody(text);
        const m = b.message.toLowerCase();
        const p = b.param ?? '';
        const cap = outputCapFrom(b.message, plan.maxTokens);
        if (cap !== null) {
          quirks.maxOut = cap;
          adapted.push('output limit');
          continue;
        }
        if (p === 'max_tokens' || (/max_tokens/.test(m) && /max_completion_tokens/.test(m))) {
          quirks.tokenParam = 'max_completion_tokens';
          adapted.push('token limit parameter');
          continue;
        }
        if (p === 'max_completion_tokens' && !quirks.tokenParam) {
          quirks.tokenParam = 'max_tokens';
          adapted.push('token limit parameter');
          continue;
        }
        if (p === 'temperature' || (/temperature/.test(m) && /unsupported|not support|only the default/.test(m))) {
          quirks.noTemperature = true;
          adapted.push('temperature');
          continue;
        }
        if (p === 'top_p' || (/top_p/.test(m) && /unsupported|not support/.test(m))) {
          quirks.noTopP = true;
          adapted.push('top_p');
          continue;
        }
        if (p === 'reasoning_effort' || /reasoning_effort/.test(m)) {
          quirks.noReasoningEffort = true;
          adapted.push('reasoning effort');
          continue;
        }
        if (plan.structured !== 'none' && (p === 'response_format' || /response_format|json_object|json_schema|json mode|structured output/.test(m))) {
          // Not every server that speaks this protocol has structured outputs, or even JSON mode: step down and remember.
          quirks.structured = plan.structured === 'schema' ? 'json' : 'none';
          adapted.push(plan.structured === 'schema' ? 'response schema' : 'JSON mode');
          continue;
        }
      }
      throw mapHttpError(res.status, text, res.headers.get('retry-after'), r.provider.name);
    }
    throw new AiError('bad_request', `${r.provider.name} rejected the request parameters.`);
  }

  private metaOf(plan: Plan, o: { id?: string; raw?: string; completed: boolean; usage?: OpenAiUsage }): ProviderMeta {
    return { responseId: o.id, rawFinishReason: o.raw, completed: o.completed, usage: usageOf(o.usage), structured: plan.structured, reasoning: plan.reasoning, adapted: plan.adapted.length ? plan.adapted : undefined };
  }

  async *stream(r: ResolvedModel, req: ChatRequest, http: HttpClient): AsyncGenerator<StreamChunk> {
    const { res, plan } = await this.post(r, req, http, true);
    if (!res.body) throw new AiError('malformed', `${r.provider.name} returned an empty stream.`);
    let reason: 'stop' | 'length' | 'other' = 'other';
    let raw: string | undefined;
    let sawAny = false;
    let completed = false;
    let id: string | undefined;
    let usage: OpenAiUsage | undefined;
    try {
      for await (const ev of parseSse(res.body)) {
        if (ev.data === '[DONE]') {
          completed = true;
          break;
        }
        const j = parseEventJson<{
          id?: string;
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: OpenAiUsage;
          error?: { message?: string };
        }>(ev.data, r.provider.name);
        if (j.error) throw new AiError('server', `${r.provider.name}: ${j.error.message ?? 'stream error'}`);
        if (j.id) id = j.id;
        if (j.usage) usage = j.usage;
        const choice = j.choices?.[0];
        const text = choice?.delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          sawAny = true;
          yield { type: 'text', text };
        }
        if (choice?.finish_reason) {
          reason = finish(choice.finish_reason);
          raw = choice.finish_reason;
          completed = true;
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw mapNetworkError(err, r.provider);
    }
    if (!sawAny) {
      // A stream that wrote nothing is an empty reply however it ended — the non-streaming path treats it the same way.
      if (reason === 'length') throw outputLimit(r.provider.name);
      throw new AiError('malformed', `${r.provider.name} returned no content${raw && raw !== 'stop' && raw !== 'STOP' ? ` (${raw})` : ''}.`);
    }
    yield { type: 'done', finishReason: reason, meta: this.metaOf(plan, { id, raw, completed, usage }) };
  }

  async complete(r: ResolvedModel, req: ChatRequest, http: HttpClient): Promise<CompleteResult> {
    const { res, plan } = await this.post(r, req, http, false);
    let j: { id?: string; choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]; usage?: OpenAiUsage };
    try {
      j = (await res.json()) as typeof j;
    } catch {
      throw new AiError('malformed', `${r.provider.name} returned an unreadable response.`);
    }
    const c = j.choices?.[0];
    const text = c?.message?.content;
    const raw = c?.finish_reason ?? undefined;
    if (typeof text !== 'string' || !text) {
      if (raw === 'length') throw outputLimit(r.provider.name);
      throw new AiError('malformed', `${r.provider.name} returned an empty response${raw && raw !== 'stop' ? ` (${raw})` : ''}.`);
    }
    return { text, finishReason: finish(raw), meta: this.metaOf(plan, { id: j.id, raw, completed: raw !== undefined, usage: j.usage }) };
  }

  async listModels(provider: ProviderConfig, apiKey: string | null, http: HttpClient, signal?: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await http.fetch(`${normalizeBase(provider.baseUrl)}/models`, { headers: this.headers(apiKey), signal });
    } catch (err) {
      throw mapNetworkError(err, provider);
    }
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'), provider.name);
    const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
    const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    // Ollama's native shape, in case the user pointed at it directly.
    const alt = (j.models ?? []).map((m) => m.id ?? m.name).filter((x): x is string => !!x);
    return [...new Set([...ids, ...alt])].sort();
  }
}
