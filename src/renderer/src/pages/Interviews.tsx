import { BookOpenCheck, Briefcase, CheckCircle2, FileText, Mic, Plus, Radio, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { INTERVIEW_TYPES, type Interview, type InterviewType, type ResumeRecord, type ResumeSummary } from '@shared/types';
import type { ExtractedDocumentDTO } from '@shared/ipc';
import { Busy, DropZone, Empty, Modal, Notice, Pill, Tabs, useConfirm } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

const MAX_BYTES = 15 * 1024 * 1024;

export async function readFile(file: File): Promise<ExtractedDocumentDTO> {
  if (file.size > MAX_BYTES) throw new Error('That file is larger than 15 MB.');
  return call('documents.extract', { name: file.name, data: await file.arrayBuffer() });
}

export default function Interviews() {
  const { navigate, params, setActiveInterview, activeInterviewId } = useApp();
  const [tab, setTab] = useState<'interviews' | 'resumes'>('interviews');
  const [creating, setCreating] = useState(!!params.openNew);
  const interviews = useAsync(() => call('interviews.list'), []);
  const resumes = useAsync(() => call('resumes.list'), []);
  const { ask, dialog } = useConfirm();
  const list = interviews.data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Interviews</div>
          <h1 className="h1">Every interview, prepared.</h1>
          <p className="sub">Add a role and your résumé once. Candor analyses the job description, matches it against your real experience and builds a compact context it reuses for every answer.</p>
        </div>
        <button className="btn btn-primary btn-lg" onClick={() => setCreating(true)}><Plus /> New interview</button>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'interviews', label: 'Interviews' }, { id: 'resumes', label: 'Résumés', badge: resumes.data?.length ? <span className="pill" style={{ marginLeft: 8 }}>{resumes.data.length}</span> : null }]} />

      {tab === 'interviews' && (
        interviews.loading && !interviews.data ? <Busy /> : list.length === 0 ? (
          <div className="card"><Empty icon={<Briefcase />} title="No interviews yet" action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus /> Create your first interview</button>}>Paste a job description and choose your résumé. You will get a match analysis, likely questions and prepared answers.</Empty></div>
        ) : (
          <div className="grid grid-3">
            {list.map((i) => (
              <InterviewTile key={i.id} i={i} active={i.id === activeInterviewId} onPrepare={() => { setActiveInterview(i.id); navigate('preparation', { interviewId: i.id }); }} onLive={() => { setActiveInterview(i.id); navigate('live'); }} onMock={() => { setActiveInterview(i.id); navigate('mock'); }} onDelete={guarded(async () => { if (await ask('Delete this interview?', 'Its preparation material is deleted. Past sessions stay in History.', { confirm: 'Delete', danger: true })) { await call('interviews.delete', { id: i.id }); void interviews.reload(); } })} />
            ))}
          </div>
        )
      )}
      {tab === 'resumes' && <ResumesTab resumes={resumes.data ?? []} loading={resumes.loading} reload={() => void resumes.reload()} />}

      <NewInterviewModal open={creating} onClose={() => setCreating(false)} resumes={resumes.data ?? []} onCreated={(i) => { setCreating(false); void interviews.reload(); void resumes.reload(); setActiveInterview(i.id); useApp.getState().toast('Interview ready.', 'ok'); navigate('preparation', { interviewId: i.id }); }} />
      {dialog}
    </div>
  );
}

function InterviewTile({ i, active, onPrepare, onLive, onMock, onDelete }: { i: Interview; active: boolean; onPrepare: () => void; onLive: () => void; onMock: () => void; onDelete: () => void }) {
  const m = i.match;
  const total = m ? m.strong.length + m.partial.length + m.missing.length : 0;
  return (
    <div className="tile hoverable" style={active ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="tile-title truncate">{i.jobTitle || 'Untitled role'}</div>
          <div className="muted small truncate">{i.company || 'Company not set'}</div>
        </div>
        <Pill tone={i.status === 'ready' ? 'ok' : 'warn'}>{i.status === 'ready' ? 'analysed' : 'draft'}</Pill>
      </div>
      <div className="chip-row"><Pill>{INTERVIEW_TYPES.find((t) => t.value === i.interviewType)?.label}</Pill>{active && <Pill tone="accent">active</Pill>}</div>
      {m && total > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <div className="match-bar" aria-label="Résumé match">
            <div style={{ flex: m.strong.length, background: 'var(--ok)' }} /><div style={{ flex: m.partial.length, background: 'var(--warn)' }} /><div style={{ flex: m.missing.length, background: 'var(--bad)' }} />
          </div>
          <div className="small muted">{m.strong.length} strong · {m.partial.length} partial · {m.missing.length} gaps</div>
        </div>
      )}
      <div className="row row-wrap" style={{ marginTop: 'auto', paddingTop: 6 }}>
        <button className="btn btn-sm btn-primary" onClick={onPrepare}><BookOpenCheck /> Prepare</button>
        <button className="btn btn-sm" onClick={onLive}><Radio /> Live</button>
        <button className="btn btn-sm" onClick={onMock}><Mic /> Mock</button>
        <span className="grow" />
        <button className="btn btn-sm btn-ghost btn-icon" aria-label="Delete interview" onClick={onDelete}><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

type ResumeChoice = { kind: 'existing'; id: string } | { kind: 'new'; doc: ExtractedDocumentDTO } | { kind: 'none' };

export function ResumePicker({ resumes, value, onChange }: { resumes: ResumeSummary[]; value: ResumeChoice; onChange: (v: ResumeChoice) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const take = async (p: Promise<ExtractedDocumentDTO | null>) => {
    setBusy(true);
    setError(null);
    try {
      const d = await p;
      if (d) onChange({ kind: 'new', doc: d });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      {resumes.length > 0 && (
        <select className="select" aria-label="Choose a saved résumé" value={value.kind === 'existing' ? value.id : value.kind === 'new' ? '__new' : ''} onChange={(e) => e.target.value && e.target.value !== '__new' ? onChange({ kind: 'existing', id: e.target.value }) : e.target.value === '' ? onChange({ kind: 'none' }) : undefined}>
          <option value="">Choose a saved résumé…</option>
          {value.kind === 'new' && <option value="__new">New: {value.doc.name}</option>}
          {resumes.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.factCount} facts</option>)}
        </select>
      )}
      {value.kind === 'new' ? (
        <div className="notice notice-ok"><CheckCircle2 /><div className="grow"><strong>{value.doc.name}</strong><div className="small muted">{value.doc.text.length.toLocaleString()} characters read{value.doc.pages ? ` from ${value.doc.pages} page${value.doc.pages === 1 ? '' : 's'}` : ''}. Text is parsed on this PC.</div>{value.doc.warnings.map((w) => <div key={w} className="small" style={{ color: 'var(--warn)' }}>{w}</div>)}</div><button className="btn btn-sm" onClick={() => onChange({ kind: 'none' })}>Change</button></div>
      ) : pasting ? (
        <div className="col">
          <textarea className="textarea" style={{ minHeight: 160 }} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste your résumé text here" aria-label="Résumé text" />
          <div className="row"><button className="btn btn-primary btn-sm" disabled={paste.trim().length < 40} onClick={() => { onChange({ kind: 'new', doc: { name: 'Pasted résumé', source: 'paste', text: paste, warnings: [] } }); setPasting(false); }}>Use this text</button><button className="btn btn-sm" onClick={() => setPasting(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <DropZone label="Drop your résumé here" busy={busy} onFile={(f) => void take(readFile(f))} onPick={() => void take(call('documents.pick', { purpose: 'resume' }))} />
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setPasting(true)}><FileText /> Or paste the text</button>
        </>
      )}
      {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}
    </div>
  );
}

function NewInterviewModal({ open, onClose, resumes, onCreated }: { open: boolean; onClose: () => void; resumes: ResumeSummary[]; onCreated: (i: Interview) => void }) {
  const settings = useApp((s) => s.settings);
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [type, setType] = useState<InterviewType>('general');
  const [jd, setJd] = useState('');
  const [notes, setNotes] = useState('');
  const [interviewer, setInterviewer] = useState('');
  const [resume, setResume] = useState<ResumeChoice>({ kind: 'none' });
  const [useAi, setUseAi] = useState(true);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jdBusy, setJdBusy] = useState(false);
  const [more, setMore] = useState(false);
  const aiReady = !!settings?.routing.prep.primary || !!settings?.routing.live.primary;

  useEffect(() => {
    if (open) {
      setError(null);
      setStep(null);
      if (resumes.length > 0 && resume.kind === 'none') setResume({ kind: 'existing', id: resumes[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const busy = step !== null;
  const canCreate = (jobTitle.trim() || jd.trim().length > 40) && resume.kind !== 'none' && !busy;

  const submit = async () => {
    setError(null);
    try {
      let resumeId: string | null = null;
      if (resume.kind === 'existing') resumeId = resume.id;
      else if (resume.kind === 'new') {
        setStep(useAi && aiReady ? 'Reading your résumé and extracting facts with AI…' : 'Reading your résumé…');
        const rec: ResumeRecord = await call('resumes.create', { name: resume.doc.name, source: resume.doc.source, text: resume.doc.text, useAi: useAi && aiReady });
        resumeId = rec.id;
      }
      setStep('Creating the interview…');
      const i = await call('interviews.create', { jobTitle: jobTitle.trim(), company: company.trim(), interviewType: type, jobDescription: jd, companyNotes: notes, interviewerInfo: interviewer, resumeId });
      setStep(useAi && aiReady ? 'Analysing the job description and matching it to your experience…' : 'Analysing the job description…');
      const analysed = await call('interviews.analyze', { id: i.id, useAi: useAi && aiReady });
      setStep(null);
      onCreated(analysed);
      setJobTitle(''); setCompany(''); setJd(''); setNotes(''); setInterviewer(''); setResume({ kind: 'none' });
    } catch (e) {
      setStep(null);
      setError(errorMessage(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      wide
      title="New interview"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!canCreate} onClick={guarded(submit)}>{busy ? <Busy label={step ?? ''} /> : <><Sparkles /> Create &amp; analyse</>}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        {error && <Notice tone="bad" onClose={() => setError(null)}>{error}</Notice>}
        <div className="grid grid-3">
          <div className="field"><label htmlFor="ni-title">Job title</label><input id="ni-title" className="input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Operations Manager" /></div>
          <div className="field"><label htmlFor="ni-company">Company</label><input id="ni-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Contoso" /></div>
          <div className="field"><label htmlFor="ni-type">Interview type</label><select id="ni-type" className="select" value={type} onChange={(e) => setType(e.target.value as InterviewType)}>{INTERVIEW_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        </div>
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <div className="field"><label>Your résumé</label><ResumePicker resumes={resumes} value={resume} onChange={setResume} /></div>
          <div className="field">
            <label htmlFor="ni-jd">Job description</label>
            <textarea id="ni-jd" className="textarea" style={{ minHeight: 190 }} value={jd} onChange={(e) => setJd(e.target.value)} placeholder="Paste the job description, or import a file below" />
            <div className="row">
              <button className="btn btn-sm" disabled={jdBusy} onClick={guarded(async () => { setJdBusy(true); try { const d = await call('documents.pick', { purpose: 'jd' }); if (d) setJd(d.text); } catch (e) { setError(errorMessage(e)); } finally { setJdBusy(false); } })}>{jdBusy ? <Busy /> : <Upload />} Import from file</button>
              <span className="hint">{jd.length.toLocaleString()} characters</span>
            </div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setMore((m) => !m)}>{more ? 'Hide' : 'Add'} company info &amp; interviewer details (optional)</button>
        {more && (
          <div className="grid grid-2">
            <div className="field"><label htmlFor="ni-notes">Company information</label><textarea id="ni-notes" className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What you know: products, culture, news, why you want to work there. Candor only uses what you write here." /></div>
            <div className="field"><label htmlFor="ni-int">Interviewer</label><textarea id="ni-int" className="textarea" value={interviewer} onChange={(e) => setInterviewer(e.target.value)} placeholder="Name, role, anything you know" /></div>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(e) => setUseAi(e.target.checked)} />
          <span>Use AI to analyse the résumé and job description <span className="hint">{aiReady ? '— sends the résumé and JD text to your AI provider once; results are checked against your text and anything not found in it is discarded.' : '— no AI model is set up, so the offline analyser will be used (you can re-run with AI later).'}</span></span>
        </label>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ResumesTab({ resumes, loading, reload }: { resumes: ResumeSummary[]; loading: boolean; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const [adding, setAdding] = useState(false);
  if (loading && resumes.length === 0) return <Busy />;
  return (
    <div className="stack-lg">
      <div className="row between"><p className="muted small" style={{ maxWidth: '64ch' }}>Each résumé is parsed once into small, source-checked facts. Open one to see exactly what Candor is allowed to claim.</p><button className="btn" onClick={() => setAdding(true)}><Plus /> Add résumé</button></div>
      {resumes.length === 0 ? <div className="card"><Empty icon={<FileText />} title="No résumés yet">Add one here or while creating an interview.</Empty></div> : (
        <div className="list card card-flush">
          {resumes.map((r) => (
            <div key={r.id} className="list-item">
              <FileText size={18} color="var(--text-faint)" />
              <div className="grow"><div style={{ fontWeight: 550 }}>{r.name}</div><div className="small muted">{r.headline ?? 'No headline found'} · {r.factCount} facts · added {new Date(r.createdAt).toLocaleDateString()}</div></div>
              <Pill tone={r.parseMethod === 'llm' ? 'accent' : 'default'}>{r.parseMethod === 'llm' ? 'AI-assisted' : 'offline parser'}</Pill>
              <button className="btn btn-sm" onClick={() => setOpen(r.id)}>Inspect</button>
              <button className="btn btn-sm btn-danger btn-icon" aria-label={`Delete ${r.name}`} onClick={guarded(async () => { if (await ask('Delete this résumé?', 'Interviews that use it will need another résumé.', { confirm: 'Delete', danger: true })) { await call('resumes.delete', { id: r.id }); reload(); } })}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      <ResumeDetail id={open} onClose={() => setOpen(null)} onChanged={reload} />
      <AddResume open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload(); }} />
      {dialog}
    </div>
  );
}

function AddResume({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [choice, setChoice] = useState<ResumeChoice>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appSettings = useApp((s) => s.settings);
  const aiReady = !!appSettings?.routing.prep.primary || !!appSettings?.routing.live.primary;
  const [useAi, setUseAi] = useState(true);
  return (
    <Modal open={open} onClose={onClose} title="Add a résumé" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={choice.kind !== 'new' || busy} onClick={guarded(async () => { if (choice.kind !== 'new') return; setBusy(true); setError(null); try { await call('resumes.create', { name: choice.doc.name, source: choice.doc.source, text: choice.doc.text, useAi: useAi && aiReady }); setChoice({ kind: 'none' }); onAdded(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } })}>{busy ? <Busy /> : null} Add</button></>}>
      <div className="col">
        {error && <Notice tone="bad">{error}</Notice>}
        <ResumePicker resumes={[]} value={choice} onChange={setChoice} />
        <label className="check"><input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(e) => setUseAi(e.target.checked)} /> Use AI to extract facts {!aiReady && <span className="hint">(no AI model set up)</span>}</label>
      </div>
    </Modal>
  );
}

function ResumeDetail({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const rec = useAsync(() => (id ? call('resumes.get', { id }) : Promise.resolve(null)), [id]);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const appSettings = useApp((s) => s.settings);
  const aiReady = !!appSettings?.routing.prep.primary || !!appSettings?.routing.live.primary;
  const r = rec.data;
  const p = r?.profile;
  return (
    <Modal open={!!id} onClose={onClose} wide title={r?.name ?? 'Résumé'} footer={<>{r && <button className="btn" disabled={busy} onClick={guarded(async () => { setBusy(true); try { await call('resumes.reparse', { id: r.id, useAi: aiReady }); await rec.reload(); onChanged(); toast(aiReady ? 'Re-analysed with AI.' : 'Re-parsed with the offline parser.', 'ok'); } catch (e) { toast(errorMessage(e), 'bad'); } finally { setBusy(false); } })}>{busy ? <Busy /> : <RefreshCw />} Re-analyse{aiReady ? ' with AI' : ''}</button>}<button className="btn btn-primary" onClick={onClose}>Done</button></>}>
      {!p || !r ? <Busy /> : (
        <div className="col" style={{ gap: 14 }}>
          {r.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          <div className="grid grid-3">
            <div><div className="eyebrow">Name</div>{p.name ?? '—'}</div>
            <div><div className="eyebrow">Current role</div>{p.currentRole ?? '—'}</div>
            <div><div className="eyebrow">Experience</div>{p.yearsExperience ? `about ${p.yearsExperience} years` : '—'}</div>
          </div>
          {p.skills.length > 0 && <div><div className="eyebrow" style={{ marginBottom: 6 }}>Skills &amp; tools</div><div className="chip-row">{[...new Set([...p.skills, ...p.tools])].slice(0, 40).map((s) => <span key={s} className="pill">{s}</span>)}</div></div>}
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Roles found</div>
            {p.roles.length === 0 ? <span className="muted small">No roles recognised — facts below are still usable.</span> : p.roles.map((x, i) => <div key={i} className="small" style={{ padding: '4px 0' }}><strong>{x.title || '—'}</strong> · {x.company || '—'} <span className="faint">{[x.start, x.current ? 'Present' : x.end].filter(Boolean).join(' – ')}</span></div>)}
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{p.facts.length} facts Candor may use</div>
            <div className="list card card-flush" style={{ maxHeight: 280, overflow: 'auto' }}>
              {p.facts.map((f) => <div key={f.id} className="list-item" style={{ alignItems: 'flex-start' }}><Pill>{f.kind}</Pill><div className="grow small"><div>{f.text}</div>{f.label && <div className="faint">{f.label}</div>}</div></div>)}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
