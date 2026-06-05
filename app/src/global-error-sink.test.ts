/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { toast } from 'sonner';
import { installGlobalErrorSink } from './global-error-sink';

// Capture the listeners installed by installGlobalErrorSink so we can fire
// them directly without having to trigger real DOM events through jsdom.
type ErrorHandler = (event: ErrorEvent) => void;
type RejectionHandler = (event: PromiseRejectionEvent) => void;

function captureListeners(): {
  errorHandler: ErrorHandler;
  rejectionHandler: RejectionHandler;
} {
  let errorHandler!: ErrorHandler;
  let rejectionHandler!: RejectionHandler;

  const origAdd = window.addEventListener.bind(window);
  const spy = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'error') errorHandler = listener as ErrorHandler;
      else if (type === 'unhandledrejection') rejectionHandler = listener as RejectionHandler;
      // Still register with jsdom so teardown doesn't error
      origAdd(type, listener);
    });

  installGlobalErrorSink();
  spy.mockRestore();

  return { errorHandler, rejectionHandler };
}

function makeErrorEvent(message: string, error?: Error): ErrorEvent {
  return {
    type: 'error',
    message,
    error: error ?? null,
  } as unknown as ErrorEvent;
}

function makeRejectionEvent(reason: unknown): PromiseRejectionEvent {
  return {
    type: 'unhandledrejection',
    reason,
  } as unknown as PromiseRejectionEvent;
}

describe('installGlobalErrorSink', () => {
  let errorHandler: ErrorHandler;
  let rejectionHandler: RejectionHandler;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let toastError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    toastError = toast.error as ReturnType<typeof vi.fn>;
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ({ errorHandler, rejectionHandler } = captureListeners());
  });

  afterEach(() => {
    vi.useRealTimers();
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── (a) ResizeObserver messages do NOT call toast.error ──────────────────

  it('does not toast "ResizeObserver loop limit exceeded"', () => {
    const msg = 'ResizeObserver loop limit exceeded';
    errorHandler(makeErrorEvent(msg));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does not toast "ResizeObserver loop completed with undelivered notifications"', () => {
    const msg = 'ResizeObserver loop completed with undelivered notifications';
    errorHandler(makeErrorEvent(msg));
    expect(toastError).not.toHaveBeenCalled();
  });

  // ── (a) ResizeObserver messages DO call console.debug with the right args ─

  it('console.debug logs the "loop limit exceeded" ResizeObserver warning', () => {
    const msg = 'ResizeObserver loop limit exceeded';
    errorHandler(makeErrorEvent(msg));
    expect(debugSpy).toHaveBeenCalledWith(
      '[global-error-sink] benign ResizeObserver loop warning:',
      msg,
    );
  });

  it('console.debug logs the "loop completed" ResizeObserver warning', () => {
    const msg = 'ResizeObserver loop completed with undelivered notifications';
    errorHandler(makeErrorEvent(msg));
    expect(debugSpy).toHaveBeenCalledWith(
      '[global-error-sink] benign ResizeObserver loop warning:',
      msg,
    );
  });

  // ── (b) ResizeObserver warnings use console.debug NOT console.error ───────

  it('does not console.error for ResizeObserver loop warnings', () => {
    errorHandler(makeErrorEvent('ResizeObserver loop limit exceeded'));
    errorHandler(makeErrorEvent('ResizeObserver loop completed with undelivered notifications'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ── (c) genuine errors DO call toast.error ────────────────────────────────

  it('toasts genuine Error objects as "Unexpected error: <msg>"', () => {
    const err = new Error('something went wrong');
    errorHandler(makeErrorEvent(err.message, err));
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('Unexpected error: something went wrong');
  });

  it('toasts genuine string error messages', () => {
    errorHandler(makeErrorEvent('Script error'));
    expect(toastError).toHaveBeenCalledWith('Unexpected error: Script error');
  });

  it('console.errors genuine errors', () => {
    const err = new Error('boom');
    errorHandler(makeErrorEvent(err.message, err));
    expect(errorSpy).toHaveBeenCalledWith('[global-error-sink]', 'Unexpected error', err);
  });

  // ── (d) unhandledrejection toasts "Unhandled promise rejection: <msg>" ────

  it('toasts unhandled rejection with Error reason', () => {
    const err = new Error('fetch failed');
    rejectionHandler(makeRejectionEvent(err));
    expect(toastError).toHaveBeenCalledWith('Unhandled promise rejection: fetch failed');
  });

  // ── (e) string + non-Error reasons ───────────────────────────────────────

  it('toasts unhandled rejection with string reason', () => {
    rejectionHandler(makeRejectionEvent('timeout'));
    expect(toastError).toHaveBeenCalledWith('Unhandled promise rejection: timeout');
  });

  it('toasts unhandled rejection with object reason (JSON stringified)', () => {
    rejectionHandler(makeRejectionEvent({ code: 42 }));
    expect(toastError).toHaveBeenCalledWith('Unhandled promise rejection: {"code":42}');
  });

  // ── (f) de-dup: same message within 2s toasts only once ──────────────────

  it('deduplicates identical messages fired within RECENT_WINDOW_MS', () => {
    const err = new Error('boom');
    errorHandler(makeErrorEvent(err.message, err));
    vi.advanceTimersByTime(500); // still within 2 s window
    errorHandler(makeErrorEvent(err.message, err));
    vi.advanceTimersByTime(500);
    errorHandler(makeErrorEvent(err.message, err));
    expect(toastError).toHaveBeenCalledOnce();
  });

  it('toasts again after the dedup window expires', () => {
    const err = new Error('flap');
    errorHandler(makeErrorEvent(err.message, err));
    vi.advanceTimersByTime(2500); // past the 2 s window
    errorHandler(makeErrorEvent(err.message, err));
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it('toasts different messages separately (no cross-message dedup)', () => {
    errorHandler(makeErrorEvent('alpha'));
    errorHandler(makeErrorEvent('beta'));
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenNthCalledWith(1, 'Unexpected error: alpha');
    expect(toastError).toHaveBeenNthCalledWith(2, 'Unexpected error: beta');
  });
});
