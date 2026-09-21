import { History as HistoryIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AnswerRecord, SessionKind, SessionRecord } from '@shared/types';
import { ANSWER_MODES } from '@shared/modes';
import { formatMs } from '@shared/util';
import { Busy, Empty, Notice, Pill, useConfirm } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { AnswerText } from './Live';
import { MockReport } from './Mock';
import { guarded } from '@/lib/guarded';

export default function HistoryPage() {
  const params = useApp((s) => s.params);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<SessionKind | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(params.sessionId ?? null);
  const list = useAsync(() => call('sessions.list', { search: search || undefined, kind: kind === 'all' ? undefined : kind }), [search, kind]);
  const sessions = list.data ?? [];
  useEffect(() => { if (params.sessionId) setSelected(params.sessionId); }, [params.sessionId]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">History</div>
          <h1 className="h1">Every session, searchable.</h1>
        </div>
      </div>
      <div className="history-split">
        <div className="col" style={{ gap: 12 }}>
          <input className="input" placeholder="Search questions, answers, transcript, notes…" aria-label="Search history" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="modes" role="group" aria-label="Kind">
            {(['all', 'live', 'mock', 'practice'] as const).map((k) => <button key={k} className="mode-btn" aria-pressed={kind === k} onClick={() => setKind(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}
          </div>
          <div className="card card-flush list" style={{ maxHeight: 'calc(100vh - 290px)', overflow: 'auto' }}>
            {list.loading && !list.data ? <div style={{ padding: 16 }}><Busy /></div> : sessions.length === 0 ? <Empty icon={<HistoryIcon />} title={search ? 'No matches' : 'No sessions yet'}>{search ? 'Try different words.' : 'Live, mock and practice sessions appear here.'}</Empty> : sessions.map((s) => (
              <button key={s.id} className="list-item" style={selected === s.id ? { background: 'var(--accent-soft)' } : undefined} onClick={() => setSelected(s.id)}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontWeight: 550 }}>{s.title}</div>
                  <div className="small faint">{new Date(s.startedAt).toLocaleString()}{s.stats ? ` · ${s.stats.turns} Q` : ''}</div>
                </div>
                <Pill tone={s.kind === 'live' ? 'accent' : 'default'}>{s.kind}</Pill>
              </button>
            ))}
          </div>
        </div>
        {selected ? <SessionView key={selected} id={selected} onDeleted={() => { setSelected(null); void list.reload(); }} /> : <div className="card"><Empty title="Select a session">Its transcript, answers, timings and your notes appear here.</Empty></div>}
      </div>
    </div>
  );
}

function SessionView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const detail = useAsync(() => call('sessions.get', { id }), [id]);
  const toast = useApp((s) => s.toast);
  const { ask, dialog } = useConfirm();
  const [notes, setNotes] = useState<string | null>(null);
  const d = detail.data;
  if (detail.loading && !d) return <div className="card"><Busy /></div>;
  if (detail.error || !d) return <Notice tone="bad">{detail.error ?? 'Could not load this session.'}</Notice>;
  const s: SessionRecord = d;
  const mock = d.answers.some((a) => a.mock);
  return (
    <div className="stack-lg" style={{ minWidth: 0 }}>
      <div className="card">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h2 className="h1" style={{ fontSize: '1.7rem' }}>{s.title}</h2>
            <div className="muted small" style={{ marginTop: 4 }}>{new Date(s.startedAt).toLocaleString()}{s.endedAt ? ` → ${new Date(s.endedAt).toLocaleTimeString()}` : ' (unfinished)'}{s.company ? ` · ${s.company}` : ''}{s.interviewType ? ` · ${s.interviewType}` : ''}</div>
          </div>
          <button className="btn btn-danger btn-sm" onClick={guarded(async () => { if (await ask('Delete this session?', 'Its transcript, answers and timings will be permanently deleted.', { confirm: 'Delete', danger: true })) { await call('sessions.delete', { id }); toast('Session deleted.', 'ok'); onDeleted(); } })}><Trash2 /> Delete</button>
        </div>
        {s.stats && (
          <div className="grid grid-4" style={{ marginTop: 14 }}>
            <div className="stat"><div className="stat-value">{s.stats.turns}</div><div className="stat-label">questions</div></div>
            <div className="stat"><div className="stat-value" style={{ fontSize: '1.7rem' }}>{formatMs(s.stats.ttftMedianMs)}</div><div className="stat-label">median first word</div></div>
            <div className="stat"><div className="stat-value" style={{ fontSize: '1.7rem' }}>{formatMs(s.stats.ttftP95Ms)}</div><div className="stat-label">p95 first word</div></div>
            <div className="stat"><div className="stat-value">{s.stats.cacheHits}</div><div className="stat-label">instant (prepared / cached)</div></div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="h2" style={{ marginBottom: 8 }}>Your notes</h2>
        <textarea className="textarea" aria-label="Session notes" value={notes ?? s.notes} onChange={(e) => setNotes(e.target.value)} onBlur={guarded(async () => { if (notes !== null && notes !== s.notes) { try { await call('sessions.notes', { id, notes }); toast('Notes saved.', 'ok'); void detail.reload(); } catch (e) { toast(errorMessage(e), 'bad'); } } })} placeholder="What went well? What to improve? Follow-ups to send?" />
      </div>

      {mock && <MockReport sessionId={id} embedded />}

      {!mock && (
        <div className="card">
          <h2 className="h2" style={{ marginBottom: 12 }}>Questions &amp; answers</h2>
          {d.answers.length === 0 ? <p className="muted small">No answers were saved for this session.</p> : (
            <div className="col" style={{ gap: 18 }}>{d.answers.map((a) => <AnswerBlock key={a.id} a={a} onChanged={() => void detail.reload()} />)}</div>
          )}
        </div>
      )}

      {d.transcript.length > 0 && (
        <div className="card">
          <h2 className="h2" style={{ marginBottom: 10 }}>Transcript</h2>
          <div className="col" style={{ gap: 6 }}>{d.transcript.map((t) => <div key={t.id} className="small"><b style={{ color: t.speaker === 'interviewer' ? 'var(--info)' : t.speaker === 'candidate' ? 'var(--accent)' : 'var(--text-faint)' }}>{t.speaker === 'candidate' ? 'You' : t.speaker === 'interviewer' ? 'Interviewer' : 'Speaker'}:</b> {t.text}</div>)}</div>
        </div>
      )}
      {dialog}
    </div>
  );
}

function AnswerBlock({ a, onChanged }: { a: AnswerRecord; onChanged: () => void }) {
  const toast = useApp((s) => s.toast);
  const l = a.latency;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="bubble bubble-q"><strong>{a.questionText}</strong></div>
      <div className="bubble bubble-a"><div style={{ whiteSpace: 'pre-wrap' }}><AnswerText text={a.answerText} flagged={a.grounding?.unverified} /></div></div>
      <div className="row row-wrap small faint">
        <Pill>{ANSWER_MODES[a.mode].label}</Pill>
        {a.source === 'cache' && <Pill tone="ok">instant</Pill>}
        {a.edited && <Pill>edited</Pill>}
        {a.model && <span>{a.model}</span>}
        {l?.ttftMs !== undefined && <span>first word {formatMs(l.ttftMs)}</span>}
        {l?.totalMs !== undefined && <span>total {formatMs(l.totalMs)}</span>}
        {l?.speculative && <span>started early ⚡</span>}
        {a.feedback.map((f) => <Pill key={f} tone={f === 'useful' ? 'ok' : 'warn'}>{f.replace('-', ' ')}</Pill>)}
        <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard.writeText(a.answerText).then(() => toast('Copied.', 'ok'))}>Copy</button>
        <button className="btn btn-sm btn-ghost" onClick={guarded(async () => { await call('answers.feedback', { id: a.id, tags: a.feedback.includes('useful') ? [] : ['useful'] }); onChanged(); })}>{a.feedback.includes('useful') ? 'Unmark useful' : 'Mark useful'}</button>
      </div>
    </div>
  );
}
