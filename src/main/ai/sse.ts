import { AiError } from '@shared/errors';

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. Handles chunk boundaries anywhere (including inside a UTF-8
 * sequence or between "\r" and "\n"), multi-line data fields and comment lines. Cancels the underlying
 * stream when the consumer stops early so the connection is released immediately.
 */
/** Parse one SSE data payload as a JSON object; anything else is a malformed stream from the provider. */
export function parseEventJson<T extends object>(data: string, provider: string): T {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new AiError('malformed', `${provider} sent a malformed stream event.`);
  }
  if (typeof value !== 'object' || value === null) throw new AiError('malformed', `${provider} sent a malformed stream event.`);
  return value as T;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // A trailing "\r" may be the first half of "\r\n": keep it for the next chunk.
      const hold = buf.endsWith('\r') ? '\r' : '';
      if (hold) buf = buf.slice(0, -1);
      buf = buf.replace(/\r\n?/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEvent(raw);
        if (ev) yield ev;
      }
      buf += hold;
    }
    buf += decoder.decode();
    buf = buf.replace(/\r\n?/g, '\n');
    if (buf.trim()) {
      const ev = parseEvent(buf);
      if (ev) yield ev;
    }
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function parseEvent(raw: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join('\n') };
}
