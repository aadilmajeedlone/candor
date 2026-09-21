import { AiError, isAiError } from '@shared/errors';
import { googleAuthOf, isGoogleApiHost, usesAdc } from '@shared/google';
import type { AiTask, ConnectionTestResult, GoogleAuthStatus, ModelConfig, ModelListResult, ModelProbeResult, ProviderConfig, ProviderKind } from '@shared/types';
import { isAbortError, sleep } from '@shared/util';
import { ANSWER_SYSTEM } from '@prompts/index';
import type { LlmGateway, LlmGenerateRequest, LlmGenerateResult, LlmReplyMeta } from '@core/live/types';
import type { Repos } from '../db/repos';
import { geminiCandidates, isGeminiChatModel } from '@shared/models';
import { endpointScope } from '@shared/net';
import type { ScopedLogger } from '../logging';
import { envGroupFor, type SecretStore } from '../security/secrets';
import { aiDebug } from './diagnostics';
import { mapNetworkError } from './errors';
import { GoogleAdc, problemFor, type CredentialSource } from './googleAuth';
import { AnthropicAdapter } from './providers/anthropic';
import { GoogleAdapter } from './providers/google';
import { OpenAiCompatibleAdapter } from './providers/openai';
import type { ChatRequest, HttpClient, ProviderAdapter, ResolvedModel } from './types';

export interface GatewayDeps {
  repos: Repos;
  secrets: SecretStore;
  http: HttpClient;
  log: ScopedLogger;
  adapters?: Partial<Record<ProviderKind, ProviderAdapter>>;
  /** Where Google sign-in (Application Default Credentials) comes from. Production uses Google's library; tests inject one. */
  googleCredentials?: CredentialSource;
  /** Override the live first-token deadline for internet providers (tests). */
  liveFirstTokenMs?: number;
  /** Tell the person something that belongs to no single request (a saved model was repaired). Wired to the app-wide notice. */
  notify?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** If a task has no route of its own, borrow this one, so a single configured model still serves everything. */
const BORROW: Record<AiTask, AiTask | null> = { live: 'prep', prep: 'live', classify: 'live', mock: 'prep' };
/** No tokens for this long while streaming counts as a stall. */
const STALL_MS = 15_000;
/** Live answers must start quickly or the fallback takes over. */
const LIVE_FIRST_TOKEN_MS = 9_000;

/** This PC or your own network (LAN / VPN): no API key is required and plain http is acceptable. */
export function isLocalUrl(url: string): boolean {
  return endpointScope(url) !== 'internet';
}

/** After a repair found nothing usable, do not probe again for this long. */
const HEAL_COOLDOWN_MS = 10 * 60_000;
/** At most this many other models are tried (each try is one tiny request). */
const HEAL_MAX_PROBES = 5;
/** Requests that fail together (Preparation runs four sections at once) get one app-wide message, not four. */
const ANNOUNCE_DEDUPE_MS = 60_000;
/**
 * A structured reply (JSON) is useless unless it arrives whole, so its output budget is the one the caller sized for the
 * reply it asked for. This is only a sanity ceiling. The per-model "max tokens" setting exists to keep spoken answers
 * short; it must not silently cut a data reply in half.
 */
const STRUCTURED_TOKEN_CAP = 8192;
/** A model that failed with a server error or a timeout is tried after its fallback for this long, not first. */
const COOL_MS = 60_000;
/** Server errors / timeouts from one model within COOL_MS (across all requests) that make the model "unwell". */
const STRIKES_TO_REST = 2;

export class AiGateway implements LlmGateway {
  private readonly adapters: Record<ProviderKind, ProviderAdapter>;
  private readonly credentials: CredentialSource;
  /** Repairs in progress and recent dead ends, per provider + model, so parallel requests share one repair. */
  private readonly healing = new Map<string, Promise<{ working: string | null; tried: string[] }>>();
  private readonly healDeadEnd = new Map<string, { at: number; tried: string[] }>();
  private readonly announced = new Map<string, number>();
  /** Model row id → when it may be preferred again after a server error or timeout. */
  private readonly cooling = new Map<string, number>();
  /** Model row id → recent server errors / timeouts, counted across every request. */
  private readonly strikes = new Map<string, { n: number; at: number }>();

  constructor(private readonly d: GatewayDeps) {
    this.credentials = d.googleCredentials ?? new GoogleAdc();
    this.adapters = {
      'openai-compatible': d.adapters?.['openai-compatible'] ?? new OpenAiCompatibleAdapter(),
      anthropic: d.adapters?.anthropic ?? new AnthropicAdapter(),
      google: d.adapters?.google ?? new GoogleAdapter(this.credentials),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Resolution                                                          */
  /* ------------------------------------------------------------------ */

  keyFor(provider: ProviderConfig): string | null {
    return this.d.secrets.get(`provider.${provider.id}`, envGroupFor(provider.kind, provider.baseUrl));
  }

  resolveModel(modelId: string | null): ResolvedModel | null {
    if (!modelId) return null;
    const model = this.d.repos.getModel(modelId);
    if (!model) return null;
    const provider = this.d.repos.getProvider(model.providerId);
    if (!provider || !provider.enabled) return null;
    const apiKey = this.keyFor(provider);
    // Google sign-in needs no key; a stored or environment key is only an optional fallback.
    if (!apiKey && !isLocalUrl(provider.baseUrl) && !usesAdc(provider)) {
      throw new AiError('not_configured', `No API key is set for “${provider.name}”. Add one in Settings → AI Providers.`, { retryable: false });
    }
    return { provider, model, apiKey };
  }

  route(task: AiTask): { primary: ResolvedModel | null; fallback: ResolvedModel | null } {
    const routing = this.d.repos.getSettings().routing;
    let r = routing[task];
    if (!r.primary) {
      const borrow = BORROW[task];
      if (borrow && routing[borrow].primary) r = routing[borrow];
    }
    return { primary: this.resolveModel(r.primary), fallback: r.fallback && r.fallback !== r.primary ? this.resolveModel(r.fallback) : null };
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    if (req.signal.aborted) throw new AiError('aborted', 'Cancelled', { retryable: false });
    const { primary, fallback } = this.route(req.task);
    if (!primary) {
      throw new AiError('not_configured', `No model is set up for ${describeTask(req.task)}. Add a provider and choose a model in Settings.`, { retryable: false });
    }
    // A model that has just failed with a server error or a timeout is probably still unwell. Rather than make every request
    // wait through its retries again, go to the fallback first for a little while (the model stays configured as it was).
    const swapped = !!fallback && this.isCooling(primary) && !this.isCooling(fallback);
    const first = swapped && fallback ? fallback : primary;
    const second = swapped ? primary : fallback;
    const progress = { emitted: false };
    try {
      const res = await this.attemptHealing(first, req, progress, !!second);
      this.cooling.delete(first.model.id);
      return swapped ? { ...res, usedFallback: true } : res;
    } catch (err) {
      if (req.signal.aborted || isAbortError(err) || (isAiError(err) && err.code === 'aborted')) throw err;
      const ai = isAiError(err) ? err : mapNetworkError(err, first.provider);
      this.restIfUnwell(first, ai);
      // Never switch models after the user has already seen part of an answer; that would splice two answers.
      if (!second || progress.emitted || ai.code === 'context_overflow') throw ai;
      req.onNotice?.('warn', `${first.provider.name} failed (${ai.code.replace('_', ' ')}). Switching to the fallback model “${second.model.model}”.`);
      this.d.log.warn('primary failed, using fallback', { task: req.task, code: ai.code, status: ai.status, model: first.model.model, fallback: second.model.model });
      try {
        const res = await this.attemptHealing(second, req, { emitted: false }, false);
        this.cooling.delete(second.model.id);
        return { ...res, usedFallback: !swapped };
      } catch (err2) {
        if (isAiError(err2)) this.restIfUnwell(second, err2);
        throw err2;
      }
    }
  }

  private isCooling(r: ResolvedModel): boolean {
    const until = this.cooling.get(r.model.id);
    return until !== undefined && until > Date.now();
  }

  private restIfUnwell(r: ResolvedModel, err: AiError): void {
    if (err.code === 'server' || err.code === 'timeout') this.cooling.set(r.model.id, Date.now() + COOL_MS);
  }

  /**
   * Count a server error or timeout against a model, whichever request met it. Once several have piled up the model is
   * rested, and requests that are still retrying it (Preparation runs four sections at once) stop and use the fallback
   * instead of each waiting through a full retry cycle of their own.
   */
  private strike(r: ResolvedModel, err: AiError): void {
    if (err.code !== 'server' && err.code !== 'timeout') return;
    const now = Date.now();
    const s = this.strikes.get(r.model.id);
    const n = s && now - s.at < COOL_MS ? s.n + 1 : 1;
    this.strikes.set(r.model.id, { n, at: now });
    if (n >= STRIKES_TO_REST) this.cooling.set(r.model.id, now + COOL_MS);
  }

  /**
   * Run a request; if a Google model turns out to be unusable on this project, repair the model choice and run it once
   * more. This only ever repairs what the app itself picked wrongly (an old version chose preview, computer-use and
   * deep-research models that have no free quota or cannot chat at all): it stays with the same provider and key, it is
   * limited to the free-tier signature or a model that does not exist, it costs at most a few tiny test requests, it
   * saves the change where the user can see it (Settings → Models), and it says so.
   */
  private async attemptHealing(r: ResolvedModel, req: LlmGenerateRequest, progress: { emitted: boolean }, canFailOver: boolean): Promise<LlmGenerateResult> {
    try {
      return await this.runWithRetry(r, req, progress, canFailOver);
    } catch (err) {
      if (req.signal.aborted || isAbortError(err) || progress.emitted) throw err;
      const ai = isAiError(err) ? err : mapNetworkError(err, r.provider);
      if (!this.healable(r, ai)) throw ai;
      const outcome = await this.healGoogleModel(r, req.task, ai);
      if (!outcome.healed) {
        if (outcome.tried.length === 0) throw ai;
        throw new AiError('rate_limit', `None of the Gemini models Candor tried has quota on this project (${outcome.tried.join(', ')}). That is a free-tier limit, not a payment problem: use a local model or a friend's GPU, or a different Google project. Turning on billing would make usage paid; Candor never does that for you.`, { retryable: false, reason: 'free-tier-no-quota' });
      }
      this.announce(req, `“${r.model.model}” cannot be used with this Google project, so Candor switched this model to “${outcome.healed.model.model}”. You can change it in Settings → Models.`);
      return this.runWithRetry(outcome.healed, req, progress, canFailOver);
    }
  }

  /** Only Gemini API-key providers, and only failures that point at the model itself rather than at the connection or the key. */
  private healable(r: ResolvedModel, err: AiError): boolean {
    if (r.provider.kind !== 'google' || usesAdc(r.provider)) return false;
    if (err.reason === 'free-tier-no-quota' || err.code === 'model_not_found') return true;
    // A model that should never have been chosen for chat (computer-use, deep-research, embedding, image, speech…)
    // that fails for any reason other than the connection or the request itself is the model's fault by definition.
    // (If the key is what is wrong, listing the models fails first and nothing else is tried.)
    return !isGeminiChatModel(r.model.model) && !['network', 'timeout', 'server', 'aborted', 'not_configured', 'context_overflow'].includes(err.code);
  }

  /**
   * A repair changes a saved setting, so it is always said out loud: on the request's own notice channel when it has one
   * (Live shows it on the Live page), otherwise as an app-wide notice (Preparation and Mock have no place for one).
   */
  private announce(req: LlmGenerateRequest, message: string): void {
    if (req.onNotice) {
      req.onNotice('warn', message);
      return;
    }
    const last = this.announced.get(message);
    if (last !== undefined && Date.now() - last < ANNOUNCE_DEDUPE_MS) return;
    this.announced.set(message, Date.now());
    this.d.notify?.('warn', message);
  }

  private async healGoogleModel(r: ResolvedModel, task: AiTask, err: AiError): Promise<{ healed: ResolvedModel | null; tried: string[] }> {
    const key = `${r.provider.id}|${r.model.model}`;
    const dead = this.healDeadEnd.get(key);
    if (dead && Date.now() - dead.at < HEAL_COOLDOWN_MS) return { healed: null, tried: dead.tried };
    let job = this.healing.get(key);
    if (!job) {
      // On the free tier the fast Flash / Flash-Lite models are the ones with quota; Pro usually has none.
      const role = err.reason === 'free-tier-no-quota' || task === 'live' || task === 'classify' ? 'fast' : 'quality';
      job = this.findWorkingGeminiModel(r, role).finally(() => this.healing.delete(key));
      this.healing.set(key, job);
    }
    const found = await job;
    if (!found.working) {
      this.healDeadEnd.set(key, { at: Date.now(), tried: found.tried });
      return { healed: null, tried: found.tried };
    }
    // Keep the name meaningful ("Fast · model") and save the repaired choice so it is not repeated.
    const prefix = /^(.*?) · /.exec(r.model.name)?.[1];
    const saved = this.d.repos.saveModel({ ...r.model, name: prefix ? `${prefix} · ${found.working}` : found.working, model: found.working });
    this.d.log.warn('repaired an unusable Gemini model', { was: r.model.model, now: found.working });
    return { healed: { provider: r.provider, model: saved, apiKey: r.apiKey }, tried: found.tried };
  }

  private async findWorkingGeminiModel(r: ResolvedModel, role: 'fast' | 'quality'): Promise<{ working: string | null; tried: string[] }> {
    const listed = await this.listModels(r.provider.id);
    if (!listed.ok) return { working: null, tried: [] };
    const pool = geminiCandidates(listed.models, role).filter((m) => m !== r.model.model).slice(0, HEAL_MAX_PROBES);
    if (pool.length === 0) return { working: null, tried: [] };
    const probe = await this.probeModels(r.provider.id, pool);
    return { working: probe.working, tried: probe.tried.map((t) => t.model) };
  }

  private async runWithRetry(r: ResolvedModel, req: LlmGenerateRequest, progress: { emitted: boolean }, canFailOver: boolean): Promise<LlmGenerateResult> {
    const maxRetries = req.task === 'live' ? 1 : 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(r, req, progress);
      } catch (err) {
        const ai = isAiError(err) ? err : mapNetworkError(err, r.provider);
        this.strike(r, ai);
        // With a fallback to go to, a model that is failing everywhere is not retried again and again.
        const resting = canFailOver && this.isCooling(r);
        const retrying = !(req.signal.aborted || ai.code === 'aborted' || !ai.retryable || progress.emitted || attempt >= maxRetries || resting);
        this.traceFailure(r, req, ai, { attempt: attempt + 1, retrying });
        if (!retrying) throw ai;
        const backoff = req.task === 'live' ? 250 : 600 * 2 ** attempt;
        const wait = Math.min(ai.retryAfterMs ?? backoff, req.task === 'live' ? 1500 : 8000);
        req.onNotice?.('info', `${r.provider.name}: ${ai.code.replace('_', ' ')}. Retrying in ${(wait / 1000).toFixed(1)}s…`);
        await sleep(wait, req.signal);
      }
    }
  }

  private async runOnce(r: ResolvedModel, req: LlmGenerateRequest, progress: { emitted: boolean }): Promise<LlmGenerateResult> {
    const adapter = this.adapters[r.provider.kind];
    const ceiling = r.model.maxTokens > 0 ? r.model.maxTokens : 1024;
    const wanted = req.maxTokens ?? ceiling;
    const chat: ChatRequest = {
      system: req.system,
      user: req.user,
      // A structured reply carries the caller's own budget; a spoken answer is held to the model's cap.
      maxTokens: req.json ? Math.min(wanted, STRUCTURED_TOKEN_CAP) : Math.min(wanted, ceiling),
      temperature: req.temperature ?? r.model.temperature,
      topP: r.model.topP,
      json: req.json,
      schema: req.schema,
      fast: req.task === 'live' || req.task === 'classify',
      minimalReasoning: req.minimalReasoning,
    };
    const wantStream = r.model.streaming && !!req.onToken;

    const attempt = async (stream: boolean): Promise<LlmGenerateResult> => {
      const t0 = performance.now();
      const metaOf = (m: ProviderMetaLike | undefined): LlmReplyMeta => ({ completed: true, ...m, streamed: stream, ms: Math.round(performance.now() - t0), maxTokens: chat.maxTokens });
      // The quick first-token deadline exists so a flaky internet service hands over to the fallback fast. A model on this PC or
      // on the user's own network is slower for honest reasons (a laptop CPU may need seconds to read the prompt), so it is
      // allowed the model's own timeout instead of being cut off and retried.
      const quick = req.task === 'live' && !isLocalUrl(r.provider.baseUrl);
      const guard = new Guard(req.signal, r.model.timeoutMs, quick ? Math.min(this.d.liveFirstTokenMs ?? LIVE_FIRST_TOKEN_MS, r.model.timeoutMs) : r.model.timeoutMs, STALL_MS);
      chat.signal = guard.signal;
      try {
        if (!stream) {
          const out = await adapter.complete(r, chat, this.d.http);
          const done: LlmGenerateResult = { text: out.text, finishReason: out.finishReason, model: r.model.model, provider: r.provider.name, usedFallback: false, meta: metaOf(out.meta) };
          this.traceReply(r, req, chat, done);
          return done;
        }
        let text = '';
        let finishReason: 'stop' | 'length' | 'other' = 'other';
        let providerMeta: ProviderMetaLike | undefined;
        for await (const chunk of adapter.stream(r, chat, this.d.http)) {
          if (chunk.type === 'text') {
            guard.touch();
            progress.emitted = true;
            text += chunk.text;
            req.onToken?.(chunk.text);
          } else {
            finishReason = chunk.finishReason;
            providerMeta = chunk.meta;
          }
        }
        const done: LlmGenerateResult = { text, finishReason, model: r.model.model, provider: r.provider.name, usedFallback: false, meta: metaOf(providerMeta) };
        // A stream that just stops, with no finish reason, is a dropped connection: whatever was shown may be cut off.
        if (done.meta?.completed === false && text) req.onNotice?.('warn', 'The connection ended before the answer was finished, so it may be cut off.');
        this.traceReply(r, req, chat, done);
        return done;
      } catch (err) {
        throw guard.translate(err, r.provider);
      } finally {
        guard.dispose();
      }
    };

    if (!wantStream) return attempt(false);
    try {
      return await attempt(true);
    } catch (err) {
      const ai = isAiError(err) ? err : mapNetworkError(err, r.provider);
      // Streaming-specific trouble (proxy buffering, malformed events) before any text: try a plain response once.
      // (Running out of output space is not a streaming problem: a plain response would hit the same limit.)
      const streamingProblem = (ai.code === 'malformed' && ai.reason !== 'output-limit') || (ai.code === 'network' && !progress.emitted);
      if (progress.emitted || req.signal.aborted || !streamingProblem) throw ai;
      req.onNotice?.('warn', 'Streaming failed — retrying without streaming (the answer will appear all at once).');
      return attempt(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics: sizes, reasons and classes; never keys, prompts or replies */
  /* ------------------------------------------------------------------ */

  private describe(r: ResolvedModel, req: LlmGenerateRequest): Record<string, unknown> {
    return { task: req.task, provider: r.provider.kind, host: hostOf(r.provider.baseUrl), model: r.model.model };
  }

  private traceReply(r: ResolvedModel, req: LlmGenerateRequest, chat: ChatRequest, res: LlmGenerateResult): void {
    const m = res.meta;
    const facts = {
      ...this.describe(r, req),
      streamed: m?.streamed,
      structured: m?.structured,
      reasoning: m?.reasoning,
      maxTokens: chat.maxTokens,
      finish: m?.rawFinishReason ?? res.finishReason,
      completed: m?.completed,
      chars: res.text.length,
      promptTokens: m?.usage?.inputTokens,
      outputTokens: m?.usage?.outputTokens,
      reasoningTokens: m?.usage?.reasoningTokens,
      ms: m?.ms,
      id: m?.responseId,
      adapted: m?.adapted,
    };
    this.d.log.info('model reply', facts);
    aiDebug.record('reply', facts, { system: req.system, user: req.user, reply: res.text });
  }

  private traceFailure(r: ResolvedModel, req: LlmGenerateRequest, err: AiError, o: { attempt: number; retrying: boolean }): void {
    if (err.code === 'aborted') return;
    const facts = { ...this.describe(r, req), code: err.code, status: err.status, reason: err.reason, attempt: o.attempt, retrying: o.retrying, message: err.message.slice(0, 300) };
    this.d.log.warn('model request failed', facts);
    aiDebug.record('error', facts, { system: req.system, user: req.user });
  }

  /* ------------------------------------------------------------------ */
  /* Warm-up                                                             */
  /* ------------------------------------------------------------------ */

  /** Open the connection and prime provider-side prefix caches before the first question. Best effort. */
  async warm(task: 'live', staticPrefix: string): Promise<void> {
    let primary: ResolvedModel | null;
    try {
      primary = this.route(task).primary;
    } catch {
      return;
    }
    if (!primary) return;
    this.d.http.preconnect?.(primary.provider.baseUrl);
    const ac = new AbortController();
    // A cloud service warms in a couple of seconds; a model on your own hardware may need tens of seconds to read the
    // static prefix once (after which every question reuses it), so it is given time to finish.
    const timer = setTimeout(() => ac.abort(), isLocalUrl(primary.provider.baseUrl) ? Math.min(primary.model.timeoutMs, 90_000) : 8000);
    try {
      await this.adapters[primary.provider.kind].complete(
        primary,
        { system: ANSWER_SYSTEM, user: `${staticPrefix}\n\n<question kind="other">Ready.</question>\n<format>Reply with the single word: ok</format>`, maxTokens: 4, temperature: 0, fast: true, signal: ac.signal },
        this.d.http,
      );
    } catch {
      /* warming must never surface errors */
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics used by Settings                                        */
  /* ------------------------------------------------------------------ */

  async listModels(providerId: string, signal?: AbortSignal): Promise<ModelListResult> {
    const provider = this.d.repos.getProvider(providerId);
    if (!provider) return { ok: false, models: [], error: 'Provider not found.' };
    try {
      const listed = await this.adapters[provider.kind].listModels(provider, this.keyFor(provider), this.d.http, signal);
      return Array.isArray(listed) ? { ok: true, models: listed } : { ok: true, models: listed.models, note: listed.note };
    } catch (err) {
      const ai = isAiError(err) ? err : mapNetworkError(err, provider);
      return { ok: false, models: [], error: ai.message };
    }
  }

  /** Send a tiny real request and report measured latency. */
  async testModel(model: ModelConfig): Promise<ConnectionTestResult> {
    const provider = this.d.repos.getProvider(model.providerId);
    if (!provider) return { ok: false, error: { code: 'not_configured', message: 'Provider not found.' } };
    const key = this.keyFor(provider);
    if (!key && !isLocalUrl(provider.baseUrl) && !usesAdc(provider)) return { ok: false, error: { code: 'not_configured', message: 'No API key set for this provider.' } };
    const resolved: ResolvedModel = { provider, model, apiKey: key };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(model.timeoutMs, 20_000));
    const t0 = performance.now();
    try {
      let ttft: number | undefined;
      let n = 0;
      const chat: ChatRequest = { system: 'You are a connectivity check.', user: 'Reply with the single word: ok', maxTokens: 16, temperature: 0, fast: true, signal: ac.signal };
      if (model.streaming) {
        for await (const c of this.adapters[provider.kind].stream(resolved, chat, this.d.http)) {
          if (c.type === 'text' && ttft === undefined) ttft = performance.now() - t0;
          if (c.type === 'text') n++;
        }
      } else {
        await this.adapters[provider.kind].complete(resolved, chat, this.d.http);
      }
      void n;
      return { ok: true, latencyMs: Math.round(ttft ?? performance.now() - t0), model: model.model };
    } catch (err) {
      const ai = isAiError(err) ? err : mapNetworkError(err, provider);
      const timedOut = ac.signal.aborted;
      return { ok: false, error: { code: timedOut ? 'timeout' : ai.code, message: timedOut ? 'The model did not answer in time.' : ai.message } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forget cached Google credentials so the next request re-reads them (after signing in again or changing the project). */
  resetGoogleAuth(): void {
    this.credentials.reset();
  }

  /** Report what Google sign-in found on this PC and what is wrong with it, in plain language. Never includes a token. */
  async checkGoogleAuth(providerId: string): Promise<GoogleAuthStatus> {
    const provider = this.d.repos.getProvider(providerId);
    const now = Date.now();
    if (!provider || provider.kind !== 'google') {
      return { ok: false, mode: 'apiKey', checkedAt: now, problem: { code: 'other', title: 'This provider does not use Google sign-in.', detail: '', steps: [] } };
    }
    const cfg = googleAuthOf(provider);
    if (cfg.mode !== 'adc') {
      const has = !!this.keyFor(provider);
      return { ok: has, mode: 'apiKey', checkedAt: now, problem: has ? undefined : { code: 'other', title: 'No API key is set for this provider.', detail: 'Add one in Edit, or switch this provider to Google sign-in.', steps: [] } };
    }
    if (!isGoogleApiHost(provider.baseUrl)) {
      return { ok: false, mode: 'adc', checkedAt: now, problem: problemFor('refused_host', 'The base URL is not a Google API address.') };
    }
    return this.credentials.status(cfg);
  }

  /** Try candidate models one after another and report the first that answers (skips the rest if sign-in itself is broken). */
  async probeModels(providerId: string, candidates: string[]): Promise<ModelProbeResult> {
    const provider = this.d.repos.getProvider(providerId);
    if (!provider) return { working: null, tried: [] };
    const tried: ModelProbeResult['tried'] = [];
    for (const model of [...new Set(candidates.map((c) => c.trim()).filter(Boolean))].slice(0, 6)) {
      const probe: ModelConfig = { id: 'probe', name: 'probe', providerId, model, temperature: 0, maxTokens: 16, topP: null, timeoutMs: 12_000, streaming: true };
      const r = await this.testModel(probe);
      tried.push({ model, ok: r.ok, message: r.error?.message });
      if (r.ok) return { working: model, tried };
      // Problems with the sign-in, the network or the setup affect every model: do not try five more.
      if (r.error && (r.error.code === 'auth' || r.error.code === 'network' || r.error.code === 'not_configured')) break;
    }
    return { working: null, tried };
  }
}

/* ------------------------------------------------------------------ */
/* Google sign-in and model probing (used by Settings)                 */
/* ------------------------------------------------------------------ */

type ProviderMetaLike = Omit<LlmReplyMeta, 'streamed' | 'ms' | 'maxTokens'>;

/** Only the host, never a path or query: safe to log. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid-url';
  }
}

function describeTask(t: AiTask): string {
  return { live: 'live answers', prep: 'preparation', classify: 'classification', mock: 'mock interviews', embed: 'embeddings' }[t];
}

/**
 * Combines the caller's abort signal with three watchdogs: total time, time to first token and mid-stream
 * stalls. `translate` turns an abort into the right error (timeout vs user cancellation).
 */
class Guard {
  private readonly ac = new AbortController();
  private reason: 'user' | 'total' | 'first-token' | 'stall' | null = null;
  private total: ReturnType<typeof setTimeout>;
  private first: ReturnType<typeof setTimeout> | null;
  private stall: ReturnType<typeof setTimeout> | null = null;
  private readonly onAbort: () => void;

  constructor(
    private readonly parent: AbortSignal,
    totalMs: number,
    firstTokenMs: number,
    private readonly stallMs: number,
  ) {
    this.onAbort = () => {
      this.reason = 'user';
      this.ac.abort();
    };
    parent.addEventListener('abort', this.onAbort, { once: true });
    this.total = setTimeout(() => this.fire('total'), totalMs);
    this.first = setTimeout(() => this.fire('first-token'), firstTokenMs);
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  private fire(reason: 'total' | 'first-token' | 'stall'): void {
    if (this.reason) return;
    this.reason = reason;
    this.ac.abort();
  }

  /** Call whenever data arrives. */
  touch(): void {
    if (this.first) {
      clearTimeout(this.first);
      this.first = null;
    }
    if (this.stall) clearTimeout(this.stall);
    this.stall = setTimeout(() => this.fire('stall'), this.stallMs);
  }

  translate(err: unknown, provider: { name: string; baseUrl?: string }): AiError {
    if (this.reason === 'user') return new AiError('aborted', 'Cancelled', { retryable: false });
    if (this.reason) {
      const name = provider.name;
      const msg = this.reason === 'first-token' ? `${name} did not start answering in time.` : this.reason === 'stall' ? `${name} stopped responding mid-answer.` : `${name} took too long to respond.`;
      return new AiError('timeout', msg, { retryable: true });
    }
    return isAiError(err) ? err : mapNetworkError(err, provider);
  }

  dispose(): void {
    clearTimeout(this.total);
    if (this.first) clearTimeout(this.first);
    if (this.stall) clearTimeout(this.stall);
    this.parent.removeEventListener('abort', this.onAbort);
  }
}
