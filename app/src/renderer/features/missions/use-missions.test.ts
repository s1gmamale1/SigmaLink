// @vitest-environment jsdom
//
// P1a Task 6 — Missions room hook. Mirrors use-jorvis-conversations.test.ts's
// hydrate-token discipline: missions can be picked fast (operator clicking
// through the rail while Jorvis is still building the board), so a slower
// `missions.get` resolution for an OLDER pick must never paint over a newer
// one. Also asserts the two P0 gotchas from the RPC layer (Task 5):
//   1. `rpc.missions.list({})` is called with an object arg — NEVER `list()`
//      bare (VALIDATION_MODE 'enforce' rejects `undefined`).
//   2. no `workspaceId` filter is ever sent — missions can be global
//      (workspace_id null) and P1a lists ALL of them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Mission, MissionEvent, MissionTask } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

type EventCb = (payload: unknown) => void;
const handlers = new Map<string, Set<EventCb>>();
function emitEvent(name: string, payload?: unknown): void {
  handlers.get(name)?.forEach((fn) => fn(payload));
}

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    missions: {
      list: (...args: unknown[]) => mocks.list(...args),
      get: (...args: unknown[]) => mocks.get(...args),
    },
  },
  onEvent: (name: string, cb: EventCb) => {
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  },
}));

import { useMissions } from './use-missions';

interface Deferred<T> {
  resolve: (value: T) => void;
  promise: Promise<T>;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** Macrotask flush — drains the effect's whole await chain. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mission(id: string, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    title: `Mission ${id}`,
    goal: 'do the thing',
    origin: 'local',
    clientLabel: null,
    workspaceId: null,
    status: 'active',
    report: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function board(id: string): { mission: Mission; tasks: MissionTask[]; events: MissionEvent[] } {
  return {
    mission: mission(id),
    tasks: [
      {
        id: `${id}-t1`,
        missionId: id,
        title: `Task for ${id}`,
        spec: '',
        status: 'backlog',
        assigneeSessionId: null,
        worktreePath: null,
        attempt: 0,
        orderIdx: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    events: [{ id: `${id}-e1`, missionId: id, taskId: null, kind: 'created', body: null, ts: 1 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.list.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ mission: null, tasks: [], events: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMissions', () => {
  it('fetches the mission list on mount via list({}) — never list() bare, no workspace filter', async () => {
    const rows = [mission('m1'), mission('m2', { workspaceId: 'ws-1' })];
    mocks.list.mockResolvedValue(rows);

    const { result } = renderHook(() => useMissions());
    await waitFor(() => expect(result.current.missions).toEqual(rows));

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({});
    // A null-workspace (global) mission must render fine in the list — no
    // crash, no silent drop.
    expect(result.current.missions.some((m) => m.workspaceId === null)).toBe(true);
  });

  it('a `missions:changed` event triggers a list refetch', async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([mission('m-new')]);

    const { result } = renderHook(() => useMissions());
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    act(() => {
      emitEvent('missions:changed');
    });
    await waitFor(() => expect(result.current.missions).toEqual([mission('m-new')]));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('picking a mission fetches its board (tasks + events) via get({missionId})', async () => {
    const b = board('m1');
    mocks.get.mockResolvedValue(b);

    const { result } = renderHook(() => useMissions());
    act(() => {
      result.current.onPickMission('m1');
    });
    await waitFor(() => expect(result.current.missionId).toBe('m1'));

    expect(mocks.get).toHaveBeenCalledWith({ missionId: 'm1' });
    expect(result.current.tasks).toEqual(b.tasks);
    expect(result.current.events).toEqual(b.events);
    expect(result.current.mission).toEqual(b.mission);
  });

  it('a `missions:changed` event refetches the currently-open mission board too', async () => {
    const first = board('m1');
    const second = { ...board('m1'), events: [...board('m1').events, { id: 'm1-e2', missionId: 'm1', taskId: null, kind: 'task_done', body: null, ts: 2 }] };
    mocks.get.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { result } = renderHook(() => useMissions());
    act(() => {
      result.current.onPickMission('m1');
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    act(() => {
      emitEvent('missions:changed');
    });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('hydrate-token guard — the LAST pick wins even when its RPC resolves first', async () => {
    const dA = deferred<ReturnType<typeof board>>();
    const dB = deferred<ReturnType<typeof board>>();
    mocks.get.mockImplementation((input: { missionId: string }) =>
      input.missionId === 'a' ? dA.promise : dB.promise,
    );

    const { result } = renderHook(() => useMissions());
    act(() => {
      result.current.onPickMission('a');
    });
    act(() => {
      result.current.onPickMission('b');
    });

    // B (the latest pick) resolves FIRST…
    dB.resolve(board('b'));
    await waitFor(() => expect(result.current.missionId).toBe('b'));

    // …then the STALE A resolves late. It must be discarded.
    dA.resolve(board('a'));
    await flush();

    expect(result.current.missionId).toBe('b');
    expect(result.current.tasks).toEqual(board('b').tasks);
  });

  it('clearMission resets the active board and guards a pending hydrate', async () => {
    const dA = deferred<ReturnType<typeof board>>();
    mocks.get.mockReturnValue(dA.promise);

    const { result } = renderHook(() => useMissions());
    act(() => {
      result.current.onPickMission('a');
    });
    act(() => {
      result.current.clearMission();
    });

    dA.resolve(board('a'));
    await flush();

    expect(result.current.missionId).toBeNull();
    expect(result.current.tasks).toEqual([]);
    expect(result.current.events).toEqual([]);
  });
});
