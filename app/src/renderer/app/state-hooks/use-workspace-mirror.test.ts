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
import { __resetWorkspaceMirrorModuleStateForTests } from './use-workspace-mirror';

type EventCb = (payload: unknown) => void;

interface WindowContextStub {
  windowId: number | null;
  isMain: boolean;
  workspaceScope: string | null;
}

interface SigmaStub {
  eventOn: ReturnType<typeof vi.fn<(event: string, cb: EventCb) => () => void>>;
  eventSend: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>;
  emit: (event: string, payload: unknown) => void;
}

// Multi-window B3 — `windowContext` is read at call time by window-context.ts
// (isMainWindow / getWorkspaceScope), so installing it on the stubbed
// window.sigma is enough to drive scoped-vs-main behaviour per test.
function installSigmaStub(windowContext?: WindowContextStub): SigmaStub {
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
  const eventSend = vi.fn<(event: string, payload: unknown) => void>();
  const emit = (event: string, payload: unknown) => {
    handlers.get(event)?.forEach((fn) => fn(payload));
  };
  (globalThis as unknown as { window: { sigma: unknown } }).window = {
    ...(globalThis.window ?? {}),
    sigma: { eventOn, eventSend, invoke: vi.fn(), windowContext },
  };
  return { eventOn, eventSend, emit };
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
  // Module-scope caches (secondaryOwned / lastUnion) survive remounts by
  // design — clear them between cases so scope state doesn't leak across tests.
  __resetWorkspaceMirrorModuleStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderMirror(state: AppState) {
  const { useWorkspaceMirror } = await import('./use-workspace-mirror');
  return renderHook(() => useWorkspaceMirror(state, dispatch));
}

function syncCalls(): Array<Extract<Action, { type: 'SYNC_OPEN_WORKSPACES' }>> {
  return dispatch.mock.calls
    .map((args) => args[0])
    .filter(
      (a): a is Extract<Action, { type: 'SYNC_OPEN_WORKSPACES' }> =>
        a.type === 'SYNC_OPEN_WORKSPACES',
    );
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

// Multi-window B3 — scope-aware filtering + main-only outbound echo.
describe('useWorkspaceMirror — multi-window B3 scope awareness', () => {
  function mainState(): AppState {
    const wsA = workspace('a');
    const wsB = workspace('b');
    return {
      ...initialAppState,
      ready: true,
      workspaces: [wsA, wsB],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };
  }

  it('main window filters out a workspace owned by a secondary window', async () => {
    // window.sigma has no windowContext → defaults to main-window semantics.
    await renderMirror(mainState());

    await act(async () => {
      // 'b' is detached into a non-main window.
      sigma.emit('app:window-scope-changed', {
        scopes: [
          { windowId: 1, isMain: true, workspaceIds: ['a'] },
          { windowId: 2, isMain: false, workspaceIds: ['b'] },
        ],
      });
      // Then main broadcasts the UNION ['a','b'].
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'b'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The main window must NOT render 'b' — it's owned by window 2.
    const last = syncCalls().at(-1);
    expect(last?.workspaceIds).toEqual(['a']);
  });

  it('a scope event RE-FILTERS immediately without a new open-list event', async () => {
    await renderMirror(mainState());

    // First: full union arrives, nothing detached yet → SYNC ['a','b'].
    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'b'] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['a', 'b']);
    const countAfterOpen = syncCalls().length;

    // Then: 'b' detaches. The scope event alone must re-run reconcile against
    // lastUnion and drop 'b' — NO new open-list event.
    await act(async () => {
      sigma.emit('app:window-scope-changed', {
        scopes: [
          { windowId: 1, isMain: true, workspaceIds: ['a'] },
          { windowId: 2, isMain: false, workspaceIds: ['b'] },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(syncCalls().length).toBeGreaterThan(countAfterOpen);
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['a']);
  });

  it('scoped (secondary) window keeps only its own workspace', async () => {
    sigma = installSigmaStub({ windowId: 2, isMain: false, workspaceScope: 'b' });
    const wsA = workspace('a');
    const wsB = workspace('b');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA, wsB],
      openWorkspaces: [wsB],
      activeWorkspaceId: 'b',
    };

    await renderMirror(state);

    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'b'] });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Scope='b' → only 'b' survives, even though the union carried 'a' too.
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['b']);
  });

  it('a scoped window NEVER echoes outbound', async () => {
    sigma = installSigmaStub({ windowId: 2, isMain: false, workspaceScope: 'b' });
    const wsB = workspace('b');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsB],
      openWorkspaces: [wsB], // non-empty + ready → would echo if it were main
      activeWorkspaceId: 'b',
    };

    await renderMirror(state);
    await act(async () => {
      await Promise.resolve();
    });

    const echoes = sigma.eventSend.mock.calls.filter(
      ([event]) => event === 'app:open-workspaces-changed',
    );
    expect(echoes).toHaveLength(0);
  });

  it('main window still echoes outbound (pre-B3 regression)', async () => {
    // Default context (no windowContext) → main window.
    const wsA = workspace('a');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };

    await renderMirror(state);
    await act(async () => {
      await Promise.resolve();
    });

    const echoes = sigma.eventSend.mock.calls.filter(
      ([event]) => event === 'app:open-workspaces-changed',
    );
    expect(echoes).toHaveLength(1);
    expect(echoes[0]?.[1]).toEqual({ workspaceIds: ['a'] });
  });

  it('a stale reconcile racing across the rpc await never dispatches LAST (monotonic token)', async () => {
    // state.workspaces knows only 'a' so the open-list event for ['a','b']
    // takes the RPC branch and parks on this manually-resolved promise.
    const wsA = workspace('a');
    const wsB = workspace('b');
    const state: AppState = {
      ...initialAppState,
      ready: true,
      workspaces: [wsA],
      openWorkspaces: [wsA],
      activeWorkspaceId: 'a',
    };
    let resolveList!: (workspaces: Workspace[]) => void;
    listMock.mockReturnValueOnce(
      new Promise<Workspace[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    await renderMirror(state);

    // 1) Open-list ['a','b'] — 'b' unknown → awaits the deferred list.
    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'b'] });
      await Promise.resolve();
    });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(syncCalls()).toHaveLength(0); // still parked on the rpc await

    // 2) Scope event detaches 'b' — its reconcile is synchronous (visible
    //    ['a'] is fully covered by the cache) and dispatches SYNC ['a'].
    await act(async () => {
      sigma.emit('app:window-scope-changed', {
        scopes: [
          { windowId: 1, isMain: true, workspaceIds: ['a'] },
          { windowId: 2, isMain: false, workspaceIds: ['b'] },
        ],
      });
      await Promise.resolve();
    });
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['a']);

    // 3) NOW the rpc resolves — the OLDER reconcile wakes up. Pre-fix it
    //    dispatched SYNC ['a','b'] LAST, re-showing the detached 'b'.
    await act(async () => {
      resolveList([wsA, wsB]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale reconcile must have been dropped: exactly ONE SYNC, ['a'].
    expect(syncCalls()).toHaveLength(1);
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['a']);
    // Its SET_WORKSPACES is dropped too — nothing dispatches after supersession.
    const setCalls = dispatch.mock.calls
      .map((args) => args[0])
      .filter((a): a is Extract<Action, { type: 'SET_WORKSPACES' }> => a.type === 'SET_WORKSPACES');
    expect(setCalls).toHaveLength(0);
  });

  it('ignores a malformed scope payload (no crash, no state change)', async () => {
    await renderMirror(mainState());

    // Seed a valid union so we can prove the malformed scope event is a no-op.
    await act(async () => {
      sigma.emit('app:open-workspaces-changed', { workspaceIds: ['a', 'b'] });
      await Promise.resolve();
      await Promise.resolve();
    });
    const baseline = syncCalls().length;

    await act(async () => {
      // Various malformed shapes — each must be rejected wholesale.
      sigma.emit('app:window-scope-changed', { scopes: 'not-an-array' });
      sigma.emit('app:window-scope-changed', { scopes: [{ windowId: 'x', isMain: false, workspaceIds: [] }] });
      sigma.emit('app:window-scope-changed', { scopes: [{ windowId: 2, isMain: 'no', workspaceIds: ['b'] }] });
      sigma.emit('app:window-scope-changed', { scopes: [{ windowId: 2, isMain: false, workspaceIds: 'b' }] });
      sigma.emit('app:window-scope-changed', null);
      await Promise.resolve();
      await Promise.resolve();
    });

    // No additional SYNC dispatched — secondaryOwned untouched.
    expect(syncCalls().length).toBe(baseline);
    expect(syncCalls().at(-1)?.workspaceIds).toEqual(['a', 'b']);
  });
});
