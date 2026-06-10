// @vitest-environment jsdom
//
// 2026-06-10 audit — snapshot-writer coverage for useSessionRestore:
//   • finding 1 site 4: the snapshot `fallbackRoom` must treat EVERY
//     GLOBAL_ROOMS member as non-serializable (falls back to 'command'),
//     not just 'workspaces'. Enumerated over GLOBAL_ROOMS (anti-drift).
//   • finding 4 (Task 4 appends a describe here): the debounced snapshot
//     must FLUSH on unmount/beforeunload instead of being silently dropped.
//
// Split out of use-session-restore.test.ts (555 lines) to respect the
// 500-line cap. NOTE: unlike that file's installSigmaStub, this harness uses
// Object.defineProperty so `window` keeps its real prototype
// (addEventListener) — required once the hook registers a beforeunload flush.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducer } from 'react';
import type { Workspace } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { GLOBAL_ROOMS, initialAppState } from '../state.types';
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
  // defineProperty (NOT window replacement): keeps the real jsdom Window with
  // its prototype chain, so window.addEventListener works in the hook.
  Object.defineProperty(globalThis.window, 'sigma', {
    configurable: true,
    writable: true,
    value: { eventOn, eventSend, invoke: vi.fn() },
  });
  return { eventOn, eventSend, emit };
}

const resumeMock = vi.fn((workspaceId: string) =>
  Promise.resolve({
    workspaceId,
    resumed: [] as unknown[],
    failed: [] as unknown[],
    skipped: [] as unknown[],
  }),
);
const listForWorkspaceMock = vi.fn(async (_wsId: string) => [] as unknown[]);
const swarmsListMock = vi.fn(async (_wsId: string) => [] as unknown[]);
const kvGetMock = vi.fn(async (_key: string) => null as string | null);

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    panes: {
      resume: (id: string) => resumeMock(id),
      respawnFailed: vi.fn(async () => ({ spawned: 0, failed: 0 })),
      listForWorkspace: (id: string) => listForWorkspaceMock(id),
    },
    swarms: { list: (id: string) => swarmsListMock(id) },
    kv: { get: (k: string) => kvGetMock(k) },
  },
}));
vi.mock('../../lib/rpc', () => ({
  rpc: {
    panes: {
      resume: (id: string) => resumeMock(id),
      respawnFailed: vi.fn(async () => ({ spawned: 0, failed: 0 })),
      listForWorkspace: (id: string) => listForWorkspaceMock(id),
    },
    swarms: { list: (id: string) => swarmsListMock(id) },
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
  resumeMock.mockClear();
  listForWorkspaceMock.mockClear();
  swarmsListMock.mockClear();
  kvGetMock.mockClear();
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
  act(() => {
    for (const a of initialActions) {
      harness?.dispatch(a);
    }
  });
  return { r, getHarness: () => harness as unknown as Harness };
}

function snapshotCalls(stub: SigmaStub) {
  return stub.eventSend.mock.calls.filter((c) => c[0] === 'app:session-snapshot');
}

describe('GLOBAL_ROOMS anti-drift — site 4: snapshot fallbackRoom', () => {
  it.each([...GLOBAL_ROOMS])(
    'serialises the active workspace as command (not %s) when the active room is global',
    async (room) => {
      const wsA = workspace('a');
      const { getHarness } = await renderRestore([
        { type: 'READY', workspaces: [wsA] },
        { type: 'WORKSPACE_OPEN', workspace: wsA },
      ]);
      act(() => {
        getHarness().dispatch({ type: 'SET_ROOM', room });
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const calls = snapshotCalls(sigma);
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1]?.[1] as {
        activeWorkspaceId: string;
        openWorkspaces: Array<{ workspaceId: string; room: string }>;
      };
      // Pre-fix this failed for 'settings'/'automations': fallbackRoom only
      // excluded 'workspaces', so the global room was serialized for 'a'.
      expect(last.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'command' }]);
    },
  );
});

describe('snapshot debounce — flush instead of drop (2026-06-10 finding 4)', () => {
  it('flushes the pending snapshot on unmount instead of dropping it', async () => {
    const wsA = workspace('a');
    const { r, getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    // Drain the initial debounce so the baseline snapshot is written.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    sigma.eventSend.mockClear();

    // Change the room → a NEW snapshot is pending inside the 250ms window.
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' });
    });
    expect(snapshotCalls(sigma)).toHaveLength(0); // still debouncing

    // Unmount INSIDE the window (hook teardown). Pre-fix: the cleanup
    // cancelled the timer and the key was already marked written → the final
    // snapshot was silently lost (0 calls).
    r.unmount();

    const calls = snapshotCalls(sigma);
    expect(calls).toHaveLength(1);
    const payload = calls[0]?.[1] as {
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    expect(payload.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'swarm' }]);
  });

  it('flushes the pending snapshot on beforeunload (quit inside the debounce window)', async () => {
    const wsA = workspace('a');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    sigma.eventSend.mockClear();

    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'memory' });
    });
    expect(snapshotCalls(sigma)).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    const calls = snapshotCalls(sigma);
    expect(calls).toHaveLength(1);
    const payload = calls[0]?.[1] as {
      openWorkspaces: Array<{ workspaceId: string; room: string }>;
    };
    expect(payload.openWorkspaces).toEqual([{ workspaceId: 'a', room: 'memory' }]);
  });

  it('cancels a stale pending write when state returns to the last-written key (A→B→A)', async () => {
    const wsA = workspace('a');
    const { getHarness } = await renderRestore([
      { type: 'READY', workspaces: [wsA] },
      { type: 'WORKSPACE_OPEN', workspace: wsA },
    ]);
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'command' }); // A
    });
    act(() => {
      vi.advanceTimersByTime(500); // A written
    });
    sigma.eventSend.mockClear();

    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'swarm' }); // B pending
    });
    act(() => {
      getHarness().dispatch({ type: 'SET_ROOM', room: 'command' }); // back to A
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // A is already persisted; the stale B write must have been cancelled —
    // nothing (especially not 'swarm') may land.
    expect(snapshotCalls(sigma)).toHaveLength(0);
  });
});
