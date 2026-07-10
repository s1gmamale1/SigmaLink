# Jorvis P1c — Mission Retry Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the one missing autonomy verdict — a review wake can now RETRY a failed task (`reviewing → dispatched`, with an optionally revised spec), making `MAX_ATTEMPTS` a live backstop instead of dormant code.

**Architecture:** Three thin, layered changes on the shipped P1b machinery: (1) the pure state machine legalises `reviewing → dispatched` and becomes the home of `MAX_ATTEMPTS`; (2) `dispatch_task` grows an optional `revisedSpec`, a reviewing-lane attempt cap, and fresh-grant attempt reset for human recoveries; (3) the review directive offers the retry verdict honestly. No new tools, no new tables, no migration.

**Tech Stack:** TypeScript (erasableSyntaxOnly — no enums/param-props/namespaces), vitest + `@/test-utils/db-fake` (better-sqlite3 cannot load under vitest), zod tool schemas, drizzle DAO.

## Global Constraints

- Branch: `feat/jorvis-p1c-retry-loop` off `main` (after PR #225 merges — P1b code is the substrate).
- `MAX_ATTEMPTS = 3` — the value must not change.
- Attempt semantics (the design decision, verbatim): **autonomous retries (`reviewing → dispatched`) are monotonic and capped; human recoveries (`blocked | needs_input → dispatched`) reset `attempt` to 0 before the increment (fresh grant).** The from-status encodes who is recovering; no origin plumbing.
- `tool-catalogue.ts` and `tools.ts` zod schemas MUST stay in parity (the catalogue-parity contract test enforces it — update both or the suite fails).
- Full local gate before every commit is not required, but each task's listed test commands must be green before its commit; the branch-final gate is `npx tsc -b && npx vitest run && npx eslint . --max-warnings 0 && npm run build`.
- NEVER push, tag, or merge. Commits stay local to the branch.

## Known out-of-scope (do NOT build; already parked in WISHLIST)

- A no-verdict review turn (model calls no tool) leaves the task in `reviewing` forever — fails safe/visible; a staleness sweep is P2+ work.
- `dispatch_task` provider allowlist hardening.
- UTC budget-rollover vs local quiet-hours mismatch in scheduler.ts.

---

### Task 1: State machine + directive (the pure layers)

**Files:**
- Modify: `src/main/core/missions/state.ts`
- Modify: `src/main/core/missions/state.test.ts`
- Modify: `src/main/core/operator/supervisor.ts` (import move only)
- Modify: `src/main/core/operator/directive.ts`
- Modify: `src/main/core/operator/directive.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MAX_ATTEMPTS` exported from `core/missions/state.ts` (number, value 3); `supervisor.ts` re-exports it (`export { MAX_ATTEMPTS } from '../missions/state'`) so existing importers keep working; `buildReviewDirective(mission, task, paneExcerpt)` signature UNCHANGED but its output now contains an `Attempt: N of 3` line and a `dispatch_task` retry verdict; `reviewing → dispatched` becomes a legal task transition.

- [ ] **Step 1: Write the failing state-machine test**

In `src/main/core/missions/state.test.ts`, add to the existing transition-table tests:

```typescript
it('reviewing → dispatched is legal (P1c retry verdict)', () => {
  expect(isLegalTaskTransition('reviewing', 'dispatched')).toBe(true);
});

it('done stays terminal — dispatched is still illegal from done', () => {
  expect(isLegalTaskTransition('done', 'dispatched')).toBe(false);
});

it('exports MAX_ATTEMPTS = 3 as the shared retry cap', () => {
  expect(MAX_ATTEMPTS).toBe(3);
});
```

Add `MAX_ATTEMPTS` to the file's import from `./state`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/missions/state.test.ts`
Expected: FAIL — `MAX_ATTEMPTS` not exported; `reviewing → dispatched` returns false.

- [ ] **Step 3: Implement in state.ts**

In `src/main/core/missions/state.ts`, change the `reviewing` row and add the constant:

```typescript
const TASK_TRANSITIONS: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  backlog: ['dispatched'],
  dispatched: ['working', 'blocked', 'needs_input'],
  working: ['reviewing', 'blocked', 'needs_input', 'done'],
  // 'dispatched' is the P1c retry verdict — a review wake re-dispatches a
  // failed-but-retryable task (fresh pane, revised spec, attempt+1).
  reviewing: ['working', 'done', 'blocked', 'needs_input', 'dispatched'],
  needs_input: ['working', 'dispatched', 'blocked'],
  blocked: ['dispatched', 'working'],
  done: [], // terminal
};

/**
 * Hard cap on autonomous dispatches of one task (P1c). Lives here — beside
 * the machine whose retry edge it bounds — so the supervisor's pre-model
 * block and dispatch_task's reviewing-lane guard share ONE value. A human
 * recovery (blocked|needs_input → dispatched) resets the counter; the
 * autonomous lane (reviewing → dispatched) is monotonic and stops here.
 */
export const MAX_ATTEMPTS = 3;
```

In `src/main/core/operator/supervisor.ts`: delete the local `export const MAX_ATTEMPTS = 3;` line and add at the imports:

```typescript
import { MAX_ATTEMPTS } from '../missions/state';
export { MAX_ATTEMPTS };
```

(Keep the file's `MAX_ATTEMPTS` usages untouched; the re-export keeps `supervisor.test.ts` and any other importer working.)

- [ ] **Step 4: Run state + supervisor tests**

Run: `npx vitest run src/main/core/missions/state.test.ts src/main/core/operator/supervisor.test.ts`
Expected: PASS (supervisor behavior unchanged — same constant, new home).

- [ ] **Step 5: Write the failing directive tests**

In `src/main/core/operator/directive.test.ts`, REPLACE the test `does NOT promise automatic re-dispatch (retry loop is not wired yet — P1c)` (lines 74-81) with:

```typescript
it('offers the dispatch_task retry verdict with the attempt counter (P1c)', () => {
  const directive = buildReviewDirective(makeMission(), makeTask({ attempt: 1 }), 'output');
  expect(directive).toContain('Attempt: 1 of 3');
  expect(directive).toContain('revisedSpec');
  expect(directive).toContain('Retries left: 2');
  // the P1b-era false-promise disclaimer must be gone
  expect(directive).not.toContain('Automatic retry is not available yet');
});

it('still offers blocked for tasks that need a human', () => {
  const directive = buildReviewDirective(makeMission(), makeTask(), 'output');
  expect(directive).toContain('blocked');
});

it('shows zero retries left at the cap boundary', () => {
  const directive = buildReviewDirective(makeMission(), makeTask({ attempt: 3 }), 'output');
  expect(directive).toContain('Attempt: 3 of 3');
  expect(directive).toContain('Retries left: 0');
});
```

(`makeTask` already accepts overrides; default `attempt: 1` stays.)

- [ ] **Step 6: Run to verify the new directive tests fail**

Run: `npx vitest run src/main/core/operator/directive.test.ts`
Expected: FAIL — no `Attempt:` line, no `revisedSpec`, old disclaimer present.

- [ ] **Step 7: Implement the directive**

In `src/main/core/operator/directive.ts`: add the import and rewrite `buildReviewDirective`'s verdict block:

```typescript
import { MAX_ATTEMPTS } from '../missions/state';
```

```typescript
export function buildReviewDirective(mission: Mission, task: MissionTask, paneExcerpt: string): string {
  const retriesLeft = Math.max(0, MAX_ATTEMPTS - task.attempt);
  return [
    `Mission: ${mission.title}`,
    `Task: ${task.title}`,
    `Spec: ${task.spec}`,
    `Attempt: ${task.attempt} of ${MAX_ATTEMPTS}`,
    '',
    "Recent output from the task's pane:",
    '```',
    capExcerpt(paneExcerpt),
    '```',
    '',
    'Review the result and call exactly one verdict tool:',
    '- move_mission_task(status: "done") if the task is complete — then dispatch_task the next backlog task, or complete_mission if this was the last one.',
    `- dispatch_task(taskId, revisedSpec) to RETRY if it failed but a revised approach could succeed — put what went wrong and the corrected instructions into revisedSpec. Retries left: ${retriesLeft}.`,
    '- move_mission_task(status: "blocked") if it needs a human decision or no viable retry remains.',
  ].join('\n');
}
```

- [ ] **Step 8: Run the directive + full operator/missions suites**

Run: `npx vitest run src/main/core/operator src/main/core/missions`
Expected: PASS except `__e2e__/mission-loop.e2e.test.ts` MAY still pass unchanged (its scripted brain matches on `'Review the result'`, which is retained) — if anything else fails, fix before committing.

- [ ] **Step 9: Commit**

```bash
git add src/main/core/missions/state.ts src/main/core/missions/state.test.ts src/main/core/operator/supervisor.ts src/main/core/operator/directive.ts src/main/core/operator/directive.test.ts
git commit -m "feat(missions): legalise reviewing→dispatched + honest retry directive (P1c T1)"
```

---

### Task 2: dispatch_task — revisedSpec, reviewing-lane cap, fresh-grant reset

**Files:**
- Modify: `src/main/core/assistant/tools.ts` (schema `sDispatchTask` ~line 419; handler ~lines 1775-1826)
- Modify: `src/main/core/assistant/tool-catalogue.ts` (dispatch_task entry ~lines 508-520)
- Test: the existing dispatch_task test file (find it: `grep -rl "dispatch_task" src/main/core/assistant/*.test.ts src/main/core/assistant/__tests__ 2>/dev/null` — it is the file P1b Task 1 added; extend it, do not create a new file)

**Interfaces:**
- Consumes: `MAX_ATTEMPTS` from `../missions/state` (Task 1); `missionsDao.updateTask(id, {spec})` (exists, `dao.ts:217`); `missionsDao.appendEvent(missionId, taskId, kind, body)` (exists).
- Produces: `dispatch_task` accepts optional `revisedSpec: string` (min 1 char); throws `'task <id> has exhausted its <N> attempts — a human must recover it (move it out of blocked)'` when dispatching FROM `reviewing` at `attempt >= MAX_ATTEMPTS`; resets `attempt` to 0 (pre-increment) when dispatching FROM `blocked` or `needs_input`; appends a `task_retried` event when dispatching FROM `reviewing`.

- [ ] **Step 1: Write the failing tests**

In the existing dispatch_task test file, add (mirroring its existing harness/fixture style — read the file first and reuse its setup helpers exactly):

```typescript
it('accepts revisedSpec: updates the task spec and uses it as the initialPrompt', async () => {
  // arrange: a task in 'reviewing' with attempt 1, linked to an old session
  // act: invoke dispatch_task with { taskId, revisedSpec: 'attempt 2: fix the build first' }
  // assert: missionsDao.getTask(taskId).spec === 'attempt 2: fix the build first'
  // assert: the captured LaunchPlan's panes[0].initialPrompt === 'attempt 2: fix the build first'
  // assert: task status === 'dispatched', attempt === 2
});

it('appends a task_retried event when dispatching from reviewing', async () => {
  // arrange: task in 'reviewing', attempt 1
  // act: dispatch_task
  // assert: listEvents contains kind 'task_retried' with body JSON {attempt: 2}
});

it('throws at the attempt cap when dispatching from reviewing', async () => {
  // arrange: task in 'reviewing' with attempt 3 (use updateTask({attempt: 3}))
  // act+assert: await expect(invoke(...)).rejects.toThrow(/exhausted its 3 attempts/)
  // assert: NO pane was launched (executeLaunchPlan capture not called), task still 'reviewing'
});

it('fresh-grants a human recovery: blocked → dispatched resets attempt to 1', async () => {
  // arrange: task in 'blocked' with attempt 3
  // act: dispatch_task
  // assert: task.status === 'dispatched', task.attempt === 1 (reset to 0, then incremented)
});

it('fresh-grants needs_input → dispatched the same way', async () => {
  // arrange: task in 'needs_input' with attempt 2 → act → assert attempt === 1
});
```

Write these as REAL tests against the file's existing fake-launch harness (P1b T1's tests already capture `executeLaunchPlan` plans — reuse that seam), not as the comment sketches above.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run <the dispatch_task test file>`
Expected: FAIL — schema rejects `revisedSpec` (unknown key is stripped by zod but spec unchanged), no cap throw, no reset, no event.

- [ ] **Step 3: Implement**

In `src/main/core/assistant/tools.ts`:

Schema (~line 419):

```typescript
const sDispatchTask = z.object({
  taskId: z.string().min(1),
  provider: z.string().optional(),
  workspaceRoot: z.string().optional(),
  revisedSpec: z.string().min(1).optional(),
});
```

Add `MAX_ATTEMPTS` to the existing `../missions/state` import in tools.ts (it already imports `isLegalTaskTransition` from there — extend that import).

Handler — after the existing transition validation (`if (!isLegalTaskTransition(task.status, 'dispatched')) throw ...`), insert:

```typescript
      const from = task.status;
      // P1c — the autonomous retry lane is hard-capped. A review-wake retry
      // (reviewing → dispatched) stops at MAX_ATTEMPTS; a human recovery
      // (blocked | needs_input → dispatched) fresh-grants the counter below,
      // so the cap can never brick an operator's explicit revival.
      if (from === 'reviewing' && task.attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `task ${task.id} has exhausted its ${MAX_ATTEMPTS} attempts — a human must recover it (move it out of blocked)`,
        );
      }
      if (a.revisedSpec) {
        missionsDao.updateTask(task.id, { spec: a.revisedSpec });
      }
      if (from === 'blocked' || from === 'needs_input') {
        missionsDao.updateTask(task.id, { attempt: 0 });
      }
```

Then change the plan's prompt to use the possibly-revised spec — replace `initialPrompt: task.spec,` with:

```typescript
            initialPrompt: a.revisedSpec ?? task.spec,
```

And after the existing `missionsDao.incrementAttempt(task.id);` line, add:

```typescript
      if (from === 'reviewing') {
        missionsDao.appendEvent(
          task.missionId,
          task.id,
          'task_retried',
          JSON.stringify({ attempt: missionsDao.getTask(task.id)!.attempt }),
        );
      }
```

In `src/main/core/assistant/tool-catalogue.ts`, dispatch_task entry — keep parity:

```typescript
  {
    name: 'dispatch_task',
    description:
      'Launch a worktree-isolated pane for a mission task and move it to dispatched. The primitive the supervisor loop uses to hand a task to an agent; pass revisedSpec to retry a reviewed task with corrected instructions.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        provider: { type: 'string' },
        workspaceRoot: { type: 'string' },
        revisedSpec: { type: 'string' },
      },
    },
  },
```

NOTE: the catalogue description changed → `tools.ts`'s `T('dispatch_task', ...)` third argument (the description string) must be updated to the IDENTICAL string, or the parity test fails.

- [ ] **Step 4: Run the tool + parity + catalogue suites**

Run: `npx vitest run <the dispatch_task test file> src/main/core/assistant/tool-catalogue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts <the dispatch_task test file>
git commit -m "feat(missions): dispatch_task retry lane — revisedSpec + reviewing cap + fresh-grant reset (P1c T2)"
```

---

### Task 3: e2e — fail → retry → done, and the cap auto-block

**Files:**
- Modify: `src/main/core/operator/__e2e__/mission-loop.e2e.test.ts`

**Interfaces:**
- Consumes: everything as-built in that file (scripted `runTurn`, `simulateDispatch`, `flush`, fake KV) + Task 1's directive line `Attempt: N of 3`.
- Produces: two new e2e scenarios; `simulateDispatch` gains real-tool parity (`incrementAttempt`).

- [ ] **Step 1: Fix simulateDispatch parity (real tool increments attempt)**

```typescript
/** Mirrors dispatch_task's three DAO writes exactly, minus the real pane spawn. */
function simulateDispatch(taskId: string, sessionId: string): void {
  missionsDao.linkTaskToPane(taskId, sessionId, null);
  missionsDao.moveTask(taskId, 'dispatched');
  missionsDao.incrementAttempt(taskId);
}
```

Run: `npx vitest run src/main/core/operator/__e2e__/mission-loop.e2e.test.ts`
Expected: PASS still (the happy-path test never reaches attempt 3; if the event-trail assertion breaks, incrementAttempt writes no event — it will not break).

- [ ] **Step 2: Write the retry-scenario test (failing only if Tasks 1-2 are wrong)**

Add to the describe block:

```typescript
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
  const supervisor = createSupervisor({ runTurn, readPane });
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
```

- [ ] **Step 3: Write the cap-scenario test**

```typescript
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

  const supervisor = createSupervisor({ runTurn, readPane: vi.fn().mockReturnValue('fail') });
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
```

- [ ] **Step 4: Run the e2e file**

Run: `npx vitest run src/main/core/operator/__e2e__/mission-loop.e2e.test.ts`
Expected: PASS — all 4 tests (2 existing + 2 new).

- [ ] **Step 5: Branch-final full gate**

Run: `npx tsc -b && npx vitest run && npx eslint . --max-warnings 0 && npm run build`
Expected: all green, zero eslint warnings.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/operator/__e2e__/mission-loop.e2e.test.ts
git commit -m "test(missions): e2e retry recovery + MAX_ATTEMPTS auto-block scenarios (P1c T3)"
```
