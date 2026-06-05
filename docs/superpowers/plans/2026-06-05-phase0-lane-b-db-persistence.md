# Phase 0 Lane B — DB infra + persistence (CRIT-2 + CRIT-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SigmaLink always launch after a crash/force-quit (no post-crash UNIQUE lockout), never leak a worktree on a suppressed spawn, and never silently lose which workspaces were open.

**Architecture:** Three intertwined root causes, fixed in DB + boot + spawn + persistence layers. (1) The partial unique index `agent_sessions_ws_pane_uq` is status-agnostic while the allocator is live-only → after a crash, exited rows keep `pane_index` and the index rejects every fresh INSERT → permanent lockout. Fix = make the index **status-aware** so its notion of "slot occupied" matches the allocator (ADR-005). (2) The boot janitor only sweeps `'running'` zombies (not `'starting'`) and is **fire-and-forgotten** before `createWindow` → stale slots survive boot. Fix = sweep both statuses + **await** the janitor and the all-repo worktree sweep before the window. (3) On the UNIQUE-suppress path both spawn twins leak the just-created worktree. Fix = `removeAndPrune`. (4) `app.lastSession` flushes only in `before-quit`, which SIGKILL skips. Fix = throttled opportunistic flush on the snapshot IPC.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3 + Drizzle ORM, vitest (DB code is tested with hand-rolled Mock/RecordingDb because better-sqlite3 cannot load under vitest), node-pty.

---

## EXECUTION CONTEXT — read before starting

- **Work in the MAIN working tree** at `/Users/aisigma/projects/SigmaLink/app` — do **NOT** create a fresh git worktree. Lane B depends on **Lane A's uncommitted primitives** (`WorktreePool.removeAndPrune`, `sweepAllReposOnBoot`, `WorktreeDiskGuardError`, the cap/floor guards) that currently live only on the working tree. A fresh worktree off `HEAD` (434b42d) would not have them and would fail to compile.
- Lane B's files are **disjoint** from Lane A's files (`core/git/worktree.ts`, `core/workspaces/worktree-cleanup.ts`). Never edit those two files.
- **Commit Lane B files explicitly by path** (`git add <file> <file>`), never `git add -A` / `git add .` — that would sweep Lane A's in-progress changes into Lane B commits.
- Gate after each task: `npx tsc -b` then the task's vitest file. Full gate before done: `npx tsc -b && npx vitest run && npm run lint && npm run build`, then `npx playwright test tests/e2e/`.
- The `migrate()` runner wraps each migration `up()` in its own `db.transaction(...)` (H-7). Migrations MUST NOT emit `BEGIN`/`COMMIT`/`ROLLBACK`.

---

## Task 1: Status-aware unique index (migration 0032)

Fixes the post-crash lockout root cause (CRIT-2 / ADR-005). The new predicate is a strict subset of the old one, so dropping the old index can never surface a violation the recreate would reject — no dedup step needed.

**Files:**
- Create: `src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.ts`
- Create: `src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.test.ts`
- Modify: `src/main/core/db/migrate.ts` (import + `ALL_MIGRATIONS`)
- Modify: `src/main/core/db/schema.ts` (comment on `wsPaneUq`, ~lines 98-105)

- [ ] **Step 1: Write the failing test**

Create `0032_agent_session_pane_uq_status_aware.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { name, up } from './0032_agent_session_pane_uq_status_aware';

// better-sqlite3 cannot load under vitest — record exec'd DDL on a mock.
class MockDb {
  execed: string[] = [];
  exec(sql: string): void {
    const t = sql.trim();
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') {
      throw new Error(`migration must not manage its own txn: ${t}`);
    }
    this.execed.push(t.replace(/\s+/g, ' '));
  }
}

function run(): MockDb {
  const db = new MockDb();
  up(db as unknown as Parameters<typeof up>[0]);
  return db;
}

describe('0032_agent_session_pane_uq_status_aware', () => {
  it('has the expected name', () => {
    expect(name).toBe('0032_agent_session_pane_uq_status_aware');
  });

  it('drops the old index, then recreates it status-aware', () => {
    const db = run();
    const dropAt = db.execed.findIndex((s) => /DROP INDEX/i.test(s));
    const createAt = db.execed.findIndex((s) => /CREATE UNIQUE INDEX/i.test(s));
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(db.execed[createAt]).toMatch(
      /agent_sessions_ws_pane_uq.*workspace_id, pane_index.*WHERE pane_index IS NOT NULL AND status IN \('running', 'starting'\)/i,
    );
  });

  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });

  it('is idempotent (IF EXISTS / IF NOT EXISTS) on re-run', () => {
    const db = new MockDb();
    up(db as unknown as Parameters<typeof up>[0]);
    up(db as unknown as Parameters<typeof up>[0]);
    expect(db.execed.filter((s) => /CREATE UNIQUE INDEX/i.test(s)).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.test.ts`
Expected: FAIL — cannot find module `./0032_agent_session_pane_uq_status_aware`.

- [ ] **Step 3: Write the migration**

Create `0032_agent_session_pane_uq_status_aware.ts`:

```typescript
// 0032 — ADR-005: make agent_sessions_ws_pane_uq STATUS-AWARE.
//
// Migration 0020 created this partial unique index on
// (workspace_id, pane_index) for ALL rows with pane_index IS NOT NULL,
// regardless of status. The pane-slot allocator (allocateLowestFreeLivePaneIndex)
// counts a slot occupied only for status IN ('running','starting'). The two
// disagreed: after a crash, exited rows kept pane_index and the status-agnostic
// index rejected every fresh INSERT into that slot -> permanent post-crash
// launch lockout (CRIT-2).
//
// This drops and recreates the index with the SAME predicate the allocator
// uses, so an 'exited'/'error' row no longer occupies the slot. The new
// predicate is a strict subset of the old one (it constrains FEWER rows), so
// dropping the old index can never introduce a violation the recreate rejects
// -> no dedup step is needed (unlike 0020).
//
// H-7: migrate() wraps each up() in a transaction; do NOT emit BEGIN/COMMIT.
import type Database from 'better-sqlite3';

export const name = '0032_agent_session_pane_uq_status_aware';

export function up(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS agent_sessions_ws_pane_uq`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_ws_pane_uq
      ON agent_sessions(workspace_id, pane_index)
      WHERE pane_index IS NOT NULL
        AND status IN ('running', 'starting')
  `);
}
```

> If `0020`'s import style differs (e.g. `import Database from 'better-sqlite3'` without `type`), match `0020_agent_session_pane_unique.ts` exactly so `tsc` stays consistent.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the migration**

In `src/main/core/db/migrate.ts`, add the import after the `mig0031` import line:

```typescript
import * as mig0032 from './migrations/0032_agent_session_pane_uq_status_aware';
```

And append `mig0032` to `ALL_MIGRATIONS` immediately after `mig0031` (keep `0026` unregistered):

```typescript
  mig0027, mig0028, mig0029, mig0030, mig0031,
  mig0032,
];
```

- [ ] **Step 6: Update the schema.ts comment**

In `src/main/core/db/schema.ts`, replace the comment above `wsPaneUq` (the v1.5.5 Cluster A comment, ~lines 98-101) so it records that the live DDL is status-aware and owned by migration 0032 (Drizzle's `uniqueIndex().on()` cannot express the partial `WHERE status IN (...)` predicate, so the Drizzle declaration is intentionally a superset of the real index):

```typescript
    // v1.5.5 Cluster A + ADR-005 — uniqueness on (workspace_id, pane_index).
    // The LIVE index is STATUS-AWARE: it only enforces uniqueness for
    // pane_index IS NOT NULL AND status IN ('running','starting') so that an
    // exited/error row keeps its pane_index (for resume) without blocking a
    // fresh spawn into that slot (CRIT-2 post-crash lockout). Drizzle's
    // uniqueIndex().on() cannot express the partial WHERE, so the real DDL is
    // owned by migration 0032; this declaration is intentionally a superset.
```

(Leave the `wsPaneUq: uniqueIndex(...).on(t.workspaceId, t.paneIndex)` line itself unchanged — schema.ts is not applied directly; migrations own the DDL.)

- [ ] **Step 7: Gate**

Run: `npx tsc -b && npx vitest run src/main/core/db/`
Expected: tsc clean; migration + existing db tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.ts \
        src/main/core/db/migrations/0032_agent_session_pane_uq_status_aware.test.ts \
        src/main/core/db/migrate.ts src/main/core/db/schema.ts
git commit -m "fix(db): status-aware agent_sessions pane-slot unique index (CRIT-2, ADR-005, migration 0032)"
```

---

## Task 2: Boot janitor sweeps 'starting' zombies (keep pane_index)

The janitor today only marks `status='running'` zombies exited; a crash mid-spawn leaves `'starting'` rows that keep occupying their slot (the allocator counts `'starting'`). Sweep both. `pane_index` is already preserved (the janitor never sets it) — keep it that way.

**Files:**
- Modify: `src/main/core/db/janitor.ts` (~lines 13, 30-45)
- Create: `src/main/core/db/janitor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `janitor.test.ts`. The janitor calls `getDb()` (a Drizzle instance) and `getRawDb()` for the prune step. Mock the module that exports them — **first read the top of `janitor.ts` to confirm the exact import path** (e.g. `./connection`, `./client`, `./index`), then use it in the `vi.mock` below.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Chainable Drizzle stub: db.select().from(t).where(c).all() and
// db.update(t).set(v).where(c).run().
const updates: Array<Record<string, unknown>> = [];
let zombieRows: Array<{ id: string; status: string; pane_index: number | null }> = [];

const fakeDrizzle = {
  select: () => ({
    from: () => ({
      where: () => ({ all: () => zombieRows }),
    }),
  }),
  update: () => ({
    set: (vals: Record<string, unknown>) => ({
      where: () => ({ run: () => updates.push(vals) }),
    }),
  }),
};

const fakeRaw = {
  prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
};

// IMPORTANT: replace './connection' with the real module path janitor.ts
// imports getDb/getRawDb from (read janitor.ts line ~1-15 to confirm).
vi.mock('./connection', () => ({
  getDb: () => fakeDrizzle,
  getRawDb: () => fakeRaw,
}));

import { runBootJanitor } from './janitor';

beforeEach(() => {
  updates.length = 0;
});

describe('runBootJanitor', () => {
  it('marks BOTH running and starting zombies exited, preserving pane_index', async () => {
    zombieRows = [
      { id: 'a', status: 'running', pane_index: 0 },
      { id: 'b', status: 'starting', pane_index: 1 },
    ];
    const report = await runBootJanitor();
    expect(report.zombieSessionsMarked).toBe(2);
    // every update sets status='exited' and never touches pane_index
    for (const u of updates) {
      expect(u.status).toBe('exited');
      expect(u).not.toHaveProperty('paneIndex');
      expect(u).not.toHaveProperty('pane_index');
    }
  });

  it('marks nothing when there are no zombies', async () => {
    zombieRows = [];
    const report = await runBootJanitor();
    expect(report.zombieSessionsMarked).toBe(0);
    expect(updates.length).toBe(0);
  });
});
```

> If the `vi.mock` chain shape doesn't match how the janitor builds its query (e.g. it uses `.get()` not `.all()`, or a different prune path), adjust the stub to mirror the real chain in `janitor.ts` — keep the assertions.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/core/db/janitor.test.ts`
Expected: FAIL — only the `'running'` zombie is marked (1, not 2), because the query filters `eq(status,'running')`.

- [ ] **Step 3: Make the janitor sweep both statuses**

In `src/main/core/db/janitor.ts`:

Add `inArray` to the drizzle-orm import (it already imports `eq`, `and`):

```typescript
import { and, eq, inArray } from 'drizzle-orm';
```

Change the zombie SELECT (currently `.where(eq(agentSessions.status, 'running'))`, ~line 37):

```typescript
    .where(inArray(agentSessions.status, ['running', 'starting']))
```

Change the per-row update guard (currently `and(eq(agentSessions.id, row.id), eq(agentSessions.status, 'running'))`, ~line 43):

```typescript
      .where(
        and(
          eq(agentSessions.id, row.id),
          inArray(agentSessions.status, ['running', 'starting']),
        ),
      )
```

Leave the `.set({ status: 'exited', exitCode: -1, exitedAt: now })` exactly as-is — it must NOT touch `pane_index`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/core/db/janitor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Gate + commit**

```bash
npx tsc -b
git add src/main/core/db/janitor.ts src/main/core/db/janitor.test.ts
git commit -m "fix(db): boot janitor sweeps 'starting' zombies too, preserving pane_index (CRIT-2)"
```

---

## Task 3: Await boot janitor + all-repo worktree sweep before the window

`runBootJanitor()` is fire-and-forgotten (`void` at rpc-router.ts:276) and `sweepAllReposOnBoot` (Lane A, already implemented + tested) is never called. Make both run, awaited, before `createWindow()` / auto-resume.

**Files:**
- Modify: `src/main/rpc-router.ts` (~lines 13, 271-296, 2093-2095)
- Modify: `src/main/electron/main.ts` (~lines 736-754; `whenReady().then` + `registerRouter` call site)

- [ ] **Step 1: Find the worktree base expression**

Read `src/main/rpc-router.ts` around line 295 where `new WorktreePool({...})` is constructed and note the base directory expression it is given (e.g. `path.join(userData, 'worktrees')`). The sweep must use the **same base**. Also confirm whether `sweepAllReposOnBoot` is already imported (it is not — `cleanupOrphanWorktrees` is, at ~line 39).

- [ ] **Step 2: Import the sweep + await the janitor and sweep**

In `src/main/rpc-router.ts`:

Add to the worktree-cleanup import (alongside `cleanupOrphanWorktrees`):

```typescript
import { cleanupOrphanWorktrees, sweepAllReposOnBoot } from './core/workspaces/worktree-cleanup';
```

Make `buildRouter` async (line ~271) — `function buildRouter()` → `async function buildRouter()`.

Replace the fire-and-forget janitor block (lines ~275-278) with an awaited janitor + awaited boot sweep. Use the same `<WORKTREE_BASE>` expression found in Step 1:

```typescript
  // Boot recovery (CRIT-2/CRIT-1): clear zombie pane-slots and reap leaked
  // worktrees BEFORE any window/auto-resume so fresh spawns aren't locked out
  // and the disk can't carry orphaned checkouts. Both are best-effort and must
  // never block startup.
  await runBootJanitor().catch((err) => {
    console.warn('[boot] janitor failed (non-fatal):', err);
  });
  await sweepAllReposOnBoot(<WORKTREE_BASE>, getRawDb()).catch((err) => {
    console.warn('[boot] worktree sweep failed (non-fatal):', err);
  });
```

> If `<WORKTREE_BASE>` is only computed inside the `new WorktreePool(...)` call below this point, hoist that base expression to a `const worktreeBase = ...;` above the janitor block and reuse it in both the sweep and the `WorktreePool` constructor.

- [ ] **Step 3: Propagate async through registerRouter**

In `src/main/rpc-router.ts` (~lines 2093-2095), make `registerRouter` async and await `buildRouter`:

```typescript
export async function registerRouter(): Promise<void> {
  if (router) return;
  router = await buildRouter();
  // ...rest unchanged...
}
```

Search the file for any other synchronous use of `registerRouter()` or immediate post-`registerRouter` access to `router`; there should be none beyond `main.ts`. If `buildRouter` returns a value used synchronously right after, confirm it's now awaited.

- [ ] **Step 4: Await registerRouter in main.ts before createWindow**

In `src/main/electron/main.ts`, the `app.whenReady().then(() => {...})` (~line 736): make the callback async and await `registerRouter()` before `createWindow()`:

```typescript
void app.whenReady().then(async () => {
  bootstrapShellPath();
  bootstrapNodeToolPath();

  const checks = checkNativeModules();
  if (checks.some((c) => !c.ok)) {
    showDiagnosticWindow(checks);
    return;
  }
  await registerRouter();
  createWindow();
  // ...rest unchanged...
});
```

- [ ] **Step 5: Gate**

Run: `npx tsc -b`
Expected: clean. (No new unit test here — this is boot wiring; the behavior is covered by Task 1/2 units and the operator force-quit smoke in the DoD. Verify nothing else depended on the janitor's old un-awaited timing.)

Run: `npx vitest run src/main/` (smoke that nothing regressed).

- [ ] **Step 6: Commit**

```bash
git add src/main/rpc-router.ts src/main/electron/main.ts
git commit -m "fix(boot): await runBootJanitor + sweepAllReposOnBoot before window (CRIT-2/CRIT-1)"
```

---

## Task 4: factory-spawn.ts — clean up the worktree on a suppressed spawn (twin A)

On a UNIQUE violation the catch kills+forgets the PTY but **leaks the worktree** created earlier. Add a best-effort `removeAndPrune`. (With Task 1's status-aware index, a UNIQUE violation now means a genuinely live occupant, so hard-suppress is correct — we only need to stop leaking the worktree.)

**Files:**
- Modify: `src/main/core/swarms/factory-spawn.ts` (UNIQUE catch ~lines 321-348)
- Modify: `src/main/core/swarms/factory-spawn.test.ts`

- [ ] **Step 1: Write the failing test**

Read `factory-spawn.test.ts` first and mirror its existing `makeDeps`/`makeArgs` + db-mock setup. Add a case that exercises `repoMode:'git'` and forces a UNIQUE error from the INSERT, then asserts the worktree is cleaned up. Sketch:

```typescript
it('removeAndPrune is called when a git-repo spawn hits a UNIQUE violation', async () => {
  const removeAndPrune = vi.fn().mockResolvedValue(undefined);
  const deps = makeDeps(registry);
  deps.worktreePool = {
    create: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/wt/pane-0', branch: 'b', sessionId: 's1',
    }),
    removeAndPrune,
  } as unknown as SwarmFactoryDeps['worktreePool'];

  // Force the INSERT transaction to throw a UNIQUE violation. Mirror however
  // this test file provides getRawDb()/the db; make its .transaction(fn) throw
  // new Error('UNIQUE constraint failed: agent_sessions.workspace_id') once.
  forceUniqueViolationOnInsert();

  const args = makeArgs(deps);
  (args.wsRow as { repoMode: string; repoRoot: string }).repoMode = 'git';
  (args.wsRow as { repoMode: string; repoRoot: string }).repoRoot = '/tmp/repo';

  const res = await spawnAgentSession(args);
  expect(res.paneIndex).toBe(-1);                       // still suppressed
  expect(removeAndPrune).toHaveBeenCalledWith('/tmp/repo', '/tmp/wt/pane-0');
  expect(registry.kill).toHaveBeenCalled();             // PTY still torn down
});
```

> `forceUniqueViolationOnInsert()` / `getRawDb` access must follow the file's existing mocking approach — read the file and adapt. If the suite has no db mock yet for the git path, add the minimal one needed to make `.transaction(fn)` run `fn` and throw the UNIQUE error.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts`
Expected: FAIL — `removeAndPrune` not called (the worktree is leaked today).

- [ ] **Step 3: Add the cleanup to the UNIQUE catch**

In `src/main/core/swarms/factory-spawn.ts`, inside the `if (/UNIQUE constraint failed/i.test(msg)) {` branch, after the existing `pty.kill`/`pty.forget` best-effort calls and BEFORE `return { sessionId: rec.id, paneIndex: -1 };`, add:

```typescript
      // CRIT-1/CRIT-2: the worktree was created before this INSERT. A suppressed
      // spawn must not leak it (the 49 GB disk-fill class). Best-effort remove
      // + prune; never let cleanup throw out of the suppression branch.
      if (worktreePath && args.wsRow.repoRoot) {
        try {
          await args.deps.worktreePool.removeAndPrune(args.wsRow.repoRoot, worktreePath);
        } catch {
          /* best-effort — the boot sweep is the backstop */
        }
      }
```

(Confirm `worktreePath` and `args.wsRow.repoRoot` are in scope at the catch — they are, set in the `repoMode==='git'` branch earlier in the same function.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/core/swarms/factory-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npx tsc -b
git add src/main/core/swarms/factory-spawn.ts src/main/core/swarms/factory-spawn.test.ts
git commit -m "fix(spawn): removeAndPrune the worktree on suppressed factory spawn (CRIT-1/CRIT-2)"
```

---

## Task 5: launcher.ts — clean up the worktree on a suppressed spawn (twin B)

Identical fix to Task 4 in the sibling twin. **Change BOTH — this is a known mirror-drift trap.** The launcher's UNIQUE branch `continue`s and never reaches the outer `catch` that holds the only `worktreePool.remove`, so it leaks too.

**Files:**
- Modify: `src/main/core/workspaces/launcher.ts` (UNIQUE catch ~lines 509-547)
- Modify (or create): `src/main/core/workspaces/launcher.test.ts`

- [ ] **Step 1: Write the failing test**

If `launcher.test.ts` exists, mirror its deps/mocks; otherwise add a focused test. Exercise a git-repo launch whose INSERT throws UNIQUE; assert `removeAndPrune` is called and an error session is pushed. Sketch:

```typescript
it('removeAndPrune is called when a git-repo launch hits a UNIQUE violation', async () => {
  const removeAndPrune = vi.fn().mockResolvedValue(undefined);
  const deps = makeLauncherDeps();
  deps.worktreePool = {
    create: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/wt/pane-0', branch: 'b', sessionId: 's1',
    }),
    remove: vi.fn(),
    removeAndPrune,
  } as unknown as typeof deps.worktreePool;

  forceUniqueViolationOnInsert();              // mirror the file's db mock

  const result = await executeLaunchPlan(/* git-repo plan, one pane */);
  expect(removeAndPrune).toHaveBeenCalledWith('/tmp/repo', '/tmp/wt/pane-0');
  expect(result.find((s) => s.status === 'error')).toBeTruthy();
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts`
Expected: FAIL — `removeAndPrune` not called.

- [ ] **Step 3: Add the cleanup to the UNIQUE catch**

In `src/main/core/workspaces/launcher.ts`, inside the `if (/UNIQUE constraint failed/i.test(msg)) {` branch, after the existing `pty.kill`/`pty.forget` and the `sessions.push({... status:'error' ...})`, and BEFORE `continue;`, add:

```typescript
          // CRIT-1/CRIT-2: the UNIQUE branch `continue`s and never reaches the
          // outer catch's worktreePool.remove, so it leaks the worktree created
          // for this pane. Remove + prune it here (best-effort).
          if (worktreePath && wsRow.repoRoot) {
            try {
              await deps.worktreePool.removeAndPrune(wsRow.repoRoot, worktreePath);
            } catch {
              /* best-effort — boot sweep is the backstop */
            }
          }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
npx tsc -b
git add src/main/core/workspaces/launcher.ts src/main/core/workspaces/launcher.test.ts
git commit -m "fix(spawn): removeAndPrune the worktree on suppressed pane launch (CRIT-1/CRIT-2, launcher twin)"
```

---

## Task 6: CRIT-3 — opportunistic throttled session snapshot flush

`app.lastSession` is flushed only in `before-quit`, which a SIGKILL force-quit never runs → workspaces lost. Add a throttled kv flush on the `app:session-snapshot` IPC so a crash loses at most a few seconds. Keep the `before-quit` flush as the final write.

**Files:**
- Modify: `src/main/core/session/session-restore.ts` (`rememberSessionSnapshot`, ~lines 71-100)
- Modify (or create): `src/main/core/session/session-restore.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that drives `rememberSessionSnapshot` and asserts a throttled kv write happens (not only at quit), and that rapid calls are coalesced. Mock `getRawDb()` to count `prepare().run()` writes; control time with `vi.useFakeTimers()`.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runSpy = vi.fn();
vi.mock('<DB_MODULE>', () => ({   // same module session-restore imports getRawDb from
  getRawDb: () => ({ prepare: () => ({ run: runSpy, get: () => undefined }) }),
}));

import { rememberSessionSnapshot } from './session-restore';

const SNAP = { version: 1, workspaces: [{ id: 'w1' }], activeWorkspaceId: 'w1' };

beforeEach(() => { runSpy.mockClear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('rememberSessionSnapshot opportunistic flush', () => {
  it('flushes to kv shortly after a snapshot (not only at quit)', () => {
    rememberSessionSnapshot(SNAP);
    vi.advanceTimersByTime(5000);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('coalesces a rapid burst into a single throttled write', () => {
    rememberSessionSnapshot(SNAP);
    rememberSessionSnapshot(SNAP);
    rememberSessionSnapshot(SNAP);
    vi.advanceTimersByTime(5000);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
```

> Replace `<DB_MODULE>` with the exact module `session-restore.ts` imports `getRawDb` from. Confirm the exported snapshot shape/normalizer accepts `SNAP`; if `normalizeSessionSnapshot` requires more fields, build a minimal valid snapshot from the file's zod schema.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/main/core/session/session-restore.test.ts`
Expected: FAIL — `rememberSessionSnapshot` only updates the in-memory cache; no kv write occurs.

- [ ] **Step 3: Add a trailing-edge throttle to rememberSessionSnapshot**

In `src/main/core/session/session-restore.ts`, add a module-scoped throttle timer and schedule `persistCachedSnapshot()` from `rememberSessionSnapshot` after it updates `cached`. Use a trailing-edge ~2s throttle so a burst coalesces into one WAL write:

```typescript
const FLUSH_THROTTLE_MS = 2000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOpportunisticFlush(): void {
  if (flushTimer) return; // trailing-edge: a burst coalesces into one write
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      persistCachedSnapshot();
    } catch (err) {
      /* a failed opportunistic write is non-fatal — before-quit retries */
      console.warn('[session] opportunistic snapshot flush failed:', err);
    }
  }, FLUSH_THROTTLE_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}
```

Then, inside `rememberSessionSnapshot`, after the existing line that updates the in-memory `cached` value (and only when the payload parsed/validated successfully), call:

```typescript
  scheduleOpportunisticFlush();
```

Do not remove or change `persistCachedSnapshot()` or the `before-quit` caller in `main.ts` — the quit-time flush stays as the final, immediate write. (Optional: in `before-quit`, clear `flushTimer` to avoid a redundant late write — not required.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/main/core/session/session-restore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Gate + commit**

```bash
npx tsc -b
git add src/main/core/session/session-restore.ts src/main/core/session/session-restore.test.ts
git commit -m "fix(session): throttled opportunistic snapshot flush so a force-quit keeps workspaces (CRIT-3)"
```

---

## Final verification (after all tasks)

- [ ] **Full gate:**

```bash
npx tsc -b && npx vitest run && npm run lint && npm run build
```
Expected: all green.

- [ ] **Full e2e** (fresh-profile sensitive — run the whole dir, not just smoke):

```bash
npx playwright test tests/e2e/
```
Expected: green.

- [ ] **Operator force-quit smoke (manual, RELEASE-BLOCKER DoD):** launch the app, open ≥1 workspace with a git-repo pane, `kill -9` the main process, relaunch. Verify: (a) the open workspaces restore, (b) new panes spawn (no UNIQUE lockout), (c) the on-disk worktree count under `~/Library/Application Support/Electron/worktrees/` does not grow across repeated rapid relaunches.

- [ ] **Dispatch a final whole-implementation code review** (superpowers:requesting-code-review) covering all six commits, with special attention to: the migration DDL predicate exactly matches the allocator predicate; the two spawn twins are identical (no mirror drift); boot is actually awaited (no `void`/sync gap remains); the throttle can't drop the final state.

---

## Scope deviations from the ROADMAP (recon-driven — flag to operator)

1. **Migration number is 0032**, not "00NN". `0026_*.pending` stays unregistered (historical SF-12 backfill); `0031` is the highest registered.
2. **No dedup step in the migration.** The status-aware predicate is a strict subset of the old one, so dropping + recreating cannot surface a new violation. (0020 needed dedup because it ADDED a constraint; 0032 RELAXES it.)
3. **Allocator already correct** (`pane-slots.ts` already uses `status IN ('running','starting')`) — no change needed; ADR-005's "allocator==index agreement" is achieved by changing the index to match the allocator, not vice-versa.
4. **Adopt-dead-row is intentionally NOT implemented.** Recon showed it is subsumed: the status-aware index (Task 1) means an exited/error occupant no longer blocks the slot, and the janitor (Tasks 2-3) clears zombie running/starting rows on boot. A UNIQUE violation now implies a genuinely live occupant, where hard-suppress is correct. Adoption would add a node-pty liveness dependency for a vanishing edge case. If the operator wants belt-and-suspenders in-session adoption, it can be a follow-up OPT task. (This is a YAGNI deviation from the literal ROADMAP scope — call it out at review.)
5. **0-now operator DB repair** (the one-time `UPDATE agent_sessions SET pane_index=NULL WHERE status NOT IN ('running','starting')`) is **not in this plan** — it's an immediate operator unblock for an already-broken install, separate from the code fix. After migration 0032 ships, it is unnecessary for fresh installs.
