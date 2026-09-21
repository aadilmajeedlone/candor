import { ZodError } from 'zod';
import { isAiError } from '@shared/errors';
import { log, redact } from '../logging';
import type { Handlers } from './handlers';
import { validators } from './validators';

const l = log('ipc');

/** Error shape sent to the renderer: a message that is safe to display. */
export class IpcError extends Error {
  constructor(
    message: string,
    readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

function summarize(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
    .join('; ');
}

/**
 * Validate a request and run its handler. Used by the Electron registrar and by tests, so the same trust
 * boundary is exercised in both. Errors are converted to short, redacted messages; details go to the log.
 */
export async function dispatch(handlers: Handlers, channel: string, payload: unknown): Promise<unknown> {
  const schema = (validators as Record<string, (typeof validators)[keyof typeof validators]>)[channel];
  const handler = (handlers as Record<string, (req: unknown) => unknown>)[channel];
  if (!schema || !handler) throw new IpcError('Unknown request.', 'unknown_channel');
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    l.warn('rejected invalid request', { channel });
    throw new IpcError(`Invalid request (${summarize(parsed.error)}).`, 'invalid');
  }
  try {
    return await handler(parsed.data);
  } catch (err) {
    if (isAiError(err)) throw new IpcError(err.message, err.code);
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    l.error('handler failed', { channel, name: err instanceof Error ? err.name : typeof err });
    throw new IpcError(redact(message).slice(0, 300), 'error');
  }
}
