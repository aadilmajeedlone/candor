import { BookMarked, BookOpenCheck, Briefcase, HelpCircle, History, LayoutDashboard, MessagesSquare, PanelLeftClose, PanelLeftOpen, Radio, Settings as SettingsIcon, WifiOff } from 'lucide-react';
import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { ANSWER_MODES, MODE_ORDER } from '@shared/modes';
import { HOTKEY_LABELS, type HotkeyAction } from '@shared/settings';
import { ErrorBoundary, Spinner, Toaster } from '@/components/ui';
import { call, subscribe } from '@/services/api';
import { useApp, type Route } from '@/store/app';
import { useLive } from '@/store/live';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Interviews = lazy(() => import('@/pages/Interviews'));
const Preparation = lazy(() => import('@/pages/Preparation'));
const Live = lazy(() => import('@/pages/Live'));
const Mock = lazy(() => import('@/pages/Mock'));
const QuestionBank = lazy(() => import('@/pages/QuestionBank'));
const Stories = lazy(() => import('@/pages/Stories'));
const HistoryPage = lazy(() => import('@/pages/History'));
const Settings = lazy(() => import('@/pages/Settings'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));

const NAV: { route: Route; label: string; icon: ReactNode }[] = [
  { route: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard /> },
  { route: 'interviews', label: 'Interviews', icon: <Briefcase /> },
  { route: 'preparation', label: 'Preparation', icon: <BookOpenCheck /> },
  { route: 'live', label: 'Live Interview', icon: <Radio /> },
  { route: 'mock', label: 'Mock Interview', icon: <MessagesSquare /> },
  { route: 'questions', label: 'Question Bank', icon: <HelpCircle /> },
  { route: 'stories', label: 'Story Bank', icon: <BookMarked /> },
  { route: 'history', label: 'History', icon: <History /> },
  { route: 'settings', label: 'Settings', icon: <SettingsIcon /> },
];

function useTheme() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.theme = settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme;
    };
    apply();
    mq.addEventListener('change', apply);
    root.dataset.contrast = settings.highContrast ? 'high' : 'normal';
    root.dataset.motion = settings.reducedMotion === 'on' || (settings.reducedMotion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'reduced' : 'full';
    root.style.fontSize = `${16 * settings.fontScale}px`;
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
}

export default function App() {
  const { ready, route, settings, online, navCollapsed, liveRunning } = useApp();
  const init = useApp((s) => s.init);
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  useTheme();

  useEffect(() => {
    void init();
    const offLive = subscribe('live.event', (e) => {
      useLive.getState().apply(e);
      if (e.type === 'listening') useApp.getState().setLiveRunning(e.listening);
    });
    const offHot = subscribe('hotkey', ({ action }) => {
      const label = HOTKEY_LABELS[action as HotkeyAction];
      if (label && !document.hasFocus()) toast(label);
    });
    const offNotice = subscribe('app.notice', (n) => toast(n.message, n.level === 'error' ? 'bad' : 'info'));
    const on = () => useApp.getState().setOnline(true);
    const off = () => useApp.getState().setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    // Restore the live screen if the window was reloaded mid-session.
    call('live.snapshot')
      .then((snap) => {
        if (snap?.running) {
          useLive.getState().begin(snap.sessionId ?? '', null, snap.mode);
          useApp.getState().setLiveRunning(true);
        }
      })
      .catch(() => undefined);
    return () => {
      offLive();
      offHot();
      offNotice();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [init, toast]);

  // In-window shortcuts: Alt+1…7 switch the answer mode on the Live screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const idx = Number(e.key) - 1;
      const mode = MODE_ORDER[idx];
      if (mode && ANSWER_MODES[mode] && useApp.getState().liveRunning) {
        e.preventDefault();
        void call('live.mode', { mode }).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready || !settings) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </div>
    );
  }

  const collapsed = navCollapsed || (route === 'live' && window.innerWidth < 1500);
  return (
    <div className="app" data-nav={collapsed ? 'collapsed' : 'open'} data-route={route}>
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <div className="brand-mark" aria-hidden>C</div>
          <span className="brand-name">Candor</span>
        </div>
        {NAV.map((n) => (
          <button key={n.route} className="nav-item" aria-current={route === n.route ? 'page' : undefined} onClick={() => navigate(n.route)} title={n.label}>
            {n.icon}
            <span className="nav-label">{n.label}</span>
            {n.route === 'live' && liveRunning && <span className="nav-live-dot" aria-label="Live session running" />}
          </button>
        ))}
        <div className="nav-spacer" />
        <button className="nav-item" onClick={() => useApp.getState().toggleNav()} aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'} title="Toggle navigation">
          {navCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          <span className="nav-label">Collapse</span>
        </button>
      </nav>
      <div className="main">
        {!online && (
          <div className="offline-bar" role="status">
            <WifiOff size={15} /> Internet connection unavailable. Your saved preparation material is still available; AI answers and speech recognition need a connection.
          </div>
        )}
        <ErrorBoundary key={route}>
          <Suspense fallback={<div className="page"><Spinner /></div>}>
            {route === 'dashboard' && <Dashboard />}
            {route === 'interviews' && <Interviews />}
            {route === 'preparation' && <Preparation />}
            {route === 'live' && <Live />}
            {route === 'mock' && <Mock />}
            {route === 'questions' && <QuestionBank />}
            {route === 'stories' && <Stories />}
            {route === 'history' && <HistoryPage />}
            {route === 'settings' && <Settings />}
          </Suspense>
        </ErrorBoundary>
      </div>
      <Toaster />
      {!settings.onboarding.completed && (
        <Suspense fallback={null}>
          <Onboarding />
        </Suspense>
      )}
    </div>
  );
}
