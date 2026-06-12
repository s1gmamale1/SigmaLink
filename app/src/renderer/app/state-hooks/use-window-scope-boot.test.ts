// @vitest-environment jsdom
//
// Multi-window B4 — scoped-window self-hydration. Verifies useWindowScopeBoot:
//   • no-ops in the main window (no scope);
//   • loads its ONE workspace, opens + activates it, and MIRRORS the restore
//     path's per-workspace pane hydration (resume → listForWorkspace +
//     swarms.list → ADD_SESSIONS / UPSERT_SWARM / SET_ACTIVE_SWARM);
//   • runs exactly once per process;
//   • warns + stays empty when the scoped workspace was deleted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, render, act } from '@testing-library/react';
import { StrictMode, createElement, useReducer } from 'react';
import type { Workspace } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { initialAppState } from '../state.types';
import { appStateReducer } from '../state.reducer';

interface WindowContextStub {
  windowId: number | null;
  isMain: boolean;
  workspaceScope: string | null;
}

function installSigmaStub(windowContext?: WindowContextStub): void {
  Object.defineProperty(globalThis.window, 'sigma', {
    configurable: true,
    writable: true,
    value: { eventOn: vi.fn(() => () => {}), eventSend: vi.fn(), invoke: vi.fn(), windowContext },
  });
}

const workspacesListMock = vi.fn<() => Promise<Workspace[]>>();
const resumeMock = vi.fn<
  (wsId: string) => Promise<{
    workspaceId: string;
    resumed: Array<{ sessionId: string }>;
    failed: Array<{ sessionId: string; error: string }>;
    skipped: Array<{ sessionId: string }>;
  }>
>();
const respawnMock = vi.fn<
  (wsId: string) => Promise<{ workspaceId: string; spawned: number; failed: number }>
>();
const listForWorkspaceMock = vi.fn<(wsId: string) => Promise<unknown[]>>();
const swarmsListMock = vi.fn<(wsId: string) => Promise<unknown[]>>();

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const rpcMock = {
  rpc: {
    workspaces: { list: (...a: unknown[]) => workspacesListMock(...(a as [])) },
    panes: {
      resume: (id: string) => resumeMock(id),
      respawnFailed: (id: string) => respawnMock(id),
      listForWorkspace: (id: string) => listForWorkspaceMock(id),
    },
    swarms: { list: (id: string) => swarmsListMock(id) },
  },
};
vi.mock('@/renderer/lib/rpc', () => rpcMock);
vi.mock('../../lib/rpc', () => rpcMock);

function workspace(id: string): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

beforeEach(() => {
  installSigmaStub();
  workspacesListMock.mockReset();
  workspacesListMock.mockResolvedValue([]);
  resumeMock.mockReset();
  resumeMock.mockImplementation((workspaceId: string) =>
    Promise.resolve({ workspaceId, resumed: [], failed: [], skipped: [] }),
  );
  respawnMock.mockReset();
  respawnMock.mockImplementation((workspaceId: string) =>
    Promise.resolve({ workspaceId, spawned: 0, failed: 0 }),
  );
  listForWorkspaceMock.mockReset();
  listForWorkspaceMock.mockResolvedValue([]);
  swarmsListMock.mockReset();
  swarmsListMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  state: AppState;
  dispatch: (a: Action) => void;
}

async function renderBoot(scope: string | null) {
  installSigmaStub(
    scope ? { windowId: 2, isMain: false, workspaceScope: scope } : undefined,
  );
  const { useWindowScopeBoot } = await import('./use-window-scope-boot');
  let harness: Harness | null = null;
  const Wrapper = () => {
    const [state, dispatch] = useReducer(appStateReducer, initialAppState);
    harness = { state, dispatch };
    useWindowScopeBoot(state, dispatch);
    return null;
  };
  const r = renderHook(() => Wrapper());
  return { r, getHarness: () => harness as unknown as Harness };
}

describe('useWindowScopeBoot', () => {
  it('no-ops in the main window (no scope)', async () => {
    await renderBoot(null);
    await act(async () => {
      await Promise.resolve();
    });
    expect(workspacesListMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('loads + opens + activates its scoped workspace and hydrates panes (resume → list → ADD_SESSIONS)', async () => {
    const wsB = workspace('b');
    workspacesListMock.mockResolvedValue([workspace('a'), wsB]);
    const fakeSessions = [
      {
        id: 'sess-b-1',
        workspaceId: 'b',
        providerId: 'claude',
        cwd: '/tmp/b',
        branch: null,
        worktreePath: null,
        status: 'running' as const,
        startedAt: 1000,
      },
    ];
    listForWorkspaceMock.mockResolvedValue(fakeSessions);

    const { getHarness } = await renderBoot('b');

    await vi.waitFor(() => {
      expect(listForWorkspaceMock).toHaveBeenCalledWith('b');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = getHarness().state;
    // Opened + activated ONLY 'b'.
    expect(state.activeWorkspaceId).toBe('b');
    expect(state.openWorkspaces.map((w) => w.id)).toEqual(['b']);
    expect(state.activeWorkspace?.id).toBe('b');
    // Resume ran for the scoped workspace.
    expect(resumeMock).toHaveBeenCalledWith('b');
    // Sessions hydrated where CommandRoom reads them.
    expect(state.sessionsByWorkspace['b']?.map((s) => s.id)).toEqual(['sess-b-1']);
  });

  it('hydrates swarms and activates the running one', async () => {
    workspacesListMock.mockResolvedValue([workspace('b')]);
    swarmsListMock.mockResolvedValue([
      { id: 'swarm-idle', workspaceId: 'b', status: 'ended' },
      { id: 'swarm-live', workspaceId: 'b', status: 'running' },
    ]);

    const { getHarness } = await renderBoot('b');

    await vi.waitFor(() => {
      expect(swarmsListMock).toHaveBeenCalledWith('b');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = getHarness().state;
    expect(state.swarmsByWorkspace['b']?.map((s) => s.id).sort()).toEqual([
      'swarm-idle',
      'swarm-live',
    ]);
    expect(state.activeSwarmId).toBe('swarm-live');
  });

  it('runs exactly once even across re-renders', async () => {
    workspacesListMock.mockResolvedValue([workspace('b')]);
    const { getHarness } = await renderBoot('b');

    await vi.waitFor(() => {
      expect(workspacesListMock).toHaveBeenCalledTimes(1);
    });
    // Force a re-render via a dispatch — the run-once ref must hold.
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(workspacesListMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledTimes(1);
  });

  it('warns + stays empty when the scoped workspace was deleted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    workspacesListMock.mockResolvedValue([workspace('a')]); // 'b' is gone

    const { getHarness } = await renderBoot('b');

    await vi.waitFor(() => {
      expect(workspacesListMock).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(resumeMock).not.toHaveBeenCalled();
    expect(getHarness().state.activeWorkspaceId).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('surfaces a respawn toast when resume reports failures', async () => {
    const { toast } = await import('sonner');
    workspacesListMock.mockResolvedValue([workspace('b')]);
    resumeMock.mockResolvedValue({
      workspaceId: 'b',
      resumed: [{ sessionId: 's1' }],
      failed: [{ sessionId: 's2', error: 'no external id' }],
      skipped: [],
    });

    await renderBoot('b');

    await vi.waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      'Resumed 1 pane. 1 pane needs to be respawned.',
    );
  });

  // B4 review fix 2 — StrictMode dev-boot. React StrictMode mounts the
  // provider, immediately cleans up, then mounts again. With the run-once ref
  // flipped at effect ENTRY, run 1 marked itself booted, the cleanup cancelled
  // it (alive=false), and run 2 early-returned → the scoped window never
  // hydrated in dev. The ref must flip only after the dispatches COMMIT;
  // the in-flight guard then keeps a still-running boot from double-firing.
  // Mirrors the RightRailContext.test.tsx render-under-<StrictMode> pattern.
  it('hydrates exactly once under StrictMode (mount→cleanup→mount)', async () => {
    installSigmaStub({ windowId: 2, isMain: false, workspaceScope: 'b' });
    workspacesListMock.mockResolvedValue([workspace('b')]);
    const { useWindowScopeBoot } = await import('./use-window-scope-boot');
    let harness: Harness | null = null;
    const Wrapper = () => {
      const [state, dispatch] = useReducer(appStateReducer, initialAppState);
      harness = { state, dispatch };
      useWindowScopeBoot(state, dispatch);
      return null;
    };
    render(createElement(StrictMode, null, createElement(Wrapper)));

    // Pre-fix this never fired: run 2 early-returned on the booted ref and
    // run 1's dispatches were dead behind the alive=false guard.
    await vi.waitFor(() => {
      expect(resumeMock).toHaveBeenCalledTimes(1);
    });
    // Let every queued microtask settle, then confirm NO second hydration.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resumeMock).toHaveBeenCalledTimes(1);

    const h = harness as unknown as Harness;
    expect(h.state.activeWorkspaceId).toBe('b');
    expect(h.state.openWorkspaces.map((w) => w.id)).toEqual(['b']);
  });
});
