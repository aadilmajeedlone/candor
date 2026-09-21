import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type TokenMode = 'ok' | 'invalid_grant' | 'invalid_client' | 'server_error';

/** A stand-in for https://oauth2.googleapis.com/token, so Google's real auth library can be exercised offline. */
export class MockTokenServer {
  private server: Server;
  port = 0;
  mode: TokenMode = 'ok';
  token = 'ya29.mock-access-token-0001';
  expiresInSeconds = 3600;
  /** Raw request bodies received (they contain the client secret and refresh token: tests must never echo them). */
  readonly bodies: string[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.bodies.push(Buffer.concat(chunks).toString('utf8'));
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (this.mode === 'invalid_grant') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        if (this.mode === 'invalid_client') return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        if (this.mode === 'server_error') return json(503, { error: 'backend_error' });
        json(200, { access_token: this.token, expires_in: this.expiresInSeconds, token_type: 'Bearer' });
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/token`;
  }
}
