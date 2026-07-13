// Pre-v3 fix — reconciler tests. The scheduler DISCARDS a gate-dropped wake
// (quiet hours / budget / freeze) and the watcher is purely event-driven, so
// an in-flight task whose terminal pane event landed while a gate was closed
// — or while the app was not running at all — strands forever. The
// reconciler's sweep() is the catch-up path: re-enqueue what the live event
// flow lost. MockDb pattern (createDbFake + vi.mock('../db/client')) mirrors
// watch.test.ts — reconcile.ts imports the missions DAO directly (repo
// convention), so mocking '../db/client' underneath it is enough.

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as dao from '../missions/dao';
import { createMissionReconciler, type MissionReconcilerDeps } from './reconcile';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

const NOW = new Date('2026-07-12T10:00:00Z').getTime();

function baseDeps(overrides: Partial<MissionReconcilerDeps> = {}): MissionReconcilerDeps {
  return {
    enqueue: vi.fn(),
    isEnabled: () => true,
    isPaneLive: () => true,
    now: () => NOW,
    ...overrides,
  };
}

function activeMission() {
  const mission = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
  dao.setMissionStatus(mission.id, 'active');
  return mission;
}

describe('createMissionReconciler', () => {
  it('does nothing when autonomy is disabled', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    const deps = baseDeps({ isEnabled: () => false });
    createMissionReconciler(deps).sweep('boot');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(dao.getTask(task.id)?.status).toBe('dispatched');
  });

  it('re-enqueues decompose for an active mission with zero tasks (dropped decompose wake)', () => {
    const mission = activeMission();
    const deps = baseDeps();
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith('decompose', mission.id);
  });

  it('re-enqueues decompose for an active mission whose tasks are ALL still backlog (decompose turn died before dispatch)', () => {
    const mission = activeMission();
    dao.addTask({ missionId: mission.id, title: 'a' });
    dao.addTask({ missionId: mission.id, title: 'b' });
    const deps = baseDeps();
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith('decompose', mission.id);
  });

  it('ignores draft missions entirely (autonomy only owns active missions)', () => {
    dao.createMission({ title: 't', goal: 'g', origin: 'local' }); // stays draft
    const deps = baseDeps();
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues review for a task stuck in reviewing (dropped review wake) — no state change', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    dao.moveTask(task.id, 'working');
    dao.moveTask(task.id, 'reviewing');
    const deps = baseDeps();
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
  });

  it('periodic: leaves a working task with a LIVE pane alone', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    dao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
    dao.moveTask(task.id, 'working');
    const deps = baseDeps({ isPaneLive: () => true });
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(dao.getTask(task.id)?.status).toBe('working');
  });

  it('periodic: a working task whose pane is DEAD moves to reviewing, appends task_reconciled, enqueues review', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    dao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
    dao.moveTask(task.id, 'working');
    const deps = baseDeps({ isPaneLive: () => false });
    createMissionReconciler(deps).sweep('periodic');
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
    const kinds = dao.listEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain('task_reconciled');
  });

  it('periodic: a dispatched task whose pane is DEAD chains dispatched→working→reviewing', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    dao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
    const deps = baseDeps({ isPaneLive: () => false });
    createMissionReconciler(deps).sweep('periodic');
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(deps.enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
  });

  it('periodic: an UNLINKED dispatched task inside the grace window is left alone (mid-dispatch race)', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched'); // updatedAt = real Date.now() ≈ test time
    const deps = baseDeps({ now: () => Date.now() });
    createMissionReconciler(deps).sweep('periodic');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(dao.getTask(task.id)?.status).toBe('dispatched');
  });

  it('periodic: an UNLINKED dispatched task past the grace window is reconciled', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    const deps = baseDeps({ now: () => Date.now() + 11 * 60_000 });
    createMissionReconciler(deps).sweep('periodic');
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(deps.enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
  });

  it('boot: a working task is reconciled even when its pane session reads LIVE (a resumed shell cannot still be running the dispatched CLI)', () => {
    const mission = activeMission();
    const task = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(task.id, 'dispatched');
    dao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
    dao.moveTask(task.id, 'working');
    const deps = baseDeps({ isPaneLive: () => true });
    createMissionReconciler(deps).sweep('boot');
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(deps.enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
  });

  it('leaves done/blocked/needs_input tasks alone (terminal or waiting-on-human)', () => {
    const mission = activeMission();
    const done = dao.addTask({ missionId: mission.id, title: 'a' });
    dao.moveTask(done.id, 'dispatched');
    dao.moveTask(done.id, 'working');
    dao.moveTask(done.id, 'done');
    const blocked = dao.addTask({ missionId: mission.id, title: 'b' });
    dao.moveTask(blocked.id, 'dispatched');
    dao.moveTask(blocked.id, 'blocked');
    const needsInput = dao.addTask({ missionId: mission.id, title: 'c' });
    dao.moveTask(needsInput.id, 'dispatched');
    dao.moveTask(needsInput.id, 'needs_input');
    const deps = baseDeps({ isPaneLive: () => false });
    createMissionReconciler(deps).sweep('boot');
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(dao.getTask(done.id)?.status).toBe('done');
    expect(dao.getTask(blocked.id)?.status).toBe('blocked');
    expect(dao.getTask(needsInput.id)?.status).toBe('needs_input');
  });

  it('a throwing dep on one mission never stops the sweep of the next mission', () => {
    const m1 = activeMission();
    const t1 = dao.addTask({ missionId: m1.id, title: 'a' });
    dao.moveTask(t1.id, 'dispatched');
    dao.linkTaskToPane(t1.id, 'sess-1', '/wt/a');
    const m2 = activeMission();
    const t2 = dao.addTask({ missionId: m2.id, title: 'b' });
    dao.moveTask(t2.id, 'dispatched');
    dao.moveTask(t2.id, 'working');
    dao.moveTask(t2.id, 'reviewing');
    const deps = baseDeps({
      isPaneLive: () => {
        throw new Error('ps exploded');
      },
    });
    createMissionReconciler(deps).sweep('periodic');
    // m1's liveness probe threw — swallowed; m2's reviewing task still re-enqueued.
    expect(deps.enqueue).toHaveBeenCalledWith('review', m2.id, t2.id);
  });

  it('sweep never throws even if the DAO itself explodes', () => {
    const deps = baseDeps();
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error('db closed');
    });
    expect(() => createMissionReconciler(deps).sweep('periodic')).not.toThrow();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
