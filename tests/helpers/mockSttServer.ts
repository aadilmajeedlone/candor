import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { rawToString } from '../../src/main/stt/wire';

export interface SttConn {
  ws: WebSocket;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  audioBytes: number;
  audioMessages: number;
  controls: string[];
  closed: boolean;
}

/** WebSocket server that mimics the Deepgram / AssemblyAI streaming wire formats. */
export class MockSttServer {
  private http: Server;
  private wss: WebSocketServer;
  readonly conns: SttConn[] = [];
  port = 0;
  /** Reject the upgrade with this status (e.g. 401). */
  rejectStatus: number | null = null;
  /** Reject only the first N connection attempts (with `rejectStatus`, default 500). */
  rejectFirst = 0;
  onConn: ((c: SttConn) => void) | null = null;

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      if (this.rejectStatus !== null || this.rejectFirst > 0) {
        const status = this.rejectStatus ?? 500;
        if (this.rejectFirst > 0) this.rejectFirst--;
        socket.write(`HTTP/1.1 ${status} Nope\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const c: SttConn = { ws, url: req.url ?? '', headers: req.headers, audioBytes: 0, audioMessages: 0, controls: [], closed: false };
        this.conns.push(c);
        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            c.audioBytes += (data as Buffer).byteLength;
            c.audioMessages++;
          } else c.controls.push(rawToString(data));
        });
        ws.on('close', () => (c.closed = true));
        this.onConn?.(c);
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  reset(): void {
    for (const c of this.conns) c.ws.terminate();
    this.conns.length = 0;
    this.rejectStatus = null;
    this.rejectFirst = 0;
    this.onConn = null;
  }

  get dgUrl(): string {
    return `ws://127.0.0.1:${this.port}/v1/listen`;
  }
  get aaiUrl(): string {
    return `ws://127.0.0.1:${this.port}/v3/ws`;
  }

  /** Send a Deepgram "Results" message. */
  dgResult(c: SttConn, text: string, o: { final?: boolean; speechFinal?: boolean; speaker?: number } = {}): void {
    c.ws.send(
      JSON.stringify({
        type: 'Results',
        is_final: !!o.final,
        speech_final: !!o.speechFinal,
        channel: { alternatives: [{ transcript: text, confidence: 0.98, words: o.speaker !== undefined ? [{ speaker: o.speaker }] : [] }] },
      }),
    );
  }

  aaiTurn(c: SttConn, text: string, o: { endOfTurn?: boolean; formatted?: boolean } = {}): void {
    c.ws.send(JSON.stringify({ type: 'Turn', transcript: text, end_of_turn: !!o.endOfTurn, turn_is_formatted: !!o.formatted, end_of_turn_confidence: 0.8 }));
  }

  async waitConn(n = 1, ms = 3000): Promise<SttConn> {
    const t0 = Date.now();
    while (this.conns.length < n) {
      if (Date.now() - t0 > ms) throw new Error(`no connection #${n} within ${ms}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.conns[n - 1];
  }
}
