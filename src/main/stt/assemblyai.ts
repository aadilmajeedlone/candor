import WebSocket from 'ws';
import type { SttConfig, SttEvents, SttProvider, SttState, SttStream } from './types';
import { rawToString } from './wire';

const DEFAULT_URL = 'wss://streaming.assemblyai.com/v3/ws';
/** AssemblyAI requires each audio message to be 50–1000 ms; batch our 20–40 ms frames to 100 ms. */
const BATCH_BYTES = 3200;

interface AaiMessage {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  end_of_turn_confidence?: number;
  error?: string;
}

export function assemblyUrl(cfg: SttConfig, tuned: boolean): string {
  const q = new URLSearchParams({ sample_rate: '16000', encoding: 'pcm_s16le', format_turns: 'true' });
  if (tuned) {
    q.set('end_of_turn_confidence_threshold', '0.6');
    q.set('min_end_of_turn_silence_when_confident', String(Math.max(100, Math.round(cfg.endpointingMs))));
  }
  return `${cfg.baseUrl ?? DEFAULT_URL}?${q.toString()}`;
}

class AssemblyStream implements SttStream {
  private ws: WebSocket | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private closedByUs = false;
  private tunedFailed = false;
  state: SttState = 'connecting';

  constructor(
    private readonly cfg: SttConfig,
    private readonly key: string,
    private readonly ev: SttEvents,
  ) {
    this.connect(true);
  }

  private set(state: SttState, message?: string, fatal = false): void {
    this.state = state;
    this.ev.onState(state, message, fatal);
  }

  private connect(tuned: boolean): void {
    const ws = new WebSocket(assemblyUrl(this.cfg, tuned), { headers: { Authorization: this.key }, handshakeTimeout: 8000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => this.set('connected'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m: AaiMessage;
      try {
        m = JSON.parse(rawToString(data)) as AaiMessage;
      } catch {
        return;
      }
      if (m.type === 'Turn') {
        const text = (m.transcript ?? '').trim();
        if (!text) return;
        if (m.end_of_turn && m.turn_is_formatted) this.ev.onTranscript({ text, isFinal: true, speechFinal: true, confidence: m.end_of_turn_confidence });
        else this.ev.onTranscript({ text, isFinal: false, speechFinal: false, confidence: m.end_of_turn_confidence });
      } else if (m.type === 'Error' || m.error) {
        this.set('error', `AssemblyAI: ${(m.error ?? 'error').slice(0, 120)}`, false);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) this.set('error', 'AssemblyAI rejected the API key.', true);
      else if (tuned && !this.tunedFailed && res.statusCode === 400) {
        // Endpointing parameters not accepted by this API version: retry with the base parameters.
        this.tunedFailed = true;
        this.connect(false);
      } else this.set('error', `AssemblyAI returned HTTP ${res.statusCode}.`, false);
    });
    ws.on('error', (err) => {
      if (this.state !== 'error' && !this.tunedFailed) this.set('error', `AssemblyAI connection error: ${err.message.slice(0, 120)}`, false);
    });
    ws.on('close', () => {
      if (this.closedByUs) this.set('closed');
      else if (this.state !== 'error' && this.ws === ws) this.set('error', 'AssemblyAI closed the connection.', false);
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    if (this.pendingBytes >= BATCH_BYTES) this.flush();
  }

  private flush(): void {
    if (this.pendingBytes === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(this.pendingBytes);
    let o = 0;
    for (const p of this.pending) {
      out.set(p, o);
      o += p.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.ws.send(out);
  }

  finalize(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.flush();
    this.ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    const ws = this.ws;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' }));
    } catch {
      /* already closed */
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

export const assemblyai: SttProvider = {
  id: 'assemblyai',
  needsKey: true,
  label: 'AssemblyAI',
  open: (cfg, key, events) => new AssemblyStream(cfg, key, events),
};
