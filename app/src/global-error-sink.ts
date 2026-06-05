import { toast } from 'sonner';

// ERR-1 — global renderer error sink. React error boundaries (see
// app/ErrorBoundary.tsx) catch render/lifecycle throws, but errors that escape
// React entirely — async/event-handler throws, rejected promises with no
// `.catch`, third-party listeners — would otherwise vanish silently. This
// surfaces them via the toast mechanism the app already uses (sonner) plus the
// console, so the operator gets a visible signal. Renderer-only: no IPC channel
// and no main-process involvement.
//
const RECENT_WINDOW_MS = 2000;

let installedCleanup: (() => void) | null = null;
let lastMessage: string | null = null;
let lastAt = 0;

// Filter out benign ResizeObserver loop warnings (browser internals, not
// application errors). They fire when a ResizeObserver callback triggers a
// resize that can't be delivered before the next paint — harmless timing
// noise. See https://github.com/WICG/resize-observer/issues/38
function isResizeObserverLoopWarning(message: string): boolean {
  return (
    message.includes('ResizeObserver loop limit exceeded') ||
    message.includes('ResizeObserver loop completed with undelivered notifications')
  );
}

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

  // Suppress benign ResizeObserver loop warnings — debug-log, do not toast.
  if (isResizeObserverLoopWarning(message)) {
    console.debug('[global-error-sink] benign ResizeObserver loop warning:', message);
    return;
  }

  const text = `${prefix}: ${message || 'Unknown error'}`;

  // Always log — the console is the developer surface and is not de-duped.
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

// De-dupe: identical messages firing in a tight burst (e.g. a render loop)
// collapse into a single toast within a short window so we don't drown the UI.
export function installGlobalErrorSink(): () => void {
  if (installedCleanup) return installedCleanup;

  const errorHandler = (event: ErrorEvent) => {
    surface('Unexpected error', event.error ?? event.message);
  };

  const rejectionHandler = (event: PromiseRejectionEvent) => {
    surface('Unhandled promise rejection', event.reason);
  };

  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);

  installedCleanup = () => {
    window.removeEventListener('error', errorHandler);
    window.removeEventListener('unhandledrejection', rejectionHandler);
    installedCleanup = null;
    lastMessage = null;
    lastAt = 0;
  };

  return installedCleanup;
}
