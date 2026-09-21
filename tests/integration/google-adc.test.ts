import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdcError, problemFor, type CredentialSource } from '../../src/main/ai/googleAuth';
import type { GoogleAuthConfig, GoogleAuthStatus } from '../../src/shared/types';
import { makeApp, type App } from '../helpers/appHarness';
import { MockLlmServer } from '../helpers/mockLlmServer';

/**
 * Google sign-in (Application Default Credentials) through the whole main process: IPC validation, the gateway, the
 * Gemini adapter (Vertex AI and Gemini API endpoints) and the live engine, against a local server that speaks Gemini's
 * wire format and insists on a Bearer token. Credentials are faked here; the real library is exercised in the unit tests.
 */

const TOKEN = 'ya29.fake-test-token-0123456789abcdefghij';

class FakeCredentials implements CredentialSource {
  fail: AdcError | null = null;
  readonly calls: { url: string; project: string }[] = [];
  resets = 0;
  headers(cfg: GoogleAuthConfig, url: string): Promise<Record<string, string>> {
    this.calls.push({ url, project: cfg.project });
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve({ authorization: `Bearer ${TOKEN}`, ...(cfg.project ? { 'x-goog-user-project': cfg.project } : {}) });
  }
  project(cfg: GoogleAuthConfig) {
    return Promise.resolve(cfg.project ? { project: cfg.project, source: 'provider' as const } : { project: 'from-adc', source: 'adc' as const });
  }
  status(cfg: GoogleAuthConfig): Promise<GoogleAuthStatus> {
    if (this.fail) return Promise.resolve({ ok: false, mode: cfg.mode, problem: this.fail.problem, checkedAt: 1 });
    return Promise.resolve({ ok: true, mode: cfg.mode, credential: 'user', project: cfg.project || 'from-adc', projectSource: cfg.project ? 'provider' : 'adc', latencyMs: 3, checkedAt: 1 });
  }
  reset(): void {
    this.resets++;
  }
}

let llm: MockLlmServer;
let creds: FakeCredentials;
let app: App;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await wait(15);
  }
};
const vertex = (over: Partial<GoogleAuthConfig> = {}): GoogleAuthConfig => ({ mode: 'adc', backend: 'vertex', project: 'test-proj', location: 'global', ...over });
const provider = (google: GoogleAuthConfig, over: { name?: string; apiKey?: string; baseUrl?: string } = {}) => app.call('providers.save', { name: over.name ?? 'Google (ADC)', kind: 'google', baseUrl: over.baseUrl ?? llm.googleUrl, enabled: true, google, apiKey: over.apiKey });
const posts = () => llm.requests.filter((r) => r.method === 'POST');

const serviceDisabled = {
  error: {
    code: 403,
    status: 'PERMISSION_DENIED',
    message: 'Vertex AI API has not been used in project 123 before or it is disabled.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com', metadata: { consumer: 'projects/123', service: 'aiplatform.googleapis.com' } }],
  },
};
const noFreeQuota = (model: string) => ({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: ${model}`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model } }] }],
  },
});

beforeAll(async () => {
  llm = await new MockLlmServer().start();
});
afterAll(async () => {
  await llm.stop();
});
beforeEach(() => {
  llm.reset();
  llm.google.requireBearer = TOKEN;
  creds = new FakeCredentials();
  app = makeApp({ googleCredentials: creds });
});

describe('Google sign-in (ADC): configuration', () => {
  it('saves a provider that needs no API key, and remembers how it signs in', async () => {
    const p = await provider(vertex());
    expect(p.google).toEqual(vertex());
    expect(p.keyOptional).toBe(true);
    expect(p.keySource).toBe('none');
    const listed = await app.call('providers.list');
    expect(listed[0]?.google?.mode).toBe('adc');
    expect(creds.resets).toBeGreaterThan(0); // a changed project/mode never reuses cached credentials
    // Editing it back to an API key removes the sign-in options (the pre-ADC shape).
    const back = await app.call('providers.save', { id: p.id, name: 'Google', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', enabled: true, apiKey: 'AIzaSyTestKey000000000000000000000000' });
    expect(back.google).toBeUndefined();
    expect(back.keySource).toBe('stored');
  });

  it('refuses to send Google credentials to a non-Google address, and rejects malformed input', async () => {
    await expect(provider(vertex(), { baseUrl: 'https://evil.example.com' })).rejects.toThrow(/Google API addresses/);
    await expect(provider(vertex(), { baseUrl: 'https://aiplatform.googleapis.com.evil.example' })).rejects.toThrow(/Google API addresses/);
    await expect(provider(vertex({ project: 'not a project!' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(provider(vertex({ location: 'us central' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.call('providers.save', { name: 'x', kind: 'google', baseUrl: llm.googleUrl, enabled: true, google: { mode: 'adc', backend: 'vertex', project: 'p', location: 'global', extra: 1 } as never })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a key for another service is refused before anything is saved or sent', async () => {
    await expect(app.call('providers.save', { name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', enabled: true, apiKey: 'AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz0123456789' })).rejects.toThrow(/looks like a Google key/);
    expect(await app.call('providers.list')).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('an API-key provider (the original behaviour) is unchanged', async () => {
    llm.google.requireBearer = undefined;
    llm.google.requireKey = 'AIza-test-key-123456';
    const p = await app.call('providers.save', { name: 'Gemini (key)', kind: 'google', baseUrl: llm.googleUrl, enabled: true, apiKey: 'AIza-test-key-123456' });
    expect(p.google).toBeUndefined();
    expect((await app.call('providers.listModels', { id: p.id })).models).toEqual(['gemini-2.5-flash']);
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    expect((await app.call('models.test', { id: live.id })).ok).toBe(true);
    expect(posts()[0]?.path).toContain('/google/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    expect(posts()[0]?.headers['x-goog-api-key']).toBe('AIza-test-key-123456');
    expect(posts()[0]?.headers.authorization).toBeUndefined();
    expect(creds.calls).toHaveLength(0); // no ADC involved
  });
});

describe('Google sign-in (ADC): Vertex AI', () => {
  it('checks the sign-in and reports what was found', async () => {
    const p = await provider(vertex());
    const s = await app.call('providers.checkAuth', { id: p.id });
    expect(s).toMatchObject({ ok: true, mode: 'adc', credential: 'user', project: 'test-proj', projectSource: 'provider' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('lists models with the Bearer token, hiding the ones that cannot chat', async () => {
    const p = await provider(vertex());
    const r = await app.call('providers.listModels', { id: p.id });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    const req = llm.requests[0];
    expect(req?.path).toContain('/google/v1beta1/publishers/google/models');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers['x-goog-api-key']).toBeUndefined();
    expect(req?.headers['x-goog-user-project']).toBe('test-proj');
  });

  it('the Live Model Test works with sign-in and no API key', async () => {
    const p = await provider(vertex());
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-pro' });
    const t = await app.call('models.test', { id: live.id });
    expect(t.ok).toBe(true);
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
    const req = posts()[0];
    expect(req?.path).toContain('/google/v1/projects/test-proj/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers['x-goog-user-project']).toBe('test-proj');
    expect(req?.headers['x-goog-api-key']).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain(TOKEN);
  });

  it('answers a live question end to end through the engine', async () => {
    const p = await provider(vertex());
    await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-pro' });
    await app.call('live.start', { interviewId: null, audio: false });
    await app.call('live.question', { text: 'Tell me about a time you led a team.' });
    await until(() => app.events('live.event').some((e) => e.type === 'answer-done'));
    const done = app.events('live.event').find((e) => e.type === 'answer-done');
    expect(done).toMatchObject({ type: 'answer-done' });
    expect(posts().some((r) => r.path.includes('/publishers/google/models/gemini-2.5-flash:streamGenerateContent') && r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    await app.call('live.stop');
  });

  it('uses the regional host and location the user chose', async () => {
    const p = await provider(vertex({ location: 'europe-west4' }));
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    await app.call('models.test', { id: live.id });
    expect(posts()[0]?.path).toContain('/locations/europe-west4/publishers/google/models/gemini-2.5-flash');
  });

  it('names the project when none is configured but ADC supplies one', async () => {
    const p = await provider(vertex({ project: '' }));
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    expect((await app.call('models.test', { id: live.id })).ok).toBe(true);
    expect(posts()[0]?.path).toContain('/projects/from-adc/');
  });
});

describe('Google sign-in (ADC): the Gemini API endpoint with an OAuth token', () => {
  it('uses the Gemini API path with the Bearer token instead of a key', async () => {
    const p = await provider(vertex({ backend: 'gemini-api', location: '' }));
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    expect((await app.call('models.test', { id: live.id })).ok).toBe(true);
    const req = posts()[0];
    expect(req?.path).toContain('/google/v1beta/models/gemini-2.5-flash:streamGenerateContent');
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers['x-goog-api-key']).toBeUndefined();
    expect((await app.call('providers.listModels', { id: p.id })).models).toEqual(['gemini-2.5-flash']);
  });
});

describe('Google sign-in (ADC): problems are explained in Settings', () => {
  it('no sign-in found on this PC', async () => {
    creds.fail = new AdcError(problemFor('adc_missing'));
    const p = await provider(vertex());
    const s = await app.call('providers.checkAuth', { id: p.id });
    expect(s.ok).toBe(false);
    expect(s.problem?.code).toBe('adc_missing');
    expect(s.problem?.steps.join(' ')).toContain('gcloud auth application-default login');

    const listed = await app.call('providers.listModels', { id: p.id });
    expect(listed.ok).toBe(false);
    expect(listed.error).toContain('gcloud auth application-default login');
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    const t = await app.call('models.test', { id: live.id });
    expect(t).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(t.error?.message).toContain('gcloud auth application-default login');
    expect(posts()).toHaveLength(0); // nothing was sent to the model
  });

  it('falls back to an API key only when there is no sign-in at all, and only on the Gemini API', async () => {
    creds.fail = new AdcError(problemFor('adc_missing'));
    llm.google.requireBearer = undefined;
    llm.google.requireKey = 'AIza-fallback-key-123456';
    const p = await provider(vertex({ backend: 'gemini-api', location: '' }), { apiKey: 'AIza-fallback-key-123456' });
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    expect((await app.call('models.test', { id: live.id })).ok).toBe(true);
    expect(posts()[0]?.headers['x-goog-api-key']).toBe('AIza-fallback-key-123456');
    // An expired login is a problem to fix, not something to paper over with a different credential.
    creds.fail = new AdcError(problemFor('adc_expired'));
    llm.requests.length = 0;
    const t = await app.call('models.test', { id: live.id });
    expect(t.ok).toBe(false);
    expect(t.error?.message).toContain('expired');
    expect(posts()).toHaveLength(0);
  });

  it('the Vertex AI API is turned off → the exact command to turn it on', async () => {
    llm.google.status = 403;
    llm.google.errorBody = serviceDisabled;
    llm.google.failCount = 1;
    const p = await provider(vertex());
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    const t = await app.call('models.test', { id: live.id });
    expect(t.ok).toBe(false);
    expect(t.error?.message).toContain('gcloud services enable aiplatform.googleapis.com --project test-proj');
  });

  it('a model with no free quota is named, and another one is found automatically', async () => {
    const p = await provider(vertex({ backend: 'gemini-api', location: '' }));
    llm.google.status = 429;
    llm.google.errorBody = noFreeQuota('gemini-2.0-flash');
    llm.google.failCount = 1;
    const { live } = await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.0-flash', qualityModel: 'gemini-2.5-flash' });
    const t = await app.call('models.test', { id: live.id });
    expect(t.ok).toBe(false);
    expect(t.error?.message).toContain('gemini-2.0-flash');
    expect(t.error?.message).toMatch(/no quota/i);

    // "Find a working model": the first candidate fails on quota, the second answers.
    llm.google.status = 429;
    llm.google.errorBody = noFreeQuota('gemini-3.5-flash');
    llm.google.failCount = 1;
    const probe = await app.call('models.probe', { providerId: p.id, candidates: ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] });
    expect(probe.working).toBe('gemini-2.5-flash');
    expect(probe.tried.map((x) => [x.model, x.ok])).toEqual([['gemini-3.5-flash', false], ['gemini-2.5-flash', true]]);
  });

  it('probing stops early when the sign-in itself is broken', async () => {
    creds.fail = new AdcError(problemFor('adc_expired'));
    const p = await provider(vertex());
    const probe = await app.call('models.probe', { providerId: p.id, candidates: ['a-1', 'b-2', 'c-3', 'd-4'] });
    expect(probe.working).toBeNull();
    expect(probe.tried).toHaveLength(1);
  });

  it('no secret ever reaches the UI, the export or the logs', async () => {
    const p = await provider(vertex(), {});
    await app.call('models.quickSetup', { providerId: p.id, fastModel: 'gemini-2.5-flash', qualityModel: 'gemini-2.5-flash' });
    const everything = JSON.stringify([await app.call('providers.list'), await app.call('settings.get'), await app.call('providers.checkAuth', { id: p.id }), app.pushed]);
    expect(everything).not.toContain(TOKEN);
    expect(JSON.stringify(await app.call('data.export'))).not.toContain(TOKEN);
  });
});
