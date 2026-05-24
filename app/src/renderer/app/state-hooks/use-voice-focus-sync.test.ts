// @vitest-environment jsdom
//
// C-10b — useVoiceFocusSync pushes the focused PTY session id to main
// via window.sigma.eventSend('voice:focused-session', { sessionId }) whenever
// the renderer's activeSessionId changes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceFocusSync } from './use-voice-focus-sync';

// ---------------------------------------------------------------------------
// Simple appStateStore substitute — does NOT require vi.mock of the module.
// The hook imports useAppStateSelector which reads from appStateStore.
// We swap appStateStore's state directly via its public subscribe/getSnapshot
// contract by replacing window.sigma and controlling state through a local
// store that we inject.
// ---------------------------------------------------------------------------

// appStateStore is a class instance exported from state.hook.ts. We reach in
// via module import and call setState to simulate activeSessionId changes.
// Import the real module so we can drive it.
import { appStateStore } from '@/renderer/app/state.hook';

// ---------------------------------------------------------------------------
// window.sigma stub
// ---------------------------------------------------------------------------

let eventSendMock: ReturnType<typeof vi.fn>;

function installSigmaStub() {
  eventSendMock = vi.fn();
  Object.defineProperty(globalThis, 'window', {
    value: {
      ...((globalThis as unknown as { window?: unknown }).window ?? {}),
      sigma: {
        eventSend: eventSendMock,
        eventOn: vi.fn(() => () => undefined),
        invoke: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useVoiceFocusSync', () => {
  beforeEach(() => {
    installSigmaStub();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends voice:focused-session with the sessionId when activeSessionId changes', () => {
    renderHook(() => useVoiceFocusSync());

    act(() => {
      // Drive state via appStateStore (what useAppStateSelector reads)
      appStateStore.setState({ ...(appStateStore.getSnapshot()), activeSessionId: 'sess-1' });
    });

    // Advance past the ~50ms debounce
    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(eventSendMock).toHaveBeenCalledWith('voice:focused-session', { sessionId: 'sess-1' });
  });

  it('sends null sessionId when activeSessionId becomes null', () => {
    // Start with a session
    appStateStore.setState({ ...(appStateStore.getSnapshot()), activeSessionId: 'sess-x' });

    renderHook(() => useVoiceFocusSync());

    act(() => {
      appStateStore.setState({ ...(appStateStore.getSnapshot()), activeSessionId: null });
    });

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(eventSendMock).toHaveBeenCalledWith('voice:focused-session', { sessionId: null });
  });

  it('debounces rapid changes — sends the final value after the debounce window', () => {
    renderHook(() => useVoiceFocusSync());

    act(() => {
      appStateStore.setState({ ...(appStateStore.getSnapshot()), activeSessionId: 'first' });
    });

    // Change again BEFORE the first debounce fires (advance only 30ms — still within window)
    act(() => {
      vi.advanceTimersByTime(30);
    });

    act(() => {
      appStateStore.setState({ ...(appStateStore.getSnapshot()), activeSessionId: 'final' });
    });

    // First timer should have been cancelled; now advance past the new debounce window
    act(() => {
      vi.advanceTimersByTime(60);
    });

    const calls = eventSendMock.mock.calls.filter(
      (args: unknown[]) => args[0] === 'voice:focused-session',
    );
    // Only the 'final' value should have been sent
    const sentValues = calls.map((args: unknown[]) => (args[1] as { sessionId: string }).sessionId);
    expect(sentValues).not.toContain('first');
    expect(sentValues).toContain('final');
  });
});
