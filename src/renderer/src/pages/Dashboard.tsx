import { ArrowRight, Check, Mic, Plus, Radio } from 'lucide-react';
import { localSpeechUsable } from '@shared/speech';
import { INTERVIEW_TYPES } from '@shared/types';
import { formatMs } from '@shared/util';
import { Busy, Empty, Pill } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call } from '@/services/api';
import { useApp } from '@/store/app';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Dashboard() {
  const { settings, profile, navigate, setActiveInterview } = useApp();
  const dash = useAsync(() => call('app.dashboard'), []);
  const resumes = useAsync(() => call('resumes.list'), []);
  const stt = useAsync(() => call('stt.keys'), []);
  const local = useAsync(() => call('stt.localStatus'), []);
  const d = dash.data;
  if (!settings) return null;
  const aiOk = !!settings.routing.live.primary || !!settings.routing.prep.primary;
  const onDevice = settings.stt.provider === 'local';
  const sttOk = onDevice ? localSpeechUsable(local.data) : (stt.data?.some((k) => k.keySource !== 'none') ?? false);
  const steps = [
    { done: (resumes.data?.length ?? 0) > 0, label: 'Add your résumé', go: () => navigate('interviews') },
    { done: aiOk, label: 'Connect an AI provider', go: () => navigate('settings', { settingsTab: 'providers' }) },
    { done: sttOk, label: onDevice ? 'Speech recognition on this PC is ready (free, nothing to set up)' : 'Add a speech-recognition key (for live audio)', go: () => navigate('settings', { settingsTab: 'speech' }) },
    { done: (d?.interviews ?? 0) > 0, label: 'Create your first interview', go: () => navigate('interviews', { openNew: true }) },
  ];
  const remaining = steps.filter((s) => !s.done);
  const name = profile?.name?.split(/\s+/)[0];

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="hero">
          <div className="hero-main">
            <div>
              <div className="eyebrow">Dashboard</div>
              <h1 className="display">{greeting()}{name ? `, ${name}` : ''}.</h1>
              <p className="muted" style={{ marginTop: 10, maxWidth: '52ch' }}>{remaining.length === 0 ? 'You are set up. Start a live session, or rehearse first with a mock interview.' : 'A few quick steps and Candor is ready to prepare you, and to answer in real time.'}</p>
            </div>
            <div className="row row-wrap">
              {remaining.length === 0 ? (
                <>
                  <button className="btn btn-primary btn-lg" onClick={() => navigate('live')}><Radio /> Start live interview</button>
                  <button className="btn btn-lg" onClick={() => navigate('mock')}><Mic /> Mock interview</button>
                </>
              ) : (
                <button className="btn btn-primary btn-lg" onClick={remaining[0].go}>{remaining[0].label} <ArrowRight /></button>
              )}
              <button className="btn btn-lg btn-ghost" onClick={() => navigate('interviews', { openNew: true })}><Plus /> New interview</button>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2 className="h2">Getting ready</h2><span className="faint small">{steps.filter((s) => s.done).length}/{steps.length}</span></div>
            <ul className="checklist">
              {steps.map((s) => (
                <li key={s.label}>
                  <span className="dot" data-done={s.done}>{s.done && <Check size={12} strokeWidth={3} />}</span>
                  <span className="grow" style={{ color: s.done ? 'var(--text-dim)' : 'var(--text)', textDecoration: s.done ? 'line-through' : undefined }}>{s.label}</span>
                  {!s.done && <button className="btn btn-sm btn-ghost" onClick={s.go}>Do it</button>}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {dash.loading && !d ? <Busy /> : d && (
          <>
            <div className="grid grid-4" style={{ marginBottom: 20 }}>
              <div className="card stat"><div className="stat-value">{d.interviews}</div><div className="stat-label">Interviews prepared</div></div>
              <div className="card stat"><div className="stat-value">{d.liveSessions}</div><div className="stat-label">Live sessions</div></div>
              <div className="card stat"><div className="stat-value">{d.mockSessions}</div><div className="stat-label">Mock &amp; practice sessions</div></div>
              <div className="card stat" title="Median across your recent live sessions, measured — not estimated."><div className="stat-value mono" style={{ fontFamily: 'var(--font-display)' }}>{d.ttftMedianMs === null ? '—' : formatMs(d.ttftMedianMs)}</div><div className="stat-label">Median time to first word</div></div>
            </div>
            <div className="grid grid-2">
              <div className="card">
                <div className="card-head"><h2 className="h2">Recent interviews</h2><button className="btn btn-sm btn-ghost" onClick={() => navigate('interviews')}>All</button></div>
                {d.recentInterviews.length === 0 ? <Empty title="Nothing yet">Create an interview to see it here.</Empty> : d.recentInterviews.map((i) => (
                  <button key={i.id} className="list-item" onClick={() => { setActiveInterview(i.id); navigate('preparation', { interviewId: i.id }); }}>
                    <div className="grow" style={{ minWidth: 0 }}><div className="truncate" style={{ fontWeight: 550 }}>{i.title}</div><div className="small faint">{INTERVIEW_TYPES.find((t) => t.value === i.interviewType)?.label} · {new Date(i.updatedAt).toLocaleDateString()}</div></div>
                    <Pill tone={i.status === 'ready' ? 'ok' : 'warn'}>{i.status === 'ready' ? 'analysed' : 'draft'}</Pill>
                  </button>
                ))}
              </div>
              <div className="card">
                <div className="card-head"><h2 className="h2">Recent sessions</h2><button className="btn btn-sm btn-ghost" onClick={() => navigate('history')}>History</button></div>
                {d.recentSessions.length === 0 ? <Empty title="No sessions yet">Live and mock sessions are saved here.</Empty> : d.recentSessions.map((s) => (
                  <button key={s.id} className="list-item" onClick={() => navigate('history', { sessionId: s.id })}>
                    <div className="grow" style={{ minWidth: 0 }}><div className="truncate" style={{ fontWeight: 550 }}>{s.title}</div><div className="small faint">{new Date(s.startedAt).toLocaleString()}{s.stats ? ` · ${s.stats.turns} question${s.stats.turns === 1 ? '' : 's'}` : ''}</div></div>
                    <Pill>{s.kind}</Pill>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
