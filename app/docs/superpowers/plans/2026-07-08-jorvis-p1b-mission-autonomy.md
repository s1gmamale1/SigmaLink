# Jorvis P1b — Mission Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the P1a mission board self-driving — Jorvis dispatches a mission's tasks into worktree-isolated panes, a deterministic watcher notices when a pane finishes, and a budget-capped supervisor wakes the brain to review the result and advance/complete/block the task, looping to done or a blocker with zero per-step human involvement.

**Architecture:** A new `core/operator/` bounded context holds the deterministic autonomy machinery — a pane→task watcher riding the EXISTING `onPaneEvent`/`onCliExited` sinks (zero model calls), a wake scheduler with a global brain-lock + hard per-day budget + quiet hours, and a supervisor that runs each wake as an `assistant.send` turn on a dedicated mission conversation with an injected directive (no new model-spawning path). One new `dispatch_task` tool launches the panes. The model is invoked ONLY through the existing hardened turn engine; everything that can be deterministic (watch, schedule, budget) is.

**Tech Stack:** TypeScript (Electron main), Drizzle/better-sqlite3 (MockDb-tested), Vitest, esbuild. Builds on P1a (`core/missions/` DAO + state machine + tools + `missions.*` RPC, all on main @ bf103f4).

## Global Constraints

- **The model is woken ONLY via the existing `assistant.send` / `invokeAssistantTool` path** — no new CLI spawn, no new model runtime. A wake = an `assistant.send` turn with origin `'autonomous'` on a dedicated per-mission conversation.
- **Autonomy is HARD-CAPPED and fail-safe-OFF.** A global KV flag `missions.autonomy.enabled` (default `'0'`) gates the entire watcher+scheduler; when off, `dispatch_task` still works (manual) but no wake ever fires. A per-day wake budget (`missions.autonomy.dailyWakeBudget`, default 40) and quiet hours (`missions.autonomy.quietHours`, default none) are enforced in the scheduler as hard stops, not suggestions. The existing control kill-switch (`isControlFrozen`) also freezes all wakes+dispatch.
- **Runaway protection is structural:** a task carries `attempt` (P1a column); the supervisor blocks a task at `attempt >= MAX_ATTEMPTS` (default 3) instead of re-dispatching forever. The scheduler dedupes wakes per task and never enqueues a wake for a mission that is terminal (`done`/`failed`/`cancelled`).
- **New origin `'autonomous'`** threads through `invokeAssistantTool` — it sits between `local` and `external`: DANGEROUS-class ops (`close_*`, `kill_swarm`, shell `send_keys`, destructive git) ESCALATE to the operator (reuse the telegram/pending-escalation path); safe/recoverable ops (the mission tools, `read_pane`, `launch_pane`) are free.
- **erasableSyntaxOnly ON; files <~500 lines; read before edit; MockDb only in tests** (better-sqlite3 Electron-ABI unloadable under vitest).
- **New tool = catalogue + blurb + external-authz parity** (P1a lesson): `tools.ts` TOOLS + `tool-catalogue.ts` + the system-prompt blurb + `authz-external.ts` `EXPECTED_VERDICT`/`EXTERNAL_ESCALATE_TOOLS` + the 3 authz test maps. The fail-closed authz test enforces it.
- **Local gate from `app/`:** `npx tsc -b` · `npx vitest run <touched>` then full `npx vitest run` · `npx eslint .` (0 warnings) · `npm run build`. Commit on `feat/jorvis-p1b-mission-autonomy` off `origin/main`. NEVER push/tag/release without the operator.
- **Deterministic over LLM in the runtime path** — watch + schedule + budget are plain code; the model wakes only for the review judgment.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `app/src/main/core/missions/dao.ts` | add `linkTaskToPane`, `incrementAttempt`, `listTasksForSession`, `listActiveMissions` | 1 |
| `app/src/main/core/assistant/tools.ts` + `tool-catalogue.ts` + `system-prompt.ts` | `dispatch_task` tool | 1 |
| `app/src/main/core/control/authz-external.ts` + `authz-external.test.ts` | classify `dispatch_task` (escalate) | 1 |
| `app/src/main/core/operator/watch.ts` (new) | pane-event → task-status watcher (deterministic) | 2 |
| `app/src/main/core/operator/scheduler.ts` (new) | wake queue + global lock + budget + quiet hours | 3 |
| `app/src/main/core/operator/directive.ts` (new) | build the injected wake directive string | 4 |
| `app/src/main/core/operator/supervisor.ts` (new) | run a wake (decompose / review) via assistant.send | 4 |
| `app/src/main/core/assistant/controller.ts` | thread origin `'autonomous'` through the authz gate | 4 |
| `app/src/main/rpc-router.ts` | wire watcher to the real sinks + construct the supervisor/scheduler | 5 |
| `app/src/main/core/operator/__e2e__/mission-loop.e2e.test.ts` (new) | stub-CLI drives a whole mission to done | 5 |

---

## Task 1: `dispatch_task` tool + DAO link helpers

**Files:**
- Modify: `app/src/main/core/missions/dao.ts` (add 4 helpers)
- Modify: `app/src/main/core/assistant/tools.ts` (schema + `dispatch_task` T-entry), `tool-catalogue.ts` (mirror), `system-prompt.ts` (blurb line)
- Modify: `app/src/main/core/control/authz-external.ts` + `authz-external.test.ts` (classify)
- Test: `app/src/main/core/missions/dao.dispatch.test.ts`, `app/src/main/core/assistant/tools.dispatch.test.ts`

**Interfaces:**
- Consumes: P1a DAO (`getTask`, `moveTask`, `appendEvent`), `executeLaunchPlan` (`../workspaces/launcher`), `pickPreset`/`emitDispatchEchoes` (tools.ts).
- Produces:
  - DAO: `linkTaskToPane(taskId, sessionId, worktreePath): MissionTask` (sets assignee_session_id + worktree_path, updated_at). `incrementAttempt(taskId): number` (returns new attempt). `listTasksForSession(sessionId): MissionTask[]` (the watcher's reverse lookup). `listActiveMissions(): Mission[]` (status `active`).
  - Tool `dispatch_task({ taskId, provider?, workspaceRoot? })` → `{ sessionId, taskId, status }`. Reads the task, launches ONE worktree-isolated pane via `executeLaunchPlan` (count 1, `initialPrompt` = the task `spec`, provider defaults to `'claude'`, worktree isolation is the launcher default), links task↔pane, moves the task `backlog|blocked → dispatched → working` (two moves or a direct dispatched then the watcher moves to working — decide: dispatch sets `dispatched`, the pane's `started` event moves to `working` in Task 2), increments `attempt`, emits `missions:changed` + a `dispatch-echo`. Returns the session id.

- [ ] **Step 1: Write the failing DAO test**

Create `dao.dispatch.test.ts` (MockDb, mirror `dao.test.ts`): `linkTaskToPane` sets assignee+worktree; `incrementAttempt` returns 1 then 2; `listTasksForSession` finds the task by its linked session; `listActiveMissions` returns only `active` missions.

```typescript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/missions/dao.dispatch.test.ts`
Expected: FAIL — the helpers aren't exported.

- [ ] **Step 3: Implement the DAO helpers**

Add to `dao.ts` (mirror the existing helper style — `getDb().update(...).set(...).where(eq(...)).run()`, `rowToTask`, `appendEvent`):

```typescript
export function linkTaskToPane(taskId: string, sessionId: string, worktreePath: string | null): MissionTask {
  const task = getTask(taskId);
  if (!task) throw new Error(`mission task not found: ${taskId}`);
  getDb().update(missionTasks)
    .set({ assigneeSessionId: sessionId, worktreePath, updatedAt: Date.now() })
    .where(eq(missionTasks.id, taskId)).run();
  appendEvent(task.missionId, taskId, 'task_dispatched', JSON.stringify({ sessionId, worktreePath }));
  return getTask(taskId)!;
}

export function incrementAttempt(taskId: string): number {
  const task = getTask(taskId);
  if (!task) throw new Error(`mission task not found: ${taskId}`);
  const next = task.attempt + 1;
  getDb().update(missionTasks).set({ attempt: next, updatedAt: Date.now() }).where(eq(missionTasks.id, taskId)).run();
  return next;
}

export function listTasksForSession(sessionId: string): MissionTask[] {
  return getDb().select().from(missionTasks).where(eq(missionTasks.assigneeSessionId, sessionId)).all().map(rowToTask);
}

export function listActiveMissions(): Mission[] {
  return listMissions({ status: 'active' });
}
```

- [ ] **Step 4: Green the DAO test, then write the tool test**

Run: `npx vitest run src/main/core/missions/dao.dispatch.test.ts` → PASS.

Create `tools.dispatch.test.ts` (mirror `tools.missions.test.ts` — `vi.mock('../workspaces/launcher')` returning a fake session, `findTool('dispatch_task')!.handler(...)`): asserts dispatch launches a pane, links the task, moves it to `dispatched`, increments attempt, returns the sessionId; the executeLaunchPlan mock received `initialPrompt` = the task spec.

- [ ] **Step 5: Implement `dispatch_task` + all parity mirrors**

In `tools.ts`: schema `const sDispatchTask = z.object({ taskId: z.string().min(1), provider: z.string().optional(), workspaceRoot: z.string().optional() });`. Add the `T('dispatch_task', ...)` entry: read the task, resolve workspaceRoot (arg → the mission's workspace → `ctx.defaultWorkspaceId`'s root), build a 1-pane `LaunchPlan` with `initialPrompt: task.spec` + `autoApprove` from the Yolo KV (mirror `launch_pane`), `executeLaunchPlan`, `linkTaskToPane(taskId, session.id, session.worktreePath ?? null)`, `moveTask(taskId, 'dispatched')`, `incrementAttempt(taskId)`, `emitDispatchEchoes(...)`, `ctx.emit?.('missions:changed', {})`. Return `{ sessionId, taskId, status: 'dispatched' }`.

Mirror in `tool-catalogue.ts` (byte-identical name+desc+inputSchema) and add a system-prompt blurb line. In `authz-external.ts`, add `'dispatch_task'` to `EXTERNAL_ESCALATE_TOOLS` (it launches a process — escalate for external), and add `dispatch_task: 'escalate'` to the test's `EXPECTED_VERDICT` + the exact-members `EXTERNAL_ESCALATE_TOOLS` assertion + `EXPECTED_EXTERNAL_TOOLS`.

- [ ] **Step 6: Full gate + commit**

Run: `npx vitest run src/main/core/missions src/main/core/assistant src/main/core/control/authz-external.test.ts && npx tsc -b && npx eslint src/main/core/missions/dao.ts src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts src/main/core/assistant/system-prompt.ts src/main/core/control/authz-external.ts`
Expected: PASS + clean (catalogue parity + authz fail-closed both green).

```bash
git add src/main/core/missions/dao.ts src/main/core/missions/dao.dispatch.test.ts \
        src/main/core/assistant/tools.ts src/main/core/assistant/tool-catalogue.ts \
        src/main/core/assistant/system-prompt.ts src/main/core/assistant/tools.dispatch.test.ts \
        src/main/core/control/authz-external.ts src/main/core/control/authz-external.test.ts
git commit -m "feat(missions): dispatch_task tool — launch a worktree pane per task + DAO link helpers (P1b)"
```

---

## Task 2: the pane→task watcher (deterministic, zero model calls)

**Files:**
- Create: `app/src/main/core/operator/watch.ts`
- Test: `app/src/main/core/operator/watch.test.ts`

**Interfaces:**
- Consumes: P1a/Task-1 DAO (`listTasksForSession`, `moveTask`, `getTask`, `appendEvent`), a `WakeQueue` interface (Task 3, DI'd — `{ enqueue(kind, missionId, taskId?): void }`).
- Produces: `createMissionWatcher(deps: { enqueue: WakeEnqueue; isEnabled: () => boolean }): { onPaneEvent(event: PaneLikeEvent): void }`. `PaneLikeEvent = { sessionId: string; kind: 'started'|'exited'|'error'|'idle'|'cli-exited'; exitCode?: number }`. On each event: if `!isEnabled()` return (autonomy off). Look up the task by `listTasksForSession(sessionId)`; if none, return (not a mission pane). Then:
  - `kind === 'started'` → move task `dispatched → working` (best-effort; ignore illegal-transition throw).
  - `kind === 'exited' | 'cli-exited' | 'error' | 'idle'` → if the task is `working`/`dispatched`, move it to `reviewing`, append a `task_awaiting_review` event, and `enqueue('review', missionId, taskId)`. This is the "deterministic watch → enqueue a wake" step (zero tokens).
- Idempotent: a second terminal event for an already-`reviewing` task does nothing (moveTask `reviewing→reviewing` is a legal no-op; don't double-enqueue — guard by checking the pre-move status).

- [ ] **Step 1: Write the failing watcher test**

Create `watch.test.ts`: a fake DAO (or MockDb-backed) + a spy `enqueue`. Assert: a `started` event moves the linked task to `working`; an `exited` event on a `working` task moves it to `reviewing` + enqueues one `review` wake; a terminal event on an unlinked session does nothing; when `isEnabled()` is false nothing happens; a double `exited` enqueues only once.

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `watch.ts`** per the interface. Keep it pure over its DI'd deps (no direct getDb — take the DAO functions or the whole dao module; prefer importing the dao module directly and DI only `enqueue` + `isEnabled`, matching how the codebase imports dao modules directly). Guard every `moveTask` in try/catch (an illegal transition from a racing event must not throw out of the sink).

- [ ] **Step 4: Green + commit**

```bash
git add src/main/core/operator/watch.ts src/main/core/operator/watch.test.ts
git commit -m "feat(operator): deterministic pane→task watcher — mark reviewing + enqueue a wake (P1b)"
```

---

## Task 3: the wake scheduler (queue + global lock + budget + quiet hours)

**Files:**
- Create: `app/src/main/core/operator/scheduler.ts`
- Test: `app/src/main/core/operator/scheduler.test.ts`

**Interfaces:**
- Consumes: a `runWake` callback (Task 4, DI'd — `(wake: Wake) => Promise<void>`), a `kvGet`/`kvSet` pair (DI'd), a `now()` clock (DI'd for testability — the repo forbids argless `Date.now()` in some seams; inject it).
- Produces: `createWakeScheduler(deps): WakeScheduler` with `{ enqueue(kind: 'decompose'|'review', missionId, taskId?): void; wakesSpentToday(): number }`. Behavior:
  - `enqueue` pushes a wake and, if no wake is currently running (the global lock is free), starts draining.
  - Drain: dequeue one wake → check gates in order: `isEnabled()` (KV `missions.autonomy.enabled==='1'`), NOT `isFrozen()` (control kill-switch), NOT in quiet hours (KV `missions.autonomy.quietHours` = `"22-8"` style, using the injected clock), budget not exhausted (`wakesSpentToday() < dailyBudget`). If any gate fails, DROP the wake (log a `mission_event` so it's visible) and continue draining the rest (they'll hit the same gate). If all gates pass: set the lock, `await runWake(wake)`, increment the day's spent counter in KV (keyed by the local date), release the lock, drain the next.
  - Global lock = one wake at a time (no concurrent brain turns).
  - Dedupe: a `review` wake for a taskId already queued/running is not re-added.

- [ ] **Step 1: Write the failing scheduler test** — cases: enqueue→runWake called; budget-exhausted drops the wake (runWake NOT called past the cap); disabled flag drops all; quiet-hours drops; the global lock serializes (two enqueues while the first runWake is pending → second waits); dedupe (same taskId twice → one run). Use fake KV + injected clock + a controllable `runWake` promise.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `scheduler.ts`.** The day-key for budget is `new Date(now()).toISOString().slice(0,10)` (inject `now`); reset happens implicitly by keying the KV counter on the date. Quiet-hours parse: `"22-8"` → active when hour ≥ 22 OR hour < 8. Keep it under 500 lines; pure except the DI'd KV/clock/runWake.

- [ ] **Step 4: Green + commit**

```bash
git add src/main/core/operator/scheduler.ts src/main/core/operator/scheduler.test.ts
git commit -m "feat(operator): wake scheduler — global lock + daily budget + quiet hours hard caps (P1b)"
```

---

## Task 4: the supervisor wake runner (model-in-the-loop, via assistant.send)

**Files:**
- Create: `app/src/main/core/operator/directive.ts`, `app/src/main/core/operator/supervisor.ts`
- Modify: `app/src/main/core/assistant/controller.ts` (accept origin `'autonomous'` on send + thread it to the authz gate)
- Test: `app/src/main/core/operator/directive.test.ts`, `app/src/main/core/operator/supervisor.test.ts`

**Interfaces:**
- Consumes: the DAO, `assistant.send` (DI'd as `runTurn: (input: { conversationId: string; prompt: string; origin: 'autonomous' }) => Promise<{ turnId: string }>`), `MAX_ATTEMPTS` const.
- Produces:
  - `directive.ts`: `buildDecomposeDirective(mission): string` and `buildReviewDirective(mission, task, paneExcerpt): string` — the injected prompts. Pure string builders (fully testable). The review directive tells the brain: here is the task spec, here is the pane's recent output (already read by the supervisor via `read_pane` before the wake), verdict via the mission tools — call `move_mission_task` to `done` (advance the next task via `dispatch_task`), `working` (re-prompt — the supervisor re-dispatches), or `blocked` (escalate). The directive NEVER contains secrets — pane excerpt is capped + it's the operator's own workspace.
  - `supervisor.ts`: `createSupervisor(deps): { runWake(wake: Wake): Promise<void> }`. For a `decompose` wake: ensure the mission has a conversation (create one if absent — a dedicated per-mission `kind:'assistant'` conversation, workspace-less/global), `runTurn` with the decompose directive. For a `review` wake: load the task; if `attempt >= MAX_ATTEMPTS` move it straight to `blocked` + append event + return (NO model call — the runaway stop); else read the pane excerpt (DI'd `readPane(sessionId): string`), `runTurn` with the review directive. The brain's tool calls (move_mission_task/dispatch_task/complete_mission) do the actual board mutation — the supervisor just frames the wake.
- `controller.ts`: `send`'s `origin` union gains `'autonomous'`; it's threaded to `invokeAssistantTool` exactly like `'telegram'`. In the authz gate, `origin==='autonomous'` routes DANGEROUS_REMOTE-class tools through the escalation path (reuse `confirmDangerous`/pendingEscalations) and lets the rest run free — mirror the `'telegram'` branch, sharing its gate.

- [ ] **Step 1: Write the failing directive test** — `buildReviewDirective` includes the task spec, the pane excerpt, and names the three verdict tools; caps the excerpt length; `buildDecomposeDirective` includes the mission goal. Pure assertions.

- [ ] **Step 2: Write the failing supervisor test** — DI'd fake `runTurn` spy + fake `readPane`: a `review` wake at attempt < MAX calls `runTurn` once with the review directive; a `review` wake at attempt >= MAX moves the task to `blocked` and does NOT call `runTurn` (the runaway stop); a `decompose` wake creates a conversation + calls `runTurn` with the decompose directive.

- [ ] **Step 3: Implement `directive.ts` then `supervisor.ts` then the `controller.ts` origin thread.** For the `'autonomous'` origin in controller.ts, share the existing telegram DANGEROUS_REMOTE branch (rename the condition to `origin === 'telegram' || origin === 'autonomous'` where it gates DANGEROUS_REMOTE, so both escalate identically) — verify against the existing gate structure and mirror it exactly; add a controller test that an autonomous-origin DANGEROUS tool call escalates.

- [ ] **Step 4: Green all three + commit**

```bash
git add src/main/core/operator/directive.ts src/main/core/operator/directive.test.ts \
        src/main/core/operator/supervisor.ts src/main/core/operator/supervisor.test.ts \
        src/main/core/assistant/controller.ts src/main/core/assistant/controller.autonomous.test.ts
git commit -m "feat(operator): supervisor wake runner + autonomous origin — review/decompose via assistant.send, MAX_ATTEMPTS stop (P1b)"
```

---

## Task 5: wire it live + stub-CLI e2e

**Files:**
- Modify: `app/src/main/rpc-router.ts` (construct scheduler+watcher+supervisor; feed the watcher from the existing `onPaneEvent`/`onCliExited` sinks; KV defaults)
- Create: `app/src/main/core/operator/__e2e__/mission-loop.e2e.test.ts`
- Modify: `app/src/main/core/db/migrations/0040_missions_autonomy_kv.ts` (+ test) — seed the KV defaults (`missions.autonomy.enabled='0'`, budget, MAX_ATTEMPTS) idempotently, mirroring `0038_os_notify_default_on.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the live wiring. In `rpc-router.ts`, after the assistant controller is built (~`:2634`): construct the scheduler (KV-backed budget/quiet-hours, `isControlFrozen` as `isFrozen`, the real assistant `send` as `runTurn`), the supervisor (DAO + `read_pane` via the controller's invokeTool), and the watcher (DI'd `enqueue` = scheduler.enqueue, `isEnabled` = KV read). In the existing `onPaneEvent` sink (~`:961`) AND `onCliExited` (~`:1018`), after the existing jorvis_pane_events + notification logic, call `missionWatcher.onPaneEvent({ sessionId, kind, exitCode })`. Wrap in try/catch (a watcher throw must never break the pane-event pipeline). When a mission is CREATED as `active` (or a `create_mission`+first `add_mission_task` lands), the decompose wake is enqueued — simplest: `create_mission` moves the mission to `active` and enqueues a `decompose` wake through a DI'd hook on the tool context (add `ctx.onMissionCreated?(missionId)` wired to `scheduler.enqueue('decompose', missionId)`).

- [ ] **Step 1: Write the migration + its test** (mirror `0038`): idempotent `INSERT OR IGNORE` of the three KV defaults. Register in `migrate.ts`.

- [ ] **Step 2: Write the stub-CLI e2e** — `mission-loop.e2e.test.ts`: a fake `claude` turn runner (not a real binary — a scripted `runTurn` that, when handed a decompose directive, calls the mission tools to add 2 tasks + dispatch the first; when handed a review directive, calls `move_mission_task` done + dispatches/completes). Drive: create an active mission → decompose wake → dispatch → simulate a pane `exited` event → watcher marks reviewing + enqueues review → review wake → task done → next task → mission `done`. Assert the mission reaches `done` with zero real CLI spawns and the event log shows the full trail. This proves the whole loop token-free.

- [ ] **Step 3: Implement the wiring.** Keep the rpc-router additions tight (it's already large). The watcher/scheduler/supervisor construction is ~20 lines; the two sink call-sites are one line each.

- [ ] **Step 4: Full gate + commit**

Run: `npx tsc -b && npx vitest run && npx eslint . && npm run build`
Expected: all green.

```bash
git add src/main/core/operator src/main/rpc-router.ts src/main/core/db/migrations/0040_missions_autonomy_kv.ts src/main/core/db/migrations/0040_missions_autonomy_kv.test.ts src/main/core/db/migrate.ts
git commit -m "feat(operator): wire watcher→scheduler→supervisor live + KV defaults + stub-CLI mission-loop e2e (P1b)"
```

---

## Task 6: full gate + phase verification

- [ ] **Step 1: Full local gate** — `npx tsc -b && npx vitest run && npx eslint . && npm run build` (re-run vitest once if a single unrelated under-load flake appears — known class).

- [ ] **Step 2: Manual smoke (operator, needs a live app + real claude)** — enable autonomy (`missions.autonomy.enabled=1`), ask Jorvis to run a small real mission; watch the board self-drive: a task dispatches into a worktree pane, the pane finishes, the task flips to reviewing then done without you touching it, the next task dispatches, the mission completes with a report. Verify the budget cap stops it after N wakes and quiet hours suppress wakes.

- [ ] **Step 3: Definition-of-done check (ROADMAP Phase 20)** — "the stub-CLI e2e runs a 3-task mission to `done` with zero human input; a deliberately-failing task lands `blocked` with an escalation; wake budget hard-cap test passes." All three are covered (Task 5 e2e, the MAX_ATTEMPTS block in Task 4, the budget test in Task 3).

---

## Self-Review notes (author)

- **Spec §6 P1.4 coverage:** decompose wake → Task 4 supervisor + Task 5 create-hook; deterministic watch → Task 2; review wake (advance/done/blocked) → Task 4 directive + the brain's tool calls; loop-to-done → the e2e (Task 5). Wake scheduler + budget → Task 3. `dispatch_task` → Task 1. Stub-CLI e2e → Task 5. autonomous origin → Task 4. All P1.4 items mapped.
- **Safety is the through-line:** autonomy default-OFF (KV), hard daily budget + quiet hours (Task 3, tested), MAX_ATTEMPTS block instead of infinite re-dispatch (Task 4, tested), global brain-lock (one wake at a time), kill-switch freezes everything, autonomous-origin dangerous ops escalate (Task 4). The e2e proves the loop terminates.
- **No new model path:** every wake is `assistant.send` with origin `'autonomous'` — reuses the P0-hardened turn engine (concurrent-turn guard, error surface, envelope tolerance) for free.
- **Grep-at-execution unknowns (flagged):** the exact `onMissionCreated` hook wiring on ToolContext (Task 5 — mirror how `ctx.emit` is threaded); the exact controller authz-gate structure to share between telegram+autonomous (Task 4 Step 3 — read the gate first); whether the e2e belongs in the standard vitest project or needs a separate config (Task 5 — check if any `__e2e__` pattern exists; if not, a plain `.test.ts` under vitest is fine since it's stub-driven, no real spawn).
- **Type consistency:** `Wake = { kind: 'decompose'|'review'; missionId: string; taskId?: string }` defined in Task 3, consumed by Task 4's `runWake`. `MissionTaskStatus` values reused from P1a. `MAX_ATTEMPTS` const shared (define in supervisor.ts, import where needed).
