import type { AiErrorCode } from './types';

export type AiErrorReason = 'free-tier-no-quota' | 'output-limit';

/** Error raised by the AI layer. `message` is always safe to show: it never contains keys or request bodies. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /**
   * Set when the cause is known precisely: Google's free tier gives this model no quota at all (which also proves the project
   * is on the free tier), or a reply was cut off / never started because the output limit (which hidden reasoning shares) ran out.
   */
  readonly reason?: AiErrorReason;

  constructor(code: AiErrorCode, message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number; reason?: AiErrorReason } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.reason = opts.reason;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? (code === 'rate_limit' || code === 'network' || code === 'timeout' || code === 'server');
  }
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AiError');
}

export interface ErrorAdvice {
  title: string;
  detail: string;
  /** Recovery actions the UI can offer. */
  actions: ('open-providers' | 'open-models' | 'retry' | 'switch-fallback' | 'open-stt' | 'open-privacy')[];
}

/** Translate an error code into plain-language advice with recovery actions. */
export function adviceFor(code: string, message?: string): ErrorAdvice {
  switch (code) {
    case 'not_configured':
      return { title: 'No AI model is set up', detail: message || 'Add a provider and choose a model for this task.', actions: ['open-providers', 'open-models'] };
    case 'auth':
      if (/sign-in|gcloud|ADC|organisation|project/i.test(message ?? '')) return { title: 'Google sign-in needs attention', detail: message ?? '', actions: ['open-providers'] };
      return { title: 'The API key was rejected', detail: message || 'Check the key in Settings → AI Providers. It may be invalid, expired or for another provider.', actions: ['open-providers'] };
    case 'rate_limit':
      return { title: 'Rate limit reached', detail: message || 'The provider is throttling requests. A fallback model can take over, or retry shortly.', actions: ['retry', 'switch-fallback', 'open-models'] };
    case 'network':
      if (/on this PC|on your network/.test(message ?? '')) return { title: 'Cannot reach your model server', detail: message ?? '', actions: ['retry', 'open-providers'] };
      return { title: 'Internet connection unavailable', detail: message || 'Cached preparation material stays available. Reconnect and retry.', actions: ['retry'] };
    case 'timeout':
      return { title: 'The model took too long to respond', detail: message || 'Try again, or pick a faster model for live answers.', actions: ['retry', 'open-models'] };
    case 'model_not_found':
      return { title: 'Model not available', detail: message || 'That model name is not offered by this provider. Refresh the model list.', actions: ['open-models'] };
    case 'context_overflow':
      return { title: 'The request was too large', detail: message || 'Shorten the résumé or job description, or choose a model with a larger context window.', actions: ['open-models'] };
    case 'malformed':
      return { title: 'The model returned an unusable reply', detail: message || 'Retry; if it keeps happening, try a different model.', actions: ['retry', 'open-models'] };
    case 'aborted':
      return { title: 'Cancelled', detail: message || '', actions: [] };
    case 'server':
      return { title: 'The provider had a server error', detail: message || 'This is usually temporary. Retry, or use a fallback model.', actions: ['retry', 'switch-fallback'] };
    default:
      return { title: 'Something went wrong', detail: message || 'Unexpected error.', actions: ['retry'] };
  }
}
