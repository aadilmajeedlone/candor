import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { Component, useCallback, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { useApp } from '@/store/app';

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner ${className}`} role="status" aria-label="Loading" />;
}

export function Busy({ label }: { label?: string }) {
  return (
    <span className="row muted small">
      <Loader2 size={15} className="spin-icon" style={{ animation: 'spin 0.8s linear infinite' }} />
      {label}
    </span>
  );
}

type PillTone = 'default' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';
export function Pill({ tone = 'default', children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone === 'default' ? '' : `pill-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = 'info', children, action, onClose, compact }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; action?: ReactNode; onClose?: () => void; compact?: boolean }) {
  const Icon = tone === 'bad' ? XCircle : tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice notice-${tone}${compact ? ' notice-compact' : ''}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon />
      <div className="grow">{children}</div>
      {action}
      {onClose && (
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div className="h3" style={{ color: 'var(--text)' }}>
        {title}
      </div>
      {children && <div className="small" style={{ maxWidth: '46ch' }}>{children}</div>}
      {action}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function SettingRow({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row between" style={{ padding: '12px 0', borderBottom: '1px solid var(--line)', alignItems: 'flex-start', gap: 24 }}>
      <div style={{ maxWidth: '58ch' }}>
        <div style={{ fontWeight: 550 }}>{title}</div>
        {hint && <div className="hint" style={{ marginTop: 2, fontSize: '0.8125rem' }}>{hint}</div>}
      </div>
      <div className="row" style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; badge?: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className="tab" onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide, labelledBy }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; labelledBy?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input, textarea, select, button.btn-primary')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id} ref={ref}>
        <div className="modal-head">
          <h2 className="h1" id={labelledBy ?? id} style={{ fontSize: '1.6rem' }}>
            {title}
          </h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback((title: string, body: ReactNode, opts: { confirm?: string; danger?: boolean } = {}) => new Promise<boolean>((resolve) => setState({ title, body, confirm: opts.confirm ?? 'Confirm', danger: opts.danger, resolve })), []);
  const dialog = state ? (
    <Modal
      open
      title={state.title}
      onClose={() => {
        state.resolve(false);
        setState(null);
      }}
      footer={
        <>
          <button className="btn" onClick={() => (state.resolve(false), setState(null))}>
            Cancel
          </button>
          <button className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => (state.resolve(true), setState(null))}>
            {state.confirm}
          </button>
        </>
      }
    >
      <div className="muted">{state.body}</div>
    </Modal>
  ) : null;
  return { ask, dialog };
}

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'bad' ? 'toast-bad' : t.kind === 'ok' ? 'toast-ok' : ''}`} role={t.kind === 'bad' ? 'alert' : 'status'}>
          {t.kind === 'ok' ? <CheckCircle2 size={17} color="var(--ok)" /> : t.kind === 'bad' ? <XCircle size={17} color="var(--bad)" /> : <Info size={17} color="var(--info)" />}
          <div className="grow">{t.message}</div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().replace(/,$/, '');
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="tag-input">
      {value.map((t) => (
        <span key={t} className="pill pill-accent">
          {t}
          <button className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, lineHeight: 0, color: 'inherit' }} onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        aria-label={placeholder ?? 'Add tag'}
      />
    </div>
  );
}

/** Drag-and-drop or click-to-choose file input. The bytes go to the main process, which validates them. */
export function DropZone({ onFile, onPick, label, busy }: { onFile: (f: File) => void; onPick?: () => void; label: string; busy?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className="dropzone"
      data-over={over}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      {busy ? <Busy label="Reading file…" /> : (
        <div className="col" style={{ alignItems: 'center', gap: 8 }}>
          <div>{label}</div>
          {onPick && (
            <button className="btn btn-sm" onClick={onPick}>
              Choose a file…
            </button>
          )}
          <div className="hint">PDF, DOCX or TXT · up to 15 MB</div>
        </div>
      )}
    </div>
  );
}

export function Meter({ level, label }: { level: number; label: string }) {
  // Map RMS (0..1) to a perceptual-ish bar: 0.001 ≈ silence, 0.3 ≈ loud.
  const pct = Math.max(0, Math.min(100, Math.round((Math.log10(Math.max(level, 0.0005)) + 3.3) * 40)));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} style={{ height: 6, width: 110, borderRadius: 99, background: 'var(--bg-raised)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: pct > 85 ? 'var(--warn)' : 'var(--ok)', transition: 'width 60ms linear' }} />
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error.message, info.componentStack?.slice(0, 300));
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <Notice tone="bad" action={<button className="btn btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>}>
          <strong>{this.props.label ?? 'This screen'} hit an unexpected problem.</strong>
          <div className="small muted" style={{ marginTop: 4 }}>{this.state.error.message}</div>
        </Notice>
      </div>
    );
  }
}
