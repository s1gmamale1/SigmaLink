// P3 T2 — board-format.ts unit tests (pure, no DB). Covers formatBoardSummary
// (/status) and formatTasks (/tasks), including the active-only filter, the
// unknown/absent-id grouping fallback, and the 3500-char hard truncation.

import { describe, it, expect } from 'vitest';
import { formatBoardSummary, formatTasks, type MissionBoardRow } from './board-format';
import type { Mission, MissionTask, MissionStatus, MissionTaskStatus } from '../../../shared/types';

// ── fixtures ─────────────────────────────────────────────────────────────────

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
    createdAt: 1000,
    updatedAt: 1000,
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
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function row(missionOver: Partial<Mission> = {}, tasks: MissionTask[] = []): MissionBoardRow {
  return { mission: mkMission(missionOver), tasks };
}

// ── formatBoardSummary (/status) ────────────────────────────────────────────

describe('formatBoardSummary', () => {
  it('returns "no active missions" for an empty board', () => {
    expect(formatBoardSummary([])).toBe('no active missions');
  });

  it('excludes non-active missions (done/draft/paused/failed/cancelled)', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm-done', status: 'done', title: 'Done one' }),
      row({ id: 'm-draft', status: 'draft', title: 'Draft one' }),
    ];
    expect(formatBoardSummary(board)).toBe('no active missions');
  });

  it('one line per active mission: title + id + task-status counts', () => {
    const board: MissionBoardRow[] = [
      row(
        { id: 'm1', title: 'Ship the widget', status: 'active' },
        [
          mkTask({ id: 't1', status: 'working' }),
          mkTask({ id: 't2', status: 'done' }),
          mkTask({ id: 't3', status: 'blocked' }),
        ],
      ),
    ];
    const out = formatBoardSummary(board);
    expect(out).toContain('Ship the widget (m1)');
    expect(out).toContain('working:1');
    expect(out).toContain('done:1');
    expect(out).toContain('blocked:1');
  });

  it('counts follow a stable column order regardless of task insertion order', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1' }, [mkTask({ status: 'blocked' }), mkTask({ status: 'backlog' })]),
    ];
    const out = formatBoardSummary(board);
    // backlog listed before blocked per STATUS_ORDER.
    expect(out.indexOf('backlog:1')).toBeLessThan(out.indexOf('blocked:1'));
  });

  it('shows "no tasks yet" for an active mission with zero tasks', () => {
    const board: MissionBoardRow[] = [row({ id: 'm1' }, [])];
    expect(formatBoardSummary(board)).toContain('no tasks yet');
  });

  it('multiple active missions each get their own line', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1', title: 'Alpha' }, [mkTask({ status: 'working' })]),
      row({ id: 'm2', title: 'Beta' }, [mkTask({ status: 'done' })]),
    ];
    const out = formatBoardSummary(board);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alpha');
    expect(lines[1]).toContain('Beta');
  });

  it('hard-truncates to <=3500 chars with a trailing ellipsis on a huge board', () => {
    const board: MissionBoardRow[] = Array.from({ length: 200 }, (_, i) =>
      row(
        { id: `m${i}`, title: `Mission number ${i} with a fairly long descriptive title` },
        [mkTask({ status: 'working' }), mkTask({ status: 'done' })],
      ),
    );
    const out = formatBoardSummary(board);
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ── formatTasks (/tasks) ─────────────────────────────────────────────────────

describe('formatTasks', () => {
  it('returns "no active missions" for an empty board and no id', () => {
    expect(formatTasks([])).toBe('no active missions');
  });

  it('a known missionId shows just that mission\'s tasks (even if not active)', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1', title: 'Alpha', status: 'done' }, [
        mkTask({ title: 'Task A', status: 'done', attempt: 2 }),
      ]),
      row({ id: 'm2', title: 'Beta', status: 'active' }, [mkTask({ title: 'Task B' })]),
    ];
    const out = formatTasks(board, 'm1');
    expect(out).toContain('Alpha (m1)');
    expect(out).toContain('Task A · done · attempt 2');
    expect(out).not.toContain('Task B');
  });

  it('an unknown missionId falls back to grouping all ACTIVE missions', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1', title: 'Alpha', status: 'active' }, [mkTask({ title: 'Task A' })]),
      row({ id: 'm2', title: 'Beta', status: 'done' }, [mkTask({ title: 'Task B' })]),
    ];
    const out = formatTasks(board, 'does-not-exist');
    expect(out).toContain('Alpha (m1)');
    expect(out).toContain('Task A');
    expect(out).not.toContain('Beta');
    expect(out).not.toContain('Task B');
  });

  it('an absent missionId groups all ACTIVE missions', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1', title: 'Alpha', status: 'active' }, [mkTask({ title: 'Task A' })]),
      row({ id: 'm2', title: 'Beta', status: 'active' }, [mkTask({ title: 'Task B' })]),
    ];
    const out = formatTasks(board);
    expect(out).toContain('Alpha (m1)');
    expect(out).toContain('Task A');
    expect(out).toContain('Beta (m2)');
    expect(out).toContain('Task B');
  });

  it('shows "(no tasks yet)" for a matched mission with zero tasks', () => {
    const board: MissionBoardRow[] = [row({ id: 'm1', title: 'Alpha' }, [])];
    expect(formatTasks(board, 'm1')).toContain('(no tasks yet)');
  });

  it('per-task line format is "<title> · <status> · attempt <n>"', () => {
    const board: MissionBoardRow[] = [
      row({ id: 'm1' }, [mkTask({ title: 'Write the spec', status: 'reviewing', attempt: 3 })]),
    ];
    const out = formatTasks(board, 'm1');
    expect(out).toContain('Write the spec · reviewing · attempt 3');
  });

  it('hard-truncates to <=3500 chars with a trailing ellipsis on a huge grouped board', () => {
    const board: MissionBoardRow[] = Array.from({ length: 100 }, (_, i) =>
      row(
        { id: `m${i}`, title: `Mission ${i}`, status: 'active' as MissionStatus },
        Array.from({ length: 20 }, (_, j) =>
          mkTask({
            id: `t${i}-${j}`,
            title: `Task ${j} for mission ${i} with a longer descriptive title`,
            status: 'working' as MissionTaskStatus,
            attempt: 1,
          }),
        ),
      ),
    );
    const out = formatTasks(board);
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out.endsWith('…')).toBe(true);
  });
});
