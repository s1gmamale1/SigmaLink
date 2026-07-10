// P1b Task 5 — stub-CLI mission-loop e2e. Proves the whole autonomy loop
// (watcher → scheduler → supervisor → mission DAO) terminates a mission
// end-to-end with ZERO real model calls and ZERO real CLI/pane spawns
// (ROADMAP Phase 20 DoD). The three machinery pieces under test — the real
// `createMissionWatcher`, `createWakeScheduler`, `createSupervisor` — are
// wired together exactly as rpc-router.ts wires them; the ONLY things
// stubbed are the two genuinely foreign dependencies those modules already
// DI for: `runTurn` (normally `assistant.send` → a real `claude` turn) and
// `readPane` (normally PtyRegistry scrollback). No PtyRegistry, no
// dispatch_task tool, no real pane is ever constructed here — `dispatch` is
// simulated by calling the exact same DAO writes dispatch_task's handler
// makes (linkTaskToPane + moveTask('dispatched')), and a pane "finishing"
// is simulated by feeding the watcher a bare `{sessionId, kind:'exited'}`
// event, the same shape PtyRegistry's real onPaneEvent sink delivers.
//
// The scripted `runTurn` below plays the brain's role per `directive.ts`'s
// own contract: a decompose directive tells it to add tasks + dispatch the
// first; a review directive tells it to verdict the reviewing task and
// either dispatch the next backlog task or complete the mission — so the
// script distinguishes the two by the directive text (`buildDecomposeDirective`
// vs `buildReviewDirective`'s distinctive line), then drives the DAO exactly
// as a real tool-calling model turn would via `add_mission_task` /
// `dispatch_task` / `move_mission_task` / `complete_mission`.
//
// Decompose-enqueue note: rpc-router.ts wires the FIRST decompose wake off a
// `create_mission` tool-trace (no tool moves a mission `draft` → `active` in
// this codebase today — see rpc-router.ts's decompose-enqueue hook comment).
// This test seeds the mission via `setMissionStatus(...,'active')` directly
// (the same DAO primitive that hook would drive) and enqueues the initial
// decompose wake explicitly, mirroring what that hook does without needing
// the full Electron app / assistant controller booted for a unit-level e2e.

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
import { getDb } from '../../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import * as missionsDao from '../../missions/dao';
import { createMissionWatcher } from '../watch';
import { createWakeScheduler, type Wake, type WakeScheduler } from '../scheduler';
import { createSupervisor, type SupervisorDeps } from '../supervisor';
import { rememberMemory, listMemories } from '../memory';

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

// Same microtask-flush pattern as scheduler.test.ts — the drain loop's await
// chain (dequeue → gate check → runWake → budget write → loop) resolves over
// a handful of ticks, not synchronously.
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function createFakeKv() {
  const store = new Map<string, string>();
  return {
    kvGet: (k: string): string | null => store.get(k) ?? null,
    kvSet: (k: string, v: string): void => {
      store.set(k, v);
    },
  };
}

/** Mirrors dispatch_task's three DAO writes exactly, minus the real pane spawn. */
function simulateDispatch(taskId: string, sessionId: string): void {
  missionsDao.linkTaskToPane(taskId, sessionId, null);
  missionsDao.moveTask(taskId, 'dispatched');
  missionsDao.incrementAttempt(taskId);
}

describe('mission-loop e2e — decompose → dispatch → review → done (stub CLI)', () => {
  it('drives a 2-task mission to done with zero real turns/spawns beyond the scripted brain', async () => {
    const kv = createFakeKv();
    kv.kvSet('missions.autonomy.enabled', '1'); // the seeded default is '0' — flip it on for this drive
    kv.kvSet('missions.autonomy.dailyBudget', '40'); // matches migration 0040's seed

    const runTurnCalls: Array<{ conversationId: string; prompt: string }> = [];
    const dispatchedSessions: string[] = [];
    let nextSession = 0;

    // P2 T7 — forward-declared so runTurn's scripted "complete_mission" write
    // below can enqueue the postmortem wake the same way rpc-router.ts's
    // late-bound `enqueue` dep does (missionScheduler is a `let` constructed
    // AFTER createSupervisor there too — see rpc-router.ts's comment).
    let scheduler: WakeScheduler | undefined = undefined;

    // The scripted "brain" — a stand-in for a real claude turn. Never spawns
    // anything real; only ever calls missionsDao writes, exactly as the real
    // mission tools (add_mission_task/dispatch_task/move_mission_task/
    // complete_mission/remember) would on the model's behalf.
    const runTurn: SupervisorDeps['runTurn'] = async (input) => {
      runTurnCalls.push({ conversationId: input.conversationId, prompt: input.prompt });
      expect(input.origin).toBe('autonomous');

      if (input.prompt.includes('Decompose this mission')) {
        const mission = missionsDao
          .listMissions()
          .find((m) => !['done', 'failed', 'cancelled'].includes(m.status))!;
        const t1 = missionsDao.addTask({ missionId: mission.id, title: 'Task 1', spec: 'do task 1' });
        missionsDao.addTask({ missionId: mission.id, title: 'Task 2', spec: 'do task 2' });
        const sessionId = `stub-sess-${nextSession++}`;
        dispatchedSessions.push(sessionId);
        simulateDispatch(t1.id, sessionId);
        return { turnId: `turn-${runTurnCalls.length}` };
      }

      if (input.prompt.includes('Review the result')) {
        const mission = missionsDao
          .listMissions()
          .find((m) => !['done', 'failed', 'cancelled'].includes(m.status))!;
        const tasks = missionsDao.listTasks(mission.id);
        const reviewing = tasks.find((t) => t.status === 'reviewing')!;
        missionsDao.moveTask(reviewing.id, 'done'); // verdict: done — mirrors move_mission_task(status:'done')

        const remainingBacklog = missionsDao.listTasks(mission.id).filter((t) => t.status === 'backlog');
        if (remainingBacklog.length > 0) {
          const sessionId = `stub-sess-${nextSession++}`;
          dispatchedSessions.push(sessionId);
          simulateDispatch(remainingBacklog[0].id, sessionId); // mirrors dispatch_task on the next task
        } else {
          // mirrors complete_mission's two writes exactly.
          missionsDao.setMissionReport(mission.id, 'All tasks complete.');
          missionsDao.setMissionStatus(mission.id, 'done');
          // What rpc-router's postmortem-enqueue hook does on a successful
          // complete_mission tool-trace (P2 T7) — mirrors the
          // decompose-enqueue hook comment above; this e2e drives the hook
          // manually since there's no real tool-tracer/rpc-router wired
          // into this unit-level e2e.
          scheduler?.enqueue('postmortem', mission.id);
        }
        return { turnId: `turn-${runTurnCalls.length}` };
      }

      if (input.prompt.includes('Write ONE postmortem memory')) {
        // P2 T7 — the scripted brain's postmortem turn: mirrors what a real
        // model turn would do on a postmortem directive (buildPostmortemDirective's
        // own closing instruction) — call remember() exactly once, then stop.
        const mission = missionsDao.listMissions().find((m) => m.status === 'done')!;
        rememberMemory({
          kind: 'postmortem',
          title: mission.title,
          body: 'Worked: parallel task dispatch. Failed: nothing. Next time: same approach.',
        });
        return { turnId: `turn-${runTurnCalls.length}` };
      }

      throw new Error(`scripted runTurn: unrecognized directive: ${input.prompt}`);
    };

    const readPane = vi.fn().mockReturnValue('stub pane output — the task finished successfully');
    const supervisor = createSupervisor({
      runTurn,
      readPane,
      kvGet: kv.kvGet,
      kvSet: kv.kvSet,
      // P2 T7 — supervisor's own enqueue dep (used for the MAX_ATTEMPTS
      // "blocker postmortem" path — not exercised by this happy-path test,
      // but wired for parity with the live rpc-router.ts wiring).
      enqueue: (kind, missionId) => scheduler?.enqueue(kind, missionId),
    });

    const onDropped = vi.fn();
    scheduler = createWakeScheduler({
      runWake: (wake: Wake) => supervisor.runWake(wake),
      kvGet: kv.kvGet,
      kvSet: kv.kvSet,
      now: () => Date.now(),
      isFrozen: () => false,
      onDropped,
    });

    const watcher = createMissionWatcher({
      enqueue: scheduler.enqueue,
      isEnabled: () => kv.kvGet('missions.autonomy.enabled') === '1',
    });

    // Seed an "active" mission (see file-header note: no tool sets this
    // status today — rpc-router's decompose-enqueue hook drives the same
    // DAO primitive off a create_mission trace).
    const mission = missionsDao.createMission({ title: 'Ship the widget', goal: 'ship it end to end', origin: 'autonomous' });
    missionsDao.setMissionStatus(mission.id, 'active');

    // What rpc-router's decompose-enqueue hook does on a create_mission trace.
    scheduler.enqueue('decompose', mission.id);
    await flush();

    // ---- after the decompose wake: 2 tasks exist, the first is dispatched ----
    let tasks = missionsDao.listTasks(mission.id);
    expect(tasks).toHaveLength(2);
    const [task1, task2] = tasks;
    expect(task1.status).toBe('dispatched');
    expect(task2.status).toBe('backlog');
    expect(dispatchedSessions).toHaveLength(1);

    // Simulate task 1's pane finishing — exactly the shape PtyRegistry's
    // real onPaneEvent sink delivers.
    watcher.onPaneEvent({ sessionId: dispatchedSessions[0], kind: 'exited', exitCode: 0 });
    await flush();

    // ---- after the first review wake: task 1 done, task 2 dispatched ----
    tasks = missionsDao.listTasks(mission.id);
    const t1After = tasks.find((t) => t.id === task1.id)!;
    const t2After = tasks.find((t) => t.id === task2.id)!;
    expect(t1After.status).toBe('done');
    expect(t2After.status).toBe('dispatched');
    expect(dispatchedSessions).toHaveLength(2);
    expect(missionsDao.getMission(mission.id)?.status).toBe('active'); // not done yet — one task still open

    // Simulate task 2's pane finishing.
    watcher.onPaneEvent({ sessionId: dispatchedSessions[1], kind: 'exited', exitCode: 0 });
    await flush();

    // ---- after the second review wake: both tasks done, mission done ----
    tasks = missionsDao.listTasks(mission.id);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    const finalMission = missionsDao.getMission(mission.id);
    expect(finalMission?.status).toBe('done');
    expect(finalMission?.report).toBe('All tasks complete.');

    // ---- P2 T7: mission completion enqueued a postmortem wake (the scripted
    // brain called scheduler?.enqueue('postmortem', ...) from inside the
    // completing review turn above) — flush once more to drain it. ----
    await flush();

    // ---- one extra scripted turn distills the run into a durable memory ----
    expect(runTurnCalls).toHaveLength(4); // 1 decompose + 2 reviews + 1 postmortem
    const postmortems = listMemories({ kind: 'postmortem' });
    expect(postmortems).toHaveLength(1);
    expect(postmortems[0].title).toBe(mission.title);

    // ---- the loop spent exactly 4 scripted turns total ----
    expect(scheduler?.wakesSpentToday()).toBe(4);
    expect(onDropped).not.toHaveBeenCalled(); // autonomy was enabled + under budget the whole drive

    // ---- the event log shows the full trail, deterministically, DAO-only ----
    const events = missionsDao.listEvents(mission.id, 500).map((e) => e.kind).reverse();
    expect(events).toEqual([
      'created',
      'status', // draft → active (test setup)
      'task_created', // task 1
      'task_created', // task 2
      'task_dispatched', // task 1 → stub-sess-0 (linkTaskToPane)
      'task_moved', // task 1 backlog → dispatched (simulateDispatch's moveTask)
      'task_moved', // task 1 dispatched → working (watcher chains through working)
      'task_moved', // task 1 working → reviewing
      'task_awaiting_review', // task 1
      'task_moved', // task 1 reviewing → done (scripted verdict)
      'task_dispatched', // task 2 → stub-sess-1 (linkTaskToPane)
      'task_moved', // task 2 backlog → dispatched
      'task_moved', // task 2 dispatched → working
      'task_moved', // task 2 working → reviewing
      'task_awaiting_review', // task 2
      'task_moved', // task 2 reviewing → done (scripted verdict) — triggers rollup, both tasks now done
      'status', // active → done (rollup, promoted by that last moveTask call)
      'status', // active → done again (complete_mission's own explicit setMissionStatus — idempotent value, still a new event row)
    ]);

    // Zero real spawns: readPane was only ever called with the stub session
    // ids this test itself created — never anything resembling a real
    // PtyRegistry session, and no PtyRegistry/executeLaunchPlan was ever
    // imported into this file at all.
    for (const call of readPane.mock.calls) {
      expect(dispatchedSessions).toContain(call[0]);
    }
  });

  it('stays fully inert (zero runTurn calls) when autonomy is disabled', async () => {
    const kv = createFakeKv();
    kv.kvSet('missions.autonomy.enabled', '0'); // the seeded (migration 0040) default

    const runTurn = vi.fn().mockResolvedValue({ turnId: 'never' });
    const readPane = vi.fn().mockReturnValue('');
    const supervisor = createSupervisor({ runTurn, readPane, kvGet: kv.kvGet, kvSet: kv.kvSet });
    const onDropped = vi.fn();
    const scheduler = createWakeScheduler({
      runWake: (wake: Wake) => supervisor.runWake(wake),
      kvGet: kv.kvGet,
      kvSet: kv.kvSet,
      now: () => Date.now(),
      isFrozen: () => false,
      onDropped,
    });
    const watcher = createMissionWatcher({
      enqueue: scheduler.enqueue,
      isEnabled: () => kv.kvGet('missions.autonomy.enabled') === '1',
    });

    const mission = missionsDao.createMission({ title: 'Should not run', goal: 'g', origin: 'autonomous' });
    missionsDao.setMissionStatus(mission.id, 'active');
    const task = missionsDao.addTask({ missionId: mission.id, title: 'a', spec: 's' });
    missionsDao.linkTaskToPane(task.id, 'sess-x', null);
    missionsDao.moveTask(task.id, 'dispatched');

    // Both entry points the live rpc-router wiring uses:
    scheduler.enqueue('decompose', mission.id); // the decompose-enqueue hook
    watcher.onPaneEvent({ sessionId: 'sess-x', kind: 'exited', exitCode: 0 }); // the pane-event sinks
    await flush();

    expect(runTurn).not.toHaveBeenCalled();
    // The watcher itself is gated inert — a disabled autonomy flag means it
    // never touches the DAO at all, so the task is untouched too.
    expect(missionsDao.getTask(task.id)?.status).toBe('dispatched');
    expect(scheduler.wakesSpentToday()).toBe(0);
  });

  it('recovers a failed task via the retry verdict, then lands the mission done', async () => {
    const kv = createFakeKv();
    kv.kvSet('missions.autonomy.enabled', '1');
    kv.kvSet('missions.autonomy.dailyBudget', '40');

    const dispatchedSessions: string[] = [];
    let nextSession = 0;
    const runTurnCalls: string[] = [];

    const runTurn: SupervisorDeps['runTurn'] = async (input) => {
      runTurnCalls.push(input.prompt);
      if (input.prompt.includes('Decompose this mission')) {
        const mission = missionsDao.listMissions().find((m) => m.status === 'active')!;
        const t = missionsDao.addTask({ missionId: mission.id, title: 'Flaky task', spec: 'attempt 1 spec' });
        const sessionId = `retry-sess-${nextSession++}`;
        dispatchedSessions.push(sessionId);
        simulateDispatch(t.id, sessionId);
        return { turnId: 't' };
      }
      if (input.prompt.includes('Review the result')) {
        const mission = missionsDao.listMissions().find((m) => m.status === 'active')!;
        const reviewing = missionsDao.listTasks(mission.id).find((t) => t.status === 'reviewing')!;
        if (input.prompt.includes('Attempt: 1 of 3')) {
          // verdict: RETRY — mirrors dispatch_task(taskId, revisedSpec)'s writes
          missionsDao.updateTask(reviewing.id, { spec: 'attempt 2: build first, then test' });
          const sessionId = `retry-sess-${nextSession++}`;
          dispatchedSessions.push(sessionId);
          simulateDispatch(reviewing.id, sessionId);
          missionsDao.appendEvent(mission.id, reviewing.id, 'task_retried', JSON.stringify({ attempt: 2 }));
        } else {
          // verdict: DONE — second attempt succeeded
          missionsDao.moveTask(reviewing.id, 'done');
          missionsDao.setMissionReport(mission.id, 'Recovered on attempt 2.');
          missionsDao.setMissionStatus(mission.id, 'done');
        }
        return { turnId: 't' };
      }
      throw new Error(`unrecognized directive: ${input.prompt}`);
    };

    const readPane = vi.fn().mockReturnValue('output');
    const supervisor = createSupervisor({ runTurn, readPane, kvGet: kv.kvGet, kvSet: kv.kvSet });
    const scheduler = createWakeScheduler({
      runWake: (w: Wake) => supervisor.runWake(w),
      kvGet: kv.kvGet, kvSet: kv.kvSet, now: () => Date.now(), isFrozen: () => false,
      onDropped: vi.fn(),
    });
    const watcher = createMissionWatcher({
      enqueue: scheduler.enqueue,
      isEnabled: () => kv.kvGet('missions.autonomy.enabled') === '1',
    });

    const mission = missionsDao.createMission({ title: 'Retry drill', goal: 'g', origin: 'autonomous' });
    missionsDao.setMissionStatus(mission.id, 'active');
    scheduler.enqueue('decompose', mission.id);
    await flush();

    // attempt 1 fails (nonzero exit) → review wake 1 → retry verdict
    watcher.onPaneEvent({ sessionId: dispatchedSessions[0], kind: 'exited', exitCode: 1 });
    await flush();

    const afterRetry = missionsDao.listTasks(mission.id)[0];
    expect(afterRetry.status).toBe('dispatched');
    expect(afterRetry.attempt).toBe(2);
    expect(afterRetry.spec).toBe('attempt 2: build first, then test');

    // attempt 2 succeeds → review wake 2 → done
    watcher.onPaneEvent({ sessionId: dispatchedSessions[1], kind: 'exited', exitCode: 0 });
    await flush();

    expect(missionsDao.listTasks(mission.id)[0].status).toBe('done');
    expect(missionsDao.getMission(mission.id)?.status).toBe('done');
    expect(runTurnCalls).toHaveLength(3); // 1 decompose + 2 reviews
    const kinds = missionsDao.listEvents(mission.id, 500).map((e) => e.kind);
    expect(kinds).toContain('task_retried');
  });

  it('auto-blocks at MAX_ATTEMPTS with zero model spend on the capped wake', async () => {
    const kv = createFakeKv();
    kv.kvSet('missions.autonomy.enabled', '1');
    kv.kvSet('missions.autonomy.dailyBudget', '40');

    const dispatchedSessions: string[] = [];
    let nextSession = 0;
    let reviewTurns = 0;

    const runTurn: SupervisorDeps['runTurn'] = async (input) => {
      const mission = missionsDao.listMissions().find((m) => m.status === 'active')!;
      if (input.prompt.includes('Decompose this mission')) {
        const t = missionsDao.addTask({ missionId: mission.id, title: 'Doomed task', spec: 's' });
        const sessionId = `cap-sess-${nextSession++}`;
        dispatchedSessions.push(sessionId);
        simulateDispatch(t.id, sessionId);
        return { turnId: 't' };
      }
      // an incorrigible brain: ALWAYS retries
      reviewTurns++;
      const reviewing = missionsDao.listTasks(mission.id).find((t) => t.status === 'reviewing')!;
      const sessionId = `cap-sess-${nextSession++}`;
      dispatchedSessions.push(sessionId);
      simulateDispatch(reviewing.id, sessionId);
      return { turnId: 't' };
    };

    const supervisor = createSupervisor({
      runTurn,
      readPane: vi.fn().mockReturnValue('fail'),
      kvGet: kv.kvGet,
      kvSet: kv.kvSet,
    });
    const scheduler = createWakeScheduler({
      runWake: (w: Wake) => supervisor.runWake(w),
      kvGet: kv.kvGet, kvSet: kv.kvSet, now: () => Date.now(), isFrozen: () => false,
      onDropped: vi.fn(),
    });
    const watcher = createMissionWatcher({
      enqueue: scheduler.enqueue,
      isEnabled: () => kv.kvGet('missions.autonomy.enabled') === '1',
    });

    const mission = missionsDao.createMission({ title: 'Cap drill', goal: 'g', origin: 'autonomous' });
    missionsDao.setMissionStatus(mission.id, 'active');
    scheduler.enqueue('decompose', mission.id);
    await flush();

    // fail all three attempts
    watcher.onPaneEvent({ sessionId: dispatchedSessions[0], kind: 'exited', exitCode: 1 }); // → review 1 → retry (attempt 2)
    await flush();
    watcher.onPaneEvent({ sessionId: dispatchedSessions[1], kind: 'exited', exitCode: 1 }); // → review 2 → retry (attempt 3)
    await flush();
    watcher.onPaneEvent({ sessionId: dispatchedSessions[2], kind: 'exited', exitCode: 1 }); // → capped wake: NO model call
    await flush();

    const task = missionsDao.listTasks(mission.id)[0];
    expect(task.status).toBe('blocked');
    expect(task.attempt).toBe(3);
    expect(reviewTurns).toBe(2); // the third review wake never reached the model
    const kinds = missionsDao.listEvents(mission.id, 500).map((e) => e.kind);
    expect(kinds).toContain('task_max_attempts');
  });
});
