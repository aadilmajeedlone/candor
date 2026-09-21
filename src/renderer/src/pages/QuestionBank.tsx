import { HelpCircle, Mic, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BANK_CATEGORIES, QUESTION_CATEGORY_LABELS, type BankQuestion, type QuestionCategory } from '@shared/types';
import { Busy, Empty, Modal, Pill } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

export default function QuestionBank() {
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<QuestionCategory | 'all'>('all');
  const [favOnly, setFavOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const qs = useAsync(() => call('questions.list', { search: search || undefined, category: category === 'all' ? undefined : category, favorite: favOnly || undefined }), [search, category, favOnly]);
  const list = qs.data ?? [];

  const toggleFav = async (q: BankQuestion) => {
    await call('questions.favorite', { id: q.id });
    void qs.reload();
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <div className="page-head">
          <div>
            <div className="eyebrow">Question bank</div>
            <h1 className="h1">Practise the questions that come up.</h1>
            <p className="sub">Search hundreds of common questions across roles, favourite the ones you find hard, and practise aloud with feedback.</p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}><Plus /> Add a question</button>
        </div>
        <div className="row row-wrap" style={{ marginBottom: 14 }}>
          <input className="input" style={{ maxWidth: 320 }} placeholder="Search questions…" aria-label="Search questions" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className={`btn ${favOnly ? 'btn-primary' : ''}`} aria-pressed={favOnly} onClick={() => setFavOnly((f) => !f)}><Star /> Favourites</button>
          <span className="faint small">{list.length} question{list.length === 1 ? '' : 's'}</span>
        </div>
        <div className="chip-row" style={{ marginBottom: 16 }}>
          <button className={`btn btn-sm ${category === 'all' ? 'btn-primary' : ''}`} onClick={() => setCategory('all')}>All</button>
          {BANK_CATEGORIES.map((c) => <button key={c} className={`btn btn-sm ${category === c ? 'btn-primary' : ''}`} onClick={() => setCategory(c)}>{QUESTION_CATEGORY_LABELS[c]}</button>)}
        </div>
        {qs.loading && !qs.data ? <Busy /> : list.length === 0 ? <div className="card"><Empty icon={<HelpCircle />} title="No questions match">Try another category or search term.</Empty></div> : (
          <div className="card card-flush list">
            {list.map((q) => (
              <div key={q.id} className="list-item">
                <button className="btn btn-ghost btn-icon btn-sm" aria-label={q.favorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={q.favorite} onClick={() => void toggleFav(q)}><Star size={16} fill={q.favorite ? 'var(--accent)' : 'none'} color={q.favorite ? 'var(--accent)' : 'currentColor'} /></button>
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{q.text}</div>
                  <div className="small faint">{q.practiceCount > 0 ? `Practised ${q.practiceCount}× · last ${q.lastPracticedAt ? new Date(q.lastPracticedAt).toLocaleDateString() : ''}` : 'Not practised yet'}</div>
                </div>
                <Pill>{QUESTION_CATEGORY_LABELS[q.category]}</Pill>
                {q.source === 'user' && <Pill tone="accent">yours</Pill>}
                <button className="btn btn-sm" onClick={() => { void call('questions.practiced', { id: q.id }).catch(() => undefined); navigate('mock', { practiceQuestion: q.text }); }}><Mic /> Practise</button>
                {q.source !== 'seed' && <button className="btn btn-sm btn-ghost btn-icon" aria-label="Delete question" onClick={guarded(async () => { await call('questions.delete', { id: q.id }); void qs.reload(); })}><Trash2 size={15} /></button>}
              </div>
            ))}
          </div>
        )}
        <AddQuestion open={adding} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void qs.reload(); toast('Question added.', 'ok'); }} />
      </div>
    </div>
  );
}

function AddQuestion({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = useState('');
  const [cat, setCat] = useState<QuestionCategory>('behavioral');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Add a question" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={text.trim().length < 5} onClick={guarded(async () => { try { await call('questions.add', { text: text.trim(), category: cat }); setText(''); onAdded(); } catch (e) { setError(errorMessage(e)); } })}>Add</button></>}>
      <div className="col">
        {error && <div className="notice notice-bad">{error}</div>}
        <div className="field"><label htmlFor="aq-text">Question</label><textarea id="aq-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="field"><label htmlFor="aq-cat">Category</label><select id="aq-cat" className="select" value={cat} onChange={(e) => setCat(e.target.value as QuestionCategory)}>{BANK_CATEGORIES.map((c) => <option key={c} value={c}>{QUESTION_CATEGORY_LABELS[c]}</option>)}</select></div>
      </div>
    </Modal>
  );
}
