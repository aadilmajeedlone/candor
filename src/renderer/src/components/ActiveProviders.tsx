import { Mic, Zap } from 'lucide-react';
import { useEffect } from 'react';
import { SCOPE_HINT, SCOPE_LABEL, type EndpointScope } from '@shared/net';
import type { ActiveModelInfo, ActiveRoute } from '@shared/types';
import { Notice, Pill } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { call } from '@/services/api';
import { useApp } from '@/store/app';

export function ScopePill({ scope }: { scope: EndpointScope }) {
  return (
    <Pill tone={scope === 'internet' ? 'warn' : 'ok'} title={SCOPE_HINT[scope]}>
      {SCOPE_LABEL[scope]}
    </Pill>
  );
}

function ModelLine({ m }: { m: ActiveModelInfo }) {
  return (
    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <strong>{m.provider}</strong>
      <span className="mono small">{m.model}</span>
      <ScopePill scope={m.scope} />
    </span>
  );
}

function RouteRow({ label, route }: { label: string; route: ActiveRoute }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <span className="muted small" style={{ width: 118, flex: 'none' }}>{label}</span>
        {route.primary ? <ModelLine m={route.primary} /> : <Pill tone="warn">not set up</Pill>}
      </div>
      {route.fallback && (
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="faint small" style={{ width: 118, flex: 'none' }}>if it fails</span>
          <ModelLine m={route.fallback} />
        </div>
      )}
      {route.problem && <div className="small" style={{ color: 'var(--warn)', marginLeft: 128 }}>{route.problem}</div>}
    </div>
  );
}

/**
 * Which AI model and which speech engine are answering, and where each one runs (this PC, your network, the
 * internet). Nothing is switched behind the scenes: a fallback only appears here because you configured it.
 */
export function ActiveProvidersCard({ title = 'What is answering' }: { title?: string }) {
  const active = useAsync(() => call('app.activeProviders'), []);
  const settings = useApp((s) => s.settings);
  const routing = JSON.stringify(settings?.routing);
  const stt = `${settings?.stt.provider}/${settings?.stt.localModel}`;
  useEffect(() => {
    void active.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routing, stt]);
  const a = active.data;
  return (
    <div className="card">
      <h2 className="h2" style={{ marginBottom: 10 }}><Zap size={16} style={{ verticalAlign: '-2px' }} /> {title}</h2>
      {!a ? null : (
        <div className="col" style={{ gap: 12 }}>
          <RouteRow label="Live answers" route={a.live} />
          <RouteRow label="Preparation" route={a.prep} />
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span className="muted small" style={{ width: 118, flex: 'none' }}><Mic size={13} style={{ verticalAlign: '-2px' }} /> Speech</span>
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <strong>{a.speech.label}</strong>
              <span className="small muted">{a.speech.detail}</span>
              <ScopePill scope={a.speech.scope} />
            </span>
          </div>
          {[a.live, a.prep].some((r) => [r.primary, r.fallback].some((m) => m?.scope === 'internet')) && (
            <Notice tone="info" compact>An internet service receives your questions and may charge per use. Check its pricing; Candor cannot see or limit what a provider bills.</Notice>
          )}
        </div>
      )}
    </div>
  );
}
