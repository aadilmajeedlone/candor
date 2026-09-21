import { CheckCircle2, ExternalLink, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { googleBaseUrl, usesAdc } from '@shared/google';
import { keyMismatch } from '@shared/keys';
import { pickDefaultModels } from '@shared/models';
import { endpointScope } from '@shared/net';
import type { GoogleAuthConfig, GoogleAuthStatus, ModelListResult, ProviderKind, ProviderView } from '@shared/types';
import { Busy, Empty, Modal, Notice, Pill, useConfirm } from '@/components/ui';
import { ScopePill } from '@/components/ActiveProviders';
import { GoogleAuthPanel, GoogleSignInHelp } from '@/components/GoogleSignIn';
import { useAsync } from '@/hooks/useAsync';
import { saveAndTestModels } from '@/lib/modelSetup';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  fast: string;
  quality: string;
  keyUrl?: string;
  local?: boolean;
  /** Present for presets that sign in with Google (Application Default Credentials) instead of an API key. */
  google?: GoogleAuthConfig;
  /** Name given to the provider when it differs from the label. */
  name?: string;
  /** The address is the user's own (a friend's server, a custom endpoint): it must be typed in. */
  needsUrl?: boolean;
  /** What to know before choosing it: cost, limits, privacy. */
  note?: string;
}

/** Starting points only. The real model list is fetched from the provider with your key (or sign-in). */
export const PRESETS: Preset[] = [
  // Free options first: nothing here needs an account or a card.
  { id: 'ollama', label: 'Ollama — runs on this PC (free)', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', fast: 'llama3.2', quality: 'llama3.1', local: true, note: 'Free and private: nothing leaves this PC. Install Ollama, run "ollama pull llama3.2", then Test & fetch models. Without a GPU, expect several seconds before the first word; a small model (1–3 billion parameters) is the practical choice on a laptop.' },
  { id: 'lmstudio', label: 'LM Studio — runs on this PC (free)', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', fast: '', quality: '', local: true, note: 'Free and private. In LM Studio, load a model and start its local server, then Test & fetch models.' },
  { id: 'friend', name: "Friend's GPU", label: "A friend's GPU or your own server — OpenAI-compatible (free)", kind: 'openai-compatible', baseUrl: 'http://', fast: '', quality: '', local: true, needsUrl: true, note: 'For vLLM, llama.cpp (llama-server), Ollama or LM Studio running on another machine. Enter its address, for example http://192.168.1.50:8000/v1 on the same network or http://100.x.y.z:8000/v1 over Tailscale. Across the internet the address must be https:// (a Cloudflare Tunnel or ngrok URL works). An API key is only needed if that server asks for one.' },
  // Free tier with an account (no card): limited, and the provider may use the content.
  { id: 'google', label: 'Google Gemini — API key (free tier available)', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com', fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro', keyUrl: 'https://aistudio.google.com/apikey', note: 'A key from Google AI Studio can use the free tier: no card, low limits, and on the free tier Google may use your content to improve its products. In AI Studio, check that the key\'s project says free of charge and not "billing enabled", or requests may be billed. Some organisations block API keys.' },
  { id: 'groq', label: 'Groq — very fast (has a free plan)', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', fast: 'llama-3.1-8b-instant', quality: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', note: 'Groq offers a rate-limited free plan. Check their current limits and terms.' },
  { id: 'openrouter', label: 'OpenRouter — some models are free', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', fast: 'openai/gpt-4o-mini', quality: 'anthropic/claude-sonnet-4.5', keyUrl: 'https://openrouter.ai/keys', note: 'Models whose id ends in ":free" cost nothing but have daily limits. Any other model is billed from your credits, so pick a ":free" model to stay free.' },
  // Paid: billed by the provider, separately from any chat subscription.
  { id: 'google-adc', label: 'Google Gemini — sign in with gcloud, no API key (Vertex AI: needs billing)', kind: 'google', baseUrl: 'https://aiplatform.googleapis.com', fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro', google: { mode: 'adc', backend: 'vertex', project: '', location: 'global' }, note: 'Vertex AI is billed by Google, so it needs a Google Cloud project with billing switched on. Candor never switches billing on for you. If you do not want to pay, use the AI Studio API key above or a local model.' },
  { id: 'openai', label: 'OpenAI (paid — prepaid credit)', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', fast: 'gpt-4.1-mini', quality: 'gpt-4.1', keyUrl: 'https://platform.openai.com/api-keys', note: 'API use is billed separately from a ChatGPT subscription.' },
  { id: 'anthropic', label: 'Anthropic Claude (paid — prepaid credit)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', fast: 'claude-haiku-4-5-20251001', quality: 'claude-sonnet-5', keyUrl: 'https://console.anthropic.com/settings/keys', note: 'API use is billed separately from a Claude Pro or Max subscription.' },
  { id: 'custom', label: 'Other OpenAI-compatible…', kind: 'openai-compatible', baseUrl: 'https://', fast: '', quality: '', needsUrl: true },
];

const KIND_LABEL: Record<ProviderKind, string> = { 'openai-compatible': 'OpenAI-compatible', anthropic: 'Anthropic', google: 'Google' };

export function ProvidersTab() {
  const providers = useAsync(() => call('providers.list'), []);
  const models = useAsync(() => call('models.list'), []);
  const toast = useApp((s) => s.toast);
  const [editing, setEditing] = useState<Partial<ProviderView> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Record<string, ModelListResult>>({});
  const [auth, setAuth] = useState<Record<string, GoogleAuthStatus>>({});
  const { ask, dialog } = useConfirm();

  const list = providers.data ?? [];

  const fetchModels = async (id: string) => {
    setBusy(id);
    const r = await call('providers.listModels', { id }).catch((e) => ({ ok: false, models: [], error: errorMessage(e) }));
    setFetched((f) => ({ ...f, [id]: r }));
    setBusy(null);
    if (r.ok) toast(`Connected — ${r.models.length} models available.`, 'ok');
    else toast(r.error ?? 'Could not reach the provider.', 'bad');
    return r;
  };

  const checkSignIn = async (id: string) => {
    setBusy(id);
    try {
      const s = await call('providers.checkAuth', { id });
      setAuth((a) => ({ ...a, [id]: s }));
      if (s.ok) toast('Google sign-in works.', 'ok');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack-lg">
      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">AI providers</h2>
            <p className="hint">Candor never ships with a key. Add your own (encrypted with Windows, never shown again), or sign in with Google and use no key at all.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing({ kind: 'openai-compatible', enabled: true })}><Plus /> Add provider</button>
        </div>
        {providers.loading && !providers.data ? <Busy /> : list.length === 0 ? (
          <Empty icon={<KeyRound />} title="No provider yet">Free options: a local model (Ollama or LM Studio), a friend's GPU, or Google Gemini's free tier. OpenAI and Anthropic are paid.</Empty>
        ) : (
          <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            {list.map((p) => {
              const f = fetched[p.id];
              const a = auth[p.id];
              const signIn = usesAdc(p);
              return (
                <div key={p.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{p.name}</strong>
                      <Pill>{KIND_LABEL[p.kind]}</Pill>
                      <ScopePill scope={p.scope} />
                      {signIn && <Pill tone="info"><ShieldCheck /> Google sign-in{p.google?.project ? ` · ${p.google.project}` : ''}</Pill>}
                      {p.keySource === 'stored' && <Pill tone="ok"><CheckCircle2 /> key {p.keyHint}{signIn ? ' (fallback)' : ''}</Pill>}
                      {p.keySource === 'env' && <Pill tone="info">key from environment</Pill>}
                      {p.keySource === 'none' && !signIn && (p.keyOptional ? <Pill>no key needed</Pill> : <Pill tone="warn">no key</Pill>)}
                      {!p.enabled && <Pill>disabled</Pill>}
                    </div>
                    <div className="small faint mono truncate" style={{ marginTop: 4 }}>{p.baseUrl}</div>
                    {f && !(a && !a.ok && signIn) && (f.ok ? (
                      <div className="small" style={{ color: 'var(--ok)', marginTop: 4 }}>{f.models.length} models found{f.note ? <span className="faint"> — {f.note}</span> : null}</div>
                    ) : (
                      <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>{f.error}</div>
                    ))}
                    {a && <div style={{ marginTop: 8 }}><GoogleAuthPanel status={a} /></div>}
                  </div>
                  <div className="row">
                    {signIn && <button className="btn btn-sm" onClick={() => void checkSignIn(p.id)} disabled={busy === p.id}>{busy === p.id ? <Busy /> : <ShieldCheck />} Check sign-in</button>}
                    <button className="btn btn-sm" onClick={() => void fetchModels(p.id)} disabled={busy === p.id}>{busy === p.id ? <Busy /> : <RefreshCw />} Test &amp; fetch models</button>
                    <button className="btn btn-sm" onClick={() => setEditing(p)}>Edit</button>
                    <button
                      className="btn btn-sm btn-danger btn-icon"
                      aria-label={`Delete ${p.name}`}
                      onClick={guarded(async () => {
                        if (await ask('Remove this provider?', 'Its stored key and any model settings that use it will be deleted.', { confirm: 'Remove', danger: true })) {
                          await call('providers.delete', { id: p.id });
                          void providers.reload();
                          void models.reload();
                        }
                      })}
                    >
                      <Trash2 />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {list.length > 0 && <QuickSetup providers={list} fetched={fetched} fetchModels={fetchModels} onDone={() => { void models.reload(); void useApp.getState().init(); }} />}

      <ProviderForm
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={async (p) => {
          setEditing(null);
          await providers.reload();
          if (usesAdc(p)) await checkSignIn(p.id);
          await fetchModels(p.id);
        }}
      />
      {dialog}
    </div>
  );
}

function QuickSetup({ providers, fetched, fetchModels, onDone }: { providers: ProviderView[]; fetched: Record<string, ModelListResult>; fetchModels: (id: string) => Promise<ModelListResult>; onDone: () => void }) {
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);
  const [pid, setPid] = useState(providers[0]?.id ?? '');
  const provider = providers.find((p) => p.id === pid);
  const preset = PRESETS.find((x) => provider && x.baseUrl.replace(/\/+$/, '') === provider.baseUrl.replace(/\/+$/, ''));
  const list = fetched[pid]?.models ?? [];
  const [fast, setFast] = useState('');
  const [quality, setQuality] = useState('');
  const [saving, setSaving] = useState(false);
  const kind = provider?.kind ?? 'openai-compatible';
  // With a real model list, suggest from it (newest suitable models first for Google); before that, from the preset.
  const suggested = list.length > 0 ? pickDefaultModels(kind, list, { fast: list[0] ?? '', quality: list[list.length - 1] ?? '' }) : { fast: preset?.fast ?? '', quality: preset?.quality ?? '', fastAlternatives: [], qualityAlternatives: [] };
  const fastV = fast || suggested.fast;
  const qualV = quality || suggested.quality;
  const configured = !!settings?.routing.live.primary;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2 className="h2">Quick setup {configured && <Pill tone="ok"><CheckCircle2 /> configured</Pill>}</h2>
          <p className="hint">Pick a fast model for live answers and a stronger one for preparation. Each falls back to the other if it fails.</p>
        </div>
      </div>
      <div className="grid grid-3">
        <div className="field">
          <label htmlFor="qs-provider">Provider</label>
          <select id="qs-provider" className="select" value={pid} onChange={(e) => { setPid(e.target.value); setFast(''); setQuality(''); }}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="qs-fast">Live answers (fast)</label>
          <input id="qs-fast" className="input mono" list="qs-models" value={fastV} onChange={(e) => setFast(e.target.value)} placeholder="model id" />
        </div>
        <div className="field">
          <label htmlFor="qs-quality">Preparation (quality)</label>
          <input id="qs-quality" className="input mono" list="qs-models" value={qualV} onChange={(e) => setQuality(e.target.value)} placeholder="model id" />
        </div>
      </div>
      <datalist id="qs-models">{list.map((m) => <option key={m} value={m} />)}</datalist>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => void fetchModels(pid)}><RefreshCw /> Refresh model list</button>
        <button
          className="btn btn-primary"
          disabled={!fastV || !qualV || saving}
          onClick={guarded(async () => {
            setSaving(true);
            try {
              const r = await saveAndTestModels({ kind, providerId: pid, fast: fastV, quality: qualV, fastAlternatives: suggested.fastAlternatives, qualityAlternatives: suggested.qualityAlternatives });
              setFast(r.fast);
              setQuality(r.quality);
              for (const n of r.notes) toast(n, 'info');
              toast(`Ready. Live model answered its first word in ${r.latencyMs} ms.`, 'ok');
              onDone();
            } catch (e) {
              toast(errorMessage(e), 'bad');
              onDone();
            } finally {
              setSaving(false);
            }
          })}
        >
          {saving ? <Busy /> : <Zap />} Save &amp; test
        </button>
      </div>
      {list.length === 0 && <p className="hint" style={{ marginTop: 8 }}>Tip: press “Test &amp; fetch models” above to fill these from your provider’s real list.</p>}
      {kind === 'google' && <p className="hint" style={{ marginTop: 8 }}>If Google reports no quota for a model, Candor tries the other suitable Gemini models and tells you which one it chose.</p>}
    </div>
  );
}

const DEFAULT_GOOGLE: GoogleAuthConfig = { mode: 'adc', backend: 'vertex', project: '', location: 'global' };

function ProviderForm({ value, onClose, onSaved }: { value: Partial<ProviderView> | null; onClose: () => void; onSaved: (p: ProviderView) => Promise<void> }) {
  const toast = useApp((s) => s.toast);
  const [preset, setPreset] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [google, setGoogle] = useState<GoogleAuthConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seen, setSeen] = useState<Partial<ProviderView> | null>(null);
  if (value !== seen) {
    setSeen(value);
    if (value) {
      setPreset('');
      setName(value.name ?? '');
      setKind(value.kind ?? 'openai-compatible');
      setBaseUrl(value.baseUrl ?? '');
      setApiKey('');
      setEnabled(value.enabled ?? true);
      setGoogle(value.google?.mode === 'adc' ? value.google : null);
      setError(null);
    }
  }
  const isNew = !value?.id;
  const chosen = PRESETS.find((p) => p.id === preset);
  const signIn = kind === 'google' && google !== null; // Google sign-in instead of an API key
  const applyGoogle = (g: GoogleAuthConfig | null) => {
    setGoogle(g);
    if (g) setBaseUrl(googleBaseUrl(g));
  };
  const applyPreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (p) {
      setName(p.name ?? p.label.replace(/ \(.*\)$/, '').replace(/ — .*$/, ''));
      setKind(p.kind);
      setBaseUrl(p.baseUrl);
      setGoogle(p.google ?? null);
    }
  };
  const keyOptional = signIn || chosen?.local || endpointScope(baseUrl) !== 'internet';
  const mismatch = keyMismatch(kind, baseUrl, apiKey);

  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title={isNew ? 'Add a provider' : 'Edit provider'}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={saving || !name.trim() || !baseUrl.trim() || (isNew && !keyOptional && !apiKey.trim()) || !!mismatch}
            onClick={guarded(async () => {
              setSaving(true);
              setError(null);
              try {
                const p = await call('providers.save', { id: value?.id, name: name.trim(), kind, baseUrl: baseUrl.trim(), enabled, apiKey: apiKey.trim() || undefined, google: signIn && google ? { ...google, project: google.project.trim(), location: google.location.trim() } : undefined });
                await onSaved(p);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setSaving(false);
              }
            })}
          >
            {saving ? <Busy /> : null} Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {error && <Notice tone="bad">{error}</Notice>}
        {mismatch && <Notice tone="warn">{mismatch}</Notice>}
        {isNew && (
          <div className="field">
            <label htmlFor="prv-preset">Start from</label>
            <select id="prv-preset" className="select" value={preset} onChange={(e) => applyPreset(e.target.value)}>
              <option value="">Choose a service…</option>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {chosen?.note && <div className="hint">{chosen.note}</div>}
          </div>
        )}
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="prv-name">Name</label>
            <input id="prv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="prv-kind">API type</label>
            <select id="prv-kind" className="select" value={kind} onChange={(e) => { const k = e.target.value as ProviderKind; setKind(k); if (k !== 'google') setGoogle(null); }}>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini</option>
            </select>
          </div>
        </div>

        {kind === 'google' && (
          <div className="field">
            <label htmlFor="prv-signin">How do you sign in to Google?</label>
            <select id="prv-signin" className="select" value={signIn ? 'adc' : 'apiKey'} onChange={(e) => applyGoogle(e.target.value === 'adc' ? { ...DEFAULT_GOOGLE, ...(google ?? {}) } : null)}>
              <option value="apiKey">API key (from Google AI Studio)</option>
              <option value="adc">Google account — Application Default Credentials (no API key)</option>
            </select>
            {signIn && <div className="hint">Use this if your organisation blocks API keys, or you would rather not handle one. Candor never sees or stores your Google password or tokens beyond memory.</div>}
          </div>
        )}

        {signIn && google && (
          <>
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="prv-backend">Endpoint</label>
                <select id="prv-backend" className="select" value={google.backend} onChange={(e) => applyGoogle({ ...google, backend: e.target.value as GoogleAuthConfig['backend'] })}>
                  <option value="vertex">Vertex AI (recommended)</option>
                  <option value="gemini-api">Gemini API (own OAuth client)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="prv-project">Project ID</label>
                <input id="prv-project" className="input mono" value={google.project} onChange={(e) => setGoogle({ ...google, project: e.target.value })} placeholder="my-project-123" spellCheck={false} />
                <div className="hint">The Google Cloud project that is billed. Leave empty to use your gcloud default.</div>
              </div>
            </div>
            {google.backend === 'vertex' && (
              <div className="field" style={{ maxWidth: 260 }}>
                <label htmlFor="prv-location">Region</label>
                <input id="prv-location" className="input mono" value={google.location} onChange={(e) => applyGoogle({ ...google, location: e.target.value })} placeholder="global" spellCheck={false} />
                <div className="hint">“global” works for most models; otherwise e.g. us-central1.</div>
              </div>
            )}
            <GoogleSignInHelp project={google.project} backend={google.backend} />
          </>
        )}

        <div className="field">
          <label htmlFor="prv-url">Base URL</label>
          <input id="prv-url" className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} readOnly={signIn} placeholder="https://api.example.com/v1" spellCheck={false} />
          <div className="hint">{signIn ? 'Set automatically. Google sign-in is only ever used with Google’s own addresses.' : 'https only — plain http is accepted for local servers (Ollama, LM Studio).'}</div>
        </div>
        <div className="field">
          <label htmlFor="prv-key">API key {signIn ? <span className="faint">(optional — only used if no Google sign-in is found)</span> : keyOptional && <span className="faint">(optional for local servers)</span>}</label>
          <input id="prv-key" className="input mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={!isNew && value?.keySource === 'stored' ? `Stored ${value.keyHint} — leave blank to keep` : signIn ? 'Leave empty to use Google sign-in only' : 'Paste your key'} />
          <div className="row small">
            <span className="hint">Encrypted with Windows before it is saved. It cannot be read back.</span>
            {chosen?.keyUrl && !signIn && (
              <button className="btn btn-sm btn-ghost" onClick={() => void call('app.openExternal', { url: chosen.keyUrl! }).catch((e: unknown) => toast(errorMessage(e), 'bad'))}><ExternalLink /> Get a key</button>
            )}
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
      </div>
    </Modal>
  );
}
