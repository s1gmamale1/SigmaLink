// @vitest-environment jsdom
//
// v1.5.4-B — State-hydration regression tests for the Sigma dispatch-pane bug class.
//
// ROOT CAUSE (v1.5.3): The `assistant:dispatch-echo` handler dispatched
// SET_ACTIVE_SESSION + SET_ROOM but never ADD_SESSIONS + UPSERT_SWARM.
// The backend created the pane; the renderer's state never knew about it.
// The pane was invisible until the next workspace reopen. No test caught this.
//
// This file tests the EXACT class of bug that was fixed:
//   After `assistant:dispatch-echo` arrives with `ok: true`, the renderer
//   must dispatch ADD_SESSIONS (and UPSERT_SWARM) so the new session is
//   visible in state.sessionsByWorkspace without requiring a workspace reopen.
//
// Strategy:
//   - Render `useSigmaDispatchEcho` in a real useReducer harness (same
//     pattern as use-session-restore.test.ts).
//   - Stub `rpcSilent.panes.listForWorkspace` + `rpcSilent.swarms.list` +
//     `rpcSilent.kv.get` to return controlled data.
//   - Emit the `assistant:dispatch-echo` event via the window.sigma stub.
//   - Assert that the reducer state includes the new session and swarm
//     BEFORE any workspace reopen occurs.
//
// Tests:
//   1. After dispatch-echo (ok: true), state.sessionsByWorkspace[wsId] contains
//      the new session returned by listForWorkspace — catches the exact pre-v1.5.3
//      regression.
//   2. After dispatch-echo (ok: true), state.swarms contains the swarm returned
//      by swarms.list — catches the companion UPSERT_SWARM gap.
//   3. After dispatch-echo (ok: false), state.sessions is NOT mutated — error
//      path is inert.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReducer } from 'react';
import type { AgentSession, Swarm } from '@/shared/types';
import type { Action, AppState } from '@/renderer/app/state.types';
import { initialAppState } from '@/renderer/app/state.types';
import { appStateReducer } from '@/renderer/app/state.reducer';

// ------------------------------------------------------------------
// sigma preload stub — mirrors the pattern used in use-session-restore.test.ts
// ------------------------------------------------------------------

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  emit: (event: string, payload: unknown) => void;
}

function installSigmaStub(): SigmaStub {
  const handlers = new Map<string, Set<EventCb>>();

  const eventOn = vi.fn((event: string, cb: EventCb) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(cb);
    return () => {
      handlers.get(event)?.delete(cb);
    };
  });

  const eventSend = vi.fn();

  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend, invoke: vi.fn() },
  };

  return {
    emit: (event: string, payload: unknown) => {
      handlers.get(event)?.forEach((fn) => fn(payload));
    },
  };
}

// ------------------------------------------------------------------
// Mock RPC layer — both import-path aliases used by the hook under test
// ------------------------------------------------------------------

const listForWorkspaceMock = vi.fn<(wsId: string) => Promise<AgentSession[]>>();
const swarmsListMock = vi.fn<(wsId: string) => Promise<Swarm[]>>();
const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    panes: { listForWorkspace: (id: string) => listForWorkspaceMock(id) },
    swarms: { list: (id: string) => swarmsListMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
  onEvent: (name: string, cb: (payload: unknown) => void) =>
    window.sigma.eventOn(name, cb),
}));

vi.mock('../../lib/rpc', () => ({
  rpcSilent: {
    panes: { listForWorkspace: (id: string) => listForWorkspaceMock(id) },
    swarms: { list: (id: string) => swarmsListMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
  onEvent: (name: string, cb: (payload: unknown) => void) =>
    window.sigma.eventOn(name, cb),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/renderer/lib/notifications', () => ({
  playDing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/notifications', () => ({
  playDing: vi.fn().mockResolvedValue(undefined),
}));

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makeSession(id: string, workspaceId: string): AgentSession {
  return {
    id,
    workspaceId,
    providerId: 'claude',
    cwd: `/tmp/${workspaceId}`,
    branch: null,
    status: 'running',
    startedAt: Date.now(),
    worktreePath: null,
  };
}

function makeSwarm(id: string, workspaceId: string): Swarm {
  return {
    id,
    workspaceId,
    name: `Swarm ${id}`,
    mission: 'test-mission',
    preset: 'custom',
    status: 'running',
    createdAt: Date.now(),
    endedAt: null,
    agents: [],
  };
}

interface Harness {
  state: AppState;
  dispatch: (a: Action) => void;
}

async function renderEchoHook() {
  const { useSigmaDispatchEcho } = await import('./use-sigma-dispatch-echo');
  let harness: Harness | null = null;

  const Wrapper = () => {
    const [state, dispatch] = useReducer(appStateReducer, initialAppState);
    harness = { state, dispatch };
    useSigmaDispatchEcho({
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId ?? undefined,
      dispatch,
    });
    return null;
  };

  const r = renderHook(() => Wrapper());
  return { r, getHarness: () => harness as unknown as Harness };
}

// ------------------------------------------------------------------
// Setup / teardown
// ------------------------------------------------------------------

let sigma: SigmaStub;

beforeEach(() => {
  sigma = installSigmaStub();
  listForWorkspaceMock.mockReset();
  swarmsListMock.mockReset();
  kvGetMock.mockReset();
  kvGetMock.mockResolvedValue(null); // autoFocus ON by default
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('state-hydration: assistant:dispatch-echo handler (v1.5.4-B regression guard)', () => {
  /**
   * PRIMARY REGRESSION TEST — catches the exact v1.5.3 bug class.
   *
   * Pre-v1.5.3: the echo handler called SET_ACTIVE_SESSION + SET_ROOM but
   * never ADD_SESSIONS. The new session existed in the DB but was invisible
   * in renderer state.sessions / sessionsByWorkspace until a workspace reopen.
   *
   * Post-v1.5.3 fix: the handler calls panes.listForWorkspace + swarms.list
   * and dispatches ADD_SESSIONS + UPSERT_SWARM before navigating.
   *
   * This test asserts the post-fix behavior. If the ADD_SESSIONS dispatch is
   * removed from useSigmaDispatchEcho, this test FAILS.
   */
  it('after dispatch-echo ok:true, state.sessionsByWorkspace[wsId] contains the new session', async () => {
    const wsId = 'ws-alpha';
    const newSession = makeSession('sess-new-01', wsId);
    listForWorkspaceMock.mockResolvedValue([newSession]);
    swarmsListMock.mockResolvedValue([]);

    const { getHarness } = await renderEchoHook();

    act(() => {
      sigma.emit('assistant:dispatch-echo', {
        workspaceId: wsId,
        sessionId: 'sess-new-01',
        providerId: 'claude',
        ok: true,
        error: null,
        conversationId: null,
      });
    });

    // Allow the async ADD_SESSIONS dispatch to resolve.
    await vi.waitFor(() => {
      expect(listForWorkspaceMock).toHaveBeenCalledWith(wsId);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = getHarness().state;
    const sessionsForWs = state.sessionsByWorkspace[wsId];
    expect(sessionsForWs).toBeDefined();
    expect(sessionsForWs?.some((s) => s.id === 'sess-new-01')).toBe(true);
  });

  /**
   * COMPANION SWARM TEST — catches the UPSERT_SWARM gap.
   *
   * The same v1.5.3 fix also added swarms.list + UPSERT_SWARM. This test
   * asserts that after the echo, state.swarms includes the new swarm row.
   * If the UPSERT_SWARM dispatch is removed, this test FAILS.
   */
  it('after dispatch-echo ok:true, state.swarms contains the swarm returned by swarms.list', async () => {
    const wsId = 'ws-beta';
    const newSession = makeSession('sess-new-02', wsId);
    const newSwarm = makeSwarm('swarm-new-01', wsId);
    listForWorkspaceMock.mockResolvedValue([newSession]);
    swarmsListMock.mockResolvedValue([newSwarm]);

    const { getHarness } = await renderEchoHook();

    act(() => {
      sigma.emit('assistant:dispatch-echo', {
        workspaceId: wsId,
        sessionId: 'sess-new-02',
        providerId: 'claude',
        ok: true,
        error: null,
        conversationId: null,
      });
    });

    await vi.waitFor(() => {
      expect(swarmsListMock).toHaveBeenCalledWith(wsId);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = getHarness().state;
    expect(state.swarms.some((sw) => sw.id === 'swarm-new-01')).toBe(true);
  });

  /**
   * ERROR PATH TEST — the failed echo must not mutate sessions state.
   *
   * When ok: false, the handler shows a toast and returns early. It must NOT
   * call listForWorkspace, must NOT call swarms.list, and must NOT dispatch
   * ADD_SESSIONS. This guards against accidentally hydrating on failure.
   */
  it('after dispatch-echo ok:false, state.sessions is not mutated and rpc is not called', async () => {
    const wsId = 'ws-gamma';

    const { getHarness } = await renderEchoHook();
    const sessionsBefore = getHarness().state.sessions;

    act(() => {
      sigma.emit('assistant:dispatch-echo', {
        workspaceId: wsId,
        sessionId: 'sess-err',
        providerId: 'claude',
        ok: false,
        error: 'backend error: pty spawn failed',
        conversationId: null,
      });
    });

    // Short settle — no async work should occur.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listForWorkspaceMock).not.toHaveBeenCalled();
    expect(swarmsListMock).not.toHaveBeenCalled();
    expect(getHarness().state.sessions).toBe(sessionsBefore); // referential equality — no new array
  });
});
