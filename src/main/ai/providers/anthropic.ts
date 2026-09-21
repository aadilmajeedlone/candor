import type { ProviderMeta } from '@core/live/types';
import { AiError } from '@shared/errors';
import type { ProviderConfig } from '@shared/types';
import { mapHttpError, mapNetworkError } from '../errors';
import { parseEventJson, parseSse } from '../sse';
import type { ChatRequest, CompleteResult, HttpClient, ProviderAdapter, ResolvedModel, StreamChunk } from '../types';

const VERSION = '2023-06-01';

function base(p: ProviderConfig): string {
  return p.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function stopReason(r: unknown): 'stop' | 'length' | 'other' {
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  if (r === 'max_tokens') return 'length';
  return 'other';
}

/** Anthropic Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  private headers(apiKey: string | null): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': VERSION };
    if (apiKey) h['x-api-key'] = apiKey;
    return h;
  }

  private body(r: ResolvedModel, req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: r.model.model,
      max_tokens: req.maxTokens,
      system: req.json ? `${req.system}\n\nRespond with a single JSON object and nothing else.` : req.system,
      messages: [{ role: 'user', content: req.user }],
      stream,
    };
    // Newer Claude models reject temperature and top_p together; temperature alone is the portable choice.
    if (req.temperature !== undefined) body.temperature = req.temperature;
    else if (req.topP !== null && req.topP !== undefined) body.top_p = req.topP;
    return body;
  }

  private async post(r: ResolvedModel, req: ChatRequest, http: HttpClient, stream: boolean): Promise<Response> {
    let res: Response;
    try {
      res = await http.fetch(`${base(r.provider)}/v1/messages`, {
        method: 'POST',
        headers: this.headers(r.apiKey),
        body: JSON.stringify(this.body(r, req, stream)),
        signal: req.signal,
      });
    } catch (err) {
      throw mapNetworkError(err, r.provider);
    }
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'), r.provider.name);
    return res;
  }

  async *stream(r: ResolvedModel, req: ChatRequest, http: HttpClient): AsyncGenerator<StreamChunk> {
    const res = await this.post(r, req, http, true);
    if (!res.body) throw new AiError('malformed', `${r.provider.name} returned an empty stream.`);
    let reason: 'stop' | 'length' | 'other' = 'other';
    let raw: string | undefined;
    let sawAny = false;
    let completed = false;
    let id: string | undefined;
    try {
      for await (const ev of parseSse(res.body)) {
        const j = parseEventJson<{ type?: string; message?: { id?: string }; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { message?: string; type?: string } }>(ev.data, r.provider.name);
        const type = j.type ?? ev.event;
        if (type === 'message_start' && j.message?.id) id = j.message.id;
        if (type === 'error') {
          const overloaded = j.error?.type === 'overloaded_error';
          throw new AiError(overloaded ? 'rate_limit' : 'server', `${r.provider.name}: ${j.error?.message ?? 'stream error'}`, { retryable: true });
        }
        if (type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta.text) {
          sawAny = true;
          yield { type: 'text', text: j.delta.text };
        } else if (type === 'message_delta' && j.delta?.stop_reason) {
          reason = stopReason(j.delta.stop_reason);
          raw = j.delta.stop_reason;
        } else if (type === 'message_stop') {
          completed = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw mapNetworkError(err, r.provider);
    }
    if (!sawAny) {
      if (reason === 'length') throw new AiError('malformed', `${r.provider.name} reached its output limit before it wrote any visible reply.`, { retryable: false, reason: 'output-limit' });
      throw new AiError('malformed', `${r.provider.name} returned no content${raw && raw !== 'end_turn' ? ` (${raw})` : ''}.`);
    }
    const meta: ProviderMeta = { responseId: id, rawFinishReason: raw, completed: completed || raw !== undefined, structured: req.json ? 'json' : 'none', reasoning: 'default' };
    yield { type: 'done', finishReason: reason, meta };
  }

  async complete(r: ResolvedModel, req: ChatRequest, http: HttpClient): Promise<CompleteResult> {
    const res = await this.post(r, req, http, false);
    let j: { id?: string; content?: { type?: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      j = (await res.json()) as typeof j;
    } catch {
      throw new AiError('malformed', `${r.provider.name} returned an unreadable response.`);
    }
    const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) {
      if (j.stop_reason === 'max_tokens') throw new AiError('malformed', `${r.provider.name} reached its output limit before it wrote any visible reply.`, { retryable: false, reason: 'output-limit' });
      throw new AiError('malformed', `${r.provider.name} returned an empty response${j.stop_reason && j.stop_reason !== 'end_turn' ? ` (${j.stop_reason})` : ''}.`);
    }
    const meta: ProviderMeta = {
      responseId: j.id,
      rawFinishReason: j.stop_reason,
      completed: j.stop_reason !== undefined,
      usage: j.usage ? { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens } : undefined,
      structured: req.json ? 'json' : 'none',
      reasoning: 'default',
    };
    return { text, finishReason: stopReason(j.stop_reason), meta };
  }

  async listModels(provider: ProviderConfig, apiKey: string | null, http: HttpClient, signal?: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await http.fetch(`${base(provider)}/v1/models?limit=100`, { headers: this.headers(apiKey), signal });
    } catch (err) {
      throw mapNetworkError(err, provider);
    }
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'), provider.name);
    const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    return (j.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  }
}
