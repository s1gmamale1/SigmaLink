// P1b Task 4 — supervisor wake runner tests. MockDb pattern (createDbFake +
// vi.mock('../db/client')) mirrors watch.test.ts / dao.test.ts: supervisor.ts
// imports the missions DAO and the conversations DAO directly (repo
// convention — see watch.ts's header comment), so mocking '../db/client'
// underneath both is enough; only `runTurn` (assistant.send) and `readPane`
// are DI'd, since those are the two genuinely foreign, model/pane-touching
// dependencies this module must never import directly.
//
// P2 Task 5 — `kvGet`/`kvSet` joined SupervisorDeps as REQUIRED fields (KV-
// durable mission→conversation pinning, D1). `baseDeps()` now backs them
// with a private in-memory Map by default so every EXISTING test keeps
// working unmodified; the new "KV-durable mission conversation" describe
// block below passes an explicit SHARED kv Map across two separate
// `createSupervisor` calls to prove restart durability.

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as missionsDao from '../missions/dao';
import { getConversation } from '../assistant/conversations';
import { createSupervisor, MAX_ATTEMPTS, type SupervisorDeps } from './supervisor';
import { KV_MISSION_CONVERSATION_PREFIX } from './global';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

/** A fresh, isolated in-memory KV store — NOT shared across baseDeps() calls
 *  unless the caller explicitly threads the same kvGet/kvSet pair through
 *  (see the restart-durability tests below). */
function makeKv(): { kvGet: (key: string) => string | null; kvSet: (key: string, value: string) => void } {
  const store = new Map<string, string>();
  return {
    kvGet: (key: string) => store.get(key) ?? null,
    kvSet: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function baseDeps(overrides: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    runTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }),
    readPane: vi.fn().mockReturnValue('pane output'),
    ...makeKv(),
    ...overrides,
  };
}

function setupMission() {
  const mission = missionsDao.createMission({ title: 'Ship it', goal: 'Ship the widget', origin: 'autonomous' });
  return mission;
}

function setupTaskInReview(missionId: string, attempt = 0) {
  const task = missionsDao.addTask({ missionId, title: 'Wire it up', spec: 'do the thing' });
  missionsDao.moveTask(task.id, 'dispatched');
  missionsDao.linkTaskToPane(task.id, 'sess-1', '/wt/a');
  missionsDao.moveTask(task.id, 'working');
  missionsDao.moveTask(task.id, 'reviewing');
  for (let i = 0; i < attempt; i++) missionsDao.incrementAttempt(task.id);
  return missionsDao.getTask(task.id)!;
}

describe('createSupervisor — review wakes', () => {
  it('a review wake below MAX_ATTEMPTS calls runTurn once with the review directive', async () => {
    const mission = setupMission();
    const task = setupTaskInReview(mission.id, MAX_ATTEMPTS - 1);
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: task.id });

    expect(deps.runTurn).toHaveBeenCalledTimes(1);
    const call = (deps.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.origin).toBe('autonomous');
    expect(call.prompt).toContain(task.spec);
    expect(call.prompt).toContain('pane output');
    expect(typeof call.conversationId).toBe('string');
    // Task must NOT have been force-moved by the supervisor itself.
    expect(missionsDao.getTask(task.id)?.status).toBe('reviewing');
  });

  it('reads the pane via the DI\'d readPane using the task\'s assignee session', async () => {
    const mission = setupMission();
    const task = setupTaskInReview(mission.id, 0);
    const readPane = vi.fn().mockReturnValue('specific pane content');
    const deps = baseDeps({ readPane });
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: task.id });

    expect(readPane).toHaveBeenCalledWith('sess-1');
  });

  it('a review wake AT MAX_ATTEMPTS moves the task to blocked and does NOT call runTurn', async () => {
    const mission = setupMission();
    const task = setupTaskInReview(mission.id, MAX_ATTEMPTS);
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: task.id });

    expect(deps.runTurn).not.toHaveBeenCalled();
    expect(missionsDao.getTask(task.id)?.status).toBe('blocked');
    const kinds = missionsDao.listEvents(mission.id).map((e) => e.kind);
    expect(kinds).toContain('task_max_attempts');
  });

  it('a review wake PAST MAX_ATTEMPTS (already blocked once, re-queued) also stops — never calls runTurn', async () => {
    const mission = setupMission();
    const task = setupTaskInReview(mission.id, MAX_ATTEMPTS + 5);
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: task.id });

    expect(deps.runTurn).not.toHaveBeenCalled();
    expect(missionsDao.getTask(task.id)?.status).toBe('blocked');
  });

  it('a review wake with no taskId is a no-op (never throws, never calls runTurn)', async () => {
    const mission = setupMission();
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await expect(
      supervisor.runWake({ kind: 'review', missionId: mission.id }),
    ).resolves.toBeUndefined();
    expect(deps.runTurn).not.toHaveBeenCalled();
  });

  it('a review wake for a deleted/unknown task is a no-op', async () => {
    const mission = setupMission();
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await expect(
      supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: 'nonexistent' }),
    ).resolves.toBeUndefined();
    expect(deps.runTurn).not.toHaveBeenCalled();
  });
});

describe('createSupervisor — decompose wakes', () => {
  it('a decompose wake creates a mission conversation and calls runTurn with the decompose directive', async () => {
    const mission = setupMission();
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'decompose', missionId: mission.id });

    expect(deps.runTurn).toHaveBeenCalledTimes(1);
    const call = (deps.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.origin).toBe('autonomous');
    expect(call.prompt).toContain(mission.goal);
    expect(typeof call.conversationId).toBe('string');
    // The conversation must actually exist (real DAO write, not a fake id).
    expect(getConversation(call.conversationId)).not.toBeNull();
  });

  it('a second wake for the same mission reuses the SAME conversation', async () => {
    const mission = setupMission();
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await supervisor.runWake({ kind: 'decompose', missionId: mission.id });
    const firstConvId = (deps.runTurn as ReturnType<typeof vi.fn>).mock.calls[0][0].conversationId;

    const task = setupTaskInReview(mission.id, 0);
    await supervisor.runWake({ kind: 'review', missionId: mission.id, taskId: task.id });
    const secondConvId = (deps.runTurn as ReturnType<typeof vi.fn>).mock.calls[1][0].conversationId;

    expect(secondConvId).toBe(firstConvId);
  });

  it('a decompose wake for a deleted/unknown mission is a no-op', async () => {
    const deps = baseDeps();
    const supervisor = createSupervisor(deps);

    await expect(
      supervisor.runWake({ kind: 'decompose', missionId: 'nonexistent' }),
    ).resolves.toBeUndefined();
    expect(deps.runTurn).not.toHaveBeenCalled();
  });
});

describe('createSupervisor — KV-durable mission conversation (P2 Task 5, D1)', () => {
  it('a second createSupervisor instance (fresh in-memory map, same fake KV) reuses the first instance\'s conversation id — restart durability', async () => {
    const mission = setupMission();
    const kv = makeKv();

    const runTurn1 = vi.fn().mockResolvedValue({ turnId: 'turn-1' });
    const supervisor1 = createSupervisor(baseDeps({ ...kv, runTurn: runTurn1 }));
    await supervisor1.runWake({ kind: 'decompose', missionId: mission.id });
    const firstConvId = runTurn1.mock.calls[0][0].conversationId as string;
    expect(getConversation(firstConvId)).not.toBeNull();

    // Simulate an app restart: a BRAND-NEW createSupervisor instance (its
    // own fresh in-memory conversationByMission Map) but the SAME kvGet/
    // kvSet pair — i.e. the durable store survived, only the process didn't.
    const runTurn2 = vi.fn().mockResolvedValue({ turnId: 'turn-2' });
    const supervisor2 = createSupervisor(baseDeps({ ...kv, runTurn: runTurn2 }));
    await supervisor2.runWake({ kind: 'decompose', missionId: mission.id });
    const secondConvId = runTurn2.mock.calls[0][0].conversationId as string;

    expect(secondConvId).toBe(firstConvId);
  });

  it('reads the KV pointer under the KV_MISSION_CONVERSATION_PREFIX + missionId key', async () => {
    const mission = setupMission();
    const kv = makeKv();
    const runTurn = vi.fn().mockResolvedValue({ turnId: 'turn-1' });
    const supervisor = createSupervisor(baseDeps({ ...kv, runTurn }));

    await supervisor.runWake({ kind: 'decompose', missionId: mission.id });
    const convId = runTurn.mock.calls[0][0].conversationId as string;

    expect(kv.kvGet(`${KV_MISSION_CONVERSATION_PREFIX}${mission.id}`)).toBe(convId);
  });

  it('a stale KV pointer to a deleted/nonexistent conversation creates a fresh conversation and overwrites the KV', async () => {
    const mission = setupMission();
    const kv = makeKv();
    kv.kvSet(`${KV_MISSION_CONVERSATION_PREFIX}${mission.id}`, 'conv-does-not-exist');
    const runTurn = vi.fn().mockResolvedValue({ turnId: 'turn-1' });
    const supervisor = createSupervisor(baseDeps({ ...kv, runTurn }));

    await supervisor.runWake({ kind: 'decompose', missionId: mission.id });
    const usedConvId = runTurn.mock.calls[0][0].conversationId as string;

    expect(usedConvId).not.toBe('conv-does-not-exist');
    expect(getConversation(usedConvId)).not.toBeNull();
    expect(kv.kvGet(`${KV_MISSION_CONVERSATION_PREFIX}${mission.id}`)).toBe(usedConvId);
  });

  it('a valid KV pointer is reused WITHOUT calling createConversation again (no duplicate conversation row)', async () => {
    const mission = setupMission();
    const kv = makeKv();

    const seedTurn = vi.fn().mockResolvedValue({ turnId: 'turn-seed' });
    await createSupervisor(baseDeps({ ...kv, runTurn: seedTurn })).runWake({
      kind: 'decompose',
      missionId: mission.id,
    });
    const seededConvId = seedTurn.mock.calls[0][0].conversationId as string;

    // Fresh instance, same KV — the SECOND wake for this mission must reuse
    // the pinned conversation without minting a new one.
    const runTurn2 = vi.fn().mockResolvedValue({ turnId: 'turn-2' });
    const task = setupTaskInReview(mission.id, 0);
    await createSupervisor(baseDeps({ ...kv, runTurn: runTurn2 })).runWake({
      kind: 'review',
      missionId: mission.id,
      taskId: task.id,
    });

    expect(runTurn2.mock.calls[0][0].conversationId).toBe(seededConvId);
  });
});
