import { endpointScope } from '@shared/net';
import { AiError } from '@shared/errors';
import { redact } from '../logging';

interface ParsedBody {
  message: string;
  code?: string;
  param?: string;
  type?: string;
}

/** Pull a human message out of the different provider error envelopes. */
export function parseErrorBody(text: string): ParsedBody {
  let message = text.trim().slice(0, 400);
  let code: string | undefined;
  let param: string | undefined;
  let type: string | undefined;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = (j.error ?? j) as Record<string, unknown>;
    if (typeof e === 'object' && e) {
      if (typeof e.message === 'string') message = e.message;
      if (typeof e.code === 'string' || typeof e.code === 'number') code = String(e.code);
      if (typeof e.param === 'string') param = e.param;
      if (typeof e.type === 'string') type = e.type;
      if (typeof e.status === 'string' && !code) code = e.status;
    }
  } catch {
    /* not JSON */
  }
  return { message: redact(message).slice(0, 300), code, param, type };
}

/**
 * A refusal that names the model's OUTPUT limit ("supports at most 4096 completion tokens", "max output tokens ... exceeds
 * the model's limit (8192)"): the largest number in the message that is below what was asked for. Null when the message is
 * not about output tokens (a context-length error, say), so an unrelated 400 never lowers a limit.
 */
export function outputCapFrom(message: string, asked: number): number | null {
  if (!/max(?:imum)?[_ ]?(?:output|completion)?[_ ]?tokens|(?:output|completion) tokens/i.test(message)) return null;
  if (/context (?:length|window)/i.test(message) && !/(?:output|completion) tokens|max_tokens/i.test(message)) return null;
  const numbers = [...message.matchAll(/\d[\d,]{2,6}/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => n >= 256 && n < asked);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Map an HTTP failure to a typed, user-safe AiError. */
export function mapHttpError(status: number, bodyText: string, retryAfter: string | null, providerName = 'The provider'): AiError {
  const b = parseErrorBody(bodyText);
  const m = b.message.toLowerCase();
  const detail = b.message ? ` (${b.message})` : '';
  if (status === 401 || status === 403) {
    return new AiError('auth', `${providerName} rejected the API key${detail}`, { status, retryable: false });
  }
  if (status === 404) {
    if (/model/.test(m)) return new AiError('model_not_found', `${providerName} does not offer this model${detail}`, { status, retryable: false });
    return new AiError('bad_request', `${providerName} returned "not found". Check the base URL${detail}`, { status, retryable: false });
  }
  if (status === 408) return new AiError('timeout', `${providerName} timed out`, { status });
  if (status === 413) return new AiError('context_overflow', `The request was too large for ${providerName}`, { status, retryable: false });
  if (status === 429) {
    const quota = /quota|billing|insufficient|credit/.test(m) || b.code === 'insufficient_quota';
    return new AiError('rate_limit', quota ? `${providerName} reports the account is out of quota or credit${detail}` : `${providerName} is rate limiting requests${detail}`, {
      status,
      retryable: !quota,
      retryAfterMs: parseRetryAfter(retryAfter),
    });
  }
  if (status === 400 || status === 422) {
    if (/context|too many tokens|prompt is too long|maximum.*length|token limit/.test(m)) {
      return new AiError('context_overflow', `The request is longer than this model's context window${detail}`, { status, retryable: false });
    }
    if (/model.*(not found|does not exist|not supported|unavailable)|not_found_error/.test(m)) {
      return new AiError('model_not_found', `${providerName} does not offer this model${detail}`, { status, retryable: false });
    }
    return new AiError('bad_request', `${providerName} rejected the request${detail}`, { status, retryable: false });
  }
  if (status >= 500) {
    return new AiError('server', `${providerName} had a server error (${status})${detail}`, { status, retryAfterMs: parseRetryAfter(retryAfter) });
  }
  return new AiError('unknown', `${providerName} returned HTTP ${status}${detail}`, { status, retryable: false });
}

/** Wrap fetch-level failures (DNS, connection reset, offline). */
/**
 * Turn a failed connection into a message that fits where the server is: a model on this PC or on the user's own
 * network is "not running / not reachable", not "the internet is down".
 */
export function mapNetworkError(err: unknown, provider: string | { name: string; baseUrl?: string } = 'The provider'): AiError {
  const providerName = typeof provider === 'string' ? provider : provider.name;
  const scope = typeof provider === 'string' || !provider.baseUrl ? 'internet' : endpointScope(provider.baseUrl);
  if (err instanceof AiError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError') return new AiError('aborted', 'Cancelled', { retryable: false });
  const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|fetch failed|Failed to fetch|net::/i.test(`${cause} ${msg}`)) {
    if (scope === 'this-pc') {
      return new AiError('network', `Could not connect to ${providerName} on this PC. Is it running? For Ollama, start the Ollama app; for LM Studio or llama.cpp, start the local server. Then try again.`, { retryable: true });
    }
    if (scope === 'private-network') {
      return new AiError('network', `Could not reach ${providerName} on your network. Check that the machine is on, its server is running, the address and port are right, and this PC is on the same network or VPN.`, { retryable: true });
    }
    return new AiError('network', `Internet connection unavailable — could not reach ${providerName}.`, { retryable: true });
  }
  return new AiError('network', `Could not reach ${providerName}: ${redact(msg).slice(0, 160)}`, { retryable: true });
}
