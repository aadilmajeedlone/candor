import { CheckCircle2, ChevronRight, Mic, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MockSummary, MockTurnRecord } from '@shared/ipc';
import type { Level } from '@shared/types';
import { CaptureError, startCapture, type CaptureHandle } from '@/audio/capture';
import { Busy, Empty, Meter, Notice, Pill } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage, sendAudio, subscribe } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

type Phase = 'setup' | 'question' | 'evaluating' | 'result' | 'summary';

export default function Mock() {
  const { params, activeInterviewId, settings, navigate } = useApp();
  const interviews = useAsync(() => call('interviews.list'), []);
  const [interviewId, setInterviewId] = useState<string | null>(params.interviewId ?? activeInterviewId);
  const [count, setCount] = useState(5);
  const [phase, setPhase] = useState<Phase>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [turn, setTurn] = useState<MockTurnRecord | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(count);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const practice = params.practiceQuestion ?? null;

  const begin = async (kind: 'mock' | 'practice', first?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('mock.start', { interviewId, questionCount: kind === 'practice' ? 1 : count, kind, firstQuestion: first });
      setSessionId(r.sessionId);
      setQuestion(r.question);
      setIndex(0);
      setTotal(kind === 'practice' ? 1 : count);
      setPhase('question');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (answer: string, durationMs: number | null) => {
    if (!sessionId) return;
    setPhase('evaluating');
    setError(null);
    try {
      const r = await call('mock.answer', { sessionId, answer, durationMs });
      setTurn(r.turn);
      setNext(r.next);
      setPhase('result');
    } catch (e) {
      setError(errorMessage(e));
      setPhase('question');
    }
  };

  const finish = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      await call('mock.finish', { sessionId });
      setPhase('summary');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => { setPhase('setup'); setSessionId(null); setTurn(null); setNext(null); useApp.getState().navigate('mock'); };

  if (phase === 'setup') {
    const list = interviews.data ?? [];
    const ai = !!settings?.routing.mock.primary || !!settings?.routing.prep.primary || !!settings?.routing.live.primary;
    return (
      <div className="page">
        <div className="page-narrow">
          <div className="page-head">
            <div>
              <div className="eyebrow">Mock interview</div>
              <h1 className="h1">Rehearse out loud.</h1>
              <p className="sub">An AI interviewer asks questions tailored to the role and your résumé. Answer by speaking (or typing), then get a clear evaluation: measured statistics plus what was strong, what was missing and how to improve.</p>
            </div>
          </div>
          {error && <div style={{ marginBottom: 14 }}><Notice tone="bad" onClose={() => setError(null)}>{error}</Notice></div>}
          {practice && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
              <div className="eyebrow">Practise this question</div>
              <p className="mock-q" style={{ margin: '8px 0 14px' }}>{practice}</p>
              <button className="btn btn-primary btn-lg" onClick={() => void begin('practice', practice)} disabled={busy}>{busy ? <Busy /> : <Play />} Start practice</button>
            </div>
          )}
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <div className="card col" style={{ gap: 14 }}>
              <div className="field"><label htmlFor="mk-int">Interview</label><select id="mk-int" className="select" value={interviewId ?? ''} onChange={(e) => setInterviewId(e.target.value || null)}><option value="">General (my profile only)</option>{list.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select></div>
              <div className="field"><label htmlFor="mk-count">Number of questions</label><select id="mk-count" className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
              {!ai && <Notice tone="info" action={<button className="btn btn-sm" onClick={() => navigate('settings', { settingsTab: 'providers' })}>Set up AI</button>}>No AI model is set up. You can still practise with questions from your bank and get measured statistics, but not the written evaluation.</Notice>}
              <button className="btn btn-primary btn-lg" onClick={() => void begin('mock')} disabled={busy}>{busy ? <Busy /> : <Play />} Start mock interview</button>
            </div>
            <div className="card">
              <h2 className="h2" style={{ marginBottom: 10 }}>How you are evaluated</h2>
              <p className="small muted">No made-up scores. You get two things:</p>
              <ul className="bullets small" style={{ marginTop: 8 }}>
                <li><strong>Measured facts</strong> — words, speaking pace, filler words, whether you gave numbers, which STAR parts appear, how much of the question you addressed.</li>
                <li><strong>A rubric</strong> for relevance, completeness, structure and conciseness: <span className="level level-strong">strong</span> (clearly meets it), <span className="level level-adequate">adequate</span> (partly), <span className="level level-weak">weak</span> (largely misses), each with a one-line reason.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'summary' && sessionId) {
    return <div className="page"><div className="page-narrow"><div className="page-head"><div><div className="eyebrow">Mock interview</div><h1 className="h1">Your report</h1></div><button className="btn btn-primary" onClick={reset}>New session</button></div><MockReport sessionId={sessionId} /></div></div>;
  }

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="row between" style={{ marginBottom: 18 }}>
          <div className="row"><Pill tone="accent">Question {index + 1} of {total}</Pill><div className="progress" style={{ width: 160 }}><div style={{ width: `${((index + (phase === 'result' ? 1 : 0)) / total) * 100}%` }} /></div></div>
          <button className="btn btn-ghost" onClick={() => void finish()}>End &amp; see report</button>
        </div>
        {error && <div style={{ marginBottom: 14 }}><Notice tone="bad" onClose={() => setError(null)}>{error}</Notice></div>}
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="eyebrow">Interviewer</div>
          <p className="mock-q" style={{ marginTop: 8 }}>{phase === 'result' && turn ? turn.question : question}</p>
        </div>
        {(phase === 'question' || phase === 'evaluating') && <AnswerBox sessionId={sessionId!} disabled={phase === 'evaluating'} onSubmit={guarded(submit)} />}
        {phase === 'result' && turn && (
          <>
            <TurnCard turn={turn} />
            <div className="row" style={{ marginTop: 16 }}>
              {next ? <button className="btn btn-primary btn-lg" onClick={() => { setQuestion(next); setIndex((i) => i + 1); setTurn(null); setPhase('question'); }}>Next question <ChevronRight /></button> : <button className="btn btn-primary btn-lg" onClick={() => void finish()} disabled={busy}>{busy ? <Busy /> : <CheckCircle2 />} See my report</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AnswerBox({ sessionId, disabled, onSubmit }: { sessionId: string; disabled: boolean; onSubmit: (answer: string, durationMs: number | null) => void }) {
  const settings = useApp((s) => s.settings);
  const [text, setText] = useState('');
  const [rec, setRec] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<CaptureHandle | null>(null);
  const startedAt = useRef<number | null>(null);
  const spoken = useRef(0);
  const base = useRef('');

  useEffect(() => subscribe('mock.event', (e) => {
    if (e.type === 'transcript') setText(`${base.current}${base.current && e.text ? ' ' : ''}${e.text}`);
    else if (e.type === 'status' && e.state === 'notice' && e.message) setError(e.message);
    else if (e.type === 'status' && e.state === 'error') setError(e.message ?? 'Speech recognition failed.');
  }), []);

  const stop = async () => {
    setRec(false);
    if (startedAt.current) spoken.current += performance.now() - startedAt.current;
    startedAt.current = null;
    await handle.current?.stop();
    handle.current = null;
    setLevel(0);
    await call('mock.listen', { sessionId, on: false }).catch(() => undefined);
  };
  // Release the microphone on unmount using the latest closure (sessionId may have changed since first render).
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => { void stopRef.current(); }, []);

  const start = async () => {
    setError(null);
    try {
      await call('mock.listen', { sessionId, on: true });
      base.current = text.trim();
      handle.current = await startCapture('mic', { deviceId: settings?.audio.micDeviceId, noiseSuppression: settings?.audio.noiseSuppression ?? true, echoCancellation: settings?.audio.echoCancellation ?? false, autoGainControl: settings?.audio.autoGainControl ?? true }, (pcm) => sendAudio('mic', pcm), setLevel);
      startedAt.current = performance.now();
      setRec(true);
    } catch (e) {
      await call('mock.listen', { sessionId, on: false }).catch(() => undefined);
      setError(e instanceof CaptureError ? e.message : errorMessage(e));
    }
  };

  const submit = async () => {
    if (rec) await stop();
    onSubmit(text.trim(), spoken.current > 0 ? Math.round(spoken.current) : null);
  };

  return (
    <div className="card col" style={{ gap: 12 }}>
      {error && <Notice tone="warn" onClose={() => setError(null)}>{error}</Notice>}
      <label className="label" htmlFor="mk-answer">Your answer</label>
      <textarea id="mk-answer" className="textarea" style={{ minHeight: 170, fontSize: '1.05rem' }} value={text} onChange={(e) => { setText(e.target.value); base.current = e.target.value; }} disabled={disabled} placeholder="Speak your answer with the microphone, or type it here." />
      <div className="row between row-wrap">
        <div className="row">
          {rec ? <button className="btn btn-danger" onClick={() => void stop()}><Square /> Stop recording</button> : <button className="btn" onClick={() => void start()} disabled={disabled}><Mic /> Record my answer</button>}
          {rec && <><span className="rec-dot" aria-hidden /><Meter level={level} label="Microphone level" /></>}
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => void submit()} disabled={disabled || text.trim().length < 3}>{disabled ? <Busy label="Evaluating…" /> : 'Submit answer'}</button>
      </div>
      <p className="hint">Speech goes to your speech-recognition provider only while “Record” is on. Editing the text before submitting is fine.</p>
    </div>
  );
}

const LEVEL_LABEL: Record<Level, string> = { strong: 'Strong', adequate: 'Adequate', weak: 'Weak' };

function TurnCard({ turn }: { turn: MockTurnRecord }) {
  const m = turn.metrics;
  const e = turn.evaluation;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Measured</div>
        <div className="grid grid-4">
          <div className="stat"><div className="stat-value" style={{ fontSize: '1.8rem' }}>{m.words}</div><div className="stat-label">words{m.seconds ? ` in ${m.seconds}s` : ''}</div></div>
          <div className="stat"><div className="stat-value" style={{ fontSize: '1.8rem' }}>{m.wordsPerMinute ?? '—'}</div><div className="stat-label">words / minute <span className="faint">(natural: 120–160)</span></div></div>
          <div className="stat"><div className="stat-value" style={{ fontSize: '1.8rem' }}>{m.fillers}</div><div className="stat-label">filler words{m.fillerList.length ? ` (${m.fillerList.join(', ')})` : ''}</div></div>
          <div className="stat"><div className="stat-value" style={{ fontSize: '1.8rem' }}>{Math.round(m.questionCoverage * 100)}%</div><div className="stat-label">of the question’s key words addressed</div></div>
        </div>
        <div className="row row-wrap" style={{ marginTop: 12, gap: 6 }}>
          {(['situation', 'task', 'action', 'result'] as const).map((k) => <Pill key={k} tone={m.star[k] ? 'ok' : 'default'}>{m.star[k] ? '✓' : '·'} {k}</Pill>)}
          <Pill tone={m.hasNumbers ? 'ok' : 'warn'}>{m.hasNumbers ? '✓ includes numbers' : 'no numbers or metrics'}</Pill>
        </div>
      </div>
      {e ? (
        <>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Assessment</div>
            <div className="rubric">
              {(['relevance', 'completeness', 'structure', 'conciseness'] as const).map((k) => (
                <div key={k} className="rubric-cell"><div className="eyebrow">{k}</div><div className={`level level-${e[k].level}`}>{LEVEL_LABEL[e[k].level]}</div><div className="small muted" style={{ marginTop: 4 }}>{e[k].note}</div></div>
              ))}
            </div>
          </div>
          <div className="grid grid-2">
            <div className="card"><div className="eyebrow" style={{ marginBottom: 8 }}>What worked</div><ul className="bullets">{e.covered.map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div className="card"><div className="eyebrow" style={{ marginBottom: 8 }}>What was missing</div><ul className="bullets">{e.missing.map((x) => <li key={x}>{x}</li>)}</ul></div>
          </div>
          <div className="card"><div className="eyebrow" style={{ marginBottom: 8 }}>How to improve</div><ul className="bullets">{e.improvements.map((x) => <li key={x}>{x}</li>)}</ul>{e.improvedAnswer && <><div className="eyebrow" style={{ margin: '16px 0 6px' }}>A stronger version (uses only your facts)</div><p className="prose" style={{ whiteSpace: 'pre-wrap' }}>{e.improvedAnswer}</p></>}</div>
        </>
      ) : <Notice tone="info">{turn.evaluationError ?? 'No written evaluation for this answer.'}</Notice>}
    </div>
  );
}

export function MockReport({ sessionId, embedded }: { sessionId: string; embedded?: boolean }) {
  const sum = useAsync(() => call('mock.summary', { sessionId }), [sessionId]);
  const s: MockSummary | null = sum.data;
  if (sum.loading && !s) return <Busy />;
  if (!s || s.turns.length === 0) return <div className="card"><Empty title="No answered questions">Answer at least one question to see a report.</Empty></div>;
  const rows = (['relevance', 'completeness', 'structure', 'conciseness'] as const).map((k) => ({ k, ...s.tally[k] }));
  return (
    <div className="stack-lg">
      <div className="card">
        <div className="card-head"><h2 className="h2">Overview</h2>{s.avgWords !== null && <span className="muted small">average answer {s.avgWords} words</span>}</div>
        <table className="table">
          <thead><tr><th>Criterion</th><th className="num">Strong</th><th className="num">Adequate</th><th className="num">Weak</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.k}><td style={{ textTransform: 'capitalize' }}>{r.k}</td><td className="num level-strong">{r.strong}</td><td className="num level-adequate">{r.adequate}</td><td className="num level-weak">{r.weak}</td></tr>)}</tbody>
        </table>
        <p className="hint" style={{ marginTop: 8 }}>Counts of questions at each level. There is deliberately no overall score: a number would look precise without meaning anything.</p>
      </div>
      {s.turns.map((t) => (
        <div key={t.index} className="col" style={{ gap: 10 }}>
          <div className="row"><Pill tone="accent">Q{t.index + 1}</Pill><strong>{t.question}</strong></div>
          <div className="bubble bubble-a" style={{ alignSelf: 'stretch', maxWidth: '100%' }}><div style={{ whiteSpace: 'pre-wrap' }}>{t.answer || <span className="faint">(no answer)</span>}</div></div>
          <TurnCard turn={t} />
        </div>
      ))}
      {embedded && null}
    </div>
  );
}
