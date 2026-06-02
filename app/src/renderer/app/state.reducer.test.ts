// Coverage for the P5 reducer hot-path optimizations.
//
// PERF-4 — `sessionsByWorkspace` is rebuilt INCREMENTALLY on session mutations:
//   a mutation in workspace A must leave every untouched workspace's array
//   referentially identical (===) so identity-memoised consumers don't
//   re-render. The affected workspace's array is rebuilt and correct.
//
// PERF-10 — the delta reducers (NOTIFICATIONS_DELTA single-add fast path,
//   UPSERT_MEMORY, UPSERT_TASK) binary-insert into the already-sorted array
//   instead of `[...arr, x].sort()`. The observable ordering must be IDENTICAL
//   to the old full-sort for newest / middle / oldest insertions (and ties).
//
// Pure reducer — no React, no DOM, no DB. Safe under vitest.

import { describe, it, expect } from 'vitest';

import { appStateReducer } from './state.reducer';
import { initialAppState, type AppState } from './state.types';
import type { AgentSession, Memory, Notification, Task } from '../../shared/types';

// ─── factories ──────────────────────────────────────────────────────────────

function session(id: string, workspaceId: string, over: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    workspaceId,
    providerId: 'claude',
    cwd: '/tmp',
    branch: null,
    status: 'running',
    startedAt: 1,
    worktreePath: null,
    ...over,
  };
}

function notif(id: string, createdAt: number, over: Partial<Notification> = {}): Notification {
  return {
    id,
    workspaceId: 'w1',
    kind: 'pty:exit',
    severity: 'info',
    title: id,
    body: null,
    payload: null,
    sourceEvent: 'pty:exit',
    dedupKey: id,
    dupCount: 1,
    createdAt,
    readAt: null,
    ...over,
  };
}

function memory(id: string, workspaceId: string, updatedAt: number): Memory {
  return {
    id,
    workspaceId,
    name: id,
    body: '',
    tags: [],
    links: [],
    createdAt: 1,
    updatedAt,
  };
}

function task(id: string, workspaceId: string, updatedAt: number): Task {
  return {
    id,
    workspaceId,
    title: id,
    description: '',
    status: 'todo' as Task['status'],
    assignedSessionId: null,
    assignedSwarmId: null,
    assignedSwarmAgentId: null,
    labels: [],
    createdAt: 1,
    updatedAt,
    archivedAt: null,
  };
}

function withSessions(sessions: AgentSession[]): AppState {
  return appStateReducer(initialAppState, { type: 'ADD_SESSIONS', sessions });
}

// ─── PERF-4 — incremental sessionsByWorkspace ────────────────────────────────

describe('PERF-4 — incremental sessionsByWorkspace regroup', () => {
  it('a session UPDATE in workspace A keeps workspace B array referentially identical', () => {
    const before = withSessions([
      session('a1', 'A'),
      session('a2', 'A'),
      session('b1', 'B'),
    ]);
    const bArrayBefore = before.sessionsByWorkspace['B'];

    // MARK_SESSION_EXITED mutates only a1 (workspace A).
    const after = appStateReducer(before, { type: 'MARK_SESSION_EXITED', id: 'a1', exitCode: 0 });

    // Workspace B's array is untouched → same reference.
    expect(after.sessionsByWorkspace['B']).toBe(bArrayBefore);

    // Workspace A's array is NEW (it changed) and correct.
    expect(after.sessionsByWorkspace['A']).not.toBe(before.sessionsByWorkspace['A']);
    expect(after.sessionsByWorkspace['A']?.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(after.sessionsByWorkspace['A']?.find((s) => s.id === 'a1')?.status).toBe('exited');
    // a2 in workspace A is an untouched object → preserved by reference.
    expect(after.sessionsByWorkspace['A']?.find((s) => s.id === 'a2')).toBe(
      before.sessionsByWorkspace['A']?.find((s) => s.id === 'a2'),
    );
  });

  it('REMOVE_SESSION in A preserves B array identity', () => {
    const before = withSessions([session('a1', 'A'), session('a2', 'A'), session('b1', 'B')]);
    const bArrayBefore = before.sessionsByWorkspace['B'];

    const after = appStateReducer(before, { type: 'REMOVE_SESSION', id: 'a1' });

    expect(after.sessionsByWorkspace['B']).toBe(bArrayBefore);
    expect(after.sessionsByWorkspace['A']?.map((s) => s.id)).toEqual(['a2']);
  });

  it('removing the LAST session of a workspace drops its key and changes the map identity', () => {
    const before = withSessions([session('a1', 'A'), session('b1', 'B')]);
    const after = appStateReducer(before, { type: 'REMOVE_SESSION', id: 'b1' });

    expect(after.sessionsByWorkspace).not.toBe(before.sessionsByWorkspace);
    expect('B' in after.sessionsByWorkspace).toBe(false);
    // A is untouched → its array reference is preserved.
    expect(after.sessionsByWorkspace['A']).toBe(before.sessionsByWorkspace['A']);
  });

  it('MINIMISE_PANE on a B pane keeps A array identity', () => {
    const before = withSessions([session('a1', 'A'), session('b1', 'B'), session('b2', 'B')]);
    const aArrayBefore = before.sessionsByWorkspace['A'];

    const after = appStateReducer(before, { type: 'MINIMISE_PANE', paneId: 'b1', minimised: true });

    expect(after.sessionsByWorkspace['A']).toBe(aArrayBefore);
    expect(after.sessionsByWorkspace['B']).not.toBe(before.sessionsByWorkspace['B']);
    expect(after.sessionsByWorkspace['B']?.find((s) => s.id === 'b1')?.minimised).toBe(true);
    // b2 untouched → preserved by reference.
    expect(after.sessionsByWorkspace['B']?.find((s) => s.id === 'b2')).toBe(
      before.sessionsByWorkspace['B']?.find((s) => s.id === 'b2'),
    );
  });

  it('ADD_SESSIONS adding to A preserves B array identity', () => {
    const before = withSessions([session('a1', 'A'), session('b1', 'B')]);
    const bArrayBefore = before.sessionsByWorkspace['B'];

    const after = appStateReducer(before, { type: 'ADD_SESSIONS', sessions: [session('a2', 'A')] });

    expect(after.sessionsByWorkspace['B']).toBe(bArrayBefore);
    expect(after.sessionsByWorkspace['A']?.map((s) => s.id)).toEqual(['a1', 'a2']);
  });
});

// ─── PERF-10 — binary-insert order preservation ──────────────────────────────

/** Old behaviour oracle: prepend then full stable-sort descending. */
function oldUpsertSortDesc<T extends { id: string }>(
  list: T[],
  item: T,
  key: (t: T) => number,
): T[] {
  const filtered = list.filter((x) => x.id !== item.id);
  return [item, ...filtered].sort((a, b) => key(b) - key(a));
}

describe('PERF-10 — UPSERT_MEMORY binary insert preserves order', () => {
  const base = [memory('m3', 'w1', 30), memory('m2', 'w1', 20), memory('m1', 'w1', 10)];

  function run(insertUpdatedAt: number) {
    const start: AppState = { ...initialAppState, memories: { w1: base } };
    const inserted = memory('mx', 'w1', insertUpdatedAt);
    const after = appStateReducer(start, { type: 'UPSERT_MEMORY', workspaceId: 'w1', memory: inserted });
    const got = after.memories['w1']!;
    const oracle = oldUpsertSortDesc(base, inserted, (m) => m.updatedAt);
    return { got, oracle };
  }

  it('newest insertion lands at the head', () => {
    const { got, oracle } = run(40);
    expect(got.map((m) => m.id)).toEqual(['mx', 'm3', 'm2', 'm1']);
    expect(got.map((m) => m.id)).toEqual(oracle.map((m) => m.id));
  });

  it('middle insertion lands in the right slot', () => {
    const { got, oracle } = run(25);
    expect(got.map((m) => m.id)).toEqual(['m3', 'mx', 'm2', 'm1']);
    expect(got.map((m) => m.id)).toEqual(oracle.map((m) => m.id));
  });

  it('oldest insertion lands at the tail', () => {
    const { got, oracle } = run(5);
    expect(got.map((m) => m.id)).toEqual(['m3', 'm2', 'm1', 'mx']);
    expect(got.map((m) => m.id)).toEqual(oracle.map((m) => m.id));
  });

  it('tie with an existing key keeps the new item ahead (matches stable full-sort)', () => {
    const { got, oracle } = run(20); // ties with m2
    expect(got.map((m) => m.id)).toEqual(oracle.map((m) => m.id));
    // New item leads the equal-key existing one.
    expect(got.indexOf(got.find((m) => m.id === 'mx')!)).toBeLessThan(
      got.findIndex((m) => m.id === 'm2'),
    );
  });

  it('re-upserting an existing id moves it without duplicating', () => {
    const start: AppState = { ...initialAppState, memories: { w1: base } };
    const after = appStateReducer(start, {
      type: 'UPSERT_MEMORY',
      workspaceId: 'w1',
      memory: memory('m1', 'w1', 99),
    });
    const got = after.memories['w1']!;
    expect(got.map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
    expect(got).toHaveLength(3);
  });
});

describe('PERF-10 — UPSERT_TASK binary insert preserves order', () => {
  const base = [task('t3', 'w1', 30), task('t2', 'w1', 20), task('t1', 'w1', 10)];

  function run(insertUpdatedAt: number) {
    const start: AppState = { ...initialAppState, tasks: { w1: base } };
    const inserted = task('tx', 'w1', insertUpdatedAt);
    const after = appStateReducer(start, { type: 'UPSERT_TASK', task: inserted });
    const got = after.tasks['w1']!;
    const oracle = oldUpsertSortDesc(base, inserted, (t) => t.updatedAt);
    return { got, oracle };
  }

  it('newest / middle / oldest insertions all match the full-sort oracle', () => {
    for (const [at, expected] of [
      [40, ['tx', 't3', 't2', 't1']],
      [25, ['t3', 'tx', 't2', 't1']],
      [5, ['t3', 't2', 't1', 'tx']],
    ] as const) {
      const { got, oracle } = run(at);
      expect(got.map((t) => t.id)).toEqual(expected as unknown as string[]);
      expect(got.map((t) => t.id)).toEqual(oracle.map((t) => t.id));
    }
  });
});

describe('PERF-10 — NOTIFICATIONS_DELTA single-add fast path preserves order', () => {
  const base = [notif('n3', 30), notif('n2', 20), notif('n1', 10)];

  /** Old behaviour oracle for the delta: Map merge + full sort desc by createdAt. */
  function oldDelta(
    list: Notification[],
    added: Notification[],
    removed: string[],
  ): Notification[] {
    const byId = new Map(list.map((n) => [n.id, n]));
    for (const n of added) byId.set(n.id, n);
    for (const id of removed) byId.delete(id);
    return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  function run(createdAt: number) {
    const start: AppState = { ...initialAppState, notifications: base };
    const added = notif('nx', createdAt);
    const after = appStateReducer(start, {
      type: 'NOTIFICATIONS_DELTA',
      added: [added],
      removed: [],
      unreadCount: 4,
    });
    return { got: after.notifications, oracle: oldDelta(base, [added], []) };
  }

  it('newest insertion lands at the head and matches the oracle', () => {
    const { got, oracle } = run(40);
    expect(got.map((n) => n.id)).toEqual(['nx', 'n3', 'n2', 'n1']);
    expect(got.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
  });

  it('middle insertion matches the oracle', () => {
    const { got, oracle } = run(25);
    expect(got.map((n) => n.id)).toEqual(['n3', 'nx', 'n2', 'n1']);
    expect(got.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
  });

  it('oldest insertion lands at the tail and matches the oracle', () => {
    const { got, oracle } = run(5);
    expect(got.map((n) => n.id)).toEqual(['n3', 'n2', 'n1', 'nx']);
    expect(got.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
  });

  it('tie createdAt: new item lands BEHIND equal-key existing (matches Map+sort oracle)', () => {
    const { got, oracle } = run(20); // ties with n2
    expect(got.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
    // The (appended-then-stable-sorted) new item sits behind the equal-key n2.
    expect(got.findIndex((n) => n.id === 'n2')).toBeLessThan(
      got.findIndex((n) => n.id === 'nx'),
    );
  });

  it('unread count is taken from the delta authoritatively', () => {
    const { got } = run(40);
    expect(got).toHaveLength(4);
  });

  it('updates unreadCount from the delta', () => {
    const start: AppState = { ...initialAppState, notifications: base };
    const after = appStateReducer(start, {
      type: 'NOTIFICATIONS_DELTA',
      added: [notif('nx', 40)],
      removed: [],
      unreadCount: 7,
    });
    expect(after.notificationsUnreadCount).toBe(7);
  });

  it('re-inserting an existing id (dedup-absorb) via the single-add path matches the oracle', () => {
    const start: AppState = { ...initialAppState, notifications: base };
    // n2 absorbs a dup → same id, bumped createdAt to the newest.
    const absorbed = notif('n2', 50, { dupCount: 2 });
    const after = appStateReducer(start, {
      type: 'NOTIFICATIONS_DELTA',
      added: [absorbed],
      removed: [],
      unreadCount: 3,
    });
    const oracle = oldDelta(base, [absorbed], []);
    expect(after.notifications.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
    expect(after.notifications.map((n) => n.id)).toEqual(['n2', 'n3', 'n1']);
    expect(after.notifications.find((n) => n.id === 'n2')?.dupCount).toBe(2);
  });

  it('batched delta (multiple adds + a removal) falls back to the full sort and matches the oracle', () => {
    const start: AppState = { ...initialAppState, notifications: base };
    const added = [notif('nx', 25), notif('ny', 35)];
    const removed = ['n1'];
    const after = appStateReducer(start, {
      type: 'NOTIFICATIONS_DELTA',
      added,
      removed,
      unreadCount: 4,
    });
    const oracle = oldDelta(base, added, removed);
    expect(after.notifications.map((n) => n.id)).toEqual(oracle.map((n) => n.id));
    expect(after.notifications.map((n) => n.id)).toEqual(['ny', 'n3', 'nx', 'n2']);
  });
});
