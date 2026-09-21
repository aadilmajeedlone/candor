import { BaseExternalAccountClient, Compute, GoogleAuth, Impersonated, JWT, UserRefreshClient, type AuthClient } from 'google-auth-library';
import { AiError } from '@shared/errors';
import { isGoogleApiHost } from '@shared/google';
import type { GoogleAuthConfig, GoogleAuthProblemCode, GoogleAuthStatus } from '@shared/types';
import { redact } from '../logging';

/**
 * Google Application Default Credentials (ADC), through Google's official `google-auth-library`.
 *
 * Candor never reads, copies, stores or logs the credentials itself: the library finds them (the
 * GOOGLE_APPLICATION_CREDENTIALS file, the file written by `gcloud auth application-default login`, or an attached
 * service account), refreshes the short-lived access token, and hands back an Authorization header. Tokens are kept in
 * memory only and are attached solely to Google API hosts.
 */

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export interface AdcProblem {
  code: GoogleAuthProblemCode;
  title: string;
  detail: string;
  steps: string[];
}

/** An authentication/configuration problem with everything the UI needs to explain and fix it. */
export class AdcError extends AiError {
  constructor(readonly problem: AdcProblem) {
    super('auth', `${problem.title}${problem.detail ? ` ${problem.detail}` : ''}`, { retryable: false });
  }
}

export const LOGIN_COMMAND = 'gcloud auth application-default login';
const INSTALL_COMMAND = 'winget install -e --id Google.CloudSDK';

/** The problem catalogue: short titles for toasts, numbered steps for the Settings panel. */
export function problemFor(code: GoogleAuthProblemCode, extra = ''): AdcProblem {
  switch (code) {
    case 'adc_missing':
      return {
        code,
        title: 'Google sign-in (ADC) was not found on this PC.',
        detail: 'Run “gcloud auth application-default login”, then press Check sign-in.',
        steps: [`Install the Google Cloud CLI if you have not (Windows), then open a new terminal: ${INSTALL_COMMAND}`, `Run: ${LOGIN_COMMAND}`, 'Sign in with the Google account that can use your project.', 'Back in Candor, press “Check sign-in”.'],
      };
    case 'adc_expired':
      return {
        code,
        title: 'Your Google sign-in has expired or was revoked.',
        detail: 'Sign in again with “gcloud auth application-default login”.',
        steps: [`Run: ${LOGIN_COMMAND}`, 'Sign in again in the browser.', 'Press “Check sign-in”.', 'Some organisations expire Google Cloud sign-ins every few hours; signing in again is the fix.'],
      };
    case 'adc_rejected':
      return {
        code,
        title: 'Google would not issue a token for these credentials.',
        detail: extra || 'They may be disabled, or your organisation may block this sign-in.',
        steps: [`Sign in again: ${LOGIN_COMMAND}`, 'If it keeps failing, ask your Google Workspace / Cloud administrator whether the Google Cloud CLI sign-in is allowed for your account.', 'If GOOGLE_APPLICATION_CREDENTIALS is set, check that it points to a valid, enabled credential file.'],
      };
    case 'adc_network':
      return {
        code,
        title: 'Could not reach Google to get a sign-in token.',
        detail: 'Check your internet connection.',
        steps: ['Check that this PC is online and can reach oauth2.googleapis.com.', 'Behind a proxy? Set the HTTPS_PROXY environment variable and restart Candor.', 'Press “Check sign-in” again.'],
      };
    case 'no_project':
      return {
        code,
        title: 'No Google Cloud project is set.',
        detail: 'Enter your project ID in the provider settings, or set a default with gcloud.',
        steps: ['Type your Google Cloud project ID into the “Project ID” field of this provider (see it in the Cloud console project picker).', 'Or set a default: gcloud config set project YOUR_PROJECT_ID', 'And a quota project: gcloud auth application-default set-quota-project YOUR_PROJECT_ID', 'Press “Check sign-in”.'],
      };
    case 'refused_host':
      return { code, title: 'Candor will not send Google credentials to that address.', detail: extra, steps: ['Use a Google API address such as https://aiplatform.googleapis.com (Vertex AI) or https://generativelanguage.googleapis.com.'] };
    default:
      return { code: 'other', title: 'Google sign-in failed.', detail: extra, steps: [`Try signing in again: ${LOGIN_COMMAND}`, 'Then press “Check sign-in”.'] };
  }
}

/** Turn whatever the auth library threw into a typed problem. Only the message and OAuth error code are read: never request configs. */
export function toAdcError(err: unknown): AdcError {
  if (err instanceof AdcError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const oauth = data && typeof data === 'object' ? (data as { error?: unknown; error_description?: unknown }) : {};
  const code = typeof oauth.error === 'string' ? oauth.error : '';
  const desc = typeof oauth.error_description === 'string' ? oauth.error_description : '';
  const text = `${message} ${code} ${desc}`;
  const netCode = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? '';

  if (/Unable to detect a Project Id/i.test(text)) return new AdcError(problemFor('no_project'));
  if (/Could not load the default credentials|default credentials were not found|does not exist, or it is not a file|ENOENT/i.test(text)) return new AdcError(problemFor('adc_missing'));
  if (/invalid_grant|invalid_rapt|reauth|expired or revoked/i.test(text)) return new AdcError(problemFor('adc_expired'));
  if (/invalid_client|unauthorized_client|disabled_client|access_denied|invalid_scope/i.test(text)) return new AdcError(problemFor('adc_rejected', desc ? redact(desc).slice(0, 160) : ''));
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up/i.test(`${text} ${netCode}`)) return new AdcError(problemFor('adc_network'));
  return new AdcError(problemFor('other', redact(message).slice(0, 160)));
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function kindOf(client: AuthClient): NonNullable<GoogleAuthStatus['credential']> {
  if (client instanceof UserRefreshClient) return 'user';
  if (client instanceof JWT) return 'service-account';
  if (client instanceof Compute) return 'compute';
  if (client instanceof Impersonated) return 'impersonated';
  if (client instanceof BaseExternalAccountClient) return 'external-account';
  return 'other';
}

/** What the Google adapter needs from an authentication source. */
export interface CredentialSource {
  /** Authorization (and quota-project) headers for a request to `url`. Throws AdcError. */
  headers(cfg: GoogleAuthConfig, url: string, signal?: AbortSignal): Promise<Record<string, string>>;
  /** The project requests are billed to, or undefined if none can be determined. */
  project(cfg: GoogleAuthConfig): Promise<{ project: string; source: NonNullable<GoogleAuthStatus['projectSource']> } | undefined>;
  /** Re-read credentials from disk and report what was found. Never includes a token. */
  status(cfg: GoogleAuthConfig): Promise<GoogleAuthStatus>;
  /** Forget cached credentials (after signing in again). */
  reset(): void;
}

export interface GoogleAdcDeps {
  /** Tests inject a GoogleAuth wired to a local token endpoint; production uses Google's default discovery. */
  createAuth?: () => GoogleAuth;
  env?: NodeJS.ProcessEnv;
}

export class GoogleAdc implements CredentialSource {
  private auth: GoogleAuth | null = null;

  constructor(private readonly deps: GoogleAdcDeps = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  reset(): void {
    this.auth = null;
  }

  private authObject(): GoogleAuth {
    this.auth ??= this.deps.createAuth ? this.deps.createAuth() : new GoogleAuth({ scopes: SCOPES });
    return this.auth;
  }

  async headers(cfg: GoogleAuthConfig, url: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!isGoogleApiHost(url)) {
      throw new AdcError(problemFor('refused_host', `${safeHost(url)} is not a Google API address.`));
    }
    try {
      const client = await raceAbort(this.authObject().getClient(), signal);
      const h = await raceAbort(client.getRequestHeaders(url), signal);
      const authorization = h.get('authorization');
      if (!authorization) throw new Error('Google returned no access token.');
      const out: Record<string, string> = { authorization };
      // Name the project to bill, or Google bills the credential's own (e.g. gcloud's) project and answers "API not enabled".
      // An explicit project in the provider settings wins over the quota project stored in the credential file.
      const quota = cfg.project.trim() || h.get('x-goog-user-project') || undefined;
      if (quota) out['x-goog-user-project'] = quota;
      return out;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      const e = toAdcError(err);
      // Stale credentials are the usual cause: pick up a fresh login on the next attempt.
      if (e.problem.code === 'adc_expired' || e.problem.code === 'adc_missing' || e.problem.code === 'adc_rejected') this.reset();
      throw e;
    }
  }

  async project(cfg: GoogleAuthConfig): Promise<{ project: string; source: NonNullable<GoogleAuthStatus['projectSource']> } | undefined> {
    const explicit = cfg.project.trim();
    if (explicit) return { project: explicit, source: 'provider' };
    for (const name of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'CLOUDSDK_CORE_PROJECT']) {
      const v = this.env[name]?.trim();
      if (v) return { project: v, source: 'environment' };
    }
    try {
      const auth = this.authObject();
      const client = await auth.getClient();
      if (client.quotaProjectId) return { project: client.quotaProjectId, source: 'adc' };
      const id = await auth.getProjectId();
      if (id) return { project: id, source: 'gcloud' };
    } catch {
      /* no project could be determined */
    }
    return undefined;
  }

  async status(cfg: GoogleAuthConfig): Promise<GoogleAuthStatus> {
    const t0 = performance.now();
    const base = { mode: cfg.mode, checkedAt: Date.now() };
    this.reset(); // the point of "Check sign-in" is to notice a fresh login
    try {
      const client = await this.authObject().getClient();
      await client.getAccessToken(); // forces a real token exchange: fails here if the login expired or was revoked
      const credential = kindOf(client);
      const proj = await this.project(cfg);
      const latencyMs = Math.round(performance.now() - t0);
      if (cfg.backend === 'vertex' && !proj) return { ...base, ok: false, credential, latencyMs, problem: problemFor('no_project') };
      return { ...base, ok: true, credential, project: proj?.project, projectSource: proj?.source, latencyMs };
    } catch (err) {
      return { ...base, ok: false, latencyMs: Math.round(performance.now() - t0), problem: toAdcError(err).problem };
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'that address';
  }
}
