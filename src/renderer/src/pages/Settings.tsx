import { CheckCircle2, Download, Gauge, KeyRound, Mic, Play, RotateCcw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ANSWER_MODES, MODE_ORDER } from '@shared/modes';
import { DEFAULT_SETTINGS, HOTKEY_ACTIONS, HOTKEY_LABELS, type HotkeyAction } from '@shared/settings';
import { sttLabel, type SttTestResult } from '@shared/speech';
import type { AnswerMode, CloudSttProviderId, SttProviderId } from '@shared/types';
import type { BenchResult } from '@shared/ipc';
import { formatMs } from '@shared/util';
import { CaptureError, listMicrophones, startCapture, type CaptureHandle } from '@/audio/capture';
import { LocalSpeechPanel } from '@/components/LocalSpeech';
import { Busy, Meter, Notice, Pill, SettingRow, Switch, TagInput, useConfirm } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage, subscribe } from '@/services/api';
import { useApp } from '@/store/app';
import { ModelsTab } from './settings/ModelsTab';
import { ProvidersTab } from './settings/ProvidersTab';
import { guarded } from '@/lib/guarded';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'profile', label: 'Profile' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'audio', label: 'Audio' },
  { id: 'providers', label: 'AI Providers' },
  { id: 'models', label: 'Models' },
  { id: 'speech', label: 'Speech recognition' },
  { id: 'hotkeys', label: 'Hotkeys' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'storage', label: 'Storage' },
  { id: 'performance', label: 'Performance' },
  { id: 'notifications', label: 'Notifications' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function Settings() {
  const params = useApp((s) => s.params);
  const [tab, setTab] = useState<TabId>((params.settingsTab as TabId) ?? 'general');
  useEffect(() => {
    if (params.settingsTab) setTab(params.settingsTab as TabId);
  }, [params.settingsTab]);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1 className="h1">{TABS.find((t) => t.id === tab)?.label}</h1>
        </div>
      </div>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} aria-current={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          {tab === 'general' && <General />}
          {tab === 'profile' && <Profile />}
          {tab === 'appearance' && <Appearance />}
          {tab === 'audio' && <Audio />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'models' && <ModelsTab />}
          {tab === 'speech' && <Speech />}
          {tab === 'hotkeys' && <Hotkeys />}
          {tab === 'privacy' && <Privacy />}
          {tab === 'storage' && <Storage />}
          {tab === 'performance' && <Performance />}
          {tab === 'notifications' && <Notifications />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function General() {
  const { settings, updateSettings } = useApp();
  const [custom, setCustom] = useState(settings?.customInstructions ?? '');
  if (!settings) return null;
  return (
    <div className="card">
      <SettingRow title="Default answer mode" hint="Used when a live session starts. You can switch instantly with Alt+1…7.">
        <select className="select" aria-label="Default answer mode" value={settings.defaultMode} onChange={(e) => void updateSettings({ defaultMode: e.target.value as AnswerMode })}>
          {MODE_ORDER.map((m) => <option key={m} value={m}>{ANSWER_MODES[m].label} — {ANSWER_MODES[m].blurb}</option>)}
        </select>
      </SettingRow>
      <SettingRow title="Answer while the interviewer is still finishing" hint="Speculative generation: Candor starts drafting once a complete question is recognised and restarts if it changes. This is the biggest latency saver; it costs a few extra tokens when a draft is discarded.">
        <select className="select" aria-label="Speculation" value={settings.live.speculation} onChange={(e) => void updateSettings({ live: { speculation: e.target.value as 'off' | 'balanced' | 'aggressive' } })}>
          <option value="off">Off — wait for the end of the question</option>
          <option value="balanced">Balanced (recommended)</option>
          <option value="aggressive">Aggressive — fastest, more restarts</option>
        </select>
      </SettingRow>
      <SettingRow title="Answer automatically" hint="When off, Candor only shows the detected question and waits for the “Answer” shortcut.">
        <Switch checked={settings.live.autoAnswer} onChange={(v) => void updateSettings({ live: { autoAnswer: v } })} label="Answer automatically" />
      </SettingRow>
      <SettingRow title="Pre-warm the model connection" hint="Opens the network connection and primes the provider’s prompt cache when a session starts, saving a few hundred milliseconds on the first question. Sends your compact profile once, as the first question would.">
        <Switch checked={settings.live.prewarm} onChange={(v) => void updateSettings({ live: { prewarm: v } })} label="Pre-warm" />
      </SettingRow>
      <SettingRow title="Hold-off after an answer" hint="After an answer appears, Candor ignores weak question-like speech for this long, so your own reply is not mistaken for a new question.">
        <div className="row"><input className="input" style={{ width: 90 }} type="number" min={0} max={30} step={1} aria-label="Hold-off seconds" value={settings.live.answerHoldMs / 1000} onChange={(e) => void updateSettings({ live: { answerHoldMs: Math.max(0, Math.min(30, Number(e.target.value))) * 1000 } })} /><span className="muted small">seconds</span></div>
      </SettingRow>
      <SettingRow title="Keep the window on top" hint="Useful while a video call is in front. Candor does not hide itself from screen sharing.">
        <Switch checked={settings.live.keepOnTop} onChange={(v) => void call('app.setKeepOnTop', { value: v }).then(() => updateSettings({ live: { keepOnTop: v } }))} label="Keep on top" />
      </SettingRow>
      <div style={{ paddingTop: 14 }}>
        <div className="field">
          <label htmlFor="custom-instr">Custom instructions for answers</label>
          <textarea id="custom-instr" className="textarea" value={custom} onChange={(e) => setCustom(e.target.value)} onBlur={() => custom !== settings.customInstructions && void updateSettings({ customInstructions: custom })} placeholder="e.g. Keep answers in British English. Prefer short sentences. Mention data and dashboards where truthful." maxLength={1200} />
          <div className="hint">Added to the answer prompt after the safety rules; it can shape tone, never override “only use my real experience”.</div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => void updateSettings({ onboarding: { completed: false, step: 0 } })}><RotateCcw /> Run the setup guide again</button>
        </div>
      </div>
    </div>
  );
}

function Profile() {
  const { profile, updateProfile } = useApp();
  const [p, setP] = useState(profile);
  if (!p) return null;
  const save = (patch: Parameters<typeof updateProfile>[0]) => void updateProfile(patch);
  return (
    <div className="card">
      <p className="hint" style={{ marginBottom: 14 }}>Your résumé is the main source of truth. This profile adds preferences and any extra facts you want Candor to be allowed to use. Candor never claims experience that is not here or in your résumé and stories.</p>
      <div className="col" style={{ gap: 14 }}>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="pf-name">Name</label><input id="pf-name" className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} onBlur={() => save({ name: p.name })} /></div>
          <div className="field">
            <label htmlFor="pf-style">Preferred answer style</label>
            <select id="pf-style" className="select" value={p.preferredStyle} onChange={(e) => { const v = e.target.value as typeof p.preferredStyle; setP({ ...p, preferredStyle: v }); save({ preferredStyle: v }); }}>
              <option value="conversational">Conversational</option>
              <option value="polished">Polished</option>
              <option value="direct">Direct</option>
            </select>
          </div>
        </div>
        <div className="field"><label htmlFor="pf-summary">Professional summary</label><textarea id="pf-summary" className="textarea" value={p.summary} onChange={(e) => setP({ ...p, summary: e.target.value })} onBlur={() => save({ summary: p.summary })} /></div>
        <div className="field"><label>Key skills</label><TagInput value={p.skills} onChange={(v) => { setP({ ...p, skills: v }); save({ skills: v }); }} placeholder="Add a skill and press Enter" /></div>
        <div className="grid grid-2">
          <div className="field"><label htmlFor="pf-edu">Education</label><textarea id="pf-edu" className="textarea" style={{ minHeight: 70 }} value={p.education} onChange={(e) => setP({ ...p, education: e.target.value })} onBlur={() => save({ education: p.education })} /></div>
          <div className="field"><label>Target roles</label><TagInput value={p.targetRoles} onChange={(v) => { setP({ ...p, targetRoles: v }); save({ targetRoles: v }); }} placeholder="e.g. Operations Manager" /></div>
        </div>
        <div className="field"><label htmlFor="pf-prefs">Interview preferences</label><textarea id="pf-prefs" className="textarea" style={{ minHeight: 70 }} value={p.interviewPreferences} onChange={(e) => setP({ ...p, interviewPreferences: e.target.value })} onBlur={() => save({ interviewPreferences: p.interviewPreferences })} placeholder="e.g. I speak slowly, so prefer shorter sentences." /></div>
        <div className="field">
          <label>Extra facts Candor may use <span className="faint">(one per line item)</span></label>
          <TagInput value={p.extraFacts} onChange={(v) => { setP({ ...p, extraFacts: v }); save({ extraFacts: v }); }} placeholder="A true fact not in your résumé, e.g. “Led the 2023 warehouse migration for 3 sites”" />
          <div className="hint">These count as your own words and can be claimed in answers. Keep them true.</div>
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const { settings, updateSettings } = useApp();
  if (!settings) return null;
  const sizes = [{ v: 0.9, l: 'Small' }, { v: 1, l: 'Default' }, { v: 1.15, l: 'Large' }, { v: 1.3, l: 'Extra large' }];
  return (
    <div className="card">
      <SettingRow title="Theme"><div className="modes" role="group" aria-label="Theme">
        {(['dark', 'light', 'system'] as const).map((t) => <button key={t} className="mode-btn" aria-pressed={settings.theme === t} onClick={() => void updateSettings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div></SettingRow>
      <SettingRow title="Text size" hint="Scales the whole interface, including the live answer.">
        <select className="select" aria-label="Text size" value={sizes.find((s) => s.v === settings.fontScale)?.v ?? 1} onChange={(e) => void updateSettings({ fontScale: Number(e.target.value) })}>
          {sizes.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
      </SettingRow>
      <SettingRow title="High contrast" hint="Stronger borders and text for readability."><Switch checked={settings.highContrast} onChange={(v) => void updateSettings({ highContrast: v })} label="High contrast" /></SettingRow>
      <SettingRow title="Reduce motion" hint="Turns off animations and transitions.">
        <select className="select" aria-label="Reduce motion" value={settings.reducedMotion} onChange={(e) => void updateSettings({ reducedMotion: e.target.value as 'system' | 'on' | 'off' })}>
          <option value="system">Follow Windows</option><option value="on">Always</option><option value="off">Never</option>
        </select>
      </SettingRow>
    </div>
  );
}

function Audio() {
  const { settings, updateSettings } = useApp();
  const mics = useAsync(() => listMicrophones(), []);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;
  const a = settings.audio;
  const test = async () => {
    setTesting(true);
    setError(null);
    let h: CaptureHandle | null = null;
    try {
      h = await startCapture('mic', { deviceId: a.micDeviceId, noiseSuppression: a.noiseSuppression, echoCancellation: a.echoCancellation, autoGainControl: a.autoGainControl }, () => undefined, setLevel);
      await new Promise((r) => setTimeout(r, 4000));
      void mics.reload();
    } catch (e) {
      setError(e instanceof CaptureError ? e.message : errorMessage(e));
    } finally {
      await h?.stop();
      setLevel(0);
      setTesting(false);
    }
  };
  return (
    <div className="card">
      {error && <div style={{ marginBottom: 12 }}><Notice tone="bad" action={<button className="btn btn-sm" onClick={() => void call('app.openSystemSettings', { page: 'microphone' })}>Windows privacy settings</button>}>{error}</Notice></div>}
      <SettingRow title="Interviewer audio source" hint="Computer audio captures the call itself (Zoom, Teams, Meet…), so the interviewer is never confused with you. Use the microphone for in-person interviews.">
        <select className="select" aria-label="Interviewer audio source" value={a.interviewerSource} onChange={(e) => void updateSettings({ audio: { interviewerSource: e.target.value as 'system' | 'mic' } })}>
          <option value="system">Computer audio (video call)</option><option value="mic">Microphone (in person)</option>
        </select>
      </SettingRow>
      <SettingRow title="Transcribe my voice too" hint="Only with computer audio as the interviewer source. Gives follow-up questions the context of what you actually said.">
        <Switch checked={a.transcribeMyVoice} onChange={(v) => void updateSettings({ audio: { transcribeMyVoice: v } })} label="Transcribe my voice" />
      </SettingRow>
      <SettingRow title="Microphone" hint="Device names appear after you allow microphone access once.">
        <select className="select" aria-label="Microphone" value={a.micDeviceId ?? ''} onChange={(e) => void updateSettings({ audio: { micDeviceId: e.target.value || null } })}>
          <option value="">System default</option>
          {(mics.data ?? []).map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || 'Microphone'}</option>)}
        </select>
      </SettingRow>
      <SettingRow title="Test microphone" hint="Speak for a few seconds and watch the meter. Nothing is recorded or sent.">
        <div className="row"><Meter level={level} label="Microphone level" /><button className="btn" onClick={guarded(test)} disabled={testing}>{testing ? <Busy label="Listening…" /> : <><Mic /> Test</>}</button></div>
      </SettingRow>
      <SettingRow title="Speech-detection sensitivity" hint="Higher reacts faster to the end of a question but may trigger on background noise.">
        <select className="select" aria-label="VAD sensitivity" value={settings.vadSensitivity} onChange={(e) => void updateSettings({ vadSensitivity: e.target.value as 'low' | 'medium' | 'high' })}>
          <option value="low">Low — noisy rooms</option><option value="medium">Medium</option><option value="high">High — quiet rooms, fastest</option>
        </select>
      </SettingRow>
      <SettingRow title="Noise suppression"><Switch checked={a.noiseSuppression} onChange={(v) => void updateSettings({ audio: { noiseSuppression: v } })} label="Noise suppression" /></SettingRow>
      <SettingRow title="Automatic gain control"><Switch checked={a.autoGainControl} onChange={(v) => void updateSettings({ audio: { autoGainControl: v } })} label="Automatic gain control" /></SettingRow>
      <SettingRow title="Echo cancellation" hint="Leave off unless the interviewer’s voice from your speakers is being picked up by your microphone."><Switch checked={a.echoCancellation} onChange={(v) => void updateSettings({ audio: { echoCancellation: v } })} label="Echo cancellation" /></SettingRow>
      <div style={{ paddingTop: 12 }}><button className="btn btn-sm" onClick={() => void call('app.openSystemSettings', { page: 'sound' })}>Open Windows sound settings</button></div>
    </div>
  );
}

function Speech() {
  const { settings, updateSettings, toast } = useApp();
  const keys = useAsync(() => call('stt.keys'), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SttTestResult>>({});
  if (!settings) return null;
  const cloud: CloudSttProviderId[] = ['deepgram', 'assemblyai'];
  const label = (p: SttProviderId) => sttLabel(p);
  const url = (p: CloudSttProviderId) => (p === 'deepgram' ? 'https://console.deepgram.com/' : 'https://www.assemblyai.com/dashboard/signup');
  const primary = settings.stt.provider;
  const options: [SttProviderId, string][] = [['local', 'On this PC — free & private (recommended)'], ['deepgram', 'Deepgram — cloud, needs an account and key'], ['assemblyai', 'AssemblyAI — cloud, needs an account and key']];
  return (
    <div className="stack-lg">
      <Notice tone="info">
        Live transcription runs <strong>on this PC</strong> by default: free, private (audio never leaves the computer), works offline and needs no account or key. Cloud services are optional; they need their own account and API key and may cost money — Candor never switches to one by itself.
      </Notice>

      <div className="card">
        <SettingRow title="Speech recognition" hint="The engine that turns the interviewer's voice into text. The Live screen always shows which one is active.">
          <select className="select" aria-label="Primary speech provider" value={primary} onChange={(e) => void updateSettings({ stt: { provider: e.target.value as SttProviderId } })}>
            {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </SettingRow>
        <SettingRow title="Fallback" hint="Used automatically if the engine above fails. A cloud fallback needs its own key; nothing is used that you have not set up here.">
          <select className="select" aria-label="Fallback speech provider" value={settings.stt.fallbackProvider} onChange={(e) => void updateSettings({ stt: { fallbackProvider: e.target.value as SttProviderId | 'none' } })}>
            <option value="none">None</option>
            {options.filter(([id]) => id !== primary).map(([id, text]) => <option key={id} value={id}>{text}</option>)}
          </select>
        </SettingRow>
      </div>

      <div className="card"><LocalSpeechPanel /></div>

      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Cloud speech services (optional)</summary>
        <p className="hint" style={{ margin: '10px 0' }}>Deepgram and AssemblyAI stream audio to their servers. They need an account and API key; free credit is a trial, and usage beyond it is billed by them. Keys are stored encrypted on this PC.</p>
        <div className="grid grid-2">
          {cloud.map((p) => {
            const k = keys.data?.find((x) => x.provider === p);
            const r = results[p];
            return (
              <div key={p} className="col" style={{ gap: 10 }}>
                <div className="row between"><strong>{label(p)}</strong>{primary === p && <Pill tone="accent">primary</Pill>}</div>
                <div className="row">
                  {k?.keySource === 'stored' ? <Pill tone="ok"><CheckCircle2 /> key {k.keyHint}</Pill> : k?.keySource === 'env' ? <Pill tone="info">from environment</Pill> : <Pill tone="warn">no key</Pill>}
                  <button className="btn btn-sm btn-ghost" onClick={() => void call('app.openExternal', { url: url(p) })}>Get a key</button>
                </div>
                <div className="row">
                  <input className="input mono" type="password" autoComplete="off" aria-label={`${label(p)} API key`} placeholder="Paste API key" value={draft[p] ?? ''} onChange={(e) => setDraft({ ...draft, [p]: e.target.value })} />
                  <button className="btn btn-primary" disabled={!draft[p]?.trim()} onClick={guarded(async () => { try { await call('stt.setKey', { provider: p, apiKey: draft[p].trim() }); setDraft({ ...draft, [p]: '' }); void keys.reload(); toast(`${label(p)} key saved (encrypted).`, 'ok'); } catch (e) { toast(errorMessage(e), 'bad'); } })}><KeyRound /> Save</button>
                </div>
                <div className="row">
                  <button className="btn btn-sm" disabled={busy === p || k?.keySource === 'none'} onClick={guarded(async () => { setBusy(p); const t = await call('stt.test', { provider: p }).catch((e): SttTestResult => ({ ok: false, error: errorMessage(e) })); setResults((x) => ({ ...x, [p]: t })); setBusy(null); })}>{busy === p ? <Busy /> : <Play />} Test connection</button>
                  {k?.keySource === 'stored' && <button className="btn btn-sm btn-ghost" onClick={guarded(async () => { await call('stt.clearKey', { provider: p }); void keys.reload(); })}>Remove key</button>}
                </div>
                {r && (r.ok ? <div className="small" style={{ color: 'var(--ok)' }}>Connected in {r.latencyMs} ms.</div> : <div className="small" style={{ color: 'var(--bad)' }}>{r.error}</div>)}
              </div>
            );
          })}
        </div>
      </details>

      <div className="card">
        <SettingRow title="Language" hint="BCP-47 code, e.g. en, en-US, en-IN. The on-device models understand English (the accurate one also Chinese); this setting matters for cloud services."><input className="input" style={{ width: 110 }} aria-label="Language" defaultValue={settings.stt.language} onBlur={(e) => e.target.value.trim() && void updateSettings({ stt: { language: e.target.value.trim() } })} /></SettingRow>
        <SettingRow title="Deepgram model" hint="Cloud only."><input className="input mono" style={{ width: 160 }} aria-label="Deepgram model" defaultValue={settings.stt.model} onBlur={(e) => e.target.value.trim() && void updateSettings({ stt: { model: e.target.value.trim() } })} /></SettingRow>
        <SettingRow title="End-of-speech wait" hint="How long the engine waits in silence before declaring the question finished. Shorter is faster; too short can cut a question in two (Candor merges those).">
          <div className="row"><input className="input" style={{ width: 90 }} type="number" min={100} max={1500} step={50} aria-label="Endpointing milliseconds" defaultValue={settings.stt.endpointingMs} onBlur={(e) => void updateSettings({ stt: { endpointingMs: Math.max(100, Math.min(1500, Number(e.target.value) || 300)) } })} /><span className="muted small">ms</span></div>
        </SettingRow>
        <SettingRow title="Label speakers (experimental)" hint="Adds “Speaker 1/2…” tags to the transcript when a single microphone hears everyone. Deepgram only; accuracy varies, so treat the tags as hints. Not used when the interviewer comes from system audio."><Switch checked={settings.stt.diarize} onChange={(v) => void updateSettings({ stt: { diarize: v } })} label="Diarization" /></SettingRow>
      </div>
    </div>
  );
}

const KEY_NAMES: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
function acceleratorFrom(e: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return null; // a global shortcut needs at least one non-shift modifier
  const key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : /^F\d{1,2}$/.test(e.key) ? e.key : null);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function Hotkeys() {
  const { settings, updateSettings } = useApp();
  const status = useAsync(() => call('hotkeys.status'), []);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  if (!settings) return null;
  const show = (s: string) => s.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
  return (
    <div className="card">
      <p className="hint" style={{ marginBottom: 6 }}>Global shortcuts work even when another window (your video call) has focus. If Windows or another app already uses a combination, it shows as unavailable — pick another.</p>
      {hint && <Notice tone="warn" onClose={() => setHint(null)}>{hint}</Notice>}
      {HOTKEY_ACTIONS.map((a) => {
        const st = status.data?.[a];
        return (
          <SettingRow key={a} title={HOTKEY_LABELS[a]}>
            <div className="row">
              {st && (st.registered ? <Pill tone="ok"><CheckCircle2 /> active</Pill> : <Pill tone="bad"><XCircle /> unavailable</Pill>)}
              <button
                className="btn mono"
                style={{ minWidth: 220 }}
                onClick={() => { setRecording(a); setHint(null); }}
                onKeyDown={guarded(async (e) => {
                  if (recording !== a) return;
                  e.preventDefault();
                  if (e.key === 'Escape') return setRecording(null);
                  const acc = acceleratorFrom(e);
                  if (!acc) return setHint('Hold Ctrl or Alt (optionally with Shift) and press a key.');
                  const dup = HOTKEY_ACTIONS.find((o) => o !== a && settings.hotkeys[o].toLowerCase() === acc.toLowerCase());
                  if (dup) return setHint(`That combination is already used for “${HOTKEY_LABELS[dup]}”.`);
                  setRecording(null);
                  await updateSettings({ hotkeys: { [a]: acc } });
                  void status.reload();
                })}
                onBlur={() => setRecording(null)}
              >
                {recording === a ? 'Press the new shortcut…' : show(settings.hotkeys[a])}
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Reset ${HOTKEY_LABELS[a]}`} title="Reset to default" onClick={guarded(async () => { await updateSettings({ hotkeys: { [a]: DEFAULT_SETTINGS.hotkeys[a] } }); void status.reload(); })}><RotateCcw size={14} /></button>
            </div>
          </SettingRow>
        );
      })}
      <SettingRow title="Switch answer mode" hint="Inside the window only."><span className="kbd">Alt + 1 … 7</span></SettingRow>
    </div>
  );
}

function Privacy() {
  const { settings, updateSettings, toast } = useApp();
  const info = useAsync(() => call('app.info'), []);
  const providers = useAsync(() => call('providers.list'), []);
  const { ask, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  if (!settings) return null;
  const sttLocal = settings.stt.provider === 'local';
  const sttName = sttLabel(settings.stt.provider);
  const names = (providers.data ?? []).filter((p) => p.enabled).map((p) => p.name).join(', ') || 'your AI provider';
  return (
    <div className="stack-lg">
      <div className="card">
        <h2 className="h2" style={{ marginBottom: 10 }}><ShieldCheck size={18} style={{ verticalAlign: '-3px' }} /> What Candor does with your data</h2>
        <table className="table">
          <thead><tr><th>Data</th><th>Stays on this PC</th><th>Sent to</th></tr></thead>
          <tbody>
            <tr><td>Résumé, job description, notes, stories, profile</td><td>Yes — local database</td><td>{names}: a compact profile summary (your name, current role, top skills, education) and only the few relevant facts per question. The analysis step sends the résumé/JD text once when you choose “Use AI”.</td></tr>
            <tr><td>Live audio</td><td>{sttLocal ? 'Yes: recognised here, never saved' : 'Never saved'}</td><td>{sttLocal ? 'Nowhere: speech recognition runs on this PC' : `${sttName}, only while listening (not when paused)`}</td></tr>
            <tr><td>Question text + retrieved facts</td><td>—</td><td>{names}</td></tr>
            <tr><td>Transcripts and answers</td><td>{settings.privacy.storeTranscripts || settings.privacy.storeAnswers ? 'Yes, if enabled below' : 'Not stored'}</td><td>Nowhere</td></tr>
            <tr><td>API keys</td><td>Encrypted with Windows (DPAPI)</td><td>Only to their own provider, as request credentials</td></tr>
            <tr><td>Analytics / telemetry</td><td colSpan={2}>None. Candor has no telemetry and no accounts.</td></tr>
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 10 }}>Candor does not use your data to train any model. Your AI and speech providers have their own retention policies — review theirs.</p>
      </div>
      <div className="card">
        <SettingRow title="Save transcripts" hint="The text of what was heard, for History and search."><Switch checked={settings.privacy.storeTranscripts} onChange={(v) => void updateSettings({ privacy: { storeTranscripts: v } })} label="Save transcripts" /></SettingRow>
        <SettingRow title="Save answers" hint="Suggested answers, latency and feedback for each question."><Switch checked={settings.privacy.storeAnswers} onChange={(v) => void updateSettings({ privacy: { storeAnswers: v } })} label="Save answers" /></SettingRow>
        <SettingRow title="Audio & privacy notice" hint={settings.live.consentAcceptedAt ? `Accepted ${new Date(settings.live.consentAcceptedAt).toLocaleString()}` : 'Not yet accepted — you will be asked before the first listening session.'}>
          {settings.live.consentAcceptedAt ? <button className="btn btn-sm" onClick={() => void updateSettings({ live: { consentAcceptedAt: null } })}>Withdraw</button> : <Pill>not accepted</Pill>}
        </SettingRow>
        {info.data && (
          <SettingRow title="Encrypted key storage" hint="Windows encrypts API keys for your user account.">
            {info.data.safeStorageAvailable ? <Pill tone="ok"><CheckCircle2 /> available</Pill> : <Pill tone="bad">unavailable — keys cannot be saved</Pill>}
          </SettingRow>
        )}
      </div>
      <div className="card">
        <h2 className="h2" style={{ marginBottom: 10 }}>Your data</h2>
        <div className="row row-wrap">
          <button className="btn" disabled={busy} onClick={guarded(async () => { const r = await call('data.export').catch((e) => { toast(errorMessage(e), 'bad'); return null; }); if (r) toast(`Exported to ${r.path}. API keys are never included.`, 'ok'); })}><Download /> Export my data (JSON)</button>
          <button className="btn btn-danger" onClick={guarded(async () => { if (await ask('Delete all interview history?', 'Live, mock and practice sessions with their transcripts and answers will be permanently deleted. Résumés, interviews and stories are kept.', { confirm: 'Delete history', danger: true })) { await call('data.purge', { scope: 'history' }); toast('History deleted.', 'ok'); } })}><Trash2 /> Delete history</button>
          <button className="btn btn-danger" onClick={guarded(async () => { if (await ask('Delete everything?', 'This removes all résumés, interviews, stories, history, settings and stored API keys from this PC. It cannot be undone.', { confirm: 'Delete everything', danger: true })) { setBusy(true); await call('data.purge', { scope: 'all' }); await useApp.getState().init(); toast('All data deleted.', 'ok'); setBusy(false); } })}><Trash2 /> Delete all data</button>
        </div>
      </div>
      {dialog}
    </div>
  );
}

function Storage() {
  const info = useAsync(() => call('data.storage'), []);
  const app = useAsync(() => call('app.info'), []);
  const d = info.data;
  const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
  return (
    <div className="card">
      {!d ? <Busy /> : (
        <table className="table">
          <tbody>
            {app.data && <tr><td>Candor version</td><td>{app.data.version}{app.data.isPackaged ? '' : ' (development build)'} <span className="faint small">· Electron {app.data.electron} · Chromium {app.data.chrome} · Node {app.data.node} · {app.data.platform}</span></td></tr>}
            <tr><td>Database</td><td className="mono small">{d.dbPath}</td></tr>
            <tr><td>Size on disk</td><td>{mb(d.dbBytes)}</td></tr>
            <tr><td>Log files</td><td className="mono small">{d.logPath}</td></tr>
            <tr><td>Interviews</td><td>{d.counts.interviews}</td></tr>
            <tr><td>Live sessions</td><td>{d.counts.liveSessions}</td></tr>
            <tr><td>Mock / practice sessions</td><td>{d.counts.mockSessions}</td></tr>
            <tr><td>Stories</td><td>{d.counts.stories}</td></tr>
            <tr><td>Saved answers</td><td>{d.counts.answers}</td></tr>
            {app.data && <tr><td>Environment keys detected</td><td>{app.data.envKeys.length ? app.data.envKeys.join(', ') : 'none'}</td></tr>}
          </tbody>
        </table>
      )}
      <p className="hint" style={{ marginTop: 10 }}>Logs never contain API keys, prompts, transcripts or audio.</p>
    </div>
  );
}

function Performance() {
  const { settings, updateSettings, toast } = useApp();
  const perf = useAsync(() => call('perf.get'), []);
  const hist = useAsync(() => call('bench.history'), []);
  const [runs, setRuns] = useState(10);
  const [mode, setMode] = useState<AnswerMode>('concise');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const cur = useRef(0);
  useEffect(() => subscribe('bench.progress', (p) => setProgress({ done: p.done, total: p.total })), []);
  if (!settings) return null;
  const run = async () => {
    setRunning(true);
    setResult(null);
    setProgress({ done: 0, total: runs });
    cur.current++;
    try {
      const r = await call('bench.run', { runs, mode });
      setResult(r);
      void hist.reload();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setRunning(false);
    }
  };
  const table = (r: BenchResult) => (
    <table className="table">
      <thead><tr><th>Measure</th><th className="num">Median</th><th className="num">p90</th><th className="num">p95</th><th className="num">Min</th><th className="num">Max</th><th className="num">n</th></tr></thead>
      <tbody>
        {([['Time to first token', r.ttft], ['Question → complete answer', r.total]] as const).map(([label, s]) => (
          <tr key={label}><td>{label}</td><td className="num">{formatMs(s.median)}</td><td className="num">{formatMs(s.p90)}</td><td className="num">{formatMs(s.p95)}</td><td className="num">{formatMs(s.min)}</td><td className="num">{formatMs(s.max)}</td><td className="num">{s.count}</td></tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="stack-lg">
      <div className="card">
        <SettingRow title="Show the performance panel on the Live screen" hint="Adds a “Perf” button with p50/p95 latencies, per-turn timings, audio and speech-service state. Also shows UI paint time."><Switch checked={settings.live.showDebugPanel} onChange={(v) => void updateSettings({ live: { showDebugPanel: v } })} label="Performance panel" /></SettingRow>
        {perf.data && <SettingRow title="This app"><span className="small muted">Window ready in {perf.data.startupMs} ms · memory {perf.data.memoryMB} MB (all processes) · up {perf.data.uptimeS}s</span></SettingRow>}
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="h2"><Gauge size={18} style={{ verticalAlign: '-3px' }} /> Latency benchmark</h2>
            <p className="hint">Sends real questions through the live pipeline to your configured live model and measures time-to-first-token and total time. The first request (connection setup) is shown separately and excluded. Numbers depend on your network, model and provider; nothing here is simulated.</p>
          </div>
        </div>
        <div className="row row-wrap">
          <div className="field" style={{ width: 130 }}><label htmlFor="b-runs">Requests</label><select id="b-runs" className="select" value={runs} onChange={(e) => setRuns(Number(e.target.value))}>{[5, 10, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
          <div className="field" style={{ width: 180 }}><label htmlFor="b-mode">Answer mode</label><select id="b-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as AnswerMode)}>{MODE_ORDER.map((m) => <option key={m} value={m}>{ANSWER_MODES[m].label}</option>)}</select></div>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} onClick={guarded(run)} disabled={running}>{running ? <Busy label={progress ? `${progress.done}/${progress.total}` : ''} /> : <Play />} Run benchmark</button>
        </div>
        {running && progress && <div className="progress" style={{ marginTop: 12 }}><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
        {result && (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}><Pill>{result.provider}</Pill><Pill>{result.model || 'no model'}</Pill><Pill>{ANSWER_MODES[result.mode].label} mode</Pill>{result.failures > 0 && <Pill tone="bad">{result.failures} failed</Pill>}</div>
            {table(result)}
            {result.notes.map((n) => <p key={n} className="hint" style={{ marginTop: 6 }}>{n}</p>)}
            {result.runs.some((r) => !r.ok) && <Notice tone="bad">{result.runs.find((r) => !r.ok)?.error}</Notice>}
          </div>
        )}
      </div>
      {(hist.data ?? []).length > 0 && (
        <div className="card">
          <h2 className="h2" style={{ marginBottom: 10 }}>Previous runs</h2>
          <table className="table">
            <thead><tr><th>When</th><th>Model</th><th>Mode</th><th className="num">TTFT median</th><th className="num">TTFT p95</th><th className="num">Total median</th><th className="num">Failed</th></tr></thead>
            <tbody>
              {(hist.data ?? []).map((b) => (
                <tr key={b.id}><td>{new Date(b.createdAt).toLocaleString()}</td><td className="mono small">{b.provider} · {b.model}</td><td>{b.mode}</td><td className="num">{formatMs(b.ttft.median)}</td><td className="num">{formatMs(b.ttft.p95)}</td><td className="num">{formatMs(b.total.median)}</td><td className="num">{b.failures}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { settings, updateSettings } = useApp();
  if (!settings) return null;
  return (
    <div className="card">
      <SettingRow title="In-app messages" hint="Small confirmations and status messages in the corner of the window."><Switch checked={settings.notifications.toasts} onChange={(v) => void updateSettings({ notifications: { toasts: v } })} label="In-app messages" /></SettingRow>
      <SettingRow title="Desktop notifications" hint="A Windows notification when preparation finishes while Candor is not the active window."><Switch checked={settings.notifications.desktop} onChange={(v) => void updateSettings({ notifications: { desktop: v } })} label="Desktop notifications" /></SettingRow>
    </div>
  );
}
