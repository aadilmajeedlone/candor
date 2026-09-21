import { BookMarked, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Story, StoryInput } from '@shared/types';
import { Busy, Empty, Modal, Notice, Pill, TagInput, useConfirm } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

const BLANK: StoryInput = { title: '', situation: '', task: '', action: '', result: '', skills: [], roles: [], tags: [] };

export default function Stories() {
  const stories = useAsync(() => call('stories.list'), []);
  const [editing, setEditing] = useState<(StoryInput & { id?: string }) | null>(null);
  const [q, setQ] = useState('');
  const { ask, dialog } = useConfirm();
  const list = (stories.data ?? []).filter((s) => !q.trim() || `${s.title} ${s.situation} ${s.action} ${s.result} ${s.tags.join(' ')} ${s.skills.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-head">
          <div>
            <div className="eyebrow">Story bank</div>
            <h1 className="h1">Your best examples, ready to use.</h1>
            <p className="sub">Save real situations in STAR form. During a live interview Candor retrieves the most relevant story for a question such as “tell me about a difficult stakeholder” and builds the answer from it.</p>
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => setEditing({ ...BLANK })}><Plus /> New story</button>
        </div>
        {(stories.data?.length ?? 0) > 0 && <div className="field" style={{ maxWidth: 360, marginBottom: 16 }}><input className="input" placeholder="Search stories…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stories" /></div>}
        {stories.loading && !stories.data ? <Busy /> : list.length === 0 ? (
          <div className="card"><Empty icon={<BookMarked />} title={q ? 'No matching stories' : 'No stories yet'} action={!q ? <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}><Plus /> Add your first story</button> : undefined}>A good story has a clear situation, what you had to do, what <em>you</em> did, and a measurable result.</Empty></div>
        ) : (
          <div className="grid grid-2">
            {list.map((s) => (
              <button key={s.id} className="tile" onClick={() => setEditing(s)}>
                <div className="tile-title">{s.title}</div>
                <p className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.situation}</p>
                <div className="chip-row">{[...s.skills, ...s.tags].slice(0, 6).map((t) => <span key={t} className="pill">{t}</span>)}</div>
                <div className="small"><strong style={{ color: 'var(--ok)' }}>Result:</strong> <span className="muted">{s.result.slice(0, 110)}{s.result.length > 110 ? '…' : ''}</span></div>
              </button>
            ))}
          </div>
        )}
        <StoryEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void stories.reload(); }}
          onDelete={guarded(async (s) => { if (await ask('Delete this story?', s.title, { confirm: 'Delete', danger: true })) { await call('stories.delete', { id: s.id }); setEditing(null); void stories.reload(); } })}
        />
        {dialog}
      </div>
    </div>
  );
}

function StoryEditor({ value, onClose, onSaved, onDelete }: { value: (StoryInput & { id?: string }) | null; onClose: () => void; onSaved: () => void; onDelete: (s: Story) => void }) {
  const [s, setS] = useState<StoryInput & { id?: string }>(BLANK);
  const [seen, setSeen] = useState<typeof value>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assist, setAssist] = useState(false);
  const settings = useApp((x) => x.settings);
  if (value !== seen) {
    setSeen(value);
    if (value) { setS(value); setError(null); setNotes(''); setAssist(false); }
  }
  const aiReady = !!settings?.routing.prep.primary || !!settings?.routing.live.primary;
  const set = <K extends keyof StoryInput>(k: K, v: StoryInput[K]) => setS((x) => ({ ...x, [k]: v }));
  const field = (k: 'situation' | 'task' | 'action' | 'result', label: string, hint: string) => (
    <div className="field"><label htmlFor={`st-${k}`}>{label}</label><textarea id={`st-${k}`} className="textarea" style={{ minHeight: 84 }} value={s[k]} onChange={(e) => set(k, e.target.value)} placeholder={hint} /></div>
  );
  return (
    <Modal open={!!value} onClose={onClose} wide title={s.id ? 'Edit story' : 'New story'} footer={<>{s.id && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => onDelete(s as Story)}><Trash2 /> Delete</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!s.title.trim() || busy} onClick={guarded(async () => { setBusy(true); setError(null); try { await call('stories.save', s); onSaved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } })}>Save story</button></>}>
      <div className="col" style={{ gap: 14 }}>
        {error && <Notice tone="bad">{error}</Notice>}
        {!s.id && (
          <div>
            {assist ? (
              <div className="col">
                <label className="label" htmlFor="st-notes">Rough notes — write it however it comes</label>
                <textarea id="st-notes" className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Returns were taking too long and the backlog kept growing. I mapped the process, removed two approval steps and set up a triage queue. Handling time dropped 22%." />
                <div className="row"><button className="btn btn-sm btn-primary" disabled={notes.trim().length < 20 || busy} onClick={guarded(async () => { setBusy(true); setError(null); try { const d = await call('stories.assist', { notes }); setS((x) => ({ ...x, ...d, title: d.title || x.title })); setAssist(false); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } })}>{busy ? <Busy /> : <Sparkles />} Structure it</button><button className="btn btn-sm" onClick={() => setAssist(false)}>Cancel</button></div>
                <p className="hint">The AI only rearranges what you wrote. Anything your notes don’t cover is left blank for you to fill.</p>
              </div>
            ) : (
              <button className="btn btn-sm" disabled={!aiReady} title={aiReady ? '' : 'Set up an AI model first'} onClick={() => setAssist(true)}><Sparkles /> Draft from rough notes</button>
            )}
          </div>
        )}
        <div className="field"><label htmlFor="st-title">Title</label><input id="st-title" className="input" value={s.title} onChange={(e) => set('title', e.target.value)} placeholder="Returns workflow redesign" /></div>
        <div className="grid grid-2">
          {field('situation', 'Situation', 'The context and the problem')}
          {field('task', 'Task', 'What you were responsible for')}
          {field('action', 'Action', 'What you personally did, step by step')}
          {field('result', 'Result', 'The outcome — numbers if you have them')}
        </div>
        <div className="grid grid-3">
          <div className="field"><label>Skills demonstrated</label><TagInput value={s.skills} onChange={(v) => set('skills', v)} placeholder="e.g. process improvement" /></div>
          <div className="field"><label>Relevant roles</label><TagInput value={s.roles} onChange={(v) => set('roles', v)} placeholder="e.g. Operations Manager" /></div>
          <div className="field"><label>Tags</label><TagInput value={s.tags} onChange={(v) => set('tags', v)} placeholder="e.g. conflict, deadline" /></div>
        </div>
        <Pill tone="info">Everything in a story counts as your own words: keep it true.</Pill>
      </div>
    </Modal>
  );
}
