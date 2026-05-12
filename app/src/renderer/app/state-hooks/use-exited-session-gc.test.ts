// @vitest-environment jsdom
//
// BUG-C3 regression coverage. Verifies that timers scheduled by
// `useExitedSessionGc` do not dispatch into a torn-down provider after the
// component unmounts. Uses fake timers to control the 5s grace window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AgentSession } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { initialAppState } from '../state.types';
import { useExitedSessionGc } from './use-exited-session-gc';

function session(id: string, status: AgentSession['status']): AgentSession {
  return {
    id,
    workspaceId: 'a',
    providerId: 'claude',
    cwd: '/tmp/a',
    branch: null,
    status,
    startedAt: 1,
    worktreePath: null,
  };
}

function stateWith(sessions: AgentSession[]): AppState {
  return { ...initialAppState, ready: true, sessions };
}

let dispatch: ReturnType<typeof vi.fn<(a: Action) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  dispatch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useExitedSessionGc — BUG-C3 timer race on unmount', () => {
  it('does not dispatch REMOVE_SESSION when the component unmounts before the timer fires', () => {
    const exited = session('s1', 'exited');
    const { unmount } = renderHook(() => useExitedSessionGc(stateWith([exited]), dispatch));

    // Timer is scheduled but has not yet fired.
    expect(dispatch).not.toHaveBeenCalled();

    // Unmount BEFORE the 5s timer fires. The cleanup effect clears the Map;
    // even if a queued timer callback fires we should not see a dispatch.
    unmount();

    // Advance past the grace window. Any leaked timer would fire here.
    vi.advanceTimersByTime(10_000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches REMOVE_SESSION when the timer fires while still mounted', () => {
    const exited = session('s1', 'exited');
    renderHook(() => useExitedSessionGc(stateWith([exited]), dispatch));

    vi.advanceTimersByTime(5_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
  });

  it('cancels a scheduled timer when the session is removed from state before it fires', () => {
    const exited = session('s1', 'exited');
    const { rerender } = renderHook(({ s }: { s: AgentSession[] }) =>
      useExitedSessionGc(stateWith(s), dispatch),
      { initialProps: { s: [exited] } },
    );

    // Session disappears before the grace window elapses.
    rerender({ s: [] });
    vi.advanceTimersByTime(10_000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not double-schedule when an exited session persists across rerenders', () => {
    const exited = session('s1', 'exited');
    const { rerender } = renderHook(({ s }: { s: AgentSession[] }) =>
      useExitedSessionGc(stateWith(s), dispatch),
      { initialProps: { s: [exited] } },
    );

    rerender({ s: [exited] });
    rerender({ s: [exited] });
    vi.advanceTimersByTime(5_000);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
