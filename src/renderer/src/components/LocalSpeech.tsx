import { CheckCircle2, Play, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LOCAL_MODEL_INFO, type LocalModelPreference, type LocalSttStatus, type SttTestResult } from '@shared/speech';
import { Busy, Notice, Pill, SettingRow } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { guarded } from '@/lib/guarded';
import { call, errorMessage } from '@/services/api';
import { useApp } from '@/store/app';

const STATE_LABEL: Record<LocalSttStatus['state'], string> = {
  idle: 'Not loaded yet',
  loading: 'Loading the speech model…',
  ready: 'Ready',
  failed: 'Needs attention',
};

/**
 * The on-device speech engine in plain view: which model, whether it is loaded, what went wrong if it did, and a
 * button that transcribes a built-in sample through the exact path live audio takes — no microphone, no account.
 */
export function LocalSpeechPanel({ withPreference = true }: { withPreference?: boolean }) {
  const { settings, updateSettings, toast } = useApp();
  const status = useAsync(() => call('stt.localStatus'), []);
  const [busy, setBusy] = useState<'test' | 'load' | null>(null);
  const [result, setResult] = useState<SttTestResult | null>(null);

  // While the model is loading (first use takes a few seconds), keep the status fresh.
  const loading = status.data?.state === 'loading';
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => void status.reload(), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  if (!settings) return null;
  const s = status.data;
  const pref = settings.stt.localModel;
  const tone = !s ? 'default' : s.state === 'ready' ? 'ok' : s.state === 'failed' ? 'bad' : s.state === 'loading' ? 'warn' : 'default';

  const run = async (kind: 'test' | 'load') => {
    setBusy(kind);
    setResult(null);
    try {
      if (kind === 'test') setResult(await call('stt.test', { provider: 'local' }));
      else await call('stt.warmup');
    } catch (e) {
      setResult({ ok: false, error: errorMessage(e) });
    } finally {
      setBusy(null);
      void status.reload();
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <strong>Speech engine on this PC</strong>
          {s && (
            <Pill tone={tone} title={s.message ?? undefined}>
              {STATE_LABEL[s.state]}
              {s.state === 'ready' && s.loadMs !== null ? ` · loaded in ${(s.loadMs / 1000).toFixed(1)} s` : ''}
              {s.state === 'ready' && s.rssMb ? ` · ${s.rssMb} MB` : ''}
            </Pill>
          )}
        </div>
        <span className="muted small">Free · private · works offline</span>
      </div>

      {s?.state === 'failed' && s.message && <Notice tone="bad" compact>{s.message}</Notice>}
      {s && s.lagMs > 1000 && <Notice tone="warn" compact>Recognition is running about {(s.lagMs / 1000).toFixed(1)} s behind the microphone. Close heavy apps or choose the light model below.</Notice>}

      {withPreference && (
        <SettingRow title="Model" hint={s ? `${LOCAL_MODEL_INFO[s.modelId].description} (${s.modelSize})` : undefined}>
          <select
            className="select"
            aria-label="On-device speech model"
            value={pref}
            onChange={guarded(async (e) => {
              await updateSettings({ stt: { localModel: e.target.value as LocalModelPreference } });
              void status.reload();
            })}
          >
            <option value="auto">Automatic (recommended)</option>
            <option value="accurate">{LOCAL_MODEL_INFO['x-asr-160'].label}</option>
            <option value="light">{LOCAL_MODEL_INFO['zipformer-en-70m'].label}</option>
          </select>
        </SettingRow>
      )}
      {s && <p className="hint">In use: {s.modelLabel}.</p>}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={guarded(() => run('test'))}>
          {busy === 'test' ? <Busy label="Listening to the sample…" /> : <Play />} Test speech recognition
        </button>
        {s?.state !== 'ready' && (
          <button className="btn btn-sm" disabled={busy !== null || s?.state === 'loading'} onClick={guarded(() => run('load'))}>
            {busy === 'load' || s?.state === 'loading' ? <Busy label="Loading…" /> : 'Load the model now'}
          </button>
        )}
        <button
          className="btn btn-sm btn-ghost"
          onClick={guarded(async () => {
            await call('app.openSystemSettings', { page: 'microphone' });
            toast('Opened Windows microphone settings.', 'info');
          })}
        >
          Microphone permissions
        </button>
      </div>

      {result && (
        <div className="small" style={{ color: result.ok ? 'var(--ok)' : 'var(--bad)' }} role="status">
          {result.ok ? <CheckCircle2 size={14} style={{ verticalAlign: '-2px' }} /> : <XCircle size={14} style={{ verticalAlign: '-2px' }} />} {result.ok ? result.detail : result.error}
        </div>
      )}
      <p className="hint">
        The test plays a short recording through the same path your microphone audio takes, so it works without a microphone. The model loads once (about 10 seconds the first time) and is kept ready between sessions; it is released after 10 idle minutes.
      </p>
    </div>
  );
}
