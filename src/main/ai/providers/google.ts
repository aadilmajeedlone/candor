import type { ProviderMeta } from '@core/live/types';
import { AiError } from '@shared/errors';
import { GEMINI_API_HOST, googleAuthOf, stripGeminiPrefix } from '@shared/google';
import { isGeminiChatModel, parseGeminiModel } from '@shared/models';
import type { GoogleAuthConfig, ProviderConfig } from '@shared/types';
import { mapNetworkError, outputCapFrom, parseErrorBody } from '../errors';
import { AdcError, GoogleAdc, problemFor, type CredentialSource } from '../googleAuth';
import { mapGoogleHttpError } from '../googleErrors';
import { toGeminiSchema } from '../schema';
import { parseEventJson, parseSse } from '../sse';
import type { ChatRequest, CompleteResult, HttpClient, ListedModels, ProviderAdapter, ResolvedModel, StreamChunk } from '../types';

function finish(r: unknown): 'stop' | 'length' | 'other' {
  if (r === 'STOP') return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  return 'other';
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
  responseId?: string;
}

const usageOf = (u: GeminiUsage | undefined): ProviderMeta['usage'] =>
  u ? { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, reasoningTokens: u.thoughtsTokenCount } : undefined;

/** The provider cut the reply off, or spent the whole output limit before any visible text (hidden reasoning shares that limit). */
const outputLimit = (name: string): AiError =>
  new AiError('malformed', `${name} used its whole output limit before it wrote any visible reply (hidden reasoning counts toward that limit).`, { retryable: false, reason: 'output-limit' });

/** Shown when Vertex AI will not list its models (permission) but may still answer. */
const VERTEX_SUGGESTIONS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

/**
 * How to keep a Gemini model's hidden reasoning small, most specific first. Reasoning tokens are spent from the same output
 * limit as the reply, so an unlimited "thinking" model can use up a modest limit and leave a cut-off answer (or none).
 * Each family takes a different parameter; a model that refuses one is moved down the list and remembered.
 */
function thinkingLadder(model: string): Record<string, unknown>[] {
  if (/^gemini-2\.5-pro/.test(model)) return [{ thinkingBudget: 128 }]; // Pro cannot switch thinking off; 128 is its smallest budget
  if (/^gemini-2\.5-flash/.test(model)) return [{ thinkingBudget: 0 }];
  if (/^gemini-[3-9]/.test(model)) return [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }];
  return [];
}

interface Learned {
  /** The model refused a response schema: use JSON mode without one. */
  noSchema?: boolean;
  /** Position in the thinking ladder: how many limits the model has refused. */
  thinking?: number;
  /** The most output tokens the model accepts, learned from a refusal that named it. */
  maxOut?: number;
}

interface Plan {
  maxTokens: number;
  structured: 'schema' | 'json' | 'none';
  thinking?: Record<string, unknown>;
  reasoning: 'default' | 'limited';
  adapted: string[];
}

interface Target {
  url: string;
  headers: Record<string, string>;
  vertex: boolean;
  project?: string;
  /** The sign-in mode actually used (an API-key fallback is reported as such). */
  cfg: GoogleAuthConfig;
}

type Route = { kind: 'generate'; model: string; method: string } | { kind: 'list' };

/**
 * Google Gemini, over either the Gemini Developer API (API key) or, with Google sign-in (Application Default
 * Credentials), Vertex AI or the Gemini API with an OAuth token. Streaming, parsing and the latency tuning are shared.
 */
export class GoogleAdapter implements ProviderAdapter {
  private learned = new Map<string, Learned>();

  constructor(private readonly credentials: CredentialSource = new GoogleAdc()) {}

  private q(model: string): Learned {
    let v = this.learned.get(model);
    if (!v) this.learned.set(model, (v = {}));
    return v;
  }

  private async target(p: ProviderConfig, apiKey: string | null, route: Route, signal?: AbortSignal): Promise<Target> {
    const cfg = googleAuthOf(p);
    const json = { 'content-type': 'application/json' };
    if (cfg.mode === 'adc') {
      try {
        const { url, project } = await this.adcUrl(p, cfg, route);
        return { url, headers: { ...json, ...(await this.credentials.headers(cfg, url, signal)) }, vertex: cfg.backend === 'vertex', project, cfg };
      } catch (err) {
        // No Application Default Credentials on this PC at all, but an API key exists (stored, or GEMINI_API_KEY): use it.
        if (err instanceof AdcError && err.problem.code === 'adc_missing' && apiKey) {
          // A Gemini Developer API key does not work on Vertex AI, so the fallback always talks to the Gemini API.
          const base = cfg.backend === 'vertex' ? GEMINI_API_HOST : p.baseUrl;
          return { url: this.keyUrl(base, route), headers: { ...json, 'x-goog-api-key': apiKey }, vertex: false, cfg: { ...cfg, mode: 'apiKey', backend: 'gemini-api' } };
        }
        throw err;
      }
    }
    return { url: this.keyUrl(p.baseUrl, route), headers: apiKey ? { ...json, 'x-goog-api-key': apiKey } : json, vertex: false, cfg };
  }

  private keyUrl(base: string, route: Route): string {
    const b = base.trim().replace(/\/+$/, '');
    return route.kind === 'list' ? `${b}/v1beta/models?pageSize=200` : `${b}/v1beta/models/${stripGeminiPrefix(route.model)}:${route.method}`;
  }

  private async adcUrl(p: ProviderConfig, cfg: GoogleAuthConfig, route: Route): Promise<{ url: string; project?: string }> {
    const base = p.baseUrl.trim().replace(/\/+$/, '');
    if (cfg.backend !== 'vertex') return { url: this.keyUrl(base, route) };
    const proj = await this.credentials.project(cfg);
    if (!proj) throw new AdcError(problemFor('no_project'));
    if (route.kind === 'list') return { url: `${base}/v1beta1/publishers/google/models?pageSize=200`, project: proj.project };
    const location = cfg.location.trim() || 'global';
    return { url: `${base}/v1/projects/${proj.project}/locations/${location}/publishers/google/models/${stripGeminiPrefix(route.model)}:${route.method}`, project: proj.project };
  }

  /** What to ask of this model for this request, given what it has already refused. */
  private plan(r: ResolvedModel, req: ChatRequest, adapted: string[]): Plan {
    const learned = this.q(r.model.model);
    const structured: Plan['structured'] = !req.json ? 'none' : req.schema && !learned.noSchema ? 'schema' : 'json';
    const ladder = req.fast || req.minimalReasoning ? thinkingLadder(stripGeminiPrefix(r.model.model)) : [];
    const thinking = ladder[learned.thinking ?? 0];
    return { maxTokens: Math.min(req.maxTokens, learned.maxOut ?? req.maxTokens), structured, thinking, reasoning: thinking ? 'limited' : 'default', adapted };
  }

  private body(req: ChatRequest, plan: Plan): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: plan.maxTokens };
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.topP !== null && req.topP !== undefined) generationConfig.topP = req.topP;
    if (req.json) generationConfig.responseMimeType = 'application/json';
    if (plan.structured === 'schema' && req.schema) generationConfig.responseSchema = toGeminiSchema(req.schema);
    // Gemini 2.5 and 3 "think" by default, which adds seconds of latency and eats the output budget.
    if (plan.thinking) generationConfig.thinkingConfig = plan.thinking;
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig,
    };
  }

  private async post(r: ResolvedModel, req: ChatRequest, http: HttpClient, stream: boolean): Promise<{ res: Response; plan: Plan }> {
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const adapted: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const plan = this.plan(r, req, adapted);
      const t = await this.target(r.provider, r.apiKey, { kind: 'generate', model: r.model.model, method }, req.signal);
      let res: Response;
      try {
        res = await http.fetch(t.url, { method: 'POST', headers: t.headers, body: JSON.stringify(this.body(req, plan)), signal: req.signal });
      } catch (err) {
        throw mapNetworkError(err, r.provider);
      }
      if (res.ok) return { res, plan };
      const text = await res.text().catch(() => '');
      if (res.status === 400 && attempt < 4) {
        const message = parseErrorBody(text).message;
        const learned = this.q(r.model.model);
        const cap = outputCapFrom(message, plan.maxTokens);
        if (cap !== null) {
          learned.maxOut = cap;
          adapted.push('output limit');
          continue;
        }
        // A model that does not know a reasoning parameter or a response schema is asked again without it, and remembered.
        if (plan.thinking && /thinking|thought/i.test(message)) {
          learned.thinking = (learned.thinking ?? 0) + 1;
          adapted.push('reasoning limit');
          continue;
        }
        if (plan.structured === 'schema' && /schema|response_?mime|controlled generation|unknown name|json/i.test(message)) {
          learned.noSchema = true;
          adapted.push('response schema');
          continue;
        }
      }
      throw mapGoogleHttpError(res.status, text, res.headers.get('retry-after'), { provider: r.provider.name, cfg: t.cfg, project: t.project, model: r.model.model });
    }
    throw new AiError('bad_request', `${r.provider.name} rejected the request.`);
  }

  private textOf(j: GeminiResponse): string {
    return (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  }

  async *stream(r: ResolvedModel, req: ChatRequest, http: HttpClient): AsyncGenerator<StreamChunk> {
    const { res, plan } = await this.post(r, req, http, true);
    if (!res.body) throw new AiError('malformed', `${r.provider.name} returned an empty stream.`);
    let reason: 'stop' | 'length' | 'other' = 'other';
    let raw: string | undefined;
    let sawAny = false;
    let sawFinish = false;
    let usage: GeminiUsage | undefined;
    let responseId: string | undefined;
    try {
      for await (const ev of parseSse(res.body)) {
        const j = parseEventJson<GeminiResponse>(ev.data, r.provider.name);
        if (j.error) throw new AiError('server', `${r.provider.name}: ${j.error.message ?? 'stream error'}`);
        if (j.promptFeedback?.blockReason) throw new AiError('bad_request', `${r.provider.name} blocked the prompt (${j.promptFeedback.blockReason}).`, { retryable: false });
        const text = this.textOf(j);
        if (text) {
          sawAny = true;
          yield { type: 'text', text };
        }
        const fr = j.candidates?.[0]?.finishReason;
        if (fr) {
          reason = finish(fr);
          raw = fr;
          sawFinish = true;
        }
        if (j.usageMetadata) usage = j.usageMetadata;
        if (j.responseId) responseId = j.responseId;
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
    const meta: ProviderMeta = { responseId, rawFinishReason: raw, completed: sawFinish, usage: usageOf(usage), structured: plan.structured, reasoning: plan.reasoning, adapted: plan.adapted.length ? plan.adapted : undefined };
    yield { type: 'done', finishReason: reason, meta };
  }

  async complete(r: ResolvedModel, req: ChatRequest, http: HttpClient): Promise<CompleteResult> {
    const { res, plan } = await this.post(r, req, http, false);
    let j: GeminiResponse;
    try {
      j = (await res.json()) as GeminiResponse;
    } catch {
      throw new AiError('malformed', `${r.provider.name} returned an unreadable response.`);
    }
    if (j.promptFeedback?.blockReason) throw new AiError('bad_request', `${r.provider.name} blocked the prompt (${j.promptFeedback.blockReason}).`, { retryable: false });
    const text = this.textOf(j);
    const raw = j.candidates?.[0]?.finishReason;
    if (!text) {
      if (raw === 'MAX_TOKENS') throw outputLimit(r.provider.name);
      throw new AiError('malformed', `${r.provider.name} returned an empty response${raw && raw !== 'STOP' ? ` (${raw})` : ''}.`);
    }
    const meta: ProviderMeta = { responseId: j.responseId, rawFinishReason: raw, completed: raw !== undefined, usage: usageOf(j.usageMetadata), structured: plan.structured, reasoning: plan.reasoning, adapted: plan.adapted.length ? plan.adapted : undefined };
    return { text, finishReason: finish(raw), meta };
  }

  async listModels(provider: ProviderConfig, apiKey: string | null, http: HttpClient, signal?: AbortSignal): Promise<ListedModels> {
    const t = await this.target(provider, apiKey, { kind: 'list' }, signal);
    let res: Response;
    try {
      res = await http.fetch(t.url, { headers: t.headers, signal });
    } catch (err) {
      throw mapNetworkError(err, provider);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Vertex may refuse to list models to an account that can still call them: offer well-known names instead.
      const listingNotAllowed = t.vertex && (res.status === 404 || res.status === 400 || (res.status === 403 && /IAM_PERMISSION_DENIED|permission/i.test(text) && !/SERVICE_DISABLED|BILLING|USER_PROJECT|serviceusage/i.test(text)));
      if (listingNotAllowed) return { models: VERTEX_SUGGESTIONS, note: 'Vertex AI would not list its models for this account, so common Gemini names are shown. Press Test on one to check it works.' };
      throw mapGoogleHttpError(res.status, text, res.headers.get('retry-after'), { provider: provider.name, cfg: t.cfg, project: t.project });
    }
    const j = (await res.json().catch(() => ({}))) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
      publisherModels?: { name?: string }[];
    };
    const names = t.vertex
      ? (j.publisherModels ?? []).map((m) => m.name?.replace(/^publishers\/google\/models\//, '').replace(/@.*$/, ''))
      : (j.models ?? []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => m.name?.replace(/^models\//, ''));
    const ids = [...new Set(names.filter((x): x is string => !!x))].filter(isGeminiChatModel);
    // Newest first, so the UI's "first suggestion" is a current model rather than the alphabetically oldest.
    ids.sort((a, b) => sortKey(b).localeCompare(sortKey(a), undefined, { numeric: true }) || a.localeCompare(b));
    return ids.length > 0 || !t.vertex ? { models: ids } : { models: VERTEX_SUGGESTIONS, note: 'Vertex AI returned no Gemini models to list, so common names are shown. Press Test on one to check it works.' };
  }
}

/** Sortable "version.family" key: 2.5.flash sorts before 3.5.flash; stable beats preview. */
function sortKey(id: string): string {
  const m = parseGeminiModel(id);
  const v = [0, 1, 2].map((i) => String(m.version[i] ?? 0).padStart(3, '0')).join('.');
  return `${m.alias ? '0' : '1'}.${v}.${m.unstable ? '0' : '1'}`;
}
