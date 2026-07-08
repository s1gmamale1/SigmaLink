// P1a Task 3 — DAO tests. MockDb pattern (createDbFake + vi.mock('../db/client'))
// mirrors conversations.test.ts / controller.test.ts; never touches better-sqlite3.

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as dao from './dao';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('missions DAO', () => {
  it('creates and reads a mission', () => {
    const m = dao.createMission({ title: 'Ship X', goal: 'ship the X feature', origin: 'local' });
    expect(m.status).toBe('draft');
    expect(m.clientLabel).toBeNull();
    expect(m.workspaceId).toBeNull();
    expect(dao.getMission(m.id)?.goal).toBe('ship the X feature');
  });

  it('getMission returns null for an unknown id', () => {
    expect(dao.getMission('nope')).toBeNull();
  });

  it('addTask auto-increments orderIdx and lists in order', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    const b = dao.addTask({ missionId: m.id, title: 'b' });
    expect(a.orderIdx).toBe(0);
    expect(b.orderIdx).toBe(1);
    expect(a.status).toBe('backlog');
    expect(dao.listTasks(m.id).map((t) => t.title)).toEqual(['a', 'b']);
  });

  it('addTask honors an explicit orderIdx', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a', orderIdx: 5 });
    expect(a.orderIdx).toBe(5);
  });

  it('moveTask updates status and returns the updated task', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    const moved = dao.moveTask(a.id, 'dispatched');
    expect(moved.status).toBe('dispatched');
    expect(dao.getTask(a.id)?.status).toBe('dispatched');
  });

  it('moveTask rejects an illegal transition', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    expect(() => dao.moveTask(a.id, 'done')).toThrowError(/illegal transition/);
    // rejected transition must not have mutated the task
    expect(dao.getTask(a.id)?.status).toBe('backlog');
  });

  it('rollup promotes the mission to done when its last task is done', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    dao.setMissionStatus(m.id, 'active');
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    dao.moveTask(a.id, 'working');
    dao.moveTask(a.id, 'done');
    expect(dao.getMission(m.id)?.status).toBe('done');
  });

  it('rollup does not promote a draft mission even when all tasks are done', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    dao.moveTask(a.id, 'working');
    dao.moveTask(a.id, 'done');
    expect(dao.getMission(m.id)?.status).toBe('draft');
  });

  it('records events (created, task_created, task_moved) newest-first', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    const kinds = dao.listEvents(m.id).map((e) => e.kind);
    expect(kinds[0]).toBe('task_moved');
    expect(kinds).toContain('created');
    expect(kinds).toContain('task_created');
  });

  it('listEvents respects an explicit limit', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.moveTask(a.id, 'dispatched');
    dao.moveTask(a.id, 'working');
    expect(dao.listEvents(m.id, 1)).toHaveLength(1);
  });

  it('setMissionStatus writes updatedAt and a status event', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    dao.setMissionStatus(m.id, 'active');
    const reread = dao.getMission(m.id);
    expect(reread?.status).toBe('active');
    expect(dao.listEvents(m.id).map((e) => e.kind)).toContain('status');
  });

  it('setMissionReport sets the report field', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    dao.setMissionReport(m.id, 'final report body');
    expect(dao.getMission(m.id)?.report).toBe('final report body');
  });

  it('updateTask patches provided fields and preserves the rest', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a', spec: 'orig spec' });
    const updated = dao.updateTask(a.id, { title: 'renamed', assigneeSessionId: 'sess-1' });
    expect(updated.title).toBe('renamed');
    expect(updated.assigneeSessionId).toBe('sess-1');
    expect(updated.spec).toBe('orig spec');
    expect(dao.getTask(a.id)?.title).toBe('renamed');
  });

  it('updateTask can clear a nullable field back to null', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    dao.updateTask(a.id, { assigneeSessionId: 'sess-1' });
    const cleared = dao.updateTask(a.id, { assigneeSessionId: null });
    expect(cleared.assigneeSessionId).toBeNull();
  });

  it('listMissions returns most-recently-updated first', () => {
    const first = dao.createMission({ title: 'first', goal: 'g', origin: 'local' });
    const second = dao.createMission({ title: 'second', goal: 'g', origin: 'local' });
    dao.setMissionStatus(first.id, 'active'); // bumps first's updatedAt after second was created
    const ids = dao.listMissions().map((m) => m.id);
    expect(ids[0]).toBe(first.id);
    expect(ids).toContain(second.id);
  });

  it('listMissions filters by status', () => {
    const m1 = dao.createMission({ title: 'a', goal: 'g', origin: 'local' });
    dao.createMission({ title: 'b', goal: 'g', origin: 'local' });
    dao.setMissionStatus(m1.id, 'active');
    const active = dao.listMissions({ status: 'active' });
    expect(active.map((m) => m.id)).toEqual([m1.id]);
  });
});
