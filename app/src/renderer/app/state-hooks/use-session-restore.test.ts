// @vitest-environment jsdom
//
// v1.1.10 — Fix 1 regression coverage. The session-snapshot writer in
// `useSessionRestore` previously stamped the current global `state.room` on
// every open workspace, forcing all of them into the same room on restore.
// The fix routes through `state.roomByWorkspace`; this test exercises the
// real reducer + hook + snapshot emission path and asserts that workspace A
// and workspace B serialize their own rooms independently.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Workspace } from '@/shared/types';
import { useReducer } from 'react';
import type { Action, AppState } from '../state.types';
import { initialAppState } from '../state.types';
import { appStateReducer } from '../state.reducer';

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  eventSend: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;
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
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend, invoke: vi.fn() },
  };
  return { eventOn, eventSend, emit };
}

const resumeMock = vi.fn<
  (wsId: string) => Promise<{ workspaceId: string; resumed: unknown[]; failed: unknown[]; skipped: unknown[] }>
>();
const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: { resume: (id: string) => resumeMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
}));
vi.mock('../../lib/rpc', () => ({
  rpc: {
    panes: { resume: (id: string) => resumeMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
}));

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

let sigma: SigmaStub;

beforeEach(() => {
  sigma = installSigmaStub();
  resumeMock.mockReset();
  resumeMock.mockImplementation((workspaceId: string) =>
    Promise.resolve({ workspaceId, resumed: [], failed: [], skipped: [] }),
  );
  kvGetMock.mockReset();
  kvGetMock.mockResolvedValue(null);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Harness {
  state: AppState;
  dispatch: (a: Action) => void;
}

async function renderRestore(initialActions: Action[] = []) {
  const { useSessionRestore } = await import('./use-session-restore');
  let harness: Harness | null = null;
  const Wrapper = () => {
    const [state, dispatch] = useReducer(appStateReducer, initialAppState);
    harness = { state, dispatch };
    useSessionRestore(state, dispatch);
    return null;
  };
  const r = renderHook(() => Wrapper());
  // Apply initial actions through the real reducer to set up workspaces.
  act(() => {
    for (const a of initialActions) {
      harness?.dispatch(a);
    }
  });
  return { r, getHarness: () => harness as unknown as Harness };
}

describe('useSessionRestore — Fix 1: per-workspace room snapshot', () => {
  it('serialises each open workspace with its own remembered room', async () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA, wsB] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
      { type: 'WORKSPACE_OPEN', workspace: wsB },
    ]);

    // wsB is now active. Put wsB in 'swarm'.
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' });
    });
    // Switch to wsA and put it in 'command'.
    act(() => {
      getHarness().dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'a' });
    });
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'command' });
    });

    // Run the debounced snapshot timer.
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const snapshotCall = sigma.eventSend.mock.calls.find(
      (c) => c[0] === 'app:session-snapshot',
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      activeWorkspaceId: string;
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    expect(payload.activeWorkspaceId).toBe('a');
    const rooms = Object.fromEntries(payload.openWorkspaces.map((e) => [e.workspaceId, e.room]));
    // The bug pre-v1.1.10 would yield { a: 'command', b: 'command' }.
    expect(rooms).toEqual({ a: 'command', b: 'swarm' });
  });

  it('restores per-workspace rooms and re-snapshots them losslessly', async () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA, wsB] },
    ]);

    // Simulate main pushing a restore payload BEFORE workspaces are opened.
    act(() => {
      sigma.emit('app:session-restore', {
        activeWorkspaceId: 'a',
        openWorkspaces: [
          { workspaceId: 'a', room: 'command' },
          { workspaceId: 'b', room: 'swarm' },
        ],
      });
    });

    // The drain effect runs once state.ready is true (already true) and
    // re-runs on workspaces change. Trigger by re-rendering.
    act(() => {
      // Reapply READY to bump dependency.
      getHarness().dispatch({ type: 'READY', workspaces: [wsA, wsB] });
    });

    // Per-workspace map is populated post-drain.
    expect(getHarness().state.roomByWorkspace).toMatchObject({ a: 'command', b: 'swarm' });
    expect(getHarness().state.activeWorkspaceId).toBe('a');
    expect(getHarness().state.room).toBe('command');

    // Now snapshot — should serialise both rooms losslessly.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const snapshotCall = sigma.eventSend.mock.calls.find(
      (c) => c[0] === 'app:session-snapshot',
    );
    expect(snapshotCall).toBeDefined();
    const payload = snapshotCall?.[1] as {
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    const rooms = Object.fromEntries(payload.openWorkspaces.map((e) => [e.workspaceId, e.room]));
    expect(rooms).toEqual({ a: 'command', b: 'swarm' });
  });
});
