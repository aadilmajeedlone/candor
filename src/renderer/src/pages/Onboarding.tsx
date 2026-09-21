import { ArrowRight, CheckCircle2, Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { googleBaseUrl } from '@shared/google';
import { keyMismatch } from '@shared/keys';
import { pickDefaultModels } from '@shared/models';
import type { GoogleAuthStatus, ModelListResult, ProviderView } from '@shared/types';
import { INTERVIEW_TYPES, type InterviewType } from '@shared/types';
import { CaptureError, startCapture, type CaptureHandle } from '@/audio/capture';
import { GoogleAuthPanel, GoogleSignInHelp } from '@/components/GoogleSignIn';
import { LocalSpeechPanel } from '@/components/LocalSpeech';
import { Busy, Meter, Notice } from '@/components/ui';
import { saveAndTestModels } from '@/lib/modelSetup';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { ResumePicker } from './Interviews';
import { PRESETS } from './settings/ProvidersTab';
import { guarded } from '@/lib/guarded';

const STEPS = ['Profile', 'Résumé', 'AI provider', 'Models', 'Microphone', 'First interview'];

export default function Onboarding() {
  const { settings, updateSettings, updateProfile, profile, navigate, toast } = useApp();
  const [step, setStep] = useState(settings?.onboarding.step ?? 0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // profile
  const [name, setName] = useState(profile?.name ?? '');
  const [summary, setSummary] = useState(profile?.summary ?? '');
  // résumé
  const [resume, setResume] = useState<Parameters<typeof ResumePicker>[0]['value']>({ kind: 'none' });
  const [resumeId, setResumeId] = useState<string | null>(null);
  // provider
  const [preset, setPreset] = useState('');
  const [key, setKey] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [project, setProject] = useState('');
  const [authStatus, setAuthStatus] = useState<GoogleAuthStatus | null>(null);
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<ModelListResult | null>(null);
  const [fast, setFast] = useState('');
  const [quality, setQuality] = useState('');
  const [fastAlt, setFastAlt] = useState<string[]>([]);
  const [qualityAlt, setQualityAlt] = useState<string[]>([]);
  // mic
  const [level, setLevel] = useState(0);
  const [micOk, setMicOk] = useState(false);
  // interview
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [type, setType] = useState<InterviewType>('general');
  const [jd, setJd] = useState('');

  const go = (n: number) => { setErr(null); setStep(n); void updateSettings({ onboarding: { step: n } }); };
  const finish = async () => { await updateSettings({ onboarding: { completed: true, step: 0 } }); };
  const p = PRESETS.find((x) => x.id === preset);

  // The guide remembers its step, so it can reopen at "Models" after a restart or an update, when this session has no
  // provider in memory. Rebuild it from what is saved (or go back to the provider step): never show a blank page.
  const latest = useRef({ settings, go });
  latest.current = { settings, go };
  useEffect(() => {
    if (step !== 3 || provider) return;
    let cancelled = false;
    void (async () => {
      try {
        const [providers, saved] = await Promise.all([call('providers.list'), call('models.list')]);
        if (cancelled) return;
        const routing = latest.current.settings?.routing;
        const live = saved.find((m) => m.id === routing?.live.primary);
        const prep = saved.find((m) => m.id === routing?.prep.primary);
        const chosen = providers.find((x) => x.id === live?.providerId) ?? providers[providers.length - 1];
        if (!chosen) {
          latest.current.go(2);
          return;
        }
        const listed = await call('providers.listModels', { id: chosen.id }).catch(() => null);
        if (cancelled) return;
        const known = listed?.ok ? listed.models : [];
        const preset = PRESETS.find((x) => x.baseUrl.replace(/\/+$/, '') === chosen.baseUrl.replace(/\/+$/, ''));
        const d = pickDefaultModels(chosen.kind, known, { fast: preset?.fast ?? '', quality: preset?.quality ?? '' });
        setProvider(chosen);
        setModels(listed?.ok ? listed : null);
        setFast(live?.model ?? d.fast);
        setQuality(prep?.model ?? d.quality);
        setFastAlt(d.fastAlternatives);
        setQualityAlt(d.qualityAlternatives);
      } catch (e) {
        if (!cancelled) setErr(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, provider]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  /** Save the provider, prove the credentials work, and list its models. Nothing is sent before the checks pass. */
  const connect = async () => {
    if (!p) return;
    const mismatch = p.google ? null : keyMismatch(p.kind, p.needsUrl ? serverUrl : p.baseUrl, key);
    if (mismatch) throw new Error(mismatch);
    const google = p.google ? { ...p.google, project: project.trim() } : undefined;
    const saved = await call('providers.save', {
      id: google && provider?.kind === 'google' ? provider.id : undefined,
      name: p.name ?? p.label.replace(/ \(.*\)$/, '').replace(/ — .*$/, ''),
      kind: p.kind,
      baseUrl: google ? googleBaseUrl(google) : p.needsUrl ? serverUrl.trim() : p.baseUrl,
      enabled: true,
      apiKey: key.trim() || undefined,
      google,
    });
    if (google) {
      const s = await call('providers.checkAuth', { id: saved.id });
      setAuthStatus(s);
      setProvider(saved);
      if (!s.ok) throw new Error(`${s.problem?.title ?? 'Google sign-in failed.'} The steps to fix it are below.`);
    }
    const m = await call('providers.listModels', { id: saved.id });
    if (!m.ok) {
      if (google) setProvider(saved); // keep it: fixing the sign-in and pressing Connect again should not start over
      else await call('providers.delete', { id: saved.id });
      throw new Error(m.error ?? 'Could not connect with that key.');
    }
    setProvider(saved);
    setModels(m);
    setKey('');
    const d = pickDefaultModels(p.kind, m.models, { fast: p.fast, quality: p.quality });
    setFast(d.fast);
    setQuality(d.quality);
    setFastAlt(d.fastAlternatives);
    setQualityAlt(d.qualityAlternatives);
    toast(`Connected — ${m.models.length} models available.`, 'ok');
    go(3);
  };

  const testMic = async () => {
    let h: CaptureHandle | null = null;
    setErr(null);
    try {
      h = await startCapture('mic', { deviceId: settings?.audio.micDeviceId, noiseSuppression: true, echoCancellation: false, autoGainControl: true }, () => undefined, (r) => { setLevel(r); if (r > 0.02) setMicOk(true); });
      await new Promise((r) => setTimeout(r, 4000));
    } catch (e) {
      setErr(e instanceof CaptureError ? e.message : errorMessage(e));
    } finally {
      await h?.stop();
      setLevel(0);
    }
  };

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label="Setup guide">
      <aside className="onb-side">
        <div className="brand" style={{ padding: 0 }}><div className="brand-mark" aria-hidden>C</div><span className="brand-name">Candor</span></div>
        <div>
          <h1 className="display" style={{ fontSize: '2.2rem' }}>Let’s get you set up.</h1>
          <p className="muted small" style={{ marginTop: 8 }}>Six short steps. Every one can be skipped and done later in Settings.</p>
        </div>
        <ol className="col" style={{ gap: 14, listStyle: 'none', padding: 0, margin: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s} className="onb-step" data-state={i === step ? 'current' : i < step ? 'done' : 'todo'}>
              <span className="dot" data-done={i < step}>{i < step ? <CheckCircle2 size={12} /> : i + 1}</span>{s}
            </li>
          ))}
        </ol>
        <div style={{ marginTop: 'auto' }}><button className="btn btn-ghost btn-sm" onClick={() => void finish()}>Skip setup</button></div>
      </aside>
      <main className="onb-main">
        <div style={{ maxWidth: 640 }} className="col">
          {err && <Notice tone="bad" onClose={() => setErr(null)}>{err}</Notice>}

          {step === 0 && (
            <>
              <h2 className="h1">About you</h2>
              <p className="muted">Candor answers as you, so it starts with who you are. Your résumé fills in the details next.</p>
              <div className="field"><label htmlFor="ob-name">Your name</label><input id="ob-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
              <div className="field"><label htmlFor="ob-sum">One-line professional summary <span className="faint">(optional)</span></label><textarea id="ob-sum" className="textarea" style={{ minHeight: 80 }} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Operations manager with 7 years running support and fulfilment teams." /></div>
              <div className="row"><button className="btn btn-primary btn-lg" onClick={guarded(async () => { await updateProfile({ name: name.trim(), summary: summary.trim() }); go(1); })}>Continue <ArrowRight /></button></div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="h1">Your résumé</h2>
              <p className="muted">Upload a PDF, DOCX or TXT (or paste the text). It is read on this PC and turned into small, checkable facts; Candor will never claim anything that isn’t in it.</p>
              <ResumePicker resumes={[]} value={resume} onChange={setResume} />
              <div className="row">
                <button className="btn btn-primary btn-lg" disabled={busy || resume.kind !== 'new'} onClick={() => void run(async () => { if (resume.kind !== 'new') return; const r = await call('resumes.create', { name: resume.doc.name, source: resume.doc.source, text: resume.doc.text, useAi: false }); setResumeId(r.id); toast(`Read ${r.profile.facts.length} facts from your résumé.`, 'ok'); go(2); })}>{busy ? <Busy /> : null} Continue <ArrowRight /></button>
                <button className="btn btn-ghost" onClick={() => go(2)}>Skip</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="h1">Connect an AI provider</h2>
              <p className="muted">Free options come first: a model on this PC (Ollama, LM Studio), a friend's GPU, or Google Gemini's free tier. Paid services need your own account and key (stored encrypted with Windows); Candor cannot see or limit what they bill.</p>
              <div className="field"><label htmlFor="ob-preset">Service</label><select id="ob-preset" className="select" value={preset} onChange={(e) => { setPreset(e.target.value); setAuthStatus(null); setErr(null); }}><option value="">Choose a service…</option>{PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>{p?.note && <div className="hint">{p.note}</div>}</div>
              {p?.needsUrl && <div className="field"><label htmlFor="ob-url">Server address</label><input id="ob-url" className="input mono" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={p.id === 'friend' ? 'http://192.168.1.50:8000/v1' : 'https://…/v1'} spellCheck={false} /></div>}
              {p && !p.local && !p.google && <div className="field"><label htmlFor="ob-key">API key</label><input id="ob-key" className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />{p.keyUrl && <div className="row"><button className="btn btn-sm btn-ghost" onClick={() => void call('app.openExternal', { url: p.keyUrl! })}>Where do I get a key?</button></div>}</div>}
              {p?.google && (
                <>
                  <div className="field"><label htmlFor="ob-project">Google Cloud project ID</label><input id="ob-project" className="input mono" value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-project-123" spellCheck={false} /><div className="hint">The project that is billed. Leave empty to use your gcloud default.</div></div>
                  <GoogleSignInHelp project={project} backend="vertex" />
                  {authStatus && <GoogleAuthPanel status={authStatus} />}
                </>
              )}
              <div className="row">
                <button className="btn btn-primary btn-lg" disabled={busy || !p || (!p.local && !p.google && !key.trim()) || (!!p.needsUrl && serverUrl.trim().length < 9)} onClick={() => void run(connect)}>{busy ? <Busy label={p?.google ? 'Checking sign-in…' : 'Connecting…'} /> : p?.google ? 'Check sign-in & connect' : 'Connect'} <ArrowRight /></button>
                <button className="btn btn-ghost" onClick={() => go(4)}>Skip</button>
              </div>
            </>
          )}

          {step === 3 && !provider && (
            <>
              <h2 className="h1">Choose your models</h2>
              <div className="row"><Busy label="Loading your AI provider…" /></div>
              <div className="row"><button className="btn btn-ghost" onClick={() => go(2)}>Back to AI provider</button></div>
            </>
          )}

          {step === 3 && provider && (
            <>
              <h2 className="h1">Choose your models</h2>
              <p className="muted">A <strong>fast</strong> model answers live questions (time to first word matters most). A <strong>stronger</strong> one prepares material and evaluates mock interviews. Each is the other’s fallback.</p>
              <datalist id="ob-models">{models?.models.map((m) => <option key={m} value={m} />)}</datalist>
              <div className="field"><label htmlFor="ob-fast">Live answers (fast)</label><input id="ob-fast" className="input mono" list="ob-models" value={fast} onChange={(e) => setFast(e.target.value)} /></div>
              <div className="field"><label htmlFor="ob-q">Preparation &amp; evaluation (quality)</label><input id="ob-q" className="input mono" list="ob-models" value={quality} onChange={(e) => setQuality(e.target.value)} /></div>
              <div className="row">
                <button className="btn btn-primary btn-lg" disabled={busy || !fast || !quality} onClick={() => void run(async () => {
                  try {
                    const r = await saveAndTestModels({ kind: provider.kind, providerId: provider.id, fast, quality, fastAlternatives: fastAlt, qualityAlternatives: qualityAlt });
                    setFast(r.fast);
                    setQuality(r.quality);
                    for (const n of r.notes) toast(n, 'info');
                    toast(`Live model answered its first word in ${r.latencyMs} ms.`, 'ok');
                    go(4);
                  } finally {
                    await useApp.getState().init(); // the routing is saved even when the test fails, so Settings shows the truth
                  }
                })}>{busy ? <Busy label="Testing…" /> : 'Save & test'} <ArrowRight /></button>
                <button className="btn btn-ghost" onClick={() => go(4)}>Skip</button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="h1">Microphone &amp; speech</h2>
              <p className="muted">Live audio needs permission to use the microphone. Speech is turned into text on this PC: free, private, no account or key. You can also type questions instead.</p>
              <div className="card col">
                <div className="row"><button className="btn" onClick={() => void testMic()}><Mic /> Test microphone</button><Meter level={level} label="Microphone level" />{micOk && <span className="small" style={{ color: 'var(--ok)' }}>Heard you ✓</span>}</div>
              </div>
              <div className="card"><LocalSpeechPanel withPreference={false} /></div>
              <p className="hint">Prefer a cloud speech service? It is optional: Settings → Speech recognition.</p>
              <div className="row"><button className="btn btn-primary btn-lg" onClick={() => go(5)}>Continue <ArrowRight /></button><button className="btn btn-ghost" onClick={() => go(5)}>Skip</button></div>
            </>
          )}

          {step === 5 && (
            <>
              <h2 className="h1">Your first interview</h2>
              <p className="muted">Paste the job description and Candor will compare it with your résumé and prepare you.</p>
              <div className="grid grid-2">
                <div className="field"><label htmlFor="ob-jt">Job title</label><input id="ob-jt" className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} /></div>
                <div className="field"><label htmlFor="ob-co">Company</label><input id="ob-co" className="input" value={company} onChange={(e) => setCompany(e.target.value)} /></div>
              </div>
              <div className="field"><label htmlFor="ob-type">Interview type</label><select id="ob-type" className="select" value={type} onChange={(e) => setType(e.target.value as InterviewType)}>{INTERVIEW_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
              <div className="field"><label htmlFor="ob-jd">Job description</label><textarea id="ob-jd" className="textarea" style={{ minHeight: 150 }} value={jd} onChange={(e) => setJd(e.target.value)} placeholder="Paste it here" /></div>
              <div className="row">
                <button className="btn btn-primary btn-lg" disabled={busy || (!jobTitle.trim() && jd.trim().length < 40)} onClick={() => void run(async () => {
                  const rid = resumeId ?? (await call('resumes.list'))[0]?.id ?? null;
                  const i = await call('interviews.create', { jobTitle: jobTitle.trim(), company: company.trim(), interviewType: type, jobDescription: jd, resumeId: rid });
                  const ai = !!useApp.getState().settings?.routing.prep.primary;
                  const a = await call('interviews.analyze', { id: i.id, useAi: ai });
                  useApp.getState().setActiveInterview(a.id);
                  await finish();
                  navigate('preparation', { interviewId: a.id });
                })}>{busy ? <Busy label="Analysing…" /> : 'Create & finish'} <ArrowRight /></button>
                <button className="btn btn-ghost" onClick={() => void finish()}>Finish without an interview</button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
