// P3 T6 — buildDailyBrief unit tests. All reads injected via BriefDeps — no
// DB, no `new Database()`. Mirrors the fixture/assertion style of
// ../remote/board-format.test.ts (mkMission/mkTask) and
// ../notifications/digest-builder.test.ts (seeded-deps content assertions +
// an injected clock for determinism).

import { describe, expect, it, vi } from 'vitest';
import { buildDailyBrief, MAX_BRIEF_CHARS, type BriefDeps } from './brief';
import type {
  Mission,
  MissionEvent,
  MissionTask,
  JorvisAmendment,
} from '../../../shared/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

function mkMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Ship the widget',
    goal: 'ship the widget end to end',
    origin: 'telegram',
    clientLabel: null,
    workspaceId: 'ws1',
    status: 'active',
    report: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...over,
  };
}

function mkTask(over: Partial<MissionTask> = {}): MissionTask {
  return {
    id: 't1',
    missionId: 'm1',
    title: 'Write the spec',
    spec: 'spec body',
    status: 'working',
    assigneeSessionId: null,
    worktreePath: null,
    attempt: 1,
    orderIdx: 0,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...over,
  };
}

function mkEvent(over: Partial<MissionEvent> = {}): MissionEvent {
  return {
    id: 'e1',
    missionId: 'm1',
    taskId: null,
    kind: 'task_moved',
    body: JSON.stringify({ from: 'working', to: 'done' }),
    ts: NOW,
    ...over,
  };
}

function mkAmendment(over: Partial<JorvisAmendment> = {}): JorvisAmendment {
  return {
    id: 'a1',
    text: 'Adopt the standard',
    rationale: null,
    status: 'proposed',
    decisionReason: null,
    proposedAt: NOW - 1000,
    decidedAt: null,
    ...over,
  };
}

interface DepsFixture {
  missions?: Mission[];
  tasksByMission?: Record<string, MissionTask[]>;
  eventsByMission?: Record<string, MissionEvent[]>;
  pendingAmendments?: JorvisAmendment[];
  wakesSpent?: number;
  dailyBudget?: number;
  now?: number;
}

function mkDeps(fx: DepsFixture = {}): BriefDeps {
  const missions = fx.missions ?? [];
  const tasksByMission = fx.tasksByMission ?? {};
  const eventsByMission = fx.eventsByMission ?? {};
  const pendingAmendments = fx.pendingAmendments ?? [];
  const wakesSpent = fx.wakesSpent ?? 0;
  const dailyBudget = fx.dailyBudget ?? 20;
  const now = fx.now ?? NOW;
  return {
    listActiveMissions: () => missions,
    listTasks: (missionId: string) => tasksByMission[missionId] ?? [],
    listRecentEvents: (missionId: string) => eventsByMission[missionId] ?? [],
    listPendingAmendments: () => pendingAmendments,
    wakesSpentToday: () => wakesSpent,
    dailyBudget: () => dailyBudget,
    now: () => now,
  };
}

// ── empty board ──────────────────────────────────────────────────────────────

describe('buildDailyBrief — empty board', () => {
  it('is exactly header + "no active missions" + the wakes line, even with pending amendments', () => {
    const deps = mkDeps({
      missions: [],
      pendingAmendments: [mkAmendment()],
      wakesSpent: 3,
      dailyBudget: 20,
    });
    const out = buildDailyBrief(deps);
    expect(out).toBe('📋 Jorvis daily brief\nno active missions\nwakes: 3/20');
  });
});

// ── per-mission lines ────────────────────────────────────────────────────────

describe('buildDailyBrief — mission lines', () => {
  it('renders the header', () => {
    const out = buildDailyBrief(mkDeps({ missions: [mkMission()] }));
    expect(out.startsWith('📋 Jorvis daily brief\n')).toBe(true);
  });

  it('one line per active mission: title + id + task-status counts', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1', title: 'Ship the widget' })],
      tasksByMission: {
        m1: [mkTask({ status: 'working' }), mkTask({ id: 't2', status: 'done' })],
      },
    });
    const out = buildDailyBrief(deps);
    expect(out).toContain('Ship the widget (m1)');
    expect(out).toContain('working:1');
    expect(out).toContain('done:1');
  });

  it('shows "no tasks yet" for an active mission with zero tasks', () => {
    const deps = mkDeps({ missions: [mkMission({ id: 'm1' })], tasksByMission: {} });
    expect(buildDailyBrief(deps)).toContain('no tasks yet');
  });

  it('multiple active missions each get their own line', () => {
    const deps = mkDeps({
      missions: [
        mkMission({ id: 'm1', title: 'Alpha' }),
        mkMission({ id: 'm2', title: 'Beta' }),
      ],
    });
    const out = buildDailyBrief(deps);
    expect(out).toContain('Alpha (m1)');
    expect(out).toContain('Beta (m2)');
  });
});

// ── last-24h activity ────────────────────────────────────────────────────────

describe('buildDailyBrief — last-24h activity', () => {
  it('counts task_moved events to done and to blocked across active missions', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' }), mkMission({ id: 'm2', title: 'Beta' })],
      eventsByMission: {
        m1: [
          mkEvent({ missionId: 'm1', body: JSON.stringify({ from: 'working', to: 'done' }) }),
          mkEvent({ missionId: 'm1', body: JSON.stringify({ from: 'working', to: 'blocked' }) }),
        ],
        m2: [
          mkEvent({ missionId: 'm2', body: JSON.stringify({ from: 'reviewing', to: 'done' }) }),
        ],
      },
    });
    const out = buildDailyBrief(deps);
    expect(out).toContain('last 24h: 2 done, 1 blocked');
  });

  it('ignores task_moved events whose `to` is neither done nor blocked', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' })],
      eventsByMission: {
        m1: [mkEvent({ body: JSON.stringify({ from: 'backlog', to: 'working' }) })],
      },
    });
    expect(buildDailyBrief(deps)).toContain('last 24h: 0 done, 0 blocked');
  });

  it('ignores non-task_moved event kinds even with a done/blocked-shaped body', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' })],
      eventsByMission: {
        m1: [mkEvent({ kind: 'status', body: JSON.stringify({ status: 'done' }) })],
      },
    });
    expect(buildDailyBrief(deps)).toContain('last 24h: 0 done, 0 blocked');
  });

  it('excludes an event at exactly now - 86_400_001 (just past the 24h window)', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' })],
      eventsByMission: { m1: [mkEvent({ ts: NOW - DAY_MS - 1 })] },
    });
    expect(buildDailyBrief(deps)).toContain('last 24h: 0 done, 0 blocked');
  });

  it('includes an event at exactly now - 86_400_000 (the 24h boundary, inclusive)', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' })],
      eventsByMission: { m1: [mkEvent({ ts: NOW - DAY_MS })] },
    });
    expect(buildDailyBrief(deps)).toContain('last 24h: 1 done, 0 blocked');
  });

  it('only queries events for active missions', () => {
    const listRecentEvents = vi.fn((missionId: string) =>
      missionId === 'm1' ? [mkEvent({ missionId: 'm1' })] : [],
    );
    const deps: BriefDeps = {
      ...mkDeps({ missions: [mkMission({ id: 'm1' })] }),
      listRecentEvents,
    };
    buildDailyBrief(deps);
    expect(listRecentEvents).toHaveBeenCalledTimes(1);
    expect(listRecentEvents).toHaveBeenCalledWith('m1', expect.any(Number));
  });
});

// ── wakes line ───────────────────────────────────────────────────────────────

describe('buildDailyBrief — wakes line', () => {
  it('renders "wakes: <spent>/<budget>"', () => {
    const deps = mkDeps({ missions: [mkMission()], wakesSpent: 7, dailyBudget: 20 });
    expect(buildDailyBrief(deps)).toContain('wakes: 7/20');
  });
});

// ── pending amendments ───────────────────────────────────────────────────────

describe('buildDailyBrief — pending amendments', () => {
  it('shows a count + /approve hint when there are pending amendments', () => {
    const deps = mkDeps({
      missions: [mkMission()],
      pendingAmendments: [mkAmendment({ id: 'a1' }), mkAmendment({ id: 'a2' })],
    });
    const out = buildDailyBrief(deps);
    expect(out).toContain('pending amendments: 2');
    expect(out).toContain('/approve');
  });

  it('omits the pending-amendments line entirely when there are none', () => {
    const deps = mkDeps({ missions: [mkMission()], pendingAmendments: [] });
    expect(buildDailyBrief(deps)).not.toContain('pending amendments');
  });
});

// ── cap enforcement ──────────────────────────────────────────────────────────

describe('buildDailyBrief — cap enforcement', () => {
  it('never exceeds MAX_BRIEF_CHARS and does not append an ellipsis on a small board', () => {
    const out = buildDailyBrief(mkDeps({ missions: [mkMission()] }));
    expect(out.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(out.endsWith('…')).toBe(false);
  });

  it('hard-truncates to <=MAX_BRIEF_CHARS with a trailing ellipsis on a huge board', () => {
    const missions = Array.from({ length: 200 }, (_, i) =>
      mkMission({ id: `m${i}`, title: `Mission number ${i} with a fairly long descriptive title` }),
    );
    const out = buildDailyBrief(mkDeps({ missions }));
    expect(out.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('prefers a whole-line cut over a mid-line cut when truncating', () => {
    // Every mission line ends in "... — no tasks yet" (no tasks seeded). A
    // naive raw-character slice would almost certainly land mid-title given
    // the huge, variable-length board below; a whole-line-preferring cap
    // must land right after a complete "no tasks yet" line.
    const missions = Array.from({ length: 300 }, (_, i) =>
      mkMission({
        id: `m${i}`,
        title: `Mission-${i}-${'X'.repeat(70)}`,
      }),
    );
    const out = buildDailyBrief(mkDeps({ missions }));
    expect(out.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1).endsWith('no tasks yet')).toBe(true);
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe('buildDailyBrief — determinism', () => {
  it('produces byte-identical output for the same seeded deps + injected now', () => {
    const deps = mkDeps({
      missions: [mkMission({ id: 'm1' })],
      eventsByMission: { m1: [mkEvent()] },
      pendingAmendments: [mkAmendment()],
      wakesSpent: 5,
      dailyBudget: 20,
    });
    expect(buildDailyBrief(deps)).toBe(buildDailyBrief(deps));
  });
});
