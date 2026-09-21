import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/pages.css';
import './styles/live.css';
import App from './App';
import { ErrorBoundary } from './components/ui';
import { errorMessage } from './services/api';
import { useApp } from './store/app';

// Safety net: a rejected promise nobody handled becomes a visible message, never a silent failure.
window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  ev.preventDefault();
  const reason: unknown = ev.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return;
  console.error('Unhandled rejection:', reason);
  useApp.getState().toast(errorMessage(reason), 'bad');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Candor">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
