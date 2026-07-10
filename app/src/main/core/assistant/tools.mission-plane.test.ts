// P3 Task 4 — external mission plane (submit_task / check_task / get_report).
// Same harness as tools.missions.test.ts (vi.mock('../db/client') +
// createDbFake), driven through `findTool(id)!.handler(args, ctx)` so these
// exercise the SAME parse/handler path the assistant CLI + external MCP use.
// D2: the plane absorbs SigmaControl — free for external origin, safety
// lives in the autonomy gates (missions.autonomy.enabled) + DANGEROUS_REMOTE
// downstream, not at this door.

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

describe('external mission plane tools', () => {
  describe('submit_task', () => {
    it('creates an active mission with goal=order, title=first 60 chars of order when no title given', async () => {
      const emit = vi.fn();
      const ctx = makeCtx({ emit });
      const order = 'x'.repeat(80);
      const out = (await findTool('submit_task')!.handler({ order }, ctx)) as {
        missionId: string;
        autonomyEnabled: boolean;
      };
      const mission = missionsDao.getMission(out.missionId);
      expect(mission?.goal).toBe(order);
      expect(mission?.title).toBe(order.slice(0, 60));
      expect(mission?.status).toBe('active');
      expect(emit).toHaveBeenCalledWith('missions:changed', {});
    });

    it('uses the provided title verbatim when given', async () => {
      const ctx = makeCtx();
      const out = (await findTool('submit_task')!.handler(
        { order: 'do the thing', title: 'My Mission' },
        ctx,
      )) as { missionId: string };
      expect(missionsDao.getMission(out.missionId)?.title).toBe('My Mission');
    });

    it('origin defaults to local when ctx.origin is absent', async () => {
      const ctx = makeCtx();
      const out = (await findTool('submit_task')!.handler({ order: 'order' }, ctx)) as {
        missionId: string;
      };
      expect(missionsDao.getMission(out.missionId)?.origin).toBe('local');
      expect(missionsDao.getMission(out.missionId)?.clientLabel).toBeNull();
    });

    it('external origin stamps origin=external + clientLabel on the mission row', async () => {
      const ctx = makeCtx({ origin: 'external', clientLabel: 'hermes-1' });
      const out = (await findTool('submit_task')!.handler({ order: 'order' }, ctx)) as {
        missionId: string;
      };
      const mission = missionsDao.getMission(out.missionId);
      expect(mission?.origin).toBe('external');
      expect(mission?.clientLabel).toBe('hermes-1');
    });

    it('enqueues a decompose wake via ctx.enqueueMissionWake', async () => {
      const enqueueMissionWake = vi.fn();
      const ctx = makeCtx({ enqueueMissionWake });
      const out = (await findTool('submit_task')!.handler({ order: 'order' }, ctx)) as {
        missionId: string;
      };
      expect(enqueueMissionWake).toHaveBeenCalledWith('decompose', out.missionId);
    });

    it('never throws when ctx.enqueueMissionWake is absent (D3 — autonomy off, still works honestly)', async () => {
      const ctx = makeCtx();
      await expect(findTool('submit_task')!.handler({ order: 'order' }, ctx)).resolves.toBeTruthy();
    });

    it('autonomyEnabled reflects the missions.autonomy.enabled KV flag', async () => {
      const ctxOn = makeCtx({ kvGet: (k) => (k === 'missions.autonomy.enabled' ? '1' : null) });
      const outOn = (await findTool('submit_task')!.handler({ order: 'a' }, ctxOn)) as {
        autonomyEnabled: boolean;
      };
      expect(outOn.autonomyEnabled).toBe(true);

      const ctxOff = makeCtx({ kvGet: (k) => (k === 'missions.autonomy.enabled' ? '0' : null) });
      const outOff = (await findTool('submit_task')!.handler({ order: 'b' }, ctxOff)) as {
        autonomyEnabled: boolean;
      };
      expect(outOff.autonomyEnabled).toBe(false);

      const ctxAbsent = makeCtx();
      const outAbsent = (await findTool('submit_task')!.handler({ order: 'c' }, ctxAbsent)) as {
        autonomyEnabled: boolean;
      };
      expect(outAbsent.autonomyEnabled).toBe(false);
    });

    it('rejects an empty order (min length 1) at the schema-parse boundary', () => {
      expect(() => findTool('submit_task')!.parse({ order: '' })).toThrow();
    });
  });

  describe('check_task', () => {
    it('returns {mission, tasks, recentEvents} for a known mission', async () => {
      const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
      missionsDao.addTask({ missionId: mission.id, title: 'a task' });
      const ctx = makeCtx();
      const out = (await findTool('check_task')!.handler({ missionId: mission.id }, ctx)) as {
        mission: { id: string };
        tasks: unknown[];
        recentEvents: unknown[];
      };
      expect(out.mission.id).toBe(mission.id);
      expect(out.tasks).toHaveLength(1);
      expect(out.recentEvents.length).toBeGreaterThan(0);
    });

    it('caps recentEvents at 20', async () => {
      const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
      for (let i = 0; i < 25; i++) {
        missionsDao.appendEvent(mission.id, null, `event-${i}`);
      }
      const ctx = makeCtx();
      const out = (await findTool('check_task')!.handler({ missionId: mission.id }, ctx)) as {
        recentEvents: unknown[];
      };
      expect(out.recentEvents.length).toBeLessThanOrEqual(20);
    });

    it('throws on an unknown mission id', async () => {
      const ctx = makeCtx();
      await expect(
        findTool('check_task')!.handler({ missionId: 'no-such-mission' }, ctx),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('get_report', () => {
    it('returns {status, report} for a done mission', async () => {
      const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
      missionsDao.setMissionReport(mission.id, 'final report body');
      missionsDao.setMissionStatus(mission.id, 'done');
      const ctx = makeCtx();
      const out = (await findTool('get_report')!.handler({ missionId: mission.id }, ctx)) as {
        status: string;
        report: string | null;
      };
      expect(out.status).toBe('done');
      expect(out.report).toBe('final report body');
    });

    it('report is null until the mission is done', async () => {
      const mission = missionsDao.createMission({ title: 't', goal: 'g', origin: 'local' });
      missionsDao.setMissionStatus(mission.id, 'active');
      const ctx = makeCtx();
      const out = (await findTool('get_report')!.handler({ missionId: mission.id }, ctx)) as {
        status: string;
        report: string | null;
      };
      expect(out.status).toBe('active');
      expect(out.report).toBeNull();
    });

    it('throws on an unknown mission id', async () => {
      const ctx = makeCtx();
      await expect(
        findTool('get_report')!.handler({ missionId: 'no-such-mission' }, ctx),
      ).rejects.toThrow(/not found/);
    });
  });
});
