import { Db } from '../../src/main/db/database';
import { Repos } from '../../src/main/db/repos';
import { AiGateway, type GatewayDeps } from '../../src/main/ai/gateway';
import type { HttpClient } from '../../src/main/ai/types';
import { SecretStore, type Cipher } from '../../src/main/security/secrets';
import { log } from '../../src/main/logging';
import type { AiTask, ModelConfig, ProviderConfig, ProviderKind } from '../../src/shared/types';

/** Reversible fake cipher: proves ciphertext at rest differs from the key without needing Electron. */
export const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(`enc:${Buffer.from(p).reverse().toString('base64')}`),
  decrypt: (b) => Buffer.from(Buffer.from(b.toString().replace(/^enc:/, ''), 'base64')).reverse().toString(),
};

export const nodeHttp: HttpClient = { fetch: (url, init) => fetch(url, init) };

export function makeHarness(env: NodeJS.ProcessEnv = {}, gatewayOpts: Partial<GatewayDeps> = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const secrets = new SecretStore(db, fakeCipher, env);
  const gateway = new AiGateway({ repos, secrets, http: nodeHttp, log: log('test'), ...gatewayOpts });

  function addProvider(kind: ProviderKind, baseUrl: string, apiKey: string | null, name: string = kind): ProviderConfig {
    const p = repos.saveProvider({ name, kind, baseUrl, enabled: true });
    if (apiKey) secrets.set(`provider.${p.id}`, apiKey);
    return p;
  }

  function addModel(provider: ProviderConfig, model: string, over: Partial<ModelConfig> = {}): ModelConfig {
    return repos.saveModel({ name: model, providerId: provider.id, model, temperature: 0.4, maxTokens: 800, topP: null, timeoutMs: 5000, streaming: true, ...over });
  }

  function route(task: AiTask, primary: ModelConfig | null, fallback: ModelConfig | null = null): void {
    repos.updateSettings({ routing: { [task]: { primary: primary?.id ?? null, fallback: fallback?.id ?? null } } });
  }

  return { db, repos, secrets, gateway, addProvider, addModel, route };
}
