import { AiError } from '@shared/errors';
import { LOGIN_COMMAND } from './googleAuth';
import { mapHttpError } from './errors';
import { redact } from '../logging';
import type { GoogleAuthConfig } from '@shared/types';

/** What Google puts in an error response (google.rpc.Status with typed details). */
export interface GoogleErrorDetail {
  status?: string;
  message: string;
  reasons: string[];
  metadata: Record<string, string>;
  quota: { metric: string; id?: string; model?: string; value?: string }[];
}

export function parseGoogleError(text: string): GoogleErrorDetail {
  const out: GoogleErrorDetail = { message: text.trim().slice(0, 400), reasons: [], metadata: {}, quota: [] };
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown; status?: unknown; details?: unknown } } | { message?: unknown }[];
    const e = (Array.isArray(j) ? (j[0] as { error?: unknown } | undefined)?.error : (j as { error?: unknown }).error) as { message?: unknown; status?: unknown; details?: unknown } | undefined;
    if (!e || typeof e !== 'object') return out;
    if (typeof e.message === 'string') out.message = e.message;
    if (typeof e.status === 'string') out.status = e.status;
    if (Array.isArray(e.details)) {
      for (const d of e.details as Record<string, unknown>[]) {
        if (typeof d.reason === 'string') out.reasons.push(d.reason);
        if (d.metadata && typeof d.metadata === 'object') Object.assign(out.metadata, d.metadata);
        if (Array.isArray(d.violations)) {
          for (const v of d.violations as Record<string, unknown>[]) {
            const dims = (v.quotaDimensions ?? {}) as Record<string, unknown>;
            if (typeof v.quotaMetric === 'string') {
              out.quota.push({ metric: v.quotaMetric, id: typeof v.quotaId === 'string' ? v.quotaId : undefined, model: typeof dims.model === 'string' ? dims.model : undefined, value: typeof v.quotaValue === 'string' || typeof v.quotaValue === 'number' ? String(v.quotaValue) : undefined });
            }
          }
        }
      }
    }
  } catch {
    /* not JSON */
  }
  out.message = redact(out.message).slice(0, 400);
  return out;
}

export interface GoogleErrorContext {
  provider: string;
  cfg: GoogleAuthConfig;
  project?: string;
  model?: string;
}

/**
 * Turn a Google API failure into a short message that says what to do. Falls back to the generic mapping
 * for anything not specifically recognised.
 */
export function mapGoogleHttpError(status: number, bodyText: string, retryAfter: string | null, ctx: GoogleErrorContext): AiError {
  const d = parseGoogleError(bodyText);
  const m = d.message.toLowerCase();
  const has = (reason: string): boolean => d.reasons.includes(reason);
  const vertex = ctx.cfg.backend === 'vertex';
  const adc = ctx.cfg.mode === 'adc';
  const service = vertex ? 'aiplatform.googleapis.com' : 'generativelanguage.googleapis.com';
  const apiName = vertex ? 'Vertex AI' : 'Generative Language';
  const project = ctx.project || d.metadata.consumer?.replace(/^projects\//, '') || 'YOUR_PROJECT_ID';
  const auth = (message: string): AiError => new AiError('auth', message, { status, retryable: false });

  // An organisation policy that forbids API keys: the fix is to sign in instead.
  if (/api keys? (are|is) disallowed|disallows api keys/i.test(d.message)) {
    return auth('Your organisation does not allow API keys. Use “Google Gemini — sign in with gcloud” instead (Settings → AI Providers) — note that Vertex AI needs a project with billing.');
  }

  if (status === 401 || status === 403) {
    if (has('SERVICE_DISABLED') || (/has not been used in project|is disabled/.test(m) && /api/.test(m))) {
      return auth(`The ${apiName} API is turned off for project ${project}. Run: gcloud services enable ${service} --project ${project} — wait a minute, then try again.`);
    }
    if (has('BILLING_DISABLED') || (/billing/.test(m) && /(enable|disabled|account)/.test(m))) {
      return auth(`Billing is not enabled for project ${project}${vertex ? ', and Vertex AI needs a billing account' : ''}. Link one in the Google Cloud console, then try again.`);
    }
    if (has('USER_PROJECT_DENIED') || /serviceusage\.services\.use|permission to use project/.test(m)) {
      return auth(`Your Google account may not use project ${project} for quota. Ask an admin for the “Service Usage Consumer” role there, or use another project: gcloud auth application-default set-quota-project ${project}`);
    }
    if (has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/.test(m)) {
      return auth(
        vertex
          ? `This sign-in lacks the needed permission scope. Sign in again: ${LOGIN_COMMAND}`
          : `The Gemini API endpoint needs an OAuth client. Follow Google's “OAuth quickstart”, or use Vertex AI (recommended) — see docs/GOOGLE-ADC.md.`,
      );
    }
    if (has('ACCESS_TOKEN_TYPE_UNSUPPORTED')) {
      return auth(adc ? `Google does not accept this credential type on this endpoint. Try the Vertex AI backend with gcloud sign-in.` : `Google does not accept this kind of API key on this endpoint. Use “Google Gemini — sign in with gcloud” (Vertex AI, which needs billing) instead.`);
    }
    if (has('API_KEY_INVALID') || /api key not valid|api_key_invalid/.test(m)) {
      return auth('Google rejected the API key. Check that it was copied completely and belongs to a project with the Gemini API enabled — or sign in with gcloud instead.');
    }
    if (has('IAM_PERMISSION_DENIED') || /permission .*denied|aiplatform\.\w+\.\w+/.test(m)) {
      return auth(`Your account is not allowed to call ${apiName} in project ${project}${vertex ? ' — it needs the “Vertex AI User” role (roles/aiplatform.user)' : ''}. Ask a project admin.`);
    }
    if (adc) {
      return auth(status === 401 ? `Google rejected your sign-in. Sign in again: ${LOGIN_COMMAND}` : `Google refused the request${d.message ? `: ${d.message.slice(0, 160)}` : '.'}`);
    }
  }

  if (status === 429 || d.status === 'RESOURCE_EXHAUSTED') {
    const q = d.quota[0];
    const model = q?.model ?? ctx.model ?? 'this model';
    // Google states the limit either as a structured value or only in the text ("… limit: 0, model: …").
    const limit = q?.value ?? /limit:\s*(\d+)/i.exec(d.message)?.[1];
    if (q && /free_?tier/i.test(q.metric) && limit === '0') {
      return new AiError('rate_limit', `Google's free tier gives “${model}” no quota on this project (a free-tier limit, not a payment problem). Pick another model in Settings → Models — a Flash-Lite one usually has the most — or use a local model. Turning on billing would make usage paid; Candor never does that for you.`, { status, retryable: false, reason: 'free-tier-no-quota' });
    }
    if (q && /per_?day/i.test(`${q.metric} ${q.id ?? ''}`)) {
      return new AiError('rate_limit', `The daily limit for “${model}” is used up (it resets at midnight Pacific time). Pick another model in Settings → Models, or wait.`, { status, retryable: false });
    }
  }

  if (status === 404 && vertex && /model/.test(m)) {
    return new AiError('model_not_found', `“${ctx.model ?? 'That model'}” is not available in ${ctx.cfg.location || 'global'} for project ${project}. Try location “global”, or another model.`, { status, retryable: false });
  }

  return mapHttpError(status, bodyText, retryAfter, ctx.provider);
}
