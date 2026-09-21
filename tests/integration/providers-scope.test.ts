import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, type App } from '../helpers/appHarness';

/**
 * Free-first provider handling at the app level: where each server runs is shown, plain http is allowed only for
 * this PC and your own network (so a friend's machine over a LAN or Tailscale works), nothing is chosen for the user,
 * and a server that is down produces a message about that server rather than "your internet is down".
 */

let app: App;
beforeAll(() => {
  app = makeApp();
});
afterAll(async () => {
  await app.close();
});

const model = (providerId: string, name: string, modelId: string) => ({ name, providerId, model: modelId, temperature: 0.3, maxTokens: 300, topP: null, timeoutMs: 5000, streaming: true });

describe('provider addresses', () => {
  it('a friend\'s machine on the LAN or over Tailscale works without a key and over plain http', async () => {
    const lan = await app.call('providers.save', { name: "Friend's GPU", kind: 'openai-compatible', baseUrl: 'http://192.168.1.50:8000/v1', enabled: true });
    expect(lan).toMatchObject({ scope: 'private-network', keyOptional: true, keySource: 'none' });
    const ts = await app.call('providers.save', { name: 'Friend (Tailscale)', kind: 'openai-compatible', baseUrl: 'http://100.101.102.103:8000/v1', enabled: true });
    expect(ts.scope).toBe('private-network');
    const magic = await app.call('providers.save', { name: 'Friend (MagicDNS)', kind: 'openai-compatible', baseUrl: 'http://gaming-pc.tail1234.ts.net:8000/v1', enabled: true });
    expect(magic.scope).toBe('private-network');
    for (const p of [lan, ts, magic]) await app.call('providers.delete', { id: p.id });
  });

  it('a server on the internet must use https, and the message says what to do instead', async () => {
    await expect(app.call('providers.save', { name: 'x', kind: 'openai-compatible', baseUrl: 'http://203.0.113.5:8000/v1', enabled: true })).rejects.toThrow(/https:\/\/.*your own network.*Tailscale.*Cloudflare Tunnel or ngrok/s);
    const tunnel = await app.call('providers.save', { name: 'Friend (tunnel)', kind: 'openai-compatible', baseUrl: 'https://random-words.trycloudflare.com/v1', enabled: true, apiKey: 'friend-shared-token-1234' });
    expect(tunnel).toMatchObject({ scope: 'internet', keyOptional: false, keySource: 'stored' });
    expect(JSON.stringify(tunnel)).not.toContain('friend-shared-token');
    await app.call('providers.delete', { id: tunnel.id });
  });

  it('an internet service without a key is refused when it is used, never silently', async () => {
    const p = await app.call('providers.save', { name: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', enabled: true });
    expect(p.keyOptional).toBe(false);
    const m = await app.call('models.save', model(p.id, 'cloud model', 'some-model'));
    const t = await app.call('models.test', { id: m.id });
    expect(t).toMatchObject({ ok: false, error: { code: 'not_configured' } });
    await app.call('providers.delete', { id: p.id });
  });
});

describe('"what is answering" is always visible', () => {
  it('starts empty and says why, with the free on-device speech engine as the default', async () => {
    const a = await app.call('app.activeProviders');
    expect(a.live).toMatchObject({ primary: null, fallback: null });
    expect(a.live.problem).toMatch(/No model is set up/);
    expect(a.speech).toMatchObject({ provider: 'local', label: 'On this PC', scope: 'this-pc' });
  });

  it('shows the configured model, where it runs, and a fallback only because it was configured', async () => {
    const local = await app.call('providers.save', { name: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', enabled: true });
    const friend = await app.call('providers.save', { name: "Friend's GPU", kind: 'openai-compatible', baseUrl: 'http://192.168.1.50:8000/v1', enabled: true });
    const a = await app.call('models.save', model(local.id, 'Local · llama3.2', 'llama3.2'));
    const b = await app.call('models.save', model(friend.id, 'Friend · qwen', 'qwen2.5-32b-instruct'));
    await app.call('settings.update', { routing: { live: { primary: b.id, fallback: null }, prep: { primary: a.id, fallback: null } } });

    let active = await app.call('app.activeProviders');
    expect(active.live.primary).toEqual({ provider: "Friend's GPU", model: 'qwen2.5-32b-instruct', scope: 'private-network', kind: 'openai-compatible' });
    expect(active.live.fallback).toBeNull(); // nothing is added on the user's behalf
    expect(active.prep.primary).toMatchObject({ provider: 'Ollama', scope: 'this-pc' });

    await app.call('settings.update', { routing: { live: { primary: b.id, fallback: a.id } } });
    active = await app.call('app.activeProviders');
    expect(active.live.fallback).toMatchObject({ provider: 'Ollama', model: 'llama3.2', scope: 'this-pc' });

    await app.call('settings.update', { stt: { provider: 'deepgram' } });
    expect((await app.call('app.activeProviders')).speech).toMatchObject({ provider: 'deepgram', label: 'Deepgram', scope: 'internet' });
    await app.call('settings.update', { stt: { provider: 'local' }, routing: { live: { primary: null, fallback: null }, prep: { primary: null, fallback: null } } });
    await app.call('providers.delete', { id: local.id });
    await app.call('providers.delete', { id: friend.id });
  });

  it('a route that cannot work says why instead of hiding it', async () => {
    const cloud = await app.call('providers.save', { name: 'Paid cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', enabled: true });
    const m = await app.call('models.save', model(cloud.id, 'cloud', 'big-model'));
    await app.call('settings.update', { routing: { live: { primary: m.id, fallback: null } } });
    const active = await app.call('app.activeProviders');
    expect(active.live.primary).toBeNull();
    expect(active.live.problem).toMatch(/No API key is set for “Paid cloud”/);
    await app.call('settings.update', { routing: { live: { primary: null, fallback: null } } });
    await app.call('providers.delete', { id: cloud.id });
  });
});

describe('a model server that is down', () => {
  async function closedPort(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
  }

  it('Test & fetch models says the server is not running — not that the internet is down', async () => {
    const port = await closedPort();
    const p = await app.call('providers.save', { name: 'Ollama', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true });
    const r = await app.call('providers.listModels', { id: p.id });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Could not connect to Ollama on this PC\. Is it running\?/);
    expect(r.error).not.toMatch(/Internet/i);
    await app.call('providers.delete', { id: p.id });
  });

  it('the Live Model Test reports it the same way, with the error code the interface acts on', async () => {
    const port = await closedPort();
    const p = await app.call('providers.save', { name: 'Ollama', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true });
    const m = await app.call('models.save', model(p.id, 'local', 'llama3.2'));
    const t = await app.call('models.test', { id: m.id });
    expect(t.ok).toBe(false);
    expect(t.error?.code).toBe('network');
    expect(t.error?.message).toMatch(/on this PC/);
    await app.call('providers.delete', { id: p.id });
  });
});
