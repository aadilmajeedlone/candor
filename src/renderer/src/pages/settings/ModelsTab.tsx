import { Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AI_TASKS, AI_TASK_LABELS } from '@shared/settings';
import type { AiTask, ConnectionTestResult, ModelConfig } from '@shared/types';
import { Busy, Empty, Modal, Notice, Pill, useConfirm } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';
import { guarded } from '@/lib/guarded';

export function ModelsTab() {
  const models = useAsync(() => call('models.list'), []);
  const providers = useAsync(() => call('providers.list'), []);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const toast = useApp((s) => s.toast);
  const [edit, setEdit] = useState<Partial<ModelConfig> | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionTestResult | 'busy'>>({});
  const { ask, dialog } = useConfirm();
  if (!settings) return null;
  const list = models.data ?? [];
  const providerName = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? '?';
  const label = (m: ModelConfig) => `${m.name} — ${providerName(m.providerId)}`;

  const setRoute = (task: AiTask, part: 'primary' | 'fallback', v: string) => void updateSettings({ routing: { [task]: { [part]: v || null } } });

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'busy' }));
    const r = await call('models.test', { id }).catch((e) => ({ ok: false, error: { code: 'unknown' as const, message: errorMessage(e) } }));
    setTests((t) => ({ ...t, [id]: r }));
  };

  return (
    <div className="stack-lg">
      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="h2">Routing</h2>
            <p className="hint">Each job uses its own model. Live answers should use the fastest model that is good enough; preparation can be slower and stronger. A missing route borrows the nearest one.</p>
          </div>
        </div>
        {list.length === 0 ? (
          <Empty title="No models yet">Run “Quick setup” in AI Providers, or add a model below.</Empty>
        ) : (
          <table className="table route-table">
            <thead><tr><th>Task</th><th>Primary</th><th>Fallback</th></tr></thead>
            <tbody>
              {AI_TASKS.map((task) => (
                <tr key={task}>
                  <td><strong>{AI_TASK_LABELS[task].label}</strong><div className="hint">{AI_TASK_LABELS[task].hint}</div></td>
                  <td>
                    <select className="select" aria-label={`${AI_TASK_LABELS[task].label} primary model`} value={settings.routing[task].primary ?? ''} onChange={(e) => setRoute(task, 'primary', e.target.value)}>
                      <option value="">— none —</option>
                      {list.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                    </select>
                  </td>
                  <td>
                    <select className="select" aria-label={`${AI_TASK_LABELS[task].label} fallback model`} value={settings.routing[task].fallback ?? ''} onChange={(e) => setRoute(task, 'fallback', e.target.value)}>
                      <option value="">— none —</option>
                      {list.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              <tr>
                <td><strong>Retrieval</strong><div className="hint">Finds the right facts from your résumé for each question.</div></td>
                <td colSpan={2} className="muted small">Runs entirely on this PC (keyword ranking plus local hashed embeddings): no model, no network, well under a millisecond per question on typical résumés. Neural or cloud embeddings are not part of this version.</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="h2">Model settings</h2>
          <button className="btn" disabled={(providers.data ?? []).length === 0} onClick={() => setEdit({ temperature: 0.4, maxTokens: 700, topP: null, timeoutMs: 20000, streaming: true, providerId: providers.data?.[0]?.id })}><Plus /> Add model</button>
        </div>
        {list.length === 0 ? <p className="muted small">None yet.</p> : (
          <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            {list.map((m) => {
              const t = tests[m.id];
              return (
                <div key={m.id} className="list-item">
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}><strong>{m.name}</strong><Pill>{providerName(m.providerId)}</Pill></div>
                    <div className="small faint mono">{m.model} · temp {m.temperature} · max {m.maxTokens} tokens · {m.streaming ? 'streaming' : 'no streaming'} · timeout {m.timeoutMs / 1000}s</div>
                    {t && t !== 'busy' && (t.ok ? <div className="small" style={{ color: 'var(--ok)' }}>Works — first word in {t.latencyMs} ms (measured just now)</div> : <div className="small" style={{ color: 'var(--bad)' }}>{t.error?.message}</div>)}
                  </div>
                  <button className="btn btn-sm" onClick={() => void test(m.id)} disabled={t === 'busy'}>{t === 'busy' ? <Busy /> : <Play />} Test</button>
                  <button className="btn btn-sm" onClick={() => setEdit(m)}>Edit</button>
                  <button
                    className="btn btn-sm btn-danger btn-icon"
                    aria-label={`Delete ${m.name}`}
                    onClick={guarded(async () => {
                      if (await ask('Delete this model setting?', 'Any task using it will lose that route.', { confirm: 'Delete', danger: true })) {
                        await call('models.delete', { id: m.id });
                        void models.reload();
                        void useApp.getState().init();
                      }
                    })}
                  >
                    <Trash2 />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ModelForm
        value={edit}
        providers={providers.data ?? []}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          void models.reload();
          toast('Saved.', 'ok');
        }}
      />
      {dialog}
    </div>
  );
}

function ModelForm({ value, providers, onClose, onSaved }: { value: Partial<ModelConfig> | null; providers: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [m, setM] = useState<Partial<ModelConfig>>({});
  const [seen, setSeen] = useState<Partial<ModelConfig> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<string[]>([]);
  if (value !== seen) {
    setSeen(value);
    setM(value ?? {});
    setError(null);
    setFetched([]);
  }
  const set = <K extends keyof ModelConfig>(k: K, v: ModelConfig[K]) => setM((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title={value?.id ? 'Edit model' : 'Add model'}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!m.providerId || !m.model?.trim()}
            onClick={guarded(async () => {
              try {
                await call('models.save', { id: m.id, name: m.name?.trim() || m.model!.trim(), providerId: m.providerId!, model: m.model!.trim(), temperature: m.temperature ?? 0.4, maxTokens: m.maxTokens ?? 700, topP: m.topP ?? null, timeoutMs: m.timeoutMs ?? 20000, streaming: m.streaming ?? true });
                onSaved();
              } catch (e) {
                setError(errorMessage(e));
              }
            })}
          >
            Save
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="mdl-provider">Provider</label>
            <select id="mdl-provider" className="select" value={m.providerId ?? ''} onChange={(e) => { set('providerId', e.target.value); setFetched([]); }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mdl-name">Display name</label>
            <input id="mdl-name" className="input" value={m.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Fast · gpt-4.1-mini" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="mdl-model">Model id</label>
          <div className="row">
            <input id="mdl-model" className="input mono" list="mdl-models" value={m.model ?? ''} onChange={(e) => set('model', e.target.value)} spellCheck={false} />
            <button className="btn" disabled={!m.providerId} onClick={guarded(async () => { const r = await call('providers.listModels', { id: m.providerId! }); if (r.ok) setFetched(r.models); else setError(r.error ?? 'Could not fetch models.'); })}>Fetch list</button>
          </div>
          <datalist id="mdl-models">{fetched.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
        <div className="grid grid-4">
          <div className="field"><label htmlFor="mdl-temp">Temperature</label><input id="mdl-temp" className="input" type="number" min={0} max={2} step={0.1} value={m.temperature ?? 0.4} onChange={(e) => set('temperature', Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="mdl-max">Max tokens</label><input id="mdl-max" className="input" type="number" min={16} max={16000} step={50} value={m.maxTokens ?? 700} onChange={(e) => set('maxTokens', Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="mdl-topp">Top P <span className="faint">(optional)</span></label><input id="mdl-topp" className="input" type="number" min={0} max={1} step={0.05} value={m.topP ?? ''} onChange={(e) => set('topP', e.target.value === '' ? null : Number(e.target.value))} /></div>
          <div className="field"><label htmlFor="mdl-timeout">Timeout (s)</label><input id="mdl-timeout" className="input" type="number" min={1} max={180} value={(m.timeoutMs ?? 20000) / 1000} onChange={(e) => set('timeoutMs', Math.round(Number(e.target.value) * 1000))} /></div>
        </div>
        <label className="check"><input type="checkbox" checked={m.streaming ?? true} onChange={(e) => set('streaming', e.target.checked)} /> Stream tokens as they are generated <span className="hint">(turn off only if a proxy breaks streaming)</span></label>
        <p className="hint">Max tokens is a ceiling for spoken answers: live answers use tighter per-mode limits, so shorter modes finish sooner. Preparation and analysis replies are data, so they use their own larger limits and are not cut short by this number. Some newer models ignore temperature or do not accept certain options; Candor detects this and adapts automatically.</p>
      </div>
    </Modal>
  );
}
