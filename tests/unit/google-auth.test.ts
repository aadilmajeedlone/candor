import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdcError, GoogleAdc, toAdcError } from '../../src/main/ai/googleAuth';
import { redact } from '../../src/main/logging';
import type { GoogleAuthConfig } from '../../src/shared/types';
import { MockTokenServer } from '../helpers/mockTokenServer';

/**
 * These tests run Google's real `google-auth-library` (the code that finds, refreshes and applies credentials) against
 * a local stand-in for Google's token endpoint. Nothing here talks to Google or needs a login.
 */

const REFRESH = '1//test-refresh-token-abcdefghijklmnopqrstuvwxyz';
const SECRET = 'test-client-secret-0123456789';
const cfg = (over: Partial<GoogleAuthConfig> = {}): GoogleAuthConfig => ({ mode: 'adc', backend: 'vertex', project: '', location: 'global', ...over });
const GOOGLE_URL = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m:generateContent';

let tokens: MockTokenServer;
beforeAll(async () => {
  tokens = await new MockTokenServer().start();
});
afterAll(async () => {
  await tokens.stop();
});
beforeEach(() => {
  tokens.mode = 'ok';
  tokens.token = 'ya29.mock-access-token-0001';
  tokens.bodies.length = 0;
});

/** ADC as `gcloud auth application-default login` leaves it: a user credential with a refresh token. */
function userAdc(opts: { quotaProject?: string; env?: NodeJS.ProcessEnv; noProject?: boolean } = {}): GoogleAdc {
  return new GoogleAdc({
    env: opts.env ?? {},
    createAuth: () => {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        authClient: new UserRefreshClient({ clientId: 'test-client-id', clientSecret: SECRET, refreshToken: REFRESH, quotaProjectId: opts.quotaProject, endpoints: { oauth2TokenUrl: tokens.url } }),
      });
      if (opts.noProject) auth.getProjectId = () => Promise.reject(new Error('Unable to detect a Project Id in the current environment.'));
      return auth;
    },
  });
}

describe('Google sign-in (Application Default Credentials)', () => {
  it('turns the stored login into an Authorization header, without any API key', async () => {
    const adc = userAdc({ quotaProject: 'adc-quota-project' });
    const h = await adc.headers(cfg(), GOOGLE_URL);
    expect(h.authorization).toBe(`Bearer ${tokens.token}`);
    expect(h['x-goog-user-project']).toBe('adc-quota-project'); // the quota project stored by "gcloud auth application-default set-quota-project"
    expect(Object.keys(h).some((k) => /api-key/i.test(k))).toBe(false);
  });

  it('refreshes the short-lived token once and reuses it', async () => {
    const adc = userAdc();
    await adc.headers(cfg(), GOOGLE_URL);
    await adc.headers(cfg(), GOOGLE_URL);
    await adc.headers(cfg(), GOOGLE_URL);
    expect(tokens.bodies).toHaveLength(1); // one exchange for three requests: nothing on the hot path
    expect(tokens.bodies[0]).toContain('grant_type=refresh_token');
  });

  it('bills the project chosen in Candor, overriding the credential file', async () => {
    const h = await userAdc({ quotaProject: 'from-file' }).headers(cfg({ project: 'chosen-in-candor' }), GOOGLE_URL);
    expect(h['x-goog-user-project']).toBe('chosen-in-candor');
  });

  it('will not send a token anywhere but a Google API address', async () => {
    const adc = userAdc();
    for (const url of ['https://evil.example.com/v1/models', 'http://169.254.169.254/latest', 'https://googleapis.com.evil.example/v1', 'https://aiplatform.googleapis.com.evil.example/x', 'ftp://aiplatform.googleapis.com/x']) {
      await expect(adc.headers(cfg(), url), url).rejects.toMatchObject({ problem: { code: 'refused_host' } });
    }
    expect(tokens.bodies).toHaveLength(0); // it did not even fetch a token
    // Loopback (local development and tests) and real Google hosts are fine.
    await expect(adc.headers(cfg(), 'http://127.0.0.1:1234/x')).resolves.toBeTruthy();
    await expect(adc.headers(cfg(), 'https://us-central1-aiplatform.googleapis.com/v1/x')).resolves.toBeTruthy();
  });

  it('stops waiting when the request is cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(userAdc().headers(cfg(), GOOGLE_URL, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports which credential and project were found, and never a token', async () => {
    const s = await userAdc({ quotaProject: 'adc-quota-project' }).status(cfg());
    expect(s).toMatchObject({ ok: true, mode: 'adc', credential: 'user', project: 'adc-quota-project', projectSource: 'adc' });
    const text = JSON.stringify(s);
    expect(text).not.toContain(tokens.token);
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(SECRET);

    expect(await userAdc().status(cfg({ project: 'typed-in-candor' }))).toMatchObject({ ok: true, project: 'typed-in-candor', projectSource: 'provider' });
    expect(await userAdc({ env: { GOOGLE_CLOUD_PROJECT: 'from-env' } }).status(cfg())).toMatchObject({ ok: true, project: 'from-env', projectSource: 'environment' });
  });

  it('says clearly when no project can be determined (Vertex AI needs one)', async () => {
    const s = await userAdc({ noProject: true }).status(cfg());
    expect(s.ok).toBe(false);
    expect(s.problem?.code).toBe('no_project');
    expect(s.problem?.steps.join(' ')).toContain('gcloud config set project');
    // The Gemini API endpoint does not need a project id in the URL.
    expect((await userAdc({ noProject: true }).status(cfg({ backend: 'gemini-api' }))).ok).toBe(true);
  });

  describe('failures are explained, and secrets never appear in the explanation', () => {
    const noSecrets = (text: string) => {
      for (const secret of [REFRESH, SECRET, 'test-client-id', tokens.token]) expect(text).not.toContain(secret);
    };

    it('an expired or revoked login', async () => {
      tokens.mode = 'invalid_grant';
      const adc = userAdc();
      const err = (await adc.headers(cfg(), GOOGLE_URL).catch((e: unknown) => e)) as AdcError;
      expect(err).toBeInstanceOf(AdcError);
      expect(err.problem.code).toBe('adc_expired');
      expect(err.message).toContain('gcloud auth application-default login');
      expect(err.code).toBe('auth');
      expect(err.retryable).toBe(false);
      noSecrets(JSON.stringify({ message: err.message, problem: err.problem }));
      const s = await adc.status(cfg());
      expect(s.problem?.code).toBe('adc_expired');
      noSecrets(JSON.stringify(s));
    });

    it('credentials Google refuses to use', async () => {
      tokens.mode = 'invalid_client';
      const err = (await userAdc().headers(cfg(), GOOGLE_URL).catch((e: unknown) => e)) as AdcError;
      expect(err.problem.code).toBe('adc_rejected');
      noSecrets(JSON.stringify({ message: err.message, problem: err.problem }));
    });

    it('no connection to Google', async () => {
      const dead = await new MockTokenServer().start();
      const url = dead.url;
      await dead.stop();
      const adc = new GoogleAdc({
        env: {},
        createAuth: () => new GoogleAuth({ authClient: new UserRefreshClient({ clientId: 'c', clientSecret: SECRET, refreshToken: REFRESH, endpoints: { oauth2TokenUrl: url } }) }),
      });
      const err = (await adc.headers(cfg(), GOOGLE_URL).catch((e: unknown) => e)) as AdcError;
      expect(err.problem.code).toBe('adc_network');
      noSecrets(JSON.stringify({ message: err.message, problem: err.problem }));
    });

    it('a stale login is dropped from memory so signing in again takes effect without restarting', async () => {
      const adc = userAdc();
      tokens.mode = 'invalid_grant';
      await expect(adc.headers(cfg(), GOOGLE_URL)).rejects.toBeInstanceOf(AdcError);
      tokens.mode = 'ok';
      tokens.token = 'ya29.mock-access-token-0002';
      const h = await adc.headers(cfg(), GOOGLE_URL);
      expect(h.authorization).toBe('Bearer ya29.mock-access-token-0002');
    });
  });
});

describe('when there is no Google sign-in on the PC (the real library, empty environment)', () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;
  const KEYS = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'CLOUDSDK_CONFIG', 'METADATA_SERVER_DETECTION', 'APPDATA', 'HOME', 'USERPROFILE', 'GCE_METADATA_HOST'];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), 'candor-noadc-'));
    for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'GCE_METADATA_HOST']) delete process.env[k];
    process.env.CLOUDSDK_CONFIG = home;
    process.env.APPDATA = home;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.METADATA_SERVER_DETECTION = 'none'; // do not probe for a cloud VM
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('explains how to sign in (no credential file anywhere)', async () => {
    const s = await new GoogleAdc().status(cfg());
    expect(s.ok).toBe(false);
    expect(s.problem?.code).toBe('adc_missing');
    expect(s.problem?.title).toMatch(/not found/i);
    expect(s.problem?.steps.join('\n')).toContain('gcloud auth application-default login');
    expect(s.problem?.steps.join('\n')).toContain('winget install');
  });

  it('explains a GOOGLE_APPLICATION_CREDENTIALS that points nowhere', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(home, 'missing-credentials.json');
    const s = await new GoogleAdc().status(cfg());
    expect(s.problem?.code).toBe('adc_missing');
  });

  it('a request fails with the same clear message', async () => {
    const err = (await new GoogleAdc().headers(cfg(), GOOGLE_URL).catch((e: unknown) => e)) as AdcError;
    expect(err).toBeInstanceOf(AdcError);
    expect(err.message).toContain('gcloud auth application-default login');
  });
});

describe('error translation and redaction', () => {
  it('unknown failures are shown without leaking anything token-shaped', () => {
    const e = toAdcError(new Error('boom ya29.abcdefghijklmnopqrstuvwxyz0123 and 1//0abcdefghijklmnopqrstuvwxyz and AQ.Zx9Kqabcdefghijklmnopqrstuvwxyz'));
    expect(e.problem.code).toBe('other');
    expect(e.message).not.toMatch(/ya29\.abcdef|1\/\/0abcdef|AQ\.Zx9Kqabcdef/);
  });

  it('log redaction masks Google credential shapes', () => {
    const line = redact('token ya29.a0AfB_byC1234567890abcdefghijk refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz auth key AQ.Zx9Kq6abcdefghijklmnopqrstuvwxyz0123 jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.c2lnbmF0dXJlMTIzNDU2 pem -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----');
    expect(line).not.toMatch(/ya29\.|1\/\/0gAb|AQ\.Zx9Kq6|eyJhbGci|MIIEvQ/);
    expect(line).toContain('***');
  });
});
