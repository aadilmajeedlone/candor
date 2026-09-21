import { describe, expect, it } from 'vitest';
import { mapGoogleHttpError, parseGoogleError } from '../../src/main/ai/googleErrors';
import type { GoogleAuthConfig } from '../../src/shared/types';

const vertex: GoogleAuthConfig = { mode: 'adc', backend: 'vertex', project: 'my-proj', location: 'global' };
const geminiApi: GoogleAuthConfig = { mode: 'adc', backend: 'gemini-api', project: 'my-proj', location: '' };
const apiKey: GoogleAuthConfig = { mode: 'apiKey', backend: 'gemini-api', project: '', location: '' };
const ctx = (cfg: GoogleAuthConfig, model = 'gemini-2.5-flash') => ({ provider: 'Google', cfg, project: cfg.project || undefined, model });

const body = (code: number, status: string, message: string, details: unknown[] = []) => JSON.stringify({ error: { code, message, status, details } });
const info = (reason: string, metadata: Record<string, string> = {}) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata });

describe('Google error explanations (real response shapes)', () => {
  it('parses details, reasons and quota violations', () => {
    const d = parseGoogleError(
      body(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota', [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaDimensions: { model: 'gemini-2.0-flash' } }] },
        info('RATE_LIMIT_EXCEEDED', { service: 'generativelanguage.googleapis.com' }),
      ]),
    );
    expect(d.status).toBe('RESOURCE_EXHAUSTED');
    expect(d.reasons).toEqual(['RATE_LIMIT_EXCEEDED']);
    expect(d.quota[0]).toMatchObject({ metric: expect.stringContaining('free_tier') as string, model: 'gemini-2.0-flash' });
    expect(parseGoogleError('<html>Bad gateway</html>').message).toContain('Bad gateway');
  });

  it('API turned off → the exact command to turn it on', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'Vertex AI API has not been used in project 123456 before or it is disabled.', [info('SERVICE_DISABLED', { consumer: 'projects/123456', service: 'aiplatform.googleapis.com' })]), null, ctx(vertex));
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('gcloud services enable aiplatform.googleapis.com --project my-proj');
  });

  it('the Gemini API endpoint names its own service', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in project 9 before or it is disabled.', [info('SERVICE_DISABLED')]), null, ctx(geminiApi));
    expect(e.message).toContain('generativelanguage.googleapis.com');
  });

  it('no permission to use the project for quota → what role to ask for, and the quota-project command', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'Caller does not have required permission to use project my-proj. Grant the caller the roles/serviceusage.serviceUsageConsumer role', [info('USER_PROJECT_DENIED')]), null, ctx(vertex));
    expect(e.message).toContain('Service Usage Consumer');
    expect(e.message).toContain('set-quota-project my-proj');
  });

  it('missing Vertex AI role', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/my-proj/locations/global/publishers/google/models/gemini-2.5-flash' (or it may not exist).", [info('IAM_PERMISSION_DENIED')]), null, ctx(vertex));
    expect(e.message).toContain('Vertex AI User');
    expect(e.message).toContain('roles/aiplatform.user');
  });

  it('billing not enabled', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'This API method requires billing to be enabled. Please enable billing on project #123456', [info('BILLING_DISABLED')]), null, ctx(vertex));
    expect(e.message).toMatch(/billing/i);
    expect(e.message).toContain('my-proj');
  });

  it('a sign-in without the right scope', () => {
    const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', [info('ACCESS_TOKEN_SCOPE_INSUFFICIENT')]), null, ctx(vertex));
    expect(e.message).toContain('gcloud auth application-default login');
    const g = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.', [info('ACCESS_TOKEN_SCOPE_INSUFFICIENT')]), null, ctx(geminiApi));
    expect(g.message).toMatch(/OAuth client|Vertex AI/);
  });

  it('an expired sign-in (401) says to sign in again — not "the API key was rejected"', () => {
    const e = mapGoogleHttpError(401, body(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials. Expected OAuth 2 access token'), null, ctx(vertex));
    expect(e.message).toContain('gcloud auth application-default login');
    expect(e.message).not.toMatch(/API key/i);
  });

  it('an organisation that forbids API keys is pointed at Google sign-in', () => {
    for (const msg of ["API keys are disallowed. Your organisation's security policy disallows API keys. Please use Application Default Credentials (ADC) instead.", "API keys are disallowed. Your organization's security policy disallows API keys."]) {
      const e = mapGoogleHttpError(403, body(403, 'PERMISSION_DENIED', msg), null, ctx(apiKey));
      expect(e.message).toContain('sign in with gcloud');
    }
  });

  it('new "AQ." keys on the wrong endpoint get an actionable message', () => {
    const e = mapGoogleHttpError(401, body(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', [info('ACCESS_TOKEN_TYPE_UNSUPPORTED')]), null, ctx(apiKey));
    expect(e.message).toContain('sign in with gcloud');
  });

  it('an invalid API key stays a key problem', () => {
    const e = mapGoogleHttpError(400, body(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [info('API_KEY_INVALID')]), null, ctx(apiKey));
    // 400 with API_KEY_INVALID is not covered by the 401/403 branch: it falls through to the generic mapping without mentioning ADC.
    expect(e.message).not.toContain('gcloud');
  });

  it('free tier with no quota for the model → says which model and what to do (not retryable)', () => {
    const e = mapGoogleHttpError(
      429,
      body(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.0-flash', [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.0-flash' } }] },
      ]),
      null,
      ctx(apiKey, 'gemini-2.0-flash'),
    );
    expect(e.code).toBe('rate_limit');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('gemini-2.0-flash');
    expect(e.message).toMatch(/no quota/i);
    expect(e.message).toMatch(/Settings → Models/);
    // It must not nudge anyone towards paying: billing is mentioned only to say Candor never turns it on.
    expect(e.message).not.toMatch(/enable billing/i);
    expect(e.message).toMatch(/free-tier limit, not a payment problem/);
  });

  it('a daily limit that is merely used up is described as such', () => {
    const e = mapGoogleHttpError(
      429,
      body(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded … limit: 250, model: gemini-2.5-flash', [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-flash' } }] },
      ]),
      null,
      ctx(apiKey),
    );
    expect(e.message).toMatch(/daily limit/i);
    expect(e.retryable).toBe(false);
  });

  it('a per-minute rate limit stays retryable', () => {
    const e = mapGoogleHttpError(429, body(429, 'RESOURCE_EXHAUSTED', 'Resource exhausted. Please try again later.'), '2', ctx(vertex));
    expect(e.code).toBe('rate_limit');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(2000);
  });

  it('a model that does not exist in the chosen location', () => {
    const e = mapGoogleHttpError(404, body(404, 'NOT_FOUND', 'Publisher Model `projects/my-proj/locations/us-east1/publishers/google/models/gemini-9` was not found or your project does not have access to it.'), null, ctx({ ...vertex, location: 'us-east1' }, 'gemini-9'));
    expect(e.code).toBe('model_not_found');
    expect(e.message).toContain('gemini-9');
    expect(e.message).toContain('us-east1');
  });

  it('anything else keeps the generic mapping', () => {
    expect(mapGoogleHttpError(503, body(503, 'UNAVAILABLE', 'The model is overloaded.'), null, ctx(vertex)).code).toBe('server');
    expect(mapGoogleHttpError(400, body(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.'), null, ctx(vertex)).code).toBe('bad_request');
  });
});
