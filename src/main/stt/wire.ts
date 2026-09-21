import type { RawData } from 'ws';

/** A WebSocket text frame as a string (ws delivers a Buffer, an ArrayBuffer or an array of fragments). */
export function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
