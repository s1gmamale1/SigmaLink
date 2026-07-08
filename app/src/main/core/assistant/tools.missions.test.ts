// P1a Task 4 — mission board tools (create_mission / add_mission_task /
// mission_board / move_mission_task / complete_mission). Same harness as
// tools.test.ts / tools.arg-coercion.test.ts (vi.mock('../db/client') +
// createDbFake), driven through `findTool(id)!.handler(args, ctx)` so these
// exercise the SAME parse/handler path the assistant CLI uses.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import { findTool } from './tools';
import type { ToolContext } from './tools';
import * as missionsDao from '../missions/dao';

function makeCtx(extra?: Partial<ToolContext>): ToolContext {
  return {
    pty: { list: () => [] },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/sigmalink-test',
    ...extra,
  } as unknown as ToolContext;
}

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('mission board tools', () => {
  it('create_mission persists a draft mission and returns its id', async () => {
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    const out = (await findTool('create_mission')!.handler(
      { title: 'Ship X', goal: 'ship the X feature' },
      ctx,
    )) as { missionId: string; status: string };
    expect(out.status).toBe('draft');
    expect(missionsDao.getMission(out.missionId)?.title).toBe('Ship X');
    expect(missionsDao.getMission(out.missionId)?.origin).toBe('local');
    expect(emit).toHaveBeenCalledWith('missions:changed', {});
  });

  it('add_mission_task appends a task in the backlog column', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    const out = (await findTool('add_mission_task')!.handler(
      { missionId: mission.id, title: 'do the thing' },
      ctx,
    )) as { taskId: string; orderIdx: number };
    expect(out.orderIdx).toBe(0);
    expect(missionsDao.getTask(out.taskId)?.status).toBe('backlog');
    expect(emit).toHaveBeenCalledWith('missions:changed', {});
  });

  it('mission_board with no id lists every mission', async () => {
    missionsDao.createMission({ title: 'a', goal: 'g', origin: 'local' });
    missionsDao.createMission({ title: 'b', goal: 'g', origin: 'local' });
    const out = (await findTool('mission_board')!.handler({}, makeCtx())) as {
      missions: unknown[];
    };
    expect(out.missions).toHaveLength(2);
  });

  it('mission_board with an id returns {mission, tasks, events}', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    missionsDao.addTask({ missionId: mission.id, title: 'a task' });
    const out = (await findTool('mission_board')!.handler(
      { missionId: mission.id },
      makeCtx(),
    )) as { mission: { id: string }; tasks: unknown[]; events: unknown[] };
    expect(out.mission.id).toBe(mission.id);
    expect(out.tasks).toHaveLength(1);
    expect(out.events.length).toBeGreaterThan(0);
  });

  it('move_mission_task legal path returns the new status', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a' });
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    const out = (await findTool('move_mission_task')!.handler(
      { taskId: task.id, status: 'dispatched' },
      ctx,
    )) as { taskId: string; status: string };
    expect(out.status).toBe('dispatched');
    expect(missionsDao.getTask(task.id)?.status).toBe('dispatched');
    expect(emit).toHaveBeenCalledWith('missions:changed', {});
  });

  it('move_mission_task illegal path surfaces a tool failure the same way prompt_agent does (throws)', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a' });
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    await expect(
      findTool('move_mission_task')!.handler({ taskId: task.id, status: 'done' }, ctx),
    ).rejects.toThrow(/illegal transition/);
    // rejected transition must not have mutated the task, and must not emit
    expect(missionsDao.getTask(task.id)?.status).toBe('backlog');
    expect(emit).not.toHaveBeenCalled();
  });

  it('complete_mission sets status done and stores the report', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    const out = (await findTool('complete_mission')!.handler(
      { missionId: mission.id, report: 'final report body' },
      ctx,
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    const reread = missionsDao.getMission(mission.id);
    expect(reread?.status).toBe('done');
    expect(reread?.report).toBe('final report body');
    expect(emit).toHaveBeenCalledWith('missions:changed', {});
  });

  // Task 3 review fold-in — exercise the rollup end-to-end THROUGH the tools:
  // a 2-task mission where one task is done and one isn't must stay active
  // (rollup only promotes to done when EVERY task is done).
  it('a mission with one done task and one pending task stays active (rollup, driven through the tools)', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
    // No tool sets a mission active in P1a (that's a supervisor/P1b concern) —
    // seed that one bit of setup directly via the DAO, then drive every task
    // move through the move_mission_task tool.
    missionsDao.setMissionStatus(mission.id, 'active');
    const ctx = makeCtx();
    const doneTask = missionsDao.addTask({ missionId: mission.id, title: 'a' });
    missionsDao.addTask({ missionId: mission.id, title: 'b' }); // stays in backlog

    await findTool('move_mission_task')!.handler({ taskId: doneTask.id, status: 'dispatched' }, ctx);
    await findTool('move_mission_task')!.handler({ taskId: doneTask.id, status: 'working' }, ctx);
    await findTool('move_mission_task')!.handler({ taskId: doneTask.id, status: 'done' }, ctx);

    expect(missionsDao.getMission(mission.id)?.status).toBe('active');
  });
});
