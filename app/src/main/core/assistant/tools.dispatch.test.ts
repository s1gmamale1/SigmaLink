// P1b Task 1 — dispatch_task tool: launches ONE worktree-isolated pane for a
// mission task via executeLaunchPlan (mocked here — real launch is exercised
// by launcher.test.ts), then links task↔pane, moves backlog→dispatched, and
// bumps attempt. Same harness as tools.missions.test.ts / tools.create-swarm-
// echo.test.ts (vi.mock('../db/client') + createDbFake, findTool(id)!.handler).

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
const executeLaunchPlanMock = vi.fn();
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: (...args: unknown[]) => executeLaunchPlanMock(...args),
}));

import { getDb } from '../db/client';
import { createDbFake, seedWorkspace, type DbFake } from '@/test-utils/db-fake';
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
  seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  executeLaunchPlanMock.mockReset();
  executeLaunchPlanMock.mockResolvedValue({
    sessions: [
      {
        id: 'sess-dispatch-1',
        providerId: 'claude',
        status: 'running',
        error: undefined,
        worktreePath: '/wt/dispatch-1',
      },
    ],
  });
});

describe('dispatch_task tool', () => {
  it('launches a pane, links the task, moves it to dispatched, increments attempt, returns the sessionId', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local', workspaceId: 'ws-1' });
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a', spec: 'do the thing' });
    const emit = vi.fn();
    const ctx = makeCtx({ emit });

    const out = (await findTool('dispatch_task')!.handler({ taskId: task.id }, ctx)) as {
      sessionId: string;
      taskId: string;
      status: string;
    };

    expect(out.sessionId).toBe('sess-dispatch-1');
    expect(out.taskId).toBe(task.id);
    expect(out.status).toBe('dispatched');

    const reread = missionsDao.getTask(task.id);
    expect(reread?.status).toBe('dispatched');
    expect(reread?.assigneeSessionId).toBe('sess-dispatch-1');
    expect(reread?.worktreePath).toBe('/wt/dispatch-1');
    expect(reread?.attempt).toBe(1);
    expect(emit).toHaveBeenCalledWith('missions:changed', {});

    // executeLaunchPlan received the task's spec as the initialPrompt.
    expect(executeLaunchPlanMock).toHaveBeenCalledTimes(1);
    const plan = executeLaunchPlanMock.mock.calls[0][0] as { panes: Array<{ initialPrompt?: string }> };
    expect(plan.panes[0].initialPrompt).toBe('do the thing');
  });

  it('defaults the provider to claude when none is given', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local', workspaceId: 'ws-1' });
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a', spec: 'spec' });
    await findTool('dispatch_task')!.handler({ taskId: task.id }, makeCtx());
    const plan = executeLaunchPlanMock.mock.calls[0][0] as { panes: Array<{ providerId: string }> };
    expect(plan.panes[0].providerId).toBe('claude');
  });

  it('throws when the task does not exist', async () => {
    await expect(
      findTool('dispatch_task')!.handler({ taskId: 'nope' }, makeCtx()),
    ).rejects.toThrow(/mission task not found/);
    expect(executeLaunchPlanMock).not.toHaveBeenCalled();
  });

  // Review fix (P1b T1) — a task already in-flight ('working') must never be
  // re-dispatched: no pane spawn, no clobbered assignee/worktree. Before the
  // fix this sequence spawned a REAL pane, overwrote assigneeSessionId (
  // orphaning whoever was actually working the task), and only THEN threw.
  it('refuses to dispatch a task already in "working" status — no pane spawn, no clobbered assignee', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local', workspaceId: 'ws-1' });
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a', spec: 'spec' });
    missionsDao.moveTask(task.id, 'dispatched');
    missionsDao.linkTaskToPane(task.id, 'sess-original', '/wt/original');
    missionsDao.moveTask(task.id, 'working');

    await expect(
      findTool('dispatch_task')!.handler({ taskId: task.id }, makeCtx()),
    ).rejects.toThrow(/cannot dispatch task in status 'working'/);

    expect(executeLaunchPlanMock).not.toHaveBeenCalled();
    const reread = missionsDao.getTask(task.id);
    expect(reread?.status).toBe('working');
    expect(reread?.assigneeSessionId).toBe('sess-original');
    expect(reread?.worktreePath).toBe('/wt/original');
  });

  // Minor (review) — the workspace-resolution failure path also short-circuits
  // before any launch: no mission workspace, no default workspace, no explicit
  // workspaceRoot arg.
  it('throws before launch when no workspace can be resolved', async () => {
    const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' }); // no workspaceId
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a', spec: 'spec' });

    await expect(
      findTool('dispatch_task')!.handler({ taskId: task.id }, makeCtx({ defaultWorkspaceId: null })),
    ).rejects.toThrow(/cannot resolve a workspace/);

    expect(executeLaunchPlanMock).not.toHaveBeenCalled();
  });
});
