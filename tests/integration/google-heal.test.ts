import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JD_TEXT, RESUME_TEXT } from '../fixtures/documents';
import { makeApp } from '../helpers/appHarness';
import { makeHarness } from '../helpers/gatewayHarness';
import { respond } from '../helpers/llmScript';
import { MockLlmServer } from '../helpers/mockLlmServer';

/**
 * An older version of Candor picked Gemini models with no free quota (a computer-use preview, a deep-research agent).
 * The saved choice survives an upgrade, so every request kept failing. Now the app repairs its own bad pick — only for a
 * Gemini API key, only when Google's answer proves the model itself is the problem, with a handful of tiny requests,
 * visibly (a notice, and the new model is saved where Settings → Models shows it).
 */

let srv: MockLlmServer;
beforeAll(async () => {
  srv = await new MockLlmServer().start();
});
afterAll(async () => {
  await srv.stop();
});
beforeEach(() => srv.reset());

const noFreeQuota = (model: string) => ({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: ${model}`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model } }] }],
  },
});
const notFound = (model: string) => ({ error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.` } });

const ALL = ['gemini-2.5-computer-use-preview-10-2025', 'deep-research-pro-preview-12-2025', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-embedding-001'];
const posts = () => srv.requests.filter((r) => r.method === 'POST');
const postedTo = (model: string) => posts().filter((r) => r.path.includes(`/models/${model}:`)).length;

function setup(models: { name: string; model: string }[] = [{ name: 'Fast · gemini-2.5-computer-use-preview-10-2025', model: 'gemini-2.5-computer-use-preview-10-2025' }], gatewayOpts: Parameters<typeof makeHarness>[1] = {}) {
  const h = makeHarness({}, gatewayOpts);
  const p = h.addProvider('google', srv.googleUrl, 'AIza-test-key-123456', 'Google');
  const configs = models.map((m) => h.addModel(p, m.model, { name: m.name, timeoutMs: 5000 }));
  return { h, p, configs };
}
const request = (task: 'live' | 'prep' = 'live') => {
  const notices: string[] = [];
  const tokens: string[] = [];
  return { notices, tokens, r: { task, system: 's', user: 'u', maxTokens: 100, signal: new AbortController().signal, onToken: (t: string) => tokens.push(t), onNotice: (_l: string, m: string) => notices.push(m) } };
};

describe('repairing a Gemini model with no free quota', () => {
  it('finds a model that has quota, uses it for the request, saves it, and says so', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = {
      'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') },
      'gemini-2.5-flash': { status: 429, body: noFreeQuota('gemini-2.5-flash') }, // no free quota either: skipped
    };
    const { h, configs } = setup();
    h.route('live', configs[0]);
    const { r, notices, tokens } = request();
    const out = await h.gateway.generate(r);

    expect(out.text).toContain('In my current role');
    expect(out.model).toBe('gemini-2.5-flash-lite');
    expect(tokens.length).toBeGreaterThan(0);
    expect(notices.some((n) => /switched this model to “gemini-2\.5-flash-lite”/.test(n) && /Settings → Models/.test(n))).toBe(true);
    // the repaired choice is saved, under a name that still makes sense
    const saved = h.repos.getModel(configs[0].id)!;
    expect(saved).toMatchObject({ model: 'gemini-2.5-flash-lite', name: 'Fast · gemini-2.5-flash-lite' });
    // only chat models were tried, and only a handful: never the embedding model, never a pile of requests
    expect(postedTo('gemini-embedding-001')).toBe(0);
    expect(postedTo('deep-research-pro-preview-12-2025')).toBe(0);
    expect(posts().length).toBeLessThanOrEqual(5);
  });

  it('the next request uses the repaired model directly, with no repeated probing', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') } };
    const { h, configs } = setup();
    h.route('live', configs[0]);
    await h.gateway.generate(request().r);
    const before = posts().length;
    const second = request();
    const out = await h.gateway.generate(second.r);
    expect(out.model).toBe('gemini-2.5-flash');
    expect(posts().length).toBe(before + 1); // exactly one request: the answer itself
    expect(second.notices).toEqual([]);
  });

  it('a model that does not exist (or cannot chat) is replaced the same way', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'deep-research-pro-preview-12-2025': { status: 404, body: notFound('deep-research-pro-preview-12-2025') } };
    const { h, configs } = setup([{ name: 'Quality · deep-research-pro-preview-12-2025', model: 'deep-research-pro-preview-12-2025' }]);
    h.route('prep', configs[0]);
    const { r, notices } = request('prep');
    const out = await h.gateway.generate(r);
    expect(out.text).not.toBe('');
    expect(out.model).not.toBe('deep-research-pro-preview-12-2025');
    expect(notices.some((n) => /switched this model to/.test(n))).toBe(true);
    expect(h.repos.getModel(configs[0].id)!.name).toMatch(/^Quality · gemini-/);
  });

  it('a model that Google refuses because it is not a chat model at all (deep-research agent) is replaced', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'deep-research-pro-preview-12-2025': { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'This model is only available through the Interactions API.' } } } };
    const { h, configs } = setup([{ name: 'Quality · deep-research-pro-preview-12-2025', model: 'deep-research-pro-preview-12-2025' }]);
    h.route('prep', configs[0]);
    const { r, notices } = request('prep');
    const out = await h.gateway.generate(r);
    expect(out.model).toMatch(/^gemini-/);
    expect(notices.some((n) => /switched this model to/.test(n))).toBe(true);
    expect(h.repos.getModel(configs[0].id)!.name).toMatch(/^Quality · gemini-/);
  });

  it('a non-chat model refused with a permission error is replaced too — unless the key itself is the problem', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'deep-research-pro-preview-12-2025': { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Your project is not allowed to use this model.' } } } };
    const { h, configs } = setup([{ name: 'Quality · deep-research-pro-preview-12-2025', model: 'deep-research-pro-preview-12-2025' }]);
    h.route('prep', configs[0]);
    const out = await h.gateway.generate(request('prep').r);
    expect(out.model).toMatch(/^gemini-/);

    // with a rejected key the model list fails first, so nothing is probed and the auth error is reported as it was
    srv.reset();
    srv.google.requireKey = 'AIza-a-different-key-1';
    const bad = setup([{ name: 'Quality · deep-research-pro-preview-12-2025', model: 'deep-research-pro-preview-12-2025' }]);
    bad.h.route('prep', bad.configs[0]);
    await expect(bad.h.gateway.generate(request('prep').r)).rejects.toMatchObject({ code: 'auth' });
    expect(posts()).toHaveLength(1); // only the original request: no probes with a bad key
  });

  it('says so app-wide when a request has no notice channel of its own (Preparation) — once, not once per section', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') } };
    const told: string[] = [];
    const { h, configs } = setup(undefined, { notify: (_level, message) => told.push(message) });
    h.route('prep', configs[0]);
    // like generateJson: no token callback, no notice callback
    const bare = () => ({ task: 'prep' as const, system: 's', user: 'u', maxTokens: 100, signal: new AbortController().signal });
    await Promise.all([h.gateway.generate(bare()), h.gateway.generate(bare()), h.gateway.generate(bare()), h.gateway.generate(bare())]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/switched this model to “gemini-2\.5-flash”/);
    expect(told[0]).toMatch(/Settings → Models/);
  });

  it('uses the request’s own notice channel when it has one (Live) instead of the app-wide one', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') } };
    const told: string[] = [];
    const { h, configs } = setup(undefined, { notify: (_level, message) => told.push(message) });
    h.route('live', configs[0]);
    const { r, notices } = request();
    await h.gateway.generate(r);
    expect(notices.some((n) => /switched this model to/.test(n))).toBe(true);
    expect(told).toEqual([]);
  });

  it('parallel requests share one repair', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') } };
    const { h, configs } = setup();
    h.route('live', configs[0]);
    const results = await Promise.all([h.gateway.generate(request().r), h.gateway.generate(request().r), h.gateway.generate(request().r)]);
    expect(results.every((x) => x.text.includes('In my current role'))).toBe(true);
    // one probe request (flash answers the probe), three answers, three failed attempts on the bad model: not three separate repairs
    expect(postedTo('gemini-2.5-flash')).toBeLessThanOrEqual(4);
    expect(srv.requests.filter((r) => r.method === 'GET' && r.path.includes('/models')).length).toBe(1);
  });

  it('when no model has quota it says exactly that, lists what it tried, points to free alternatives — and then stops asking', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = Object.fromEntries(ALL.map((m) => [m, { status: 429, body: noFreeQuota(m) }]));
    const { h, configs } = setup();
    h.route('live', configs[0]);
    const first = await h.gateway.generate(request().r).catch((e: Error) => e);
    expect(first).toBeInstanceOf(Error);
    const message = (first as Error).message;
    expect(message).toContain('None of the Gemini models Candor tried has quota on this project');
    expect(message).toMatch(/gemini-2\.5-flash/);
    expect(message).toMatch(/free-tier limit, not a payment problem/);
    expect(message).toMatch(/local model or a friend's GPU/);
    expect(message).not.toMatch(/enable billing/i);
    expect(h.repos.getModel(configs[0].id)!.model).toBe('gemini-2.5-computer-use-preview-10-2025'); // nothing was changed

    const attempts = posts().length;
    await h.gateway.generate(request().r).catch(() => undefined);
    expect(posts().length).toBe(attempts + 1); // the cool-down: just the failing request, no new round of probes
  });

  it('never changes a model for problems that are not the model’s fault, or for other kinds of provider', async () => {
    srv.google.listModels = ALL;
    // a real rate limit (not the free-tier "no quota at all" signature) is retried/handled as before
    srv.google.status = 429;
    srv.google.failCount = 1;
    srv.google.errorBody = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Too many requests, slow down' } };
    srv.google.retryAfter = '0';
    const { h, configs } = setup([{ name: 'Fast · gemini-2.5-flash', model: 'gemini-2.5-flash' }]);
    h.route('live', configs[0]);
    const out = await h.gateway.generate(request().r);
    expect(out.model).toBe('gemini-2.5-flash');
    expect(h.repos.getModel(configs[0].id)!.model).toBe('gemini-2.5-flash');

    // an invalid key is an auth problem: no repair attempt, and no probing with a bad key
    srv.reset();
    srv.google.requireKey = 'AIza-other-key-000000';
    const bad = setup([{ name: 'Fast · gemini-2.5-flash', model: 'gemini-2.5-flash' }]);
    bad.h.route('live', bad.configs[0]);
    await expect(bad.h.gateway.generate(request().r)).rejects.toMatchObject({ code: 'auth' });
    expect(posts().length).toBeLessThanOrEqual(2);

    // an OpenAI-compatible provider is never touched by this
    srv.reset();
    srv.openai.status = 404;
    srv.openai.failCount = 5;
    srv.openai.errorBody = { error: { message: 'The model `nope` does not exist', type: 'invalid_request_error', code: 'model_not_found' } };
    const other = makeHarness();
    const p = other.addProvider('openai-compatible', srv.openaiUrl, 'k-abcdefghij', 'OpenAI-compatible');
    other.route('live', other.addModel(p, 'nope'));
    await expect(other.gateway.generate(request().r)).rejects.toMatchObject({ code: 'model_not_found' });
    expect(other.repos.getModel(other.repos.listModels()[0].id)!.model).toBe('nope');
  });
});

describe('through the whole app: Preparation with a model saved by an older Candor', () => {
  it('repairs the model, produces every section, tells the person once, and keeps the fix', async () => {
    srv.google.listModels = ALL;
    srv.google.perModel = { 'gemini-2.5-computer-use-preview-10-2025': { status: 429, body: noFreeQuota('gemini-2.5-computer-use-preview-10-2025') } };
    // The mock receives Google's request format; the shared script reads the OpenAI one, so translate.
    srv.google.dynamic = (body) => {
      const text = (v: unknown) => (v as { parts?: { text?: string }[] } | undefined)?.parts?.[0]?.text ?? '';
      const contents = body?.contents as unknown[] | undefined;
      return respond({ messages: [{ role: 'system', content: text(body?.systemInstruction) }, { role: 'user', content: text(contents?.[0]) }] });
    };
    const app = makeApp();
    try {
      const provider = await app.call('providers.save', { name: 'Google', kind: 'google', baseUrl: srv.googleUrl, enabled: true, apiKey: 'AIza-test-key-123456' });
      // what an older Candor saved: the computer-use preview, for quick answers and for preparation
      const old = await app.call('models.save', { name: 'Fast · gemini-2.5-computer-use-preview-10-2025', providerId: provider.id, model: 'gemini-2.5-computer-use-preview-10-2025', temperature: 0.3, maxTokens: 800, topP: null, timeoutMs: 5000, streaming: true });
      await app.call('settings.update', { routing: { live: { primary: old.id, fallback: null }, prep: { primary: old.id, fallback: null } } });
      const resume = await app.call('resumes.create', { name: 'cv.txt', source: 'txt', text: RESUME_TEXT, useAi: false });
      const interview = await app.call('interviews.create', { jobTitle: 'Operations Manager', company: 'Contoso', interviewType: 'operations', jobDescription: JD_TEXT, resumeId: resume.id });

      await app.call('prep.generate', { interviewId: interview.id, section: 'all' });

      expect(app.events('prep.progress').filter((p) => p.error)).toEqual([]);
      const prep = await app.call('prep.get', { interviewId: interview.id });
      expect(Object.keys(prep).sort()).toEqual(['about', 'company', 'questions', 'role']);
      expect(prep.about!.model).toBe('gemini-2.5-flash');
      // told once, in words, app-wide (four sections ran at the same time)
      const notices = app.events('app.notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toMatch(/switched this model to “gemini-2\.5-flash”/);
      // and the fix is saved where Settings → Models shows it
      const saved = (await app.call('models.list')).find((m) => m.id === old.id);
      expect(saved).toMatchObject({ model: 'gemini-2.5-flash', name: 'Fast · gemini-2.5-flash' });
    } finally {
      await app.close();
    }
  });
});
