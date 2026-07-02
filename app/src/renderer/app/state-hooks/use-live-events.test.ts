// @vitest-environment jsdom
//
// v1.1.10 — regression coverage for Fix 6 (review refresh churn). Before the
// fix, the review-hydration effect depended on `state.sessions.length`,
// causing `runRefreshOnEvent` to tear down and re-subscribe (plus fire an
// immediate RPC fetch) on every session add/remove. Under rapid session
// churn (multi-pane spawn/teardown) this spammed `rpc.review.list`.
//
// v1.13.1 — adds tests for the notification-sound subscriber:
//   - tone plays on any unread added delta (incl. info — SF-5 widened v1.29.0)
//   - tone plays on info-only delta (SF-5)
//   - silent when toggle off
//   - silent on removed-only / empty deltas
//
// P3 (NTF-2 / SND-1) — extends to the toast↔bell handoff:
//   - tone called with the delta's MAX unread severity
//   - a themed sonner toast fires per audible new unread row
//   - DND (KV_DND='1') suppresses BOTH tone + toast
//   - a muted source (KV_OS_PER_SOURCE includes it) is neither toned nor toasted
//   - error/critical toast is persistent (duration Infinity) + carries a View action

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgentSession, Notification, ReviewState } from '@/shared/types';
import { KV_DND, KV_OS_PER_SOURCE, KV_QUIET_HOURS } from '@/shared/notification-prefs';
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

// Mock every RPC the hook touches. Only `review.list` is interesting for the
// churn assertion; the rest are no-op resolved promises so the other effects
// (skills/memory/tasks/swarms) settle quietly.
const reviewListMock = vi.fn<(wsId: string) => Promise<ReviewState>>();
// Phase-2 control — scope-guard coverage for the non-idempotent subscribers.
const splitPaneMock = vi.fn();
const sendMessageMock = vi.fn();
// open_workspace navigate coverage — returns the opened workspace so the handler
// can WORKSPACE_OPEN + SET_ACTIVE_WORKSPACE_ID it.
const workspaceOpenMock = vi.fn<(root: string) => Promise<{ id: string }>>();
// dispatch-echo hydration coverage — the GLOBAL handler refetches panes (silent)
// and dispatches ADD_SESSIONS so a launch_pane reflects in the grid in ANY room.
const panesListSilentMock = vi.fn<(id: string) => Promise<AgentSession[]>>();

function emptyReview(workspaceId: string): ReviewState {
  return { workspaceId, sessions: [] };
}

// v1.13.1 — mock playNotificationTone so we can assert it was called/not called.
const playNotificationToneMock = vi.fn();

vi.mock('../../lib/notifications', () => ({
  playNotificationTone: (...args: unknown[]) => playNotificationToneMock(...args),
}));

// Task 8 — mock playCue for agent-attention throttled sound.
const playCueMock = vi.fn();
vi.mock('../../lib/sounds', () => ({ playCue: (...a: unknown[]) => playCueMock(...a) }));

// P3 — sonner is the toast surface for the bell handoff. Mock the three call
// shapes the delta effect uses (`toast`, `toast.warning`, `toast.error`).
const toastMock = vi.fn() as ReturnType<typeof vi.fn> & {
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
toastMock.warning = vi.fn();
toastMock.error = vi.fn();
vi.mock('sonner', () => ({ toast: toastMock }));

// P3 — KV is read per delta (DND / quiet-hours / per-source mute). Back it with
// a mutable store the tests set up per case; default = empty (all permissive).
let kvStore: Record<string, string | null> = {};

const rpcMock = {
  review: { list: (id: string) => reviewListMock(id) },
  skills: { list: () => Promise.resolve({ skills: [], states: [] }) },
  memory: { list_memories: () => Promise.resolve([]) },
  tasks: { list: () => Promise.resolve([]) },
  swarms: {
    list: () => Promise.resolve([]),
    splitPane: (a: unknown) => splitPaneMock(a),
    sendMessage: (a: unknown) => sendMessageMock(a),
    resume: () => Promise.resolve(),
  },
  workspaces: { open: (root: string) => workspaceOpenMock(root) },
};
const rpcSilentMock = {
  notifications: {
    list: () => Promise.resolve([]),
    unreadCount: () => Promise.resolve(0),
  },
  kv: { get: (key: string) => Promise.resolve(kvStore[key] ?? null) },
  panes: { listForWorkspace: (id: string) => panesListSilentMock(id) },
  swarms: { list: () => Promise.resolve([]) },
};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: rpcMock,
  rpcSilent: rpcSilentMock,
}));
vi.mock('../../lib/rpc', () => ({
  rpc: rpcMock,
  rpcSilent: rpcSilentMock,
}));

function session(id: string, status: AgentSession['status'] = 'running'): AgentSession {
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
  const ws = {
    id: 'a',
    name: 'A',
    rootPath: '/tmp/a',
    repoRoot: '/tmp/a',
    repoMode: 'git' as const,
    createdAt: 1,
    lastOpenedAt: 1,
  };
  return {
    ...initialAppState,
    ready: true,
    workspaces: [ws],
    openWorkspaces: [ws],
    activeWorkspaceId: 'a',
    activeWorkspace: ws,
    sessions,
  };
}

let sigma: SigmaStub;
let dispatch: ReturnType<typeof vi.fn<(a: Action) => void>>;

beforeEach(() => {
  sigma = installSigmaStub();
  dispatch = vi.fn();
  reviewListMock.mockReset();
  reviewListMock.mockResolvedValue(emptyReview('a'));
  playNotificationToneMock.mockReset();
  playCueMock.mockReset();
  splitPaneMock.mockReset();
  splitPaneMock.mockResolvedValue({ id: 's2', splitGroupId: null });
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(undefined);
  workspaceOpenMock.mockReset();
  panesListSilentMock.mockReset();
  panesListSilentMock.mockResolvedValue([]);
  kvStore = {};
  toastMock.mockReset();
  toastMock.warning.mockReset();
  toastMock.error.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderLiveEvents(state: AppState) {
  const { useLiveEvents } = await import('./use-live-events');
  return renderHook((props: { state: AppState }) => useLiveEvents(props.state, dispatch), {
    initialProps: { state },
  });
}

// ---- v1.13.2 pty:error / pty:exit subscribers -------------------------------

describe('useLiveEvents — v1.13.2 crash vs clean-exit subscribers', () => {
  it('dispatches MARK_SESSION_ERROR on pty:error (runtime crash → pane persists)', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      sigma.emit('pty:error', { sessionId: 's1', exitCode: 137, signal: 'SIGKILL' });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'MARK_SESSION_ERROR',
      id: 's1',
      exitCode: 137,
      signal: 'SIGKILL',
    });
    // Crash must NOT be reported as a clean exit.
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MARK_SESSION_EXITED', id: 's1' }),
    );
  });

  it('coerces a non-numeric pty:error exitCode to null', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      sigma.emit('pty:error', { sessionId: 's1' });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'MARK_SESSION_ERROR',
      id: 's1',
      exitCode: null,
      signal: null,
    });
  });

  it('ignores a pty:error payload with no sessionId', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('pty:error', { exitCode: 1 });
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MARK_SESSION_ERROR' }),
    );
  });

  it('still dispatches MARK_SESSION_EXITED on pty:exit (clean exit unchanged)', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      sigma.emit('pty:exit', { sessionId: 's1', exitCode: 0 });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: 'MARK_SESSION_EXITED',
      id: 's1',
      exitCode: 0,
    });
  });
});

describe('useLiveEvents — assistant:pane-closed → REMOVE_SESSION', () => {
  it('dispatches REMOVE_SESSION when assistant:pane-closed fires with a valid sessionId', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      sigma.emit('assistant:pane-closed', { sessionId: 's1' });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
  });

  it('ignores assistant:pane-closed with no sessionId', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:pane-closed', {});
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REMOVE_SESSION' }),
    );
  });

  it('ignores assistant:pane-closed with non-string sessionId', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:pane-closed', { sessionId: 42 });
      await Promise.resolve();
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REMOVE_SESSION' }),
    );
  });
});

describe('useLiveEvents — assistant:open-workspace navigates (view follows the agent)', () => {
  it('opens AND activates the workspace so external/Jorvis work surfaces live', async () => {
    workspaceOpenMock.mockResolvedValueOnce({ id: 'ws-new' });
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:open-workspace', { root: '/tmp/new' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspaceOpenMock).toHaveBeenCalledWith('/tmp/new');
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'WORKSPACE_OPEN' }),
    );
    // The fix: without SET_ACTIVE_WORKSPACE_ID the opened workspace (and any panes
    // launched into it) stay in the background and never surface in the view.
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'ws-new' });
  });

  it('ignores assistant:open-workspace with a non-string root', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:open-workspace', { root: 42 });
      await Promise.resolve();
    });

    expect(workspaceOpenMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_ACTIVE_WORKSPACE_ID' }),
    );
  });
});

describe('useLiveEvents — v1.13.2 canonical swarm loader drives swarmsLoading', () => {
  it('dispatches SET_SWARMS_LOADING true then false around rpc.swarms.list', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const loadingCalls = dispatch.mock.calls
      .map(([a]) => a)
      .filter((a): a is { type: 'SET_SWARMS_LOADING'; loading: boolean } =>
        (a as { type: string }).type === 'SET_SWARMS_LOADING',
      );
    // At least one true and a trailing false (the finally settles it).
    expect(loadingCalls.some((a) => a.loading === true)).toBe(true);
    expect(loadingCalls.at(-1)?.loading).toBe(false);
  });
});

describe('useLiveEvents — Fix 6: review refresh churn on session add/remove', () => {
  it('does NOT refetch review state when sessions change but workspace stays', async () => {
    const initialState = stateWith([session('s1')]);
    const { rerender } = await renderLiveEvents(initialState);
    // Allow the initial fetch to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reviewListMock).toHaveBeenCalledTimes(1);

    // Sessions churn rapidly — add three, remove one. Pre-v1.1.10 every
    // rerender triggered a teardown+resubscribe+immediate refetch.
    rerender({ state: stateWith([session('s1'), session('s2')]) });
    rerender({ state: stateWith([session('s1'), session('s2'), session('s3')]) });
    rerender({ state: stateWith([session('s2'), session('s3')]) });

    await act(async () => {
      await Promise.resolve();
    });

    // No new RPC calls — the effect's dep array no longer includes
    // `sessions.length`, so it doesn't re-run on session churn.
    expect(reviewListMock).toHaveBeenCalledTimes(1);
  });

  it('still refreshes review state when the review:changed event fires (after the 250 ms coalesce)', async () => {
    vi.useFakeTimers();
    try {
      await renderLiveEvents(stateWith([session('s1')]));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(reviewListMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        sigma.emit('review:changed', { workspaceId: 'a' });
        await vi.advanceTimersByTimeAsync(250); // trailing coalesce window
      });

      expect(reviewListMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- v1.13.1 notification sound tests ---------------------------------------

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: `n-${Math.random()}`,
    workspaceId: 'a' as Notification['workspaceId'],
    kind: 'pty-exit',
    severity: 'warn',
    title: 'Test',
    body: '',
    payload: null,
    sourceEvent: null,
    dedupKey: `dk-${Math.random()}`,
    dupCount: 1,
    createdAt: Date.now(),
    readAt: null,
    ...overrides,
  };
}

// P3 — the tone + toast now run in a fire-and-forget async block AFTER the
// synchronous reducer dispatch (it awaits a Promise.all of KV reads). A single
// microtask turn no longer flushes it, so drain several turns deterministically.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

interface DeltaInput {
  added?: Notification[];
  removed?: string[];
  updated?: Notification[];
  unreadCount?: number;
}

async function emitDelta(input: DeltaInput): Promise<void> {
  await act(async () => {
    sigma.emit('notifications:changed', {
      added: input.added ?? [],
      removed: input.removed ?? [],
      updated: input.updated ?? [],
      unreadCount: input.unreadCount ?? (input.added ?? []).length,
    });
    await flushAsync();
  });
}

// 2026-07-02 review fix A — read-state deltas ride the `updated` lane:
// forwarded to the reducer (row styling reconciles in EVERY window) but
// NEVER alerting (no tone, no toast — mark-unread must not re-alert).
describe('useLiveEvents — `updated` read-state reconcile lane', () => {
  it('forwards updated rows to the reducer dispatch', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => {
      await Promise.resolve();
    });
    const n = makeNotification({ readAt: 123 });
    await emitDelta({ updated: [n], unreadCount: 0 });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'NOTIFICATIONS_DELTA',
        updated: [n],
        unreadCount: 0,
      }),
    );
  });

  it('never plays a tone or toast for updated rows (even unread ones)', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => {
      await Promise.resolve();
    });
    await emitDelta({
      updated: [makeNotification({ severity: 'warn', readAt: null })],
      unreadCount: 1,
    });

    expect(playNotificationToneMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});

describe('useLiveEvents — v1.13.1 notification sound', () => {
  it('plays tone once per delta when added contains unread warn notification', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await emitDelta({ added: [makeNotification({ severity: 'warn', readAt: null })] });

    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
  });

  it('plays tone on error severity', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({ added: [makeNotification({ severity: 'error', readAt: null })] });

    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
  });

  it('plays tone on critical severity', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({ added: [makeNotification({ severity: 'critical', readAt: null })] });

    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
  });

  it('plays tone ONCE even when multiple alertable notifications are in the delta', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [
        makeNotification({ severity: 'warn', readAt: null }),
        makeNotification({ severity: 'error', readAt: null }),
      ],
    });

    // Once per delta, not once per notification row.
    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
  });

  it('plays tone for info-only delta (SF-5: all severities audible)', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({ added: [makeNotification({ severity: 'info', readAt: null })] });

    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT play tone for removed-only delta', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({ added: [], removed: ['n-1'], unreadCount: 0 });

    expect(playNotificationToneMock).not.toHaveBeenCalled();
  });

  it('does NOT play tone for empty delta', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({ added: [], removed: [], unreadCount: 0 });

    expect(playNotificationToneMock).not.toHaveBeenCalled();
  });

  it('does NOT play tone when notification is already read (readAt set)', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'warn', readAt: Date.now() })],
      unreadCount: 0,
    });

    expect(playNotificationToneMock).not.toHaveBeenCalled();
  });
});

// ---- P3 (NTF-2) toast↔bell handoff ------------------------------------------

describe('useLiveEvents — P3 toast↔bell handoff', () => {
  it('plays the tone with the delta MAX unread severity', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [
        makeNotification({ severity: 'info', readAt: null }),
        makeNotification({ severity: 'error', readAt: null }),
        makeNotification({ severity: 'warn', readAt: null }),
      ],
    });

    expect(playNotificationToneMock).toHaveBeenCalledTimes(1);
    expect(playNotificationToneMock).toHaveBeenCalledWith('error');
  });

  it('surfaces an info toast (auto-dismiss 3000ms) for a new unread info row', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'info', title: 'Hi', body: 'world', readAt: null })],
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('Hi', { description: 'world', duration: 3000 });
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('surfaces a warning toast (5000ms) for a new unread warn row', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'warn', title: 'Heads up', readAt: null })],
    });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning.mock.calls[0][0]).toBe('Heads up');
    expect(toastMock.warning.mock.calls[0][1]).toMatchObject({ duration: 5000 });
  });

  it('error/critical toast is persistent (duration Infinity) + carries a View action', async () => {
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [
        makeNotification({ severity: 'error', title: 'Boom', kind: 'tool-error', readAt: null }),
      ],
    });

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const opts = toastMock.error.mock.calls[0][1] as {
      duration: number;
      action: { label: string; onClick: () => void };
    };
    expect(opts.duration).toBe(Infinity);
    expect(opts.action.label).toBe('View');
    // The View action deep-links via navigateToNotification → SET_ROOM 'jorvis'.
    act(() => opts.action.onClick());
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'jorvis' });
  });

  it('DND (KV_DND="1") suppresses the TOAST (tone is left to the engine gate)', async () => {
    kvStore[KV_DND] = '1';
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'error', readAt: null })],
    });

    // DND active → no toast surfaces. The tone is still DISPATCHED (the sounds
    // engine — mocked here — owns the DND/quiet gate; this call site keeps a
    // single gate source of truth rather than duplicating it).
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(playNotificationToneMock).toHaveBeenCalledWith('error');
  });

  it('quiet-hours active suppresses the toast (bell still records it)', async () => {
    // A 00:00→23:59 window is active for (almost) any local clock.
    kvStore[KV_QUIET_HOURS] = JSON.stringify({ enabled: true, start: '00:00', end: '23:59' });
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'warn', readAt: null })],
    });

    // No toast while quiet is active; the tone is still dispatched (engine gates).
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(playNotificationToneMock).toHaveBeenCalledWith('warn');
  });

  it('a muted source is neither toned nor toasted (but still upserted to the bell)', async () => {
    kvStore[KV_OS_PER_SOURCE] = JSON.stringify(['pty']);
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [makeNotification({ severity: 'error', kind: 'pty-exit', readAt: null })],
    });

    expect(playNotificationToneMock).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    // The reducer upsert (recording in the bell) still happened synchronously.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'NOTIFICATIONS_DELTA' }),
    );
  });

  it('mutes only the muted source: an unmuted row in the same delta still toasts', async () => {
    kvStore[KV_OS_PER_SOURCE] = JSON.stringify(['pty']);
    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await emitDelta({
      added: [
        makeNotification({ severity: 'error', kind: 'pty-exit', readAt: null }),
        makeNotification({ severity: 'warn', kind: 'swarm-broadcast', readAt: null }),
      ],
    });

    // pty muted → its row is dropped; swarm row drives the tone (max sev = warn)
    // and a single warning toast.
    expect(playNotificationToneMock).toHaveBeenCalledWith('warn');
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});

// ---- Task 8: agent:attention subscriber + throttled sound --------------------

describe('useLiveEvents — agent:attention subscriber', () => {
  it('agent:attention dispatches SET_ATTENTION and plays the throttled cue', async () => {
    // Use a far-future ts so the module-scope throttle (lastAttentionSoundAt) is
    // effectively reset relative to this test's timestamps.
    const baseTs = Date.now() + 10_000_000;

    await renderLiveEvents(stateWith([]));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      sigma.emit('agent:attention', { sessionId: 's1', reason: 'bell', ts: baseTs });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's1', ts: baseTs });
    expect(playCueMock).toHaveBeenCalledWith('agent-attention');

    // A second event within the 2s throttle window does NOT replay the sound.
    playCueMock.mockClear();
    await act(async () => {
      sigma.emit('agent:attention', { sessionId: 's2', reason: 'idle', ts: baseTs + 500 });
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's2', ts: baseTs + 500 });
    expect(playCueMock).not.toHaveBeenCalled();
  });

  // 2026-07-02 review fix D — the operator is LOOKING at this pane (focused
  // window + the event's session IS the active session): glow + ding are pure
  // noise (a typing pause echo re-arms the idle timer). Skip both.
  it('suppresses SET_ATTENTION + cue when the window is focused and the session is active', async () => {
    const baseTs = Date.now() + 20_000_000;
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      await renderLiveEvents({ ...stateWith([session('s1')]), activeSessionId: 's1' });
      await act(async () => { await Promise.resolve(); });

      await act(async () => {
        sigma.emit('agent:attention', { sessionId: 's1', reason: 'idle', ts: baseTs });
        await Promise.resolve();
      });

      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SET_ATTENTION' }),
      );
      expect(playCueMock).not.toHaveBeenCalled();
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('still fires for the active session when the window is NOT focused', async () => {
    const baseTs = Date.now() + 30_000_000;
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      await renderLiveEvents({ ...stateWith([session('s1')]), activeSessionId: 's1' });
      await act(async () => { await Promise.resolve(); });

      await act(async () => {
        sigma.emit('agent:attention', { sessionId: 's1', reason: 'idle', ts: baseTs });
        await Promise.resolve();
      });

      expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's1', ts: baseTs });
      expect(playCueMock).toHaveBeenCalledWith('agent-attention');
    } finally {
      hasFocus.mockRestore();
    }
  });

  it('still fires when the window is focused but a DIFFERENT session is active', async () => {
    const baseTs = Date.now() + 40_000_000;
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      await renderLiveEvents({ ...stateWith([session('s1'), session('s2')]), activeSessionId: 's2' });
      await act(async () => { await Promise.resolve(); });

      await act(async () => {
        sigma.emit('agent:attention', { sessionId: 's1', reason: 'bell', ts: baseTs });
        await Promise.resolve();
      });

      expect(dispatch).toHaveBeenCalledWith({ type: 'SET_ATTENTION', sessionId: 's1', ts: baseTs });
      expect(playCueMock).toHaveBeenCalledWith('agent-attention');
    } finally {
      hasFocus.mockRestore();
    }
  });
});

// ---- Phase-2 control — multi-window scope guard ----------------------------
// broadcast() falls back to sendToAll for DOCKED workspaces (no WindowRegistry
// owner). The non-idempotent subscribers (split_pane, send_message_to_agent)
// must run their rpc ONLY in the window whose state holds the target, or a 2nd
// (detached) window double-executes (double split / duplicate DM).

// Robustness refactor (2026-06-18): split_pane now runs rpc.swarms.splitPane in
// the TOOL (main) and emits the new session; the subscriber ONLY dispatches the
// grid update (no second rpc → no double-create), and the tool surfaces failures
// as ok:false instead of a silent ok:true.
describe('useLiveEvents — split_pane subscriber dispatches from the tool result', () => {
  it('dispatches SPLIT_PANE from the emitted newSession (no second rpc)', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    const newSession = session('s2');
    await act(async () => {
      sigma.emit('assistant:split-pane', { parentId: 's1', sessionId: 's1', newSession, groupId: 'g1', direction: 'horizontal' });
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SPLIT_PANE', parentId: 's1', groupId: 'g1', direction: 'horizontal' }),
    );
    // The subscriber must NOT re-call rpc.swarms.splitPane (the tool already did).
    expect(splitPaneMock).not.toHaveBeenCalled();
  });

  it('dispatches ADD_SESSIONS when the new session has no split group', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    const newSession = session('s2');
    await act(async () => {
      sigma.emit('assistant:split-pane', { parentId: 's1', sessionId: 's1', newSession, groupId: null, direction: 'horizontal' });
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_SESSIONS' }));
  });
});

// launch_pane / create_swarm / add_agent emit `assistant:dispatch-echo`. Its
// hydration (refetch panes → ADD_SESSIONS) must live in this GLOBAL hook so a
// pane spawned by an external client (Hermes) or Telegram surfaces in the grid
// regardless of which room is active — previously the only subscriber was inside
// JorvisRoom, so an external launch never reflected unless the operator happened
// to be in the Jorvis room.
describe('useLiveEvents — assistant:dispatch-echo hydrates the grid in ANY room', () => {
  it('refetches panes and dispatches ADD_SESSIONS on dispatch-echo ok:true', async () => {
    panesListSilentMock.mockResolvedValueOnce([session('s2')]);
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:dispatch-echo', {
        workspaceId: 'a', sessionId: 's2', providerId: 'claude', ok: true, error: null, conversationId: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(panesListSilentMock).toHaveBeenCalledWith('a');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_SESSIONS' }));
  });

  it('does not refetch or ADD_SESSIONS on dispatch-echo ok:false', async () => {
    await renderLiveEvents(stateWith([session('s1')]));
    await act(async () => { await Promise.resolve(); });
    dispatch.mockClear();

    await act(async () => {
      sigma.emit('assistant:dispatch-echo', {
        workspaceId: 'a', sessionId: 's2', providerId: 'claude', ok: false, error: 'boom', conversationId: null,
      });
      await Promise.resolve();
    });

    expect(panesListSilentMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_SESSIONS' }));
  });
});
