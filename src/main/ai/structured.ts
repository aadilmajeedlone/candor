import { z } from 'zod';
import { AiError, isAiError } from '@shared/errors';
import type { LlmGateway, LlmGenerateResult } from '@core/live/types';
import { log } from '../logging';
import { aiDebug } from './diagnostics';
import { extractJson, extractJsonObjects, type Salvage } from './jsonExtract';
import type { JsonSchema } from './schema';

/** Kept for callers that only need "the first JSON object in this text". */
export { extractJson };

const jlog = log('json');

/** A retry may raise the output budget, but never past this. */
const RETRY_TOKEN_CAP = 8192;

/** Added to the retry of a reply that could not be read. */
const BE_VALID = 'Your previous reply could not be read. Reply with one complete, valid JSON object and nothing else: no markdown fences, no commentary.';
/** Added to the retry of a reply that was cut off when the budget cannot grow any further. */
const BE_BRIEF = 'Your previous reply was cut off. Keep every text field to one or two short sentences and every list short, and finish the JSON object.';

export interface JsonRequest<T> {
  task: 'prep' | 'classify' | 'mock' | 'live';
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
  onNotice?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** The same shape as `schema`, as JSON Schema. Providers that can enforce a schema do, so the reply cannot be malformed. */
  jsonSchema?: JsonSchema;
  /** Keys that must be present for a reply that stopped early to count as complete (a reply that lacks only its closing brace is accepted). */
  requiredKeys?: string[];
  /** A shorter version of the request, used after a reply was cut off or unusable, instead of repeating the same request. */
  compact?: { system: string; user?: string; maxTokens?: number };
  /**
   * Last resort, only where the data contract allows it. `build` is first called with an empty text and whatever earlier
   * replies wrote completely (`salvaged`): if that is already enough it returns the value and no further request is made;
   * otherwise it returns null, a plain-text request (no JSON) is made, and `build` is called again with that text.
   * Return null to give up.
   */
  plainFallback?: { system: string; user: string; maxTokens: number; build: (text: string, salvaged: Record<string, unknown> | null) => T | null };
}

export interface JsonResult<T> {
  value: T;
  model: string;
  /** How the value was obtained: the first reply, a second (shorter) request, or built by the caller from what replies wrote in full ('partial'). */
  path: 'first' | 'retry' | 'partial';
  attempts: number;
}

type FailureKind = 'truncated' | 'empty' | 'no-json' | 'invalid' | 'schema';
type Outcome<T> = { ok: true; value: T } | { ok: false; kind: FailureKind; detail: string; truncated: boolean; salvage?: Salvage };

function issues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Turn a reply into a validated value, or say precisely why not. A reply is judged by how it ended as well as by what it
 * says: the provider's finish reason ("length" = the output limit was reached) and whether a stream finished at all.
 */
function interpret<T>(reply: LlmGenerateResult, req: JsonRequest<T>): Outcome<T> {
  const cutByProvider = reply.finishReason === 'length' || reply.meta?.completed === false;
  const ex = extractJsonObjects(reply.text);

  let schemaProblem: string | undefined;
  for (const obj of ex.objects) {
    const parsed = req.schema.safeParse(obj.value);
    if (parsed.success) return { ok: true, value: parsed.data };
    schemaProblem ??= issues(parsed.error);
  }
  if (ex.objects.length > 0) return { ok: false, kind: 'schema', detail: schemaProblem ?? 'the reply did not have the expected fields', truncated: false };

  // Nothing closed. A reply that lacks only its final brace — every required value written in full — is still complete.
  const s = ex.salvage;
  if (s && req.requiredKeys?.length && req.requiredKeys.every((k) => s.completeKeys.includes(k))) {
    const parsed = req.schema.safeParse(s.value);
    if (parsed.success) return { ok: true, value: parsed.data };
  }

  // "Truncated" means the text ran out: the provider said so, the stream never finished, or the model stopped mid-object.
  const truncated = cutByProvider || (ex.truncated && reply.finishReason !== 'stop');
  const kind: FailureKind = truncated ? 'truncated' : ex.truncated ? 'invalid' : (ex.failure ?? 'invalid');
  return { ok: false, kind, detail: ex.detail, truncated, salvage: s };
}

/** Values that earlier replies wrote in full, combined. Nothing is invented: a value is either there or it is not. */
function mergeSalvage(...parts: (Salvage | undefined)[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    if (!p) continue;
    for (const k of p.completeKeys) if (!(k in out)) out[k] = p.value[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function ask<T>(gw: LlmGateway, req: JsonRequest<T>, q: { system: string; user: string; maxTokens: number; temperature: number; schema: boolean }): Promise<LlmGenerateResult> {
  try {
    return await gw.generate({
      task: req.task,
      system: q.system,
      user: q.user,
      maxTokens: q.maxTokens,
      temperature: q.temperature,
      signal: req.signal,
      onNotice: req.onNotice,
      json: true,
      schema: q.schema ? req.jsonSchema : undefined,
      minimalReasoning: true,
    });
  } catch (err) {
    // The provider used its whole output limit before writing a visible reply. That is a cut-off reply like any other,
    // to be handled below, not a failure to reach the model.
    if (isAiError(err) && err.reason === 'output-limit') return { text: '', finishReason: 'length', model: 'unknown', provider: 'unknown', usedFallback: false };
    // An empty or unreadable reply is an unusable reply: it gets one different request, like any other.
    if (isAiError(err) && err.code === 'malformed') return { text: '', finishReason: 'other', model: 'unknown', provider: 'unknown', usedFallback: false };
    throw err;
  }
}

function record<T>(req: JsonRequest<T>, reply: LlmGenerateResult, attempt: number, outcome: Outcome<T>): void {
  const facts = {
    task: req.task,
    model: reply.model,
    attempt,
    finish: reply.meta?.rawFinishReason ?? reply.finishReason,
    completed: reply.meta?.completed,
    chars: reply.text.length,
    outcome: outcome.ok ? 'ok' : outcome.kind,
    truncated: outcome.ok ? false : outcome.truncated,
    detail: outcome.ok ? undefined : outcome.detail.slice(0, 200),
  };
  if (outcome.ok) jlog.info('structured reply accepted', facts);
  else jlog.warn('structured reply not usable', facts);
  aiDebug.record('parse', facts);
}

/**
 * Ask for JSON, validate it against a schema, and change the request if the first reply cannot be used.
 *
 *  1. One request with the provider's native structured output where it has one, the caller's own output budget, and
 *     hidden reasoning kept small. Most replies are accepted here, with no further model call.
 *  2. A reply is read tolerantly (fences, surrounding prose, punctuation slips, a missing closing brace) before it is
 *     judged. Only a reply that still cannot be used costs a second request.
 *  3. The second request is different from the first: shorter, and with a larger budget if the reply was cut off. Asking
 *     the same thing again with the same limit would be cut off at the same place.
 *  4. If the caller allows it, a last plain-text request supplies the main text and the rest is built from what earlier
 *     replies wrote in full.
 *
 * At most two requests are made in the ordinary failure case (three with a plain-text fallback), and the error that
 * finally reaches the person says what actually happened.
 */
export async function generateJson<T>(gw: LlmGateway, req: JsonRequest<T>): Promise<JsonResult<T>> {
  const budget = req.maxTokens ?? 2000;
  const temperature = req.temperature ?? 0.2;

  const first = await ask(gw, req, { system: req.system, user: req.user, maxTokens: budget, temperature, schema: true });
  const o1 = interpret(first, req);
  record(req, first, 1, o1);
  if (o1.ok) return { value: o1.value, model: first.model, path: 'first', attempts: 1 };

  // The first reply cannot be used. Say what happened, then ask a different question. Brevity is only requested when the
  // caller offers a compact form (About me): for extraction, a shorter reply would be a worse one. A cut-off reply is given
  // more room; an unreadable one gets a stricter reminder. The native schema that just failed to produce a usable reply is
  // not repeated: plain JSON mode is used instead.
  const c = req.compact;
  const grows = o1.truncated && budget < RETRY_TOKEN_CAP;
  req.onNotice?.(
    'info',
    o1.truncated
      ? c
        ? 'The model’s reply was cut off, so Candor is asking again with a shorter format.'
        : 'The model’s reply was cut off, so Candor is asking again with more room.'
      : 'The model’s reply could not be read as the expected data, so Candor is asking again, more strictly.',
  );
  const second = await ask(gw, req, {
    system: c?.system ?? (o1.truncated ? (grows ? req.system : `${req.system}\n\n${BE_BRIEF}`) : `${req.system}\n\n${BE_VALID}`),
    user: c?.user ?? req.user,
    maxTokens: c?.maxTokens ?? (grows ? Math.min(budget * 2, RETRY_TOKEN_CAP) : budget),
    temperature: o1.truncated ? temperature : 0,
    schema: false,
  });
  const o2 = interpret(second, req);
  record(req, second, 2, o2);
  if (o2.ok) return { value: o2.value, model: second.model, path: 'retry', attempts: 2 };

  // Two partial replies may still add up to a whole one: each value that was written in full is kept, none is invented.
  const salvaged = mergeSalvage(o1.salvage, o2.salvage);
  if (salvaged && req.requiredKeys?.length && req.requiredKeys.every((k) => k in salvaged)) {
    const parsed = req.schema.safeParse(salvaged);
    if (parsed.success) {
      jlog.info('structured reply assembled from two partial replies', { task: req.task, model: second.model, keys: Object.keys(salvaged).length });
      return { value: parsed.data, model: second.model, path: 'retry', attempts: 2 };
    }
  }

  const pf = req.plainFallback;
  if (pf) {
    // What earlier replies wrote in full may already be enough: then there is nothing more to ask.
    const enough = salvaged ? pf.build('', salvaged) : null;
    if (enough !== null) {
      jlog.info('structured reply completed from what earlier replies wrote in full', { task: req.task, model: second.model, keys: Object.keys(salvaged ?? {}).length });
      return { value: enough, model: second.model, path: 'partial', attempts: 2 };
    }
    req.onNotice?.('info', 'The model could not finish the structured reply, so Candor is asking for the main text on its own.');
    try {
      const plain = await gw.generate({ task: req.task, system: pf.system, user: pf.user, maxTokens: pf.maxTokens, temperature: 0.3, signal: req.signal, onNotice: req.onNotice });
      const value = pf.build(plain.text, salvaged);
      jlog.info('plain-text fallback', { task: req.task, model: plain.model, chars: plain.text.length, built: value !== null });
      if (value !== null) return { value, model: plain.model, path: 'partial', attempts: 3 };
    } catch (err) {
      if (!isAiError(err) || (err.code !== 'malformed' && err.code !== 'timeout' && err.code !== 'server')) throw err;
      jlog.warn('plain-text fallback failed', { task: req.task, code: err.code });
    }
  }

  const cut = o1.truncated || o2.truncated;
  throw new AiError(
    'malformed',
    cut
      ? 'The model’s reply was cut off before it was finished, and so was a shorter second attempt. The model may be running out of output space for this: try again, or choose a model with a larger output limit in Settings → Models.'
      : o2.kind === 'empty'
        ? 'The model returned an empty reply twice. Try again or choose a different model.'
        : `The model’s replies could not be read as the expected data (${o2.detail}). Try again or choose a different model.`,
    { retryable: false, reason: cut ? 'output-limit' : undefined },
  );
}
