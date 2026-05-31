import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import './index.css';
import App from '@/renderer/app/App';

// ERR-1 — global renderer error sink. React error boundaries (see
// app/ErrorBoundary.tsx) catch render/lifecycle throws, but errors that escape
// React entirely — async/event-handler throws, rejected promises with no
// `.catch`, third-party listeners — would otherwise vanish silently. This
// surfaces them via the toast mechanism the app already uses (sonner) plus the
// console, so the operator gets a visible signal. Renderer-only: no IPC channel
// and no main-process involvement.
//
// De-dupe: identical messages firing in a tight burst (e.g. a render loop)
// collapse into a single toast within a short window so we don't drown the UI.
function installGlobalErrorSink(): void {
  const RECENT_WINDOW_MS = 2000;
  let lastMessage: string | null = null;
  let lastAt = 0;

  function surface(prefix: string, detail: unknown): void {
    const message =
      detail instanceof Error
        ? detail.message
        : typeof detail === 'string'
          ? detail
          : (() => {
              try {
                return JSON.stringify(detail);
              } catch {
                return String(detail);
              }
            })();
    const text = `${prefix}: ${message || 'Unknown error'}`;

    // Always log — the console is the developer surface and is not de-duped.
    // eslint-disable-next-line no-console
    console.error('[global-error-sink]', prefix, detail);

    const now = Date.now();
    if (text === lastMessage && now - lastAt < RECENT_WINDOW_MS) {
      lastAt = now;
      return; // collapse a noisy repeat
    }
    lastMessage = text;
    lastAt = now;
    try {
      toast.error(text);
    } catch {
      /* toast is best-effort; the console.error above already recorded it */
    }
  }

  window.addEventListener('error', (event: ErrorEvent) => {
    surface('Unexpected error', event.error ?? event.message);
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    surface('Unhandled promise rejection', event.reason);
  });
}

installGlobalErrorSink();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
