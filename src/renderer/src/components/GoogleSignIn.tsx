import { Copy } from 'lucide-react';
import type { GoogleAuthStatus } from '@shared/types';
import { Notice } from '@/components/ui';
import { useApp } from '@/store/app';

/** A command the user is meant to paste into a terminal, with a copy button. */
function Command({ text }: { text: string }) {
  const toast = useApp((s) => s.toast);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.', 'ok');
    } catch {
      toast('Could not copy. Select the command and press Ctrl+C.', 'bad');
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <code className="mono small" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 8px', userSelect: 'all', overflowWrap: 'anywhere', minWidth: 0 }}>{text}</code>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Copy ${text}`} onClick={() => void copy()}><Copy /></button>
    </span>
  );
}

/** Windows set-up steps for Google sign-in (Application Default Credentials). Commands are filled in with the project typed by the user. */
export function GoogleSignInHelp({ project, backend }: { project: string; backend: 'vertex' | 'gemini-api' }) {
  const p = project.trim() || 'YOUR_PROJECT_ID';
  const service = backend === 'vertex' ? 'aiplatform.googleapis.com' : 'generativelanguage.googleapis.com';
  return (
    <div className="card" style={{ background: 'var(--bg)' }}>
      <h3 className="h3" style={{ marginBottom: 6 }}>Sign in with your Google account (Windows)</h3>
      <p className="hint" style={{ marginBottom: 10 }}>Candor uses Google’s Application Default Credentials: no API key is needed or stored. Run these in a terminal (PowerShell):</p>
      <ol className="col" style={{ gap: 10, paddingLeft: 20, margin: 0 }}>
        <li>Install the Google Cloud CLI once, then open a <strong>new</strong> terminal: <Command text="winget install -e --id Google.CloudSDK" /></li>
        <li>Let the gcloud tool itself run the next commands (a browser window opens): <Command text="gcloud auth login" /></li>
        <li>Sign in for apps like Candor (a browser window opens again): <Command text="gcloud auth application-default login" /></li>
        <li>Pick your project: <Command text={`gcloud config set project ${p}`} /></li>
        <li>Bill that project for requests: <Command text={`gcloud auth application-default set-quota-project ${p}`} /></li>
        <li>Turn the API on: <Command text={`gcloud services enable ${service} --project ${p}`} /></li>
        <li>Press <strong>Check sign-in</strong>.</li>
      </ol>
      <p className="hint" style={{ marginTop: 10 }}>
        {backend === 'vertex'
          ? 'Your account also needs the “Vertex AI User” role on the project, and the project needs a billing account.'
          : 'The Gemini API endpoint additionally needs your own OAuth client (see docs/GOOGLE-ADC.md). Vertex AI is simpler.'}
      </p>
    </div>
  );
}

const CREDENTIAL_LABEL: Record<NonNullable<GoogleAuthStatus['credential']>, string> = {
  user: 'your Google account',
  'service-account': 'a service account',
  'external-account': 'workload identity federation',
  impersonated: 'an impersonated service account',
  compute: 'this machine’s attached service account',
  other: 'Application Default Credentials',
};
const SOURCE_LABEL: Record<NonNullable<GoogleAuthStatus['projectSource']>, string> = { provider: 'set here', environment: 'from GOOGLE_CLOUD_PROJECT', adc: 'the quota project of your sign-in', gcloud: 'gcloud’s default project' };

/** The result of "Check sign-in": what was found, or exactly what to do next. Never shows a token. */
export function GoogleAuthPanel({ status }: { status: GoogleAuthStatus }) {
  if (status.ok) {
    return (
      <Notice tone="ok" compact>
        Signed in with {status.credential ? CREDENTIAL_LABEL[status.credential] : 'Application Default Credentials'}
        {status.project ? <> · billing project <strong>{status.project}</strong>{status.projectSource ? ` (${SOURCE_LABEL[status.projectSource]})` : ''}</> : null}
        {status.latencyMs !== undefined ? ` · token ready in ${status.latencyMs} ms` : ''}
      </Notice>
    );
  }
  const p = status.problem;
  if (!p) return <Notice tone="bad" compact>Sign-in check failed.</Notice>;
  return (
    <Notice tone="bad">
      <strong>{p.title}</strong> {p.detail}
      {p.steps.length > 0 && (
        <ol className="col" style={{ gap: 6, paddingLeft: 20, margin: '8px 0 0' }}>
          {p.steps.map((s) => {
            const m = /^(.*?)(?:Run: |: )((?:gcloud|winget) .+)$/.exec(s);
            return <li key={s}>{m ? <>{m[1]}{m[1] ? ' ' : ''}<Command text={m[2] ?? ''} /></> : s}</li>;
          })}
        </ol>
      )}
    </Notice>
  );
}
