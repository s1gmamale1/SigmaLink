// P1b Task 1 — DAO link helpers for dispatch_task (linkTaskToPane /
// incrementAttempt / listTasksForSession / listActiveMissions). Same MockDb
// harness as dao.test.ts (createDbFake + vi.mock('../db/client')).

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../db/client', () => ({ getDb: vi.fn(), getRawDb: vi.fn(), initializeDatabase: vi.fn(), closeDatabase: vi.fn() }));
import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as dao from './dao';

let fake: DbFake;
beforeEach(() => { fake = createDbFake(); vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>); });

describe('missions DAO — dispatch helpers', () => {
  it('linkTaskToPane sets assignee + worktree', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a', spec: 'do a' });
    const linked = dao.linkTaskToPane(a.id, 'sess-1', '/wt/a');
    expect(linked.assigneeSessionId).toBe('sess-1');
    expect(linked.worktreePath).toBe('/wt/a');
    expect(dao.listTasksForSession('sess-1').map((t) => t.id)).toEqual([a.id]);
  });
  it('incrementAttempt bumps 0→1→2', () => {
    const m = dao.createMission({ title: 't', goal: 'g', origin: 'local' });
    const a = dao.addTask({ missionId: m.id, title: 'a' });
    expect(dao.incrementAttempt(a.id)).toBe(1);
    expect(dao.incrementAttempt(a.id)).toBe(2);
  });
  it('listActiveMissions returns only active', () => {
    const m1 = dao.createMission({ title: 'a', goal: 'g', origin: 'local' });
    dao.setMissionStatus(m1.id, 'active');
    dao.createMission({ title: 'b', goal: 'g', origin: 'local' }); // stays draft
    expect(dao.listActiveMissions().map((m) => m.id)).toEqual([m1.id]);
  });
});
