import WebSocket from 'ws';
import type { SttConfig, SttEvents, SttProvider, SttState, SttStream } from './types';
import { rawToString } from './wire';

const DEFAULT_URL = 'wss://api.deepgram.com/v1/listen';
/** Deepgram closes idle sockets after ~10 s without audio or KeepAlive. */
const KEEPALIVE_MS = 5000;

interface DgResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number; words?: { speaker?: number }[] }[] };
}

export function deepgramUrl(cfg: SttConfig): string {
  const q = new URLSearchParams({
    model: cfg.model || 'nova-3',
    language: cfg.language || 'en',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: String(Math.max(10, Math.round(cfg.endpointingMs))),
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  if (cfg.diarize) q.set('diarize', 'true');
  return `${cfg.baseUrl ?? DEFAULT_URL}?${q.toString()}`;
}

class DeepgramStream implements SttStream {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lastSend = 0;
  private closedByUs = false;
  state: SttState = 'connecting';

  constructor(
    private readonly cfg: SttConfig,
    private readonly key: string,
    private readonly ev: SttEvents,
  ) {
    this.connect();
  }

  private set(state: SttState, message?: string, fatal = false): void {
    this.state = state;
    this.ev.onState(state, message, fatal);
  }

  private connect(): void {
    const ws = new WebSocket(deepgramUrl(this.cfg), { headers: { Authorization: `Token ${this.key}` }, handshakeTimeout: 8000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.set('connected');
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastSend > KEEPALIVE_MS - 500) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEPALIVE_MS);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m: DgResult;
      try {
        m = JSON.parse(rawToString(data)) as DgResult;
      } catch {
        return;
      }
      if (m.type === 'Results') {
        const alt = m.channel?.alternatives?.[0];
        const text = (alt?.transcript ?? '').trim();
        const speakers = (alt?.words ?? []).map((w) => w.speaker).filter((s): s is number => typeof s === 'number');
        const speaker = speakers.length ? mode(speakers) : undefined;
        const isFinal = !!m.is_final;
        const speechFinal = !!m.speech_final;
        if (text || speechFinal) this.ev.onTranscript({ text, isFinal, speechFinal, confidence: alt?.confidence, speaker });
      } else if (m.type === 'UtteranceEnd') {
        this.ev.onTranscript({ text: '', isFinal: true, speechFinal: true });
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode ?? 0;
      const auth = code === 401 || code === 403;
      // Permanent client errors will not fix themselves; 5xx / 408 / 429 are worth retrying.
      const fatal = auth || (code >= 400 && code < 500 && code !== 408 && code !== 429);
      this.set('error', auth ? 'Deepgram rejected the API key.' : `Deepgram returned HTTP ${code}.`, fatal);
      res.resume();
    });
    ws.on('error', (err) => {
      if (this.state !== 'error') this.set('error', `Deepgram connection error: ${err.message.slice(0, 120)}`, false);
    });
    ws.on('close', () => {
      this.stopKeepAlive();
      if (this.closedByUs) this.set('closed');
      else if (this.state !== 'error') this.set('error', 'Deepgram closed the connection.', false);
    });
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastSend = Date.now();
    this.ws.send(pcm);
  }

  finalize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'Finalize' }));
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.stopKeepAlive();
    const ws = this.ws;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
    } catch {
      /* socket already gone */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 800);
      ws.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

function mode(nums: number[]): number {
  const c = new Map<number, number>();
  for (const n of nums) c.set(n, (c.get(n) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export const deepgram: SttProvider = {
  id: 'deepgram',
  label: 'Deepgram',
  needsKey: true,
  open: (cfg, key, events) => new DeepgramStream(cfg, key, events),
};
