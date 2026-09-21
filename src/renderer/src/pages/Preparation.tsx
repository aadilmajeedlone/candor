import { AlertTriangle, BookOpenCheck, ChevronDown, ChevronRight, Copy, Mic, Radio, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ANSWER_MODES, MODE_ORDER } from '@shared/modes';
import type { AboutMePrep, AnswerMode, AnswerRecord, CompanyPrep, Interview, MatchItem, PreparedQuestion, QuestionCategory, QuestionsPrep, RolePrep } from '@shared/types';
import { QUESTION_CATEGORY_LABELS } from '@shared/types';
import { Busy, Empty, Notice, Pill, Tabs } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useGen } from '@/hooks/useGen';
import { call, errorMessage, subscribe } from '@/services/api';
import { useApp } from '@/store/app';
import { AnswerText } from './Live';

type Tab = 'about' | 'role' | 'company' | 'questions' | 'match' | 'prepared';
type SectionKey = 'about' | 'role' | 'company' | 'questions';
const SECTION_KEYS: readonly string[] = ['about', 'role', 'company', 'questions'];

export default function Preparation() {
  const { params, activeInterviewId, navigate, setActiveInterview, toast, settings } = useApp();
  const list = useAsync(() => call('interviews.list'), []);
  const [id, setId] = useState<string | null>(params.interviewId ?? activeInterviewId);
  const [tab, setTab] = useState<Tab>('about');
  const interviews = list.data ?? [];
  const interviewId = id && interviews.some((i) => i.id === id) ? id : (interviews[0]?.id ?? null);
  const interview = interviews.find((i) => i.id === interviewId) ?? null;
  const prep = useAsync(() => (interviewId ? call('prep.get', { interviewId }) : Promise.resolve(null)), [interviewId]);
  const answers = useAsync(() => (interviewId ? call('prep.answers', { interviewId }) : Promise.resolve([] as AnswerRecord[])), [interviewId]);
  const [progress, setProgress] = useState<{ step: string; done: number; total: number; error?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => subscribe('prep.progress', (p) => {
    if (p.interviewId !== interviewId) return;
    setProgress({ step: p.step, done: p.done, total: p.total, error: p.error });
    if (p.error) setErrors((e) => ({ ...e, [p.step]: p.error! }));
    if (p.step === 'complete') {
      void prep.reload();
      setProgress(null);
      if (!document.hasFocus()) void call('app.showNotification', { title: 'Preparation ready', body: 'Your interview preparation has finished.' }).catch(() => undefined);
    }
  }), [interviewId, prep]);

  if (list.loading && !list.data) return <div className="page"><Busy /></div>;
  if (interviews.length === 0) {
    return (
      <div className="page"><div className="page-narrow"><div className="card"><Empty icon={<BookOpenCheck />} title="Create an interview first" action={<button className="btn btn-primary" onClick={() => navigate('interviews', { openNew: true })}>New interview</button>}>Preparation material is generated from an interview’s job description and your résumé.</Empty></div></div></div>
    );
  }

  const data = prep.data ?? {};
  const generate = async (section: 'all' | 'about' | 'role' | 'company' | 'questions') => {
    if (!interviewId) return;
    setErrors({});
    setProgress({ step: 'starting', done: 0, total: section === 'all' ? 4 : 1 });
    try {
      await call('prep.generate', { interviewId, section });
    } catch (e) {
      toast(errorMessage(e), 'bad');
      setProgress(null);
    }
  };
  const reanalyse = async () => {
    if (!interviewId) return;
    try {
      const ai = !!settings?.routing.prep.primary || !!settings?.routing.live.primary;
      await call('interviews.analyze', { id: interviewId, useAi: ai });
      await list.reload();
      toast(ai ? 'Re-analysed with AI.' : 'Re-analysed offline.', 'ok');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-head">
          <div>
            <div className="eyebrow">Preparation</div>
            <h1 className="h1">{interview?.jobTitle || 'Interview'}{interview?.company ? <span className="faint"> · {interview.company}</span> : null}</h1>
          </div>
          <div className="row row-wrap">
            <select className="select" style={{ width: 260 }} aria-label="Interview" value={interviewId ?? ''} onChange={(e) => { setId(e.target.value); setActiveInterview(e.target.value); }}>
              {interviews.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
            </select>
            <button className="btn" onClick={() => { setActiveInterview(interviewId); navigate('live'); }}><Radio /> Go live</button>
            <button className="btn" onClick={() => { setActiveInterview(interviewId); navigate('mock'); }}><Mic /> Mock</button>
            <button className="btn btn-primary" onClick={() => void generate('all')} disabled={!!progress}>{progress ? <Busy label={`${progress.done}/${progress.total}`} /> : <Sparkles />} Generate all</button>
          </div>
        </div>
        {progress && <div className="progress" style={{ marginBottom: 16 }}><div style={{ width: `${Math.max(6, (progress.done / progress.total) * 100)}%` }} /></div>}
        {Object.entries(errors).map(([k, v]) => <div key={k} style={{ marginBottom: 10 }}><Notice tone="bad" action={SECTION_KEYS.includes(k) ? <button className="btn btn-sm" onClick={() => void generate(k as SectionKey)} disabled={!!progress}><RefreshCw /> Try again</button> : undefined}>Could not generate “{k}”: {v}</Notice></div>)}

        <Tabs value={tab} onChange={setTab} items={[
          { id: 'about', label: 'About me' }, { id: 'role', label: 'Role' }, { id: 'company', label: 'Company' },
          { id: 'questions', label: 'Questions', badge: (data.questions?.data as QuestionsPrep | undefined)?.questions?.length ? <span className="pill" style={{ marginLeft: 8 }}>{(data.questions!.data as QuestionsPrep).questions.length}</span> : null },
          { id: 'match', label: 'Résumé match' }, { id: 'prepared', label: 'Prepared answers', badge: (answers.data?.length ?? 0) > 0 ? <span className="pill" style={{ marginLeft: 8 }}>{answers.data!.length}</span> : null },
        ]} />

        {tab === 'about' && <AboutTab section={data.about} onGenerate={() => void generate('about')} busy={!!progress} />}
        {tab === 'role' && <RoleTab section={data.role} onGenerate={() => void generate('role')} busy={!!progress} />}
        {tab === 'company' && <CompanyTab section={data.company} onGenerate={() => void generate('company')} busy={!!progress} interview={interview} />}
        {tab === 'questions' && <QuestionsTab section={data.questions} interview={interview} answers={answers.data ?? []} onSaved={() => void answers.reload()} onGenerate={() => void generate('questions')} busy={!!progress} />}
        {tab === 'match' && <MatchTab interview={interview} onReanalyse={() => void reanalyse()} />}
        {tab === 'prepared' && <PreparedTab answers={answers.data ?? []} />}
      </div>
    </div>
  );
}

type Section = { data: unknown; model: string | null; generatedAt: number } | undefined;

function Meta({ section }: { section: Section }) {
  if (!section) return null;
  return <span className="faint small">{section.model ? `Generated by ${section.model}` : 'Offline draft (no AI)'} · {new Date(section.generatedAt).toLocaleString()}</span>;
}

function NoData({ onGenerate, busy, what }: { onGenerate: () => void; busy: boolean; what: string }) {
  return <div className="card"><Empty icon={<Sparkles />} title={`No ${what} yet`} action={<button className="btn btn-primary" onClick={onGenerate} disabled={busy}><Sparkles /> Generate</button>}>Built from your résumé facts and this job description. Nothing is invented: if it is not in your material, it is left out.</Empty></div>;
}

function CopyBtn({ text }: { text: string }) {
  const toast = useApp((s) => s.toast);
  return <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied.', 'ok'))}><Copy /> Copy</button>;
}

function AboutTab({ section, onGenerate, busy }: { section: Section; onGenerate: () => void; busy: boolean }) {
  if (!section) return <NoData onGenerate={onGenerate} busy={busy} what="“About me” material" />;
  const d = section.data as AboutMePrep;
  const block = (title: string, text: string) => (
    <div className="card"><div className="card-head"><h2 className="h2">{title}</h2><CopyBtn text={text} /></div><div className="prose">{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div></div>
  );
  return (
    <div className="stack-lg">
      <div className="row between"><Meta section={section} /><button className="btn btn-sm" onClick={onGenerate} disabled={busy}><RefreshCw /> Regenerate</button></div>
      {d.note && <Notice tone="warn">{d.note}</Notice>}
      {d.unverified && d.unverified.length > 0 && <Notice tone="warn">These details are not in your résumé, so check or remove them before using this text: <strong>{d.unverified.join(', ')}</strong></Notice>}
      {block('Tell me about yourself', d.tellMeAboutYourself)}
      <div className="grid grid-2">{block('Professional summary', d.professionalSummary)}{block('Current role', d.currentRole)}</div>
      {block('Career journey', d.careerJourney)}
      <div className="grid grid-2">
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Strengths</h2><ul className="bullets">{d.strengths.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Most relevant experience</h2><ul className="bullets">{d.relevantExperience.map((s) => <li key={s}>{s}</li>)}</ul></div>
      </div>
    </div>
  );
}

function RoleTab({ section, onGenerate, busy }: { section: Section; onGenerate: () => void; busy: boolean }) {
  if (!section) return <NoData onGenerate={onGenerate} busy={busy} what="role breakdown" />;
  const d = section.data as RolePrep;
  return (
    <div className="stack-lg">
      <div className="row between"><Meta section={section} /><button className="btn btn-sm" onClick={onGenerate} disabled={busy}><RefreshCw /> Regenerate</button></div>
      {d.note && <Notice tone="warn">{d.note}</Notice>}
      <div className="grid grid-2">
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Responsibilities</h2><ul className="bullets">{d.responsibilities.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Skills required</h2><div className="chip-row">{d.skillsRequired.map((s) => <span key={s} className="pill">{s}</span>)}</div><h2 className="h2" style={{ margin: '18px 0 10px' }}>Likely interview areas</h2><ul className="bullets">{d.likelyAreas.map((s) => <li key={s}>{s}</li>)}</ul></div>
      </div>
      {d.terminology.length > 0 && <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Terminology to know</h2><div className="col">{d.terminology.map((t) => <div key={t.term}><strong>{t.term}</strong> <span className="muted">— {t.meaning}</span></div>)}</div></div>}
    </div>
  );
}

function CompanyTab({ section, onGenerate, busy, interview }: { section: Section; onGenerate: () => void; busy: boolean; interview: Interview | null }) {
  if (!section) return <NoData onGenerate={onGenerate} busy={busy} what="company preparation" />;
  const d = section.data as CompanyPrep;
  return (
    <div className="stack-lg">
      <div className="row between"><Meta section={section} /><button className="btn btn-sm" onClick={onGenerate} disabled={busy}><RefreshCw /> Regenerate</button></div>
      {d.note && <Notice tone="warn">{d.note}</Notice>}
      {!interview?.companyNotes.trim() && <Notice tone="info">You have not added company information, so this is limited to the job description. Candor does not browse the web or add company facts from memory; add what you know in the interview details.</Notice>}
      <div className="card"><h2 className="h2" style={{ marginBottom: 8 }}>Summary</h2><p className="prose">{d.summary}</p>{d.fromYourNotes.length > 0 && <ul className="bullets" style={{ marginTop: 12 }}>{d.fromYourNotes.map((s) => <li key={s}>{s}</li>)}</ul>}</div>
      <div className="grid grid-2">
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Research before the interview</h2><ul className="bullets">{d.toResearch.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Questions to ask them</h2><ul className="bullets">{d.questionsToAsk.map((s) => <li key={s}>{s}</li>)}</ul></div>
      </div>
    </div>
  );
}

function QuestionsTab({ section, interview, answers, onSaved, onGenerate, busy }: { section: Section; interview: Interview | null; answers: AnswerRecord[]; onSaved: () => void; onGenerate: () => void; busy: boolean }) {
  const [mode, setMode] = useState<AnswerMode>(useApp.getState().settings?.defaultMode ?? 'standard');
  const [cat, setCat] = useState<QuestionCategory | 'all'>('all');
  const qs = useMemo(() => (section?.data as QuestionsPrep | undefined)?.questions ?? [], [section]);
  const cats = useMemo(() => [...new Set(qs.map((q) => q.category))], [qs]);
  if (!section) return <NoData onGenerate={onGenerate} busy={busy} what="personalised questions" />;
  const shown = qs.filter((q) => cat === 'all' || q.category === cat);
  const saved = (q: PreparedQuestion) => answers.find((a) => a.questionText.toLowerCase() === q.text.toLowerCase() && a.mode === mode);
  return (
    <div className="stack-lg">
      {(section.data as QuestionsPrep).note && <Notice tone="warn">{(section.data as QuestionsPrep).note}</Notice>}
      <div className="row between row-wrap">
        <div className="row row-wrap"><Meta section={section} /></div>
        <div className="row"><label className="small muted" htmlFor="pq-mode">Answer style</label><select id="pq-mode" className="select" style={{ width: 330 }} value={mode} onChange={(e) => setMode(e.target.value as AnswerMode)}>{MODE_ORDER.map((m) => <option key={m} value={m}>{ANSWER_MODES[m].label} — {ANSWER_MODES[m].blurb}</option>)}</select><button className="btn btn-sm" onClick={onGenerate} disabled={busy}><RefreshCw /> Regenerate questions</button></div>
      </div>
      <div className="chip-row">
        <button className={`btn btn-sm ${cat === 'all' ? 'btn-primary' : ''}`} onClick={() => setCat('all')}>All ({qs.length})</button>
        {cats.map((c) => <button key={c} className={`btn btn-sm ${cat === c ? 'btn-primary' : ''}`} onClick={() => setCat(c)}>{QUESTION_CATEGORY_LABELS[c]} ({qs.filter((q) => q.category === c).length})</button>)}
      </div>
      <div className="col">{shown.map((q) => <QuestionItem key={q.id} q={q} interviewId={interview?.id ?? null} mode={mode} saved={saved(q)} onSaved={onSaved} />)}</div>
    </div>
  );
}

function QuestionItem({ q, interviewId, mode, saved, onSaved }: { q: PreparedQuestion; interviewId: string | null; mode: AnswerMode; saved: AnswerRecord | undefined; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const gen = useGen();
  const navigate = useApp((s) => s.navigate);
  const text = gen.streaming || gen.text ? gen.text : (saved?.answerText ?? '');
  // Refs keep the effect keyed to the streaming transition only, while always calling the latest callback.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const genTextRef = useRef(gen.text);
  genTextRef.current = gen.text;
  useEffect(() => { if (!gen.streaming && genTextRef.current) onSavedRef.current(); }, [gen.streaming]);
  return (
    <div className="qa-item">
      <button className="qa-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <div className="grow"><div style={{ fontWeight: 550 }}>{q.text}</div>{q.why && <div className="small faint">{q.why}</div>}</div>
        <Pill>{QUESTION_CATEGORY_LABELS[q.category]}</Pill>
        {saved && <Pill tone="ok">prepared</Pill>}
      </button>
      {open && (
        <div className="qa-body">
          {gen.error && <Notice tone="bad">{gen.error}</Notice>}
          {text ? <div className="prose" style={{ fontSize: '1.02rem', whiteSpace: 'pre-wrap', paddingTop: 12 }}><AnswerText text={text} flagged={saved?.grounding?.unverified} />{gen.streaming && <span className="caret" />}</div> : <p className="muted small" style={{ paddingTop: 12 }}>No answer drafted yet. A draft uses only your résumé facts and stories.</p>}
          {saved?.grounding?.status === 'unverified-details' && !gen.streaming && <div style={{ marginTop: 8 }}><Pill tone="warn"><AlertTriangle /> Check: {saved.grounding.unverified.join(', ')}</Pill></div>}
          <div className="row row-wrap" style={{ marginTop: 12 }}>
            <button className="btn btn-sm btn-primary" disabled={gen.streaming} onClick={() => void gen.start(() => call('prep.answer', { interviewId, question: q.text, mode, save: true }))}>{gen.streaming ? <Busy label="Drafting…" /> : <><Sparkles /> {saved ? 'Redraft' : 'Draft answer'}</>}</button>
            {gen.streaming && <button className="btn btn-sm" onClick={gen.cancel}>Stop</button>}
            {text && <CopyBtn text={text} />}
            <button className="btn btn-sm btn-ghost" onClick={() => navigate('mock', { practiceQuestion: q.text, interviewId })}><Mic /> Practise this</button>
            {gen.ttftMs !== null && <span className="faint small">first word in {Math.round(gen.ttftMs)} ms</span>}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>Drafted answers are saved as prepared answers: if the interviewer asks this (or something very close) in a live session, it appears instantly.</p>
        </div>
      )}
    </div>
  );
}

function MatchTab({ interview, onReanalyse }: { interview: Interview | null; onReanalyse: () => void }) {
  const m = interview?.match;
  const jd = interview?.jdAnalysis;
  if (!interview) return null;
  if (!m || !jd) return <div className="card"><Empty title="Not analysed yet" action={<button className="btn btn-primary" onClick={onReanalyse}><RefreshCw /> Analyse now</button>}>Link a résumé to this interview and run the analysis.</Empty></div>;
  const group = (title: string, tone: 'ok' | 'warn' | 'bad', items: MatchItem[]) => (
    <div className="card">
      <div className="card-head"><h2 className="h2"><span className={`pill pill-${tone}`}>{items.length}</span> {title}</h2></div>
      {items.length === 0 ? <p className="muted small">None.</p> : items.map((it) => (
        <div key={it.requirement} className="req-row">
          <div><div style={{ fontWeight: 550 }}>{it.requirement}</div>{it.evidence.slice(0, 2).map((e) => <div key={e.factId} className="evidence">{e.text}</div>)}{it.note && <div className="small faint">{it.note}</div>}</div>
          <Pill>{it.category}</Pill>
        </div>
      ))}
    </div>
  );
  return (
    <div className="stack-lg">
      <div className="row between"><span className="faint small">{m.method === 'local+llm' ? 'Local match, enriched by AI' : 'Local match (offline)'} · {new Date(m.generatedAt).toLocaleString()}</span><button className="btn btn-sm" onClick={onReanalyse}><RefreshCw /> Re-analyse</button></div>
      <div className="card"><div className="match-bar" style={{ height: 14 }}><div style={{ flex: m.strong.length, background: 'var(--ok)' }} /><div style={{ flex: m.partial.length, background: 'var(--warn)' }} /><div style={{ flex: m.missing.length, background: 'var(--bad)' }} /></div><div className="row" style={{ marginTop: 10, gap: 18 }}><span className="small"><b style={{ color: 'var(--ok)' }}>{m.strong.length}</b> strong matches</span><span className="small"><b style={{ color: 'var(--warn)' }}>{m.partial.length}</b> partial</span><span className="small"><b style={{ color: 'var(--bad)' }}>{m.missing.length}</b> to prepare</span>{jd.yearsExperience && <span className="small muted">Asks for {jd.yearsExperience}</span>}</div></div>
      <div className="grid grid-2">{group('Strong matches', 'ok', m.strong)}{group('Partial matches', 'warn', m.partial)}</div>
      {group('Missing requirements', 'bad', m.missing)}
      {m.transferable.length > 0 && <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Transferable experience</h2>{m.transferable.map((t) => <div key={t.requirement} className="req-row"><div><strong>{t.requirement}</strong><div className="small muted">{t.explanation}</div></div></div>)}</div>}
      <div className="grid grid-2">
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Questions to expect</h2><ul className="bullets">{m.likelyQuestions.map((q) => <li key={q}>{q}</li>)}</ul></div>
        <div className="card"><h2 className="h2" style={{ marginBottom: 10 }}>Areas to prepare</h2><ul className="bullets">{m.prepAreas.map((q) => <li key={q}>{q}</li>)}</ul></div>
      </div>
      <div className="card">
        <h2 className="h2" style={{ marginBottom: 10 }}>What the job description asks for</h2>
        <div className="grid grid-3">
          <div><div className="eyebrow">Tools &amp; technologies</div><div className="chip-row" style={{ marginTop: 6 }}>{[...jd.tools, ...jd.technologies].map((t) => <span key={t} className="pill">{t}</span>)}</div></div>
          <div><div className="eyebrow">Competencies</div><div className="chip-row" style={{ marginTop: 6 }}>{jd.competencies.map((t) => <span key={t} className="pill">{t}</span>)}</div></div>
          <div><div className="eyebrow">KPIs &amp; domain</div><div className="chip-row" style={{ marginTop: 6 }}>{[...jd.kpis, ...jd.domainKnowledge].map((t) => <span key={t} className="pill">{t}</span>)}</div></div>
        </div>
      </div>
    </div>
  );
}

function PreparedTab({ answers }: { answers: AnswerRecord[] }) {
  if (answers.length === 0) return <div className="card"><Empty title="No prepared answers yet">Open a question under “Questions” and press “Draft answer”. Prepared answers appear instantly during a live interview.</Empty></div>;
  return (
    <div className="col">
      {answers.map((a) => (
        <div key={a.id} className="card">
          <div className="row between"><strong>{a.questionText}</strong><Pill>{ANSWER_MODES[a.mode].label}</Pill></div>
          <div className="prose" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}><AnswerText text={a.answerText} flagged={a.grounding?.unverified} /></div>
          {a.grounding?.status === 'unverified-details' && <div style={{ marginTop: 8 }}><Pill tone="warn"><AlertTriangle /> Check: {a.grounding.unverified.join(', ')}</Pill></div>}
          <div className="row" style={{ marginTop: 10 }}><CopyBtn text={a.answerText} /><span className="faint small">{a.model} · {new Date(a.createdAt).toLocaleString()}</span></div>
        </div>
      ))}
    </div>
  );
}
