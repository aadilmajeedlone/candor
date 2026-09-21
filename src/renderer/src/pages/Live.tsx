import { AlertTriangle, BookMarked, Check, CheckCircle2, Copy, Headphones, Info, Maximize2, Mic, Minimize2, MonitorSpeaker, Pause, Play, RefreshCw, ScanText, Send, Sparkles, Square, Wand2, XCircle, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ANSWER_MODES, MODE_ORDER } from '@shared/modes';
import { LIVE_STATUS_LABEL } from '@shared/events';
import { HOTKEY_LABELS } from '@shared/settings';
import { localSpeechUsable, sttLabel, type LocalSttStatus } from '@shared/speech';
import type { AnswerMode, FeedbackTag, Interview } from '@shared/types';
import { formatDuration, formatMs } from '@shared/util';
import { CaptureError, startCapture, type CaptureHandle } from '@/audio/capture';
import { ActiveProvidersCard } from '@/components/ActiveProviders';
import { Busy, Empty, Meter, Modal, Notice, Pill, Switch } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage, sendAudio } from '@/services/api';
import { useApp } from '@/store/app';
import { useLive } from '@/store/live';
import { guarded } from '@/lib/guarded';

export default function Live() {
  const running = useLive((s) => s.running);
  return running ? <LiveSession /> : <LiveSetup />;
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function LiveSetup() {
  const { settings, activeInterviewId, navigate, toast, updateSettings } = useApp();
  const interviews = useAsync(() => call('interviews.list'), []);
  const stt = useAsync(() => call('stt.keys'), []);
  const local = useAsync(() => call('stt.localStatus'), []);
  const [interviewId, setInterviewId] = useState<string | null>(activeInterviewId);
  const [withAudio, setWithAudio] = useState(true);
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);

  // Load the on-device speech model while the user is still choosing an interview, so "Start listening" is instant.
  const useLocal = settings?.stt.provider === 'local';
  useEffect(() => {
    if (!useLocal) return;
    let live = true;
    void call('stt.warmup')
      .then((s) => live && local.setData(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useLocal]);

  const list = interviews.data ?? [];
  const interview = list.find((i) => i.id === interviewId) ?? null;
  if (settings === null) return null;
  const sttKey = stt.data?.find((k) => k.provider === settings.stt.provider);
  const liveModelOk = !!settings.routing.live.primary || !!settings.routing.prep.primary;
  const sttOk = useLocal ? localSpeechUsable(local.data) : !!sttKey && sttKey.keySource !== 'none';
  const source = settings.audio.interviewerSource;

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const res = await call('live.start', { interviewId, audio: withAudio });
      useApp.getState().setActiveInterview(interviewId);
      useLive.getState().begin(res.sessionId, interviewId, settings.defaultMode);
      useLive.getState().setSources(res.sources);
      useApp.getState().setLiveRunning(true);
      for (const n of res.notices) toast(n, 'info');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const onStart = async () => {
    if (withAudio && !settings.live.consentAcceptedAt) {
      setConsent(true);
      return;
    }
    await start();
  };

  const testMic = async () => {
    setTesting(true);
    setError(null);
    let handle: CaptureHandle | null = null;
    try {
      handle = await startCapture('mic', { deviceId: settings.audio.micDeviceId, noiseSuppression: settings.audio.noiseSuppression, echoCancellation: settings.audio.echoCancellation, autoGainControl: settings.audio.autoGainControl }, () => undefined, (r) => setLevel(r));
      await new Promise((r) => setTimeout(r, 3500));
    } catch (e) {
      setError(e instanceof CaptureError ? e.message : errorMessage(e));
    } finally {
      await handle?.stop();
      setLevel(0);
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Live interview</div>
          <h1 className="h1">Ready when you are.</h1>
          <p className="sub">Candor listens to the interviewer, spots the question, pulls only the relevant parts of your experience and streams a speakable answer, usually before they have finished the sentence.</p>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>
        </div>
      )}

      <div className="setup">
        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h2 className="h2">Interview</h2>
              <button className="btn btn-sm btn-ghost" onClick={() => navigate('interviews', { openNew: true })}>New interview</button>
            </div>
            <div className="field">
              <select className="select" aria-label="Interview" value={interviewId ?? ''} onChange={(e) => setInterviewId(e.target.value || null)}>
                <option value="">No specific interview (use my profile only)</option>
                {list.map((i) => (
                  <option key={i.id} value={i.id}>{i.title}</option>
                ))}
              </select>
            </div>
            <div style={{ marginTop: 12 }}>
              <Preflight interview={interview} liveModelOk={liveModelOk} sttOk={sttOk} sttLabel={settings.stt.provider} localStatus={local.data} withAudio={withAudio} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2 className="h2">Audio</h2>
              <label className="row small muted">
                <Switch checked={withAudio} onChange={setWithAudio} label="Listen with speech recognition" />
                Listen with speech recognition
              </label>
            </div>
            {withAudio ? (
              <div className="col" style={{ gap: 14 }}>
                <div className="field">
                  <label>Who is the interviewer?</label>
                  <div className="modes" role="group" aria-label="Interviewer audio source">
                    <button className="mode-btn" aria-pressed={source === 'system'} onClick={() => void updateSettings({ audio: { interviewerSource: 'system' } })}>
                      <MonitorSpeaker size={14} /> Computer audio (video call)
                    </button>
                    <button className="mode-btn" aria-pressed={source === 'mic'} onClick={() => void updateSettings({ audio: { interviewerSource: 'mic' } })}>
                      <Mic size={14} /> This microphone (in person)
                    </button>
                  </div>
                  <div className="hint">
                    {source === 'system'
                      ? 'The call’s audio is captured separately from your microphone, so the interviewer and you are never confused.'
                      : 'One microphone hears everyone. Candor cannot reliably tell speakers apart in this mode; pause listening while you speak (shortcut below).'}
                  </div>
                </div>
                {source === 'system' && (
                  <label className="check">
                    <input type="checkbox" checked={settings.audio.transcribeMyVoice} onChange={(e) => void updateSettings({ audio: { transcribeMyVoice: e.target.checked } })} />
                    <span>Also transcribe my voice <span className="hint">(adds context for follow-ups and your history; uses a second speech stream)</span></span>
                  </label>
                )}
                <div className="row">
                  <button className="btn btn-sm" onClick={guarded(testMic)} disabled={testing}>
                    <Mic /> {testing ? 'Listening… say something' : 'Test microphone'}
                  </button>
                  <Meter level={level} label="Microphone level" />
                </div>
              </div>
            ) : (
              <p className="muted small">No audio will be captured. Type or paste each question into the box at the bottom of the live screen.</p>
            )}
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <ActiveProvidersCard />
          <div className="card">
            <h2 className="h2" style={{ marginBottom: 10 }}>What leaves this computer</h2>
            <ul className="bullets small">
              <li>{useLocal ? <><strong>Audio</strong> → recognised on this PC and <strong>never sent anywhere</strong>, only while listening (never when paused). Audio is not saved.</> : <><strong>Audio</strong> → {sttLabel(settings.stt.provider)} for transcription, only while listening (never when paused). Audio is not saved.</>}</li>
              <li><strong>The question and 3–6 relevant facts</strong> → your AI provider. Your full résumé and job description are not sent with each question.</li>
              <li><strong>Stored on this PC:</strong> {settings.privacy.storeTranscripts ? 'transcript' : 'no transcript'}, {settings.privacy.storeAnswers ? 'answers' : 'no answers'}. Change this in Settings → Privacy.</li>
            </ul>
          </div>
          <div className="card">
            <h2 className="h2" style={{ marginBottom: 10 }}>Shortcuts <span className="faint small">(work in any window)</span></h2>
            <div className="col" style={{ gap: 6 }}>
              {(['toggleListening', 'generate', 'shorter', 'regenerate', 'copy'] as const).map((a) => (
                <div key={a} className="row between small">
                  <span className="muted">{HOTKEY_LABELS[a]}</span>
                  <span className="kbd">{settings.hotkeys[a].replace('CommandOrControl', 'Ctrl')}</span>
                </div>
              ))}
              <div className="row between small"><span className="muted">Switch mode</span><span className="kbd">Alt + 1…7</span></div>
            </div>
          </div>
          <button className="btn btn-primary btn-lg" onClick={guarded(onStart)} disabled={starting}>
            {starting ? <Busy /> : <Play />} {withAudio ? 'Start listening' : 'Start (type questions)'}
          </button>
          <p className="hint" style={{ textAlign: 'center' }}>
            Use Candor only where interview or employer rules allow AI assistance and where everyone on the call has been told about any recording or transcription.
          </p>
        </div>
      </div>

      <Modal
        open={consent}
        onClose={() => setConsent(false)}
        title="Before Candor listens"
        footer={
          <>
            <button className="btn" onClick={() => setConsent(false)}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={guarded(async () => {
                await updateSettings({ live: { consentAcceptedAt: Date.now() } });
                setConsent(false);
                await start();
              })}
            >
              I understand — start
            </button>
          </>
        }
      >
        <div className="col" style={{ gap: 12 }}>
          <p>Candor will capture audio only after you press start, only from the source you chose, and it stops the moment you pause or end the session.</p>
          <ul className="bullets small">
            <li>{useLocal ? <>Audio is transcribed <strong>on this PC</strong> and never leaves it.</> : <>Audio is streamed to <strong>{sttLabel(settings.stt.provider)}</strong> to be transcribed.</>} Audio is never written to disk.</li>
            <li>Transcribed text of the question goes to your AI provider to draft an answer.</li>
            <li>Windows will ask for microphone access the first time. For computer audio no extra permission dialog appears.</li>
          </ul>
          <Notice tone="warn">
            Recording or transcribing other people can require their consent, and many interviews and employers prohibit AI assistance. You are responsible for following the rules that apply to you.
          </Notice>
        </div>
      </Modal>
    </div>
  );
}

function Preflight({ interview, liveModelOk, sttOk, sttLabel: label, localStatus, withAudio }: { interview: Interview | null; liveModelOk: boolean; sttOk: boolean; sttLabel: string; localStatus: LocalSttStatus | null; withAudio: boolean }) {
  const navigate = useApp((s) => s.navigate);
  const rows: { ok: boolean; text: string; fix?: () => void; fixLabel?: string; optional?: boolean }[] = [
    { ok: !!interview?.resumeId, text: interview ? 'Résumé linked to this interview' : 'Résumé (choose an interview to use its résumé)', fix: () => navigate('interviews'), fixLabel: 'Interviews', optional: !interview },
    { ok: !!interview?.jdAnalysis, text: 'Job description analysed', fix: () => navigate('interviews'), fixLabel: 'Interviews', optional: !interview },
    { ok: liveModelOk, text: 'AI model for live answers', fix: () => navigate('settings', { settingsTab: 'providers' }), fixLabel: 'Set up' },
    ...(withAudio
      ? [
          label === 'local'
            ? { ok: sttOk, text: `Speech recognition on this PC${localStatus?.state === 'ready' ? ' (ready)' : localStatus?.state === 'loading' ? ' (loading the model…)' : ''}`, fix: () => navigate('settings', { settingsTab: 'speech' }), fixLabel: 'Fix' }
            : { ok: sttOk, text: `Speech recognition key (${sttLabel(label)})`, fix: () => navigate('settings', { settingsTab: 'speech' }), fixLabel: 'Add key' },
        ]
      : []),
  ];
  return (
    <div>
      {rows.map((r) => (
        <div key={r.text} className="check-row">
          {r.ok ? <CheckCircle2 size={17} color="var(--ok)" /> : r.optional ? <Info size={17} color="var(--text-faint)" /> : <AlertTriangle size={17} color="var(--warn)" />}
          <span className="grow" style={{ color: r.ok ? 'var(--text)' : 'var(--text-dim)' }}>{r.text}</span>
          {!r.ok && r.fix && <button className="btn btn-sm btn-ghost" onClick={r.fix}>{r.fixLabel}</button>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

function useLiveAudio(onError: (e: CaptureError) => void) {
  const sources = useLive((s) => s.sources);
  const running = useLive((s) => s.running);
  const paused = useLive((s) => s.paused);
  const settings = useApp((s) => s.settings);
  const key = sources.join(',');
  useEffect(() => {
    if (!running || paused || sources.length === 0 || !settings) return;
    let cancelled = false;
    const started: CaptureHandle[] = [];
    void (async () => {
      for (const s of sources) {
        let lastLevel = 0;
        try {
          const h = await startCapture(
            s,
            { deviceId: settings.audio.micDeviceId, noiseSuppression: settings.audio.noiseSuppression, echoCancellation: settings.audio.echoCancellation, autoGainControl: settings.audio.autoGainControl },
            (pcm) => sendAudio(s, pcm),
            (rms) => {
              const now = performance.now();
              if (now - lastLevel > 70) {
                lastLevel = now;
                useLive.getState().setLevel(s, rms);
              }
            },
          );
          if (cancelled) {
            await h.stop();
            return;
          }
          started.push(h);
        } catch (e) {
          onError(e instanceof CaptureError ? e : new CaptureError(errorMessage(e), 'other'));
        }
      }
    })();
    return () => {
      cancelled = true;
      started.forEach((h) => void h.stop());
      useLive.getState().setLevel('mic', 0);
      useLive.getState().setLevel('system', 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, paused, key]);
}

function LiveSession() {
  const { settings, toast } = useApp();
  const live = useLive();
  const [captureError, setCaptureError] = useState<CaptureError | null>(null);
  const [debug, setDebug] = useState(false);
  const [ending, setEnding] = useState(false);
  useLiveAudio((e) => setCaptureError(e));
  const interviews = useAsync(() => call('interviews.list'), []);
  const interview = interviews.data?.find((i) => i.id === live.interviewId) ?? null;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = live.startedAt ? (now - live.startedAt) / 1000 : 0;

  const end = async () => {
    setEnding(true);
    try {
      await call('live.stop');
      useLive.getState().reset();
      useApp.getState().setLiveRunning(false);
      toast('Session saved to History.', 'ok');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setEnding(false);
    }
  };

  if (!settings) return null;
  const badge = live.paused ? 'paused' : 'live';
  return (
    <div className="live">
      <div className="live-top">
        <span className="live-badge" data-state={badge}><i />{live.paused ? 'PAUSED' : 'LIVE'} <span className="mono">{formatDuration(elapsed)}</span></span>
        <div className="live-title grow">
          <div className="t truncate">{interview ? `${interview.jobTitle || 'Interview'}${interview.company ? ` · ${interview.company}` : ''}` : 'General session'}</div>
          <div className="s">{interview ? interview.interviewType : 'Using your profile only'} · {live.sources.length ? live.sources.map((s) => (s === 'system' ? 'computer audio' : 'microphone')).join(' + ') : 'typed questions'}</div>
        </div>
        <ModeBar mode={live.mode} />
        <div className="row">
          {live.sources.length > 0 && (
            <button className="btn" onClick={() => void call('live.pause', { paused: !live.paused })}>
              {live.paused ? <Play /> : <Pause />} {live.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {settings.live.showDebugPanel && <button className="btn btn-ghost" onClick={() => setDebug((d) => !d)}><Zap /> Perf</button>}
          <button className="btn btn-danger" onClick={guarded(end)} disabled={ending}><Square /> End session</button>
        </div>
      </div>

      {(captureError || live.notices.length > 0) && (
        <div className="col" style={{ padding: '8px 16px 0' }}>
          {captureError && (
            <Notice
              tone="bad"
              onClose={() => setCaptureError(null)}
              action={captureError.kind === 'denied' ? <button className="btn btn-sm" onClick={() => void call('app.openSystemSettings', { page: 'microphone' })}>Open Windows settings</button> : undefined}
            >
              {captureError.message} You can keep going by typing questions below.
            </Notice>
          )}
          {live.notices.map((n) => (
            <NoticeBar key={n.id} id={n.id} level={n.level} message={n.message} code={n.code} />
          ))}
        </div>
      )}

      <div className="live-grid">
        <TranscriptPane />
        <QuestionPane />
        <AnswerPane />
      </div>

      <StatusBar />
      {debug && <DebugPanel onClose={() => setDebug(false)} />}
    </div>
  );
}

function NoticeBar({ id, level, message, code }: { id: number; level: 'info' | 'warn' | 'error'; message: string; code?: string }) {
  const navigate = useApp((s) => s.navigate);
  const dismiss = useLive((s) => s.dismissNotice);
  const tone = level === 'error' ? 'bad' : level === 'warn' ? 'warn' : 'info';
  const action =
    code === 'not_configured' || code === 'auth' || code === 'model_not_found' ? (
      <button className="btn btn-sm" onClick={() => navigate('settings', { settingsTab: 'providers' })}>Open AI settings</button>
    ) : code === 'stt' ? (
      <button className="btn btn-sm" onClick={() => navigate('settings', { settingsTab: 'speech' })}>Speech settings</button>
    ) : code === 'rate_limit' || code === 'timeout' || code === 'server' || code === 'network' ? (
      <button className="btn btn-sm" onClick={() => void call('live.regenerate').catch(() => undefined)}>Retry</button>
    ) : undefined;
  return (
    <Notice compact tone={tone} onClose={() => dismiss(id)} action={action}>
      {message}
    </Notice>
  );
}

function ModeBar({ mode }: { mode: AnswerMode }) {
  return (
    <div className="modes" role="group" aria-label="Answer mode">
      {MODE_ORDER.map((m) => (
        <button key={m} className="mode-btn" aria-pressed={mode === m} onClick={() => void call('live.mode', { mode: m })} title={`${ANSWER_MODES[m].blurb} (Alt+${ANSWER_MODES[m].key})`}>
          {ANSWER_MODES[m].label}
          <kbd>{ANSWER_MODES[m].key}</kbd>
        </button>
      ))}
    </div>
  );
}

/* ---------------- transcript ---------------- */

function TranscriptPane() {
  const segments = useLive((s) => s.segments);
  const end = useRef<HTMLDivElement>(null);
  // Block body on purpose: an effect must not return scrollIntoView()'s result (a Promise in current Chromium).
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [segments]);
  const who = (s: string) => (s === 'interviewer' ? 'Interviewer' : s === 'candidate' ? 'You' : 'Speaker');
  return (
    <section className="pane" aria-label="Live transcript">
      <div className="pane-head">
        <span className="eyebrow">Live transcript</span>
      </div>
      <div className="pane-body">
        {segments.length === 0 ? (
          <div className="faint small" style={{ padding: '8px 0' }}>Speech will appear here as it is heard.</div>
        ) : (
          segments.map((s) => (
            <div key={s.id} className="tline" data-who={s.speaker} data-final={s.isFinal}>
              <span className="who">{s.label ?? who(s.speaker)}{s.speaker === 'unknown' && !s.label ? ' (unlabelled)' : ''}</span>
              <span className="txt">{s.text}</span>
              {s.isFinal && s.speaker !== 'candidate' && (
                <button className="btn btn-sm use" onClick={() => void call('live.question', { text: s.text }).catch((e) => useApp.getState().toast(errorMessage(e), 'bad'))} title="Answer this line">
                  <Sparkles /> Answer
                </button>
              )}
            </div>
          ))
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

/* ---------------- detected question ---------------- */

function QuestionPane() {
  const { question, retrieval, turns, speculative } = useLive();
  const navigate = useApp((s) => s.navigate);
  return (
    <section className="pane" aria-label="Detected question">
      <div className="pane-head">
        <span className="eyebrow">Interviewer asked</span>
        {question && (
          <div className="row" style={{ gap: 6 }}>
            {question.kind !== 'follow-up' && <Pill tone="info">{question.kind.replace('-', ' ')}</Pill>}
            {question.isFollowUp && <Pill tone="accent">follow-up</Pill>}
          </div>
        )}
      </div>
      <div className="pane-body">
        {question ? (
          <div className="col" style={{ gap: 14 }}>
            <p className="q-text">“{question.text}”</p>
            {speculative && <Pill tone="warn"><Zap /> Answering while they finish…</Pill>}
            {retrieval && (
              <div className="col" style={{ gap: 8 }}>
                <div className="eyebrow">Context used</div>
                <div className="chip-row">
                  <span className={`ctx-chip ${retrieval.usedResume ? 'ctx-ok' : 'ctx-off'}`}><Check /> Résumé</span>
                  <span className={`ctx-chip ${retrieval.usedJd ? 'ctx-ok' : 'ctx-off'}`}><Check /> Job</span>
                  <span className={`ctx-chip ${retrieval.usedStory ? 'ctx-ok' : 'ctx-off'}`}><Check /> Story</span>
                </div>
                {retrieval.labels.length > 0 && (
                  <div className="chip-row">
                    {retrieval.labels.map((l) => (
                      <span key={l} className="ctx-chip truncate" title={l}>{l}</span>
                    ))}
                  </div>
                )}
                {retrieval.factIds.length === 0 && retrieval.storyIds.length === 0 && (
                  <div className="small muted">
                    No matching experience found for this question.{' '}
                    <button className="btn btn-sm btn-ghost" onClick={() => navigate('stories')}><BookMarked /> Add a story</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            <p className="q-empty">Waiting for a question…</p>
            <p className="small faint">When the interviewer asks something, it is detected here within a fraction of a second. You can also type a question at the bottom, or click <em>Answer</em> beside any transcript line.</p>
          </div>
        )}
        {turns.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Earlier this session</div>
            <div className="col" style={{ gap: 6 }}>
              {[...turns].reverse().map((t) => (
                <details key={t.requestId} className="small">
                  <summary className="muted" style={{ cursor: 'pointer' }}>{t.question}</summary>
                  <p className="small" style={{ margin: '6px 0 4px', whiteSpace: 'pre-wrap' }}>{t.answer}</p>
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- answer ---------------- */

const FEEDBACK: { tag: FeedbackTag; label: string }[] = [
  { tag: 'useful', label: 'Useful' },
  { tag: 'not-useful', label: 'Not useful' },
  { tag: 'too-long', label: 'Too long' },
  { tag: 'too-generic', label: 'Too generic' },
  { tag: 'incorrect', label: 'Incorrect' },
  { tag: 'needs-detail', label: 'Needs more detail' },
];

export function AnswerText({ text, flagged }: { text: string; flagged?: string[] }) {
  const lines = text.split('\n');
  const pattern = useMemo(() => (flagged && flagged.length ? new RegExp(`(${flagged.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g') : null), [flagged]);
  const mark = (s: string) => (pattern ? s.split(pattern).map((part, i) => (i % 2 === 1 ? <mark key={i} title="Not found in your résumé or stories">{part}</mark> : part)) : s);
  return (
    <>
      {lines.map((line, i) => {
        const label = /^(Situation|Task|Action|Result):\s*/.exec(line);
        const bullet = /^\s*[-•]\s+/.exec(line);
        if (label) return <div key={i}><span className="lab">{label[1]}</span>{mark(line.slice(label[0].length))}</div>;
        if (bullet) return <span key={i} className="bul">• {mark(line.slice(bullet[0].length))}</span>;
        return <div key={i}>{line ? mark(line) : <br />}</div>;
      })}
    </>
  );
}

function AnswerPane() {
  const live = useLive();
  const { toast, navigate } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [edited, setEdited] = useState<{ requestId: string; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addition, setAddition] = useState('');
  const text = edited && edited.requestId === live.requestId ? edited.text : live.answer;
  const streaming = !!live.requestId && !live.answerDone && (live.status === 'generating' || live.status === 'retrieving' || live.answer.length > 0);
  const busy = live.status === 'retrieving' || live.status === 'generating';

  const run = (p: Promise<unknown>) => void p.catch((e: unknown) => toast(errorMessage(e), 'bad'));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Answer copied.', 'ok');
    } catch {
      const r = await call('live.copy').catch(() => ({ copied: false }));
      toast(r.copied ? 'Answer copied.' : 'Could not copy.', r.copied ? 'ok' : 'bad');
    }
  };
  const feedback = (tag: FeedbackTag) => {
    const next = live.feedback.includes(tag) ? live.feedback.filter((t) => t !== tag) : [...live.feedback, tag];
    useLive.getState().apply({ type: 'feedback', answerId: live.answerId ?? '', tags: next as FeedbackTag[] });
    run(call('live.feedback', { answerId: live.answerId, tags: [tag] }));
    if (tag === 'incorrect') toast('Noted. That answer will not be reused from cache.', 'info');
  };

  return (
    <section className="pane answer-pane" aria-label="AI suggested answer">
      <div className="pane-head">
        <div className="row" style={{ gap: 8 }}>
          <span className="eyebrow" style={{ color: 'var(--accent)' }}>Suggested answer</span>
          {live.answerSource === 'cache' && <Pill tone="ok"><Zap /> instant · {live.model === 'prepared answer' ? 'prepared' : 'cached'}</Pill>}
          {live.speculative && live.requestId && <Pill tone="warn">draft</Pill>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {live.model && live.answerSource !== 'cache' && <Pill title="Model used">{live.model}</Pill>}
        </div>
      </div>
      <div className="pane-body answer-body" aria-live="polite">
        {!live.requestId && !live.question ? (
          <div className="answer-idle">
            <div className="display" style={{ fontSize: '2.2rem', color: 'var(--text-dim)' }}>Your answer appears here.</div>
            <p className="small">It streams word by word so you can start speaking straight away. Everything is drawn from your own résumé, stories and notes: if something isn’t there, Candor says so instead of inventing it.</p>
            <div className="row-wrap row" style={{ gap: 6 }}>
              <span className="kbd">{live.mode ? ANSWER_MODES[live.mode].label : ''}</span>
              <span className="faint small">mode · change with Alt+1…7</span>
            </div>
          </div>
        ) : editing ? (
          <div className="col">
            <textarea className="textarea answer-edit" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit answer" />
            <div className="row">
              <button className="btn btn-primary btn-sm" onClick={() => { setEdited({ requestId: live.requestId ?? '', text: draft }); setEditing(false); if (live.answerId) run(call('answers.edit', { id: live.answerId, text: draft })); }}>Save edit</button>
              <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : text ? (
          <div className="answer-text">
            <AnswerText text={text} flagged={live.grounding?.unverified} />
            {streaming && <span className="caret" aria-hidden />}
          </div>
        ) : (
          <div className="row muted"><span className="spinner" /> {live.status === 'retrieving' ? 'Finding the most relevant parts of your experience…' : 'Waiting for the first words…'}</div>
        )}
      </div>

      {live.answerDone && live.grounding && (
        <div className="answer-meta">
          {live.grounding.status === 'grounded' && <Pill tone="ok"><CheckCircle2 /> Every detail matches your material</Pill>}
          {live.grounding.status === 'unverified-details' && (
            <Pill tone="warn"><AlertTriangle /> Check before saying: {live.grounding.unverified.slice(0, 4).join(', ')}</Pill>
          )}
          {live.grounding.status === 'no-context' && (
            <>
              <Pill tone="info"><Info /> No matching experience found — generic answer</Pill>
              <button className="btn btn-sm btn-ghost" onClick={() => navigate('stories')}><BookMarked /> Add a story</button>
            </>
          )}
        </div>
      )}
      {live.followups.length > 0 && (
        <div className="answer-meta">
          <span className="eyebrow">They may ask next</span>
          {live.followups.map((f) => (
            <button key={f} className="btn btn-sm" onClick={() => run(call('live.question', { text: f }))}>{f}</button>
          ))}
        </div>
      )}
      {live.answerDone && (
        <div className="answer-meta" aria-label="Feedback">
          <span className="eyebrow">Was this helpful?</span>
          {FEEDBACK.map((f) => (
            <button key={f.tag} className={`btn btn-sm ${live.feedback.includes(f.tag) ? 'btn-primary' : 'btn-ghost'}`} onClick={() => feedback(f.tag)} aria-pressed={live.feedback.includes(f.tag)}>{f.label}</button>
          ))}
        </div>
      )}

      <div className="answer-actions">
        <button className="btn btn-sm" onClick={() => run(call('live.regenerate'))} disabled={!live.question || busy}><RefreshCw /> Regenerate</button>
        <button className="btn btn-sm" onClick={() => run(call('live.shorter'))} disabled={!live.question}><Minimize2 /> Shorter</button>
        <button className="btn btn-sm" onClick={() => run(call('live.expand'))} disabled={!live.question}><Maximize2 /> Expand</button>
        <button className="btn btn-sm" onClick={() => run(call('live.mode', { mode: 'star' }))} disabled={!live.question}><ScanText /> STAR</button>
        <button className="btn btn-sm btn-primary" onClick={guarded(copy)} disabled={!text}><Copy /> Copy</button>
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" onClick={() => run(call('live.transform', { kind: 'conversational' }))} disabled={!live.answerDone}><Wand2 /> More conversational</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setAdding(true)} disabled={!live.answerDone}><Sparkles /> Add my experience</button>
        <button className="btn btn-sm btn-ghost" onClick={() => run(call('live.followups'))} disabled={!live.answerDone}><Headphones /> Predict follow-ups</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setDraft(text); setEditing(true); }} disabled={!text}>Edit</button>
      </div>

      <Modal
        open={adding}
        title="Add something you actually did"
        onClose={() => setAdding(false)}
        footer={
          <>
            <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={addition.trim().length < 8} onClick={() => { run(call('live.transform', { kind: 'add-detail', addition })); setAdding(false); setAddition(''); }}>Rewrite with this</button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="add-exp">Real experience to weave in</label>
          <textarea id="add-exp" className="textarea" value={addition} onChange={(e) => setAddition(e.target.value)} placeholder="e.g. I also trained the night shift on the new escalation checklist, and complaints fell by a third." />
          <div className="hint">Candor treats this as true, first-hand experience and uses it only for this rewrite.</div>
        </div>
      </Modal>
    </section>
  );
}

/* ---------------- status bar ---------------- */

function StatusBar() {
  const live = useLive();
  const settings = useApp((s) => s.settings);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState(false);
  const l = live.latency;
  const send = async () => {
    const text = q.trim();
    if (!text) return;
    setSending(true);
    try {
      await call('live.question', { text });
      setQ('');
    } catch (e) {
      useApp.getState().toast(errorMessage(e), 'bad');
    } finally {
      setSending(false);
    }
  };
  const statusLabel = live.status === 'error' && live.statusDetail ? 'Needs attention' : LIVE_STATUS_LABEL[live.status];
  const stt = Object.values(live.stt);
  const active = useAsync(() => call('app.activeProviders'), []);
  return (
    <div className="live-bar">
      <span className="status-pill" data-s={live.status} role="status"><i />{statusLabel}</span>
      {live.sources.includes('mic') && <span className="bar-item"><Mic size={15} /><Meter level={live.levels.mic} label="Microphone level" /></span>}
      {live.sources.includes('system') && <span className="bar-item"><MonitorSpeaker size={15} /><Meter level={live.levels.system} label="Computer audio level" /></span>}
      {stt.map((s) => (
        <Pill key={s.source} tone={s.state === 'connected' ? 'ok' : s.state === 'error' ? 'bad' : 'warn'} title={s.message}>
          {sttLabel(s.provider)} · {s.state}
        </Pill>
      ))}
      <span className="bar-item" title={active.data?.live.primary ? `Answers come from ${active.data.live.primary.provider} (${active.data.live.primary.scope === 'internet' ? 'a service on the internet' : active.data.live.primary.scope === 'this-pc' ? 'this PC' : 'your network'})` : 'Model used for the current answer'}>
        <Zap size={14} /> {live.answerSource === 'cache' ? 'cached' : `${l?.provider ?? active.data?.live.primary?.provider ?? ''}${(l?.provider ?? active.data?.live.primary?.provider) ? ' · ' : ''}${live.model ?? active.data?.live.primary?.model ?? 'Fast'}`}
      </span>
      <div className="bar-metric" title="Time from sending the request to the first word from the model"><b>{formatMs(l?.ttftMs)}</b><span>TTFT</span></div>
      <div className="bar-metric" title="Question detected → answer complete"><b>{formatMs(l?.totalMs)}</b><span>Total</span></div>
      <div className="bar-metric" title="Interviewer stopped speaking → first word shown. Negative means the answer started before they finished."><b>{formatMs(l?.perceivedMs)}</b><span>First word</span></div>
      {settings?.live.showDebugPanel && <div className="bar-metric"><b>{formatMs(l?.uiFirstPaintMs)}</b><span>UI paint</span></div>}
      <form className="bar-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type or paste a question, then press Enter…" aria-label="Type a question" />
        <button className="btn btn-primary" type="submit" disabled={!q.trim() || sending}><Send /> Answer</button>
      </form>
    </div>
  );
}

function DebugPanel({ onClose }: { onClose: () => void }) {
  const dbg = useAsync(() => call('live.debug'), []);
  useEffect(() => {
    const t = setInterval(() => void dbg.reload(), 1500);
    return () => clearInterval(t);
  }, [dbg]);
  const d = dbg.data;
  const row = (label: string, s?: { median: number | null; p95: number | null; count: number }) => (
    <tr><td>{label}</td><td className="num">{formatMs(s?.median)}</td><td className="num">{formatMs(s?.p95)}</td><td className="num">{s?.count ?? 0}</td></tr>
  );
  return (
    <div className="card debug" role="dialog" aria-label="Performance">
      <div className="card-head"><h2 className="h2">Performance</h2><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close"><XCircle size={16} /></button></div>
      {!d ? <Busy /> : (
        <>
          <table className="table">
            <thead><tr><th>Metric</th><th className="num">p50</th><th className="num">p95</th><th className="num">n</th></tr></thead>
            <tbody>
              {row('LLM TTFT', d.summary.ttft)}
              {row('Question → done', d.summary.total)}
              {row('First word (perceived)', d.summary.perceived)}
              {row('Retrieval', d.summary.retrieval)}
            </tbody>
          </table>
          <div className="small muted" style={{ marginTop: 10 }}>
            Cache: {d.cacheSize} entries · {d.summary.cacheHits} hits<br />
            Audio: {d.audio.map((a) => `${a.name} ${a.seconds}s`).join(' · ') || 'none'}<br />
            STT: {d.sttStates.map((s) => `${s.source}/${s.provider} ${s.state}`).join(' · ') || 'none'}
          </div>
          <div className="eyebrow" style={{ margin: '12px 0 6px' }}>Recent turns</div>
          <table className="table">
            <thead><tr><th>TTFT</th><th className="num">Retr.</th><th className="num">Det.</th><th className="num">Total</th></tr></thead>
            <tbody>
              {d.recent.map((t, i) => (
                <tr key={i}><td className="mono">{t.cacheHit ? 'cache' : formatMs(t.ttftMs)}{t.speculative ? ' ⚡' : ''}</td><td className="num">{formatMs(t.retrievalMs)}</td><td className="num">{formatMs(t.detectionMs)}</td><td className="num">{formatMs(t.totalMs)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="hint" style={{ marginTop: 10 }}>Detection = detector compute time. All values are measured; none are estimated.</p>
    </div>
  );
}

void Empty;
