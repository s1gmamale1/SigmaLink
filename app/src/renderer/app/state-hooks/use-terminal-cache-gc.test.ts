// @vitest-environment jsdom
//
// V1.4.2 packet-03 (Layer 2) — `useTerminalCacheGc` regression coverage.
//
// Validates the contract: when a sessionId disappears from app state
// (REMOVE_SESSION dispatch, either from explicit close or from the 5s
// exited-grace timer), the cached terminal for that id MUST be disposed.
// Otherwise the renderer cache would grow until LRU eviction fires —
// fine in theory, but leaves dead PTYs sitting in scrollback the user
// already chose to close.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const destroyMock = vi.fn();
const hasCachedMock = vi.fn();

vi.mock('@/renderer/lib/terminal-cache', () => ({
  destroy: (...args: unknown[]) => destroyMock(...args),
  hasCached: (...args: unknown[]) => hasCachedMock(...args),
}));

import type { AgentSession } from '@/shared/types';
import type { AppState } from '../state.types';
import { initialAppState } from '../state.types';
import { useTerminalCacheGc } from './use-terminal-cache-gc';

function session(id: string): AgentSession {
  return {
    id,
    workspaceId: 'ws-1',
    providerId: 'claude',
    cwd: '/tmp',
    branch: null,
    status: 'running',
    startedAt: 1,
    worktreePath: null,
  };
}

function stateWith(workspaces: Record<string, AgentSession[]>): AppState {
  return {
    ...initialAppState,
    ready: true,
    sessionsByWorkspace: workspaces,
    sessions: Object.values(workspaces).flat(),
  };
}

beforeEach(() => {
  destroyMock.mockReset();
  hasCachedMock.mockReset();
  hasCachedMock.mockReturnValue(true);
});

afterEach(() => {
  /* no-op */
});

describe('useTerminalCacheGc', () => {
  it('does NOT destroy anything on first render when sessions exist', () => {
    renderHook(() => useTerminalCacheGc(stateWith({ 'ws-1': [session('s1'), session('s2')] })));
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('destroys cache entries for sessions that disappear from state', () => {
    const { rerender } = renderHook(({ s }: { s: AppState }) => useTerminalCacheGc(s), {
      initialProps: { s: stateWith({ 'ws-1': [session('s1'), session('s2')] }) },
    });
    // s2 closes → cache GC should fire destroy('s2').
    rerender({ s: stateWith({ 'ws-1': [session('s1')] }) });
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledWith('s2');
  });

  it('skips destroy when the session id is no longer cached (already GCed)', () => {
    hasCachedMock.mockReturnValue(false);
    const { rerender } = renderHook(({ s }: { s: AppState }) => useTerminalCacheGc(s), {
      initialProps: { s: stateWith({ 'ws-1': [session('s1')] }) },
    });
    rerender({ s: stateWith({ 'ws-1': [] }) });
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('does not destroy a session that re-appears in a different workspace', () => {
    // Edge case: a session id might be tracked across two workspace lists
    // briefly during a workspace switch. The GC must only fire when the id
    // is gone from ALL workspaces.
    const { rerender } = renderHook(({ s }: { s: AppState }) => useTerminalCacheGc(s), {
      initialProps: { s: stateWith({ 'ws-1': [session('shared')] }) },
    });
    rerender({ s: stateWith({ 'ws-2': [session('shared')] }) });
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
