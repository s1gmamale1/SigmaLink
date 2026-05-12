// @vitest-environment jsdom
//
// BUG-C2 regression coverage. Verifies that `useWorkspaceMirror` ALWAYS
// dispatches `SYNC_OPEN_WORKSPACES` after main emits `app:open-workspaces-
// changed`, even when the workspace-list RPC fails. Before the fix the hook
// returned early inside the catch, leaving renderer state stale.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Workspace } from '@/shared/types';
import type { Action, AppState } from '../state.types';
import { initialAppState } from '../state.types';

type EventCb = (payload: unknown) => void;

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
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
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend: vi.fn(), invoke: vi.fn() },
  };
  return { eventOn, emit };
}

const listMock = vi.fn<() => Promise<Workspace[]>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    workspaces: {
      list: (...args: unknown[]) => listMock(...(args as [])),
    },
  },
}));
// The hook imports rpc via a relative path, alias to same module.
vi.mock('../../lib/rpc', () => ({
  rpc: {
    workspaces: {
      list: (...args: unknown[]) => listMock(...(args as [])),
    },
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
let dispatch: ReturnType<typeof vi.fn<(a: Action) => void>>;

beforeEach(() => {
  sigma = installSigmaStub();
  dispatch = vi.fn();
  listMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderMirror(state: AppState) {
  const { useWorkspaceMirror } = await import('./use-workspace-mirror');
  return renderHook(() => useWorkspaceMirror(state, dispatch));
}

describe('useWorkspaceMirror — BUG-C2 RPC failure handling', () => {
  it('still dispatches SYNC_OPEN_WORKSPACES with cached workspaces when rpc.workspaces.list throws', async () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA, wsB],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };

    listMock.mockRejectedValueOnce(new Error('main process boom'));

    await renderMirror(state);
    expect(sigma.eventOn).toHaveBeenCalledWith('app:open-workspaces-changed', expect.any(Function));

    // Main now reports c is open even though our cache doesn't know about it.
    // This forces the RPC branch which will reject.
    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'c'] });
      // Allow the async lambda inside the listener to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listMock).toHaveBeenCalledTimes(1);

    // The critical assertion: SYNC_OPEN_WORKSPACES MUST be dispatched even
    // though rpc.workspaces.list rejected.
    const syncCalls = dispatch.mock.calls
      .map((args) => args[0])
      .filter((a): a is Extract<Action, { type: 'SYNC_OPEN_WORKSPACES' }> => a.type === 'SYNC_OPEN_WORKSPACES');
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]?.workspaceIds).toEqual(['a', 'c']);
    // Cached workspaces are forwarded — the reducer drops unknown ids.
    expect(syncCalls[0]?.workspaces.map((w) => w.id)).toEqual(['a', 'b']);

    // SET_WORKSPACES must NOT have been dispatched because the RPC failed.
    const setCalls = dispatch.mock.calls
      .map((args) => args[0])
      .filter((a): a is Extract<Action, { type: 'SET_WORKSPACES' }> => a.type === 'SET_WORKSPACES');
    expect(setCalls).toHaveLength(0);
  });

  it('dispatches SET_WORKSPACES then SYNC_OPEN_WORKSPACES on success path', async () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const wsC = workspace('c');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA, wsB],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };

    listMock.mockResolvedValueOnce([wsA, wsB, wsC]);

    await renderMirror(state);

    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'c'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_WORKSPACES',
      workspaces: [wsA, wsB, wsC],
    });
    const syncCall = dispatch.mock.calls
      .map((args) => args[0])
      .find((a): a is Extract<Action, { type: 'SYNC_OPEN_WORKSPACES' }> => a.type === 'SYNC_OPEN_WORKSPACES');
    expect(syncCall?.workspaceIds).toEqual(['a', 'c']);
    expect(syncCall?.workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips the RPC entirely when cached workspaces already cover all ids', async () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA, wsB],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };

    await renderMirror(state);

    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['b'] });
      await Promise.resolve();
    });

    expect(listMock).not.toHaveBeenCalled();
    const syncCall = dispatch.mock.calls
      .map((args) => args[0])
      .find((a): a is Extract<Action, { type: 'SYNC_OPEN_WORKSPACES' }> => a.type === 'SYNC_OPEN_WORKSPACES');
    expect(syncCall?.workspaceIds).toEqual(['b']);
  });
});
