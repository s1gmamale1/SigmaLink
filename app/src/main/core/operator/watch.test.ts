// P1b Task 2 — watcher tests. MockDb pattern (createDbFake + vi.mock('../db/client'))
// mirrors dao.test.ts / dao.dispatch.test.ts. watch.ts imports the missions
// DAO module directly (repo convention: dao is imported, not DI'd) so mocking
// '../db/client' underneath it is enough — no need to mock dao itself.

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
import { createMissionWatcher } from './watch';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

function setupMission() {
  const mission = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
  const task = dao.addTask({ missionId: mission.id, title: 'a' });
  dao.moveTask(task.id, 'dispatched');
  dao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
  return { mission, task };
}

describe('createMissionWatcher', () => {
  it('started moves a dispatched task to working', () => {
    const { task } = setupMission();
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'started' });
    expect(dao.getTask(task.id)?.status).toBe('working');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('exited on a working task moves it to reviewing and enqueues one review wake', () => {
    const { mission, task } = setupMission();
    dao.moveTask(task.id, 'working');
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'exited', exitCode: 0 });
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
    const kinds = dao.listEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain('task_awaiting_review');
  });

  it('cli-exited behaves like exited (shell-first path)', () => {
    const { task } = setupMission();
    dao.moveTask(task.id, 'working');
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'cli-exited', exitCode: 0 });
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a terminal event on an unlinked session does nothing', () => {
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    expect(() =>
      watcher.onPaneEvent({ sessionId: 'sess-unknown', kind: 'exited' }),
    ).not.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when autonomy is disabled', () => {
    const { task } = setupMission();
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => false });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'started' });
    expect(dao.getTask(task.id)?.status).toBe('dispatched');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a double exited only enqueues once', () => {
    const { task } = setupMission();
    dao.moveTask(task.id, 'working');
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'exited' });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'exited' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
  });

  it('a racing illegal transition on started never throws out of the sink', () => {
    const { task } = setupMission();
    dao.moveTask(task.id, 'working');
    dao.moveTask(task.id, 'done'); // terminal — started → working is now illegal
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    expect(() =>
      watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'started' }),
    ).not.toThrow();
    expect(dao.getTask(task.id)?.status).toBe('done'); // unchanged
  });

  // Review finding (Critical): in the REAL dispatch flow, PtyRegistry.spawn
  // fires 'started' synchronously and returns BEFORE dispatch_task's
  // linkTaskToPane runs, so 'started' never finds the link and the task sits
  // at `dispatched` when the terminal event arrives — not `working`. This is
  // the realistic production sequence the tests above (which fire 'started'
  // first) invert.
  it('a terminal event on a still-dispatched task (no started fired) reaches reviewing', () => {
    const { mission, task } = setupMission(); // status: dispatched, linked
    const enqueue = vi.fn();
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'exited', exitCode: 0 });
    expect(dao.getTask(task.id)?.status).toBe('reviewing');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('review', mission.id, task.id);
    const kinds = dao.listEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain('task_awaiting_review');
  });

  it('a throwing enqueue never escapes onPaneEvent', () => {
    const { task } = setupMission();
    dao.moveTask(task.id, 'working');
    const enqueue = vi.fn(() => {
      throw new Error('scheduler blew up');
    });
    const watcher = createMissionWatcher({ enqueue, isEnabled: () => true });
    expect(() =>
      watcher.onPaneEvent({ sessionId: 'sess-1', kind: 'exited' }),
    ).not.toThrow();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
