# Session-Persistence Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the three stacked root causes that make SigmaLink resume OLD/irrelevant claude sessions after relaunch, and make operator pane renames survive every resume lane.

**Architecture:** Four surgical fixes at existing choke points — (1) quit-time `expectedExit` flagging so graceful quit stops stranding rows as `status='error'` (converges graceful-quit and force-quit onto the janitor→resume lane); (2) slot-aware boot resume + a janitor supersession sweep so only the per-slot rank-winner row ever respawns (kills old-conversation resurrection, heals the 128-row backlog); (3) `handleRelaunch` closes the crashed row in the DB (stops stale-sibling leaks); (4) `name`/`display_provider_id` carry-forward on the picker resume lane. No schema migration needed.

**Tech Stack:** Electron main (TypeScript), better-sqlite3 raw SQL (window functions), drizzle, vitest (fake-DB idiom — better-sqlite3 cannot load under vitest; every suite re-implements SQL semantics in JS, dispatching on SQL-string regexes).

## Global Constraints

- Repo: work in the worktree `/Users/aisigma/projects/SigmaLink-wt-sessionfix` (branch `fix/session-persistence-correctness` off `origin/main`), app code under `app/`.
- `app/` bans TS ctor param-properties, enums, namespaces (`erasableSyntaxOnly`).
- Files ≤ ~500 lines; read every file before editing.
- Local gate before any done-claim: `npx tsc -b && npx eslint . --max-warnings 0 && npx vitest run && npm run build` (run inside `app/`). Full vitest, not scoped — sibling mocks break silently otherwise.
- NEVER push/tag/release from a task. Commits stay on the branch.
- The exit-classification sites are TRIPLETS: `workspaces/launcher.ts` onExit, `pty/resume-launcher.ts` attachExitPersistence, `swarms/factory-spawn.ts`. All three already honor `rec.expectedExit` — do NOT add a fourth semantics.
- The slot-rank CTE is a MIRROR of `panes.lastResumePlan` + `panes.listForWorkspace` (`app/src/main/rpc-router.ts:1820-1948`): rank ALL rows per `(workspace_id, pane_index)` (live-first, then `started_at DESC`, then `id DESC`), THEN filter closed — rank-then-filter (PR #221 ghost-resurrection lesson). Never filter `closed_at` inside the CTE.
- `CommandRoom.tsx` / `CommandRoom.test.tsx` have uncommitted operator WIP on another branch (`fix/pane-stale-render-esc-focus`) in the MAIN tree — keep the Task 5 diff minimal (a few lines) to keep the future rebase trivial.

---

### Task 1: `PtyRegistry.markAllExpectedExit()`

**Files:**
- Modify: `app/src/main/core/pty/registry.ts` (add method right after `markExpectedExit`, ~line 531)
- Test: `app/src/main/core/pty/registry-lifecycle.test.ts` (append a describe block; reuse the file's existing `FakePty` + mocked `spawnLocalPty` helpers)

**Interfaces:**
- Produces: `markAllExpectedExit(): void` on `PtyRegistry` — flags `expectedExit = true` on EVERY tracked session record. Task 2 calls it from `shutdownRouter`.

- [ ] **Step 1: Write the failing test**

Append to `registry-lifecycle.test.ts`, mirroring how the file's existing tests construct the registry and fake ptys (reuse its `FakePty`/spawn-mock helpers verbatim — do not invent new ones):

```ts
describe('markAllExpectedExit (quit-time stranding fix)', () => {
  it('flags every live session so exit classifiers skip the status write', () => {
    const registry = new PtyRegistry(/* same ctor args as sibling tests */);
    const a = registry.create({ providerId: 'claude', command: 'claude', args: [], cwd: '/tmp' });
    const b = registry.create({ providerId: 'codex', command: 'codex', args: [], cwd: '/tmp' });

    registry.markAllExpectedExit();

    expect(registry.get(a.id)?.expectedExit).toBe(true);
    expect(registry.get(b.id)?.expectedExit).toBe(true);
  });

  it('suppresses the onPaneEvent exit sink for flagged sessions', () => {
    // Mirror the file's existing expectedExit/onPaneEvent test shape
    // (registry.ts:410 gates `this.onPaneEvent` on `rec?.expectedExit !== true`):
    // create a session with an onPaneEvent spy, markAllExpectedExit(), fire the
    // fake pty exit, assert the spy was NOT called with a pane-exit event.
  });
});
```

The second test's body must be real code — copy the file's existing exit-event test and insert the `markAllExpectedExit()` call before firing the exit.

- [ ] **Step 2: Run test to verify it fails**

Run (in `app/`): `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: FAIL with `registry.markAllExpectedExit is not a function`

- [ ] **Step 3: Write minimal implementation**

In `registry.ts`, directly below `markExpectedExit` (~line 531):

```ts
  /**
   * Quit-time twin of markExpectedExit (2026-07-18 session-persistence fix).
   * shutdownRouter flags EVERY live session before killAll() so the quit-window
   * SIGTERM exits skip the launcher/resume/swarm onExit status writes — without
   * this, a pane whose process dies inside the ≤2.5s waitForPidsExit hold gets
   * stamped status='error' (isPtyCrash sees signal 15) and silently drops out
   * of BOTH boot auto-resume (running OR exited/-1) and the respawn-fresh
   * bucket (exited/-1). Rows now stay 'running'; the boot janitor heals them
   * to exited/-1 — one lane for graceful quit AND force-quit.
   */
  markAllExpectedExit(): void {
    for (const rec of this.sessions.values()) rec.expectedExit = true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/pty/registry-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/registry.ts src/main/core/pty/registry-lifecycle.test.ts
git commit -m "feat(pty): registry.markAllExpectedExit for quit-time exit suppression"
```

### Task 2: `shutdownRouter` flags all exits before `killAll()`

**Files:**
- Modify: `app/src/main/rpc-router.ts` (~line 3723, immediately above the `sharedDeps?.pty.killAll()` try-block)
- Test: Create `app/src/main/rpc-router.shutdown-order.test.ts` (source-order assertion — rpc-router imports electron and cannot be loaded in vitest; the repo's SOURCE-assertion idiom applies)

**Interfaces:**
- Consumes: `markAllExpectedExit()` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// rpc-router.ts cannot be imported under vitest (electron imports), so this
// guards the ORDERING contract at the source level: every quit must flag
// expectedExit on all live panes BEFORE killAll() tears them down, or the
// quit-window race re-opens (rows stranded as status='error', excluded from
// boot auto-resume — see docs/superpowers/plans/2026-07-18-session-persistence-correctness.md).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('shutdownRouter quit ordering (SOURCE assertion)', () => {
  it('calls pty.markAllExpectedExit() before pty.killAll()', () => {
    const src = fs.readFileSync(path.join(__dirname, 'rpc-router.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function shutdownRouter'));
    const markIdx = body.indexOf('markAllExpectedExit()');
    const killIdx = body.indexOf('pty.killAll()');
    expect(markIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(killIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/rpc-router.shutdown-order.test.ts`
Expected: FAIL — `markIdx` is `-1`

- [ ] **Step 3: Write minimal implementation**

In `shutdownRouter`, insert directly above the `const liveRootPids = (() => {` block:

```ts
  // session-persistence fix (2026-07-18) — flag EVERY live pane's next exit as
  // deliberate BEFORE killAll(): the quit sequence deliberately holds the DB
  // open ≤2.5s (waitForPidsExit, win32 WAL checkpoint), so without this a
  // fast-dying pane's onExit landed status='error' (isPtyCrash: signal 15) and
  // the row silently dropped out of boot auto-resume AND respawn-fresh. All
  // three exit-writer twins (workspaces/launcher, resume-launcher,
  // swarms/factory-spawn) honor rec.expectedExit.
  try {
    sharedDeps?.pty.markAllExpectedExit();
  } catch {
    /* never block shutdown */
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/rpc-router.shutdown-order.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/rpc-router.ts src/main/rpc-router.shutdown-order.test.ts
git commit -m "fix(panes): quit-time markAllExpectedExit — stop stranding live panes as status='error'"
```

### Task 3: Slot-aware `listEligibleRows` (boot resume resumes ONLY the per-slot winner)

**Files:**
- Modify: `app/src/main/core/pty/resume-launcher.ts:342-368` (`listEligibleRows`)
- Test: `app/src/main/core/pty/resume-launcher.test.ts` (extend `FakeRow` + `setupDb.all()` to implement the ranked semantics; add regression tests)

**Interfaces:**
- Consumes: nothing new. Produces: same `ResumeRow[]` shape — callers unchanged.

- [ ] **Step 1: Extend the fake DB, then write the failing tests**

In `resume-launcher.test.ts`: add `pane_index: number | null` and `closed_at: number | null` to `FakeRow` (default `null` in `insertSession`'s existing signature — extend it with optional params so existing tests stay untouched). Replace the `all()` body (lines ~74-94) with the ranked mirror:

```ts
        all(workspaceId: string) {
          expect(sql).toMatch(/FROM agent_sessions/);
          const ws = rows.filter((r) => r.workspace_id === workspaceId);
          // Mirror of the ranked CTE: rank ALL rows per (workspace, pane_index)
          // live-first → started_at DESC → id DESC; NULL pane_index rows are
          // exempt from ranking (legacy). Rank-then-filter: closed_at/status
          // filters apply AFTER the winner is chosen.
          const live = (r: FakeRow) => r.status === 'running' || r.status === 'starting';
          const winners = new Set<string>();
          const slots = new Map<number, FakeRow[]>();
          for (const r of ws) {
            if (r.pane_index === null) continue;
            const bucket = slots.get(r.pane_index) ?? [];
            bucket.push(r);
            slots.set(r.pane_index, bucket);
          }
          for (const bucket of slots.values()) {
            bucket.sort((a, b) =>
              (live(a) ? 0 : 1) - (live(b) ? 0 : 1) ||
              b.started_at - a.started_at ||
              (a.id < b.id ? 1 : -1),
            );
            winners.add(bucket[0].id);
          }
          return ws
            .filter((r) => r.pane_index === null || winners.has(r.id))
            .filter((r) => r.closed_at === null || r.closed_at === undefined)
            .filter(
              (r) =>
                r.status === 'running' ||
                (r.status === 'exited' && r.exit_code === -1),
            )
            .sort((a, b) => a.started_at - b.started_at)
            .map((r) => ({ /* same projection as before */ }));
        }
```

New tests (use the file's `insertSession` + deps helpers; claude provider):

```ts
describe('slot-aware boot resume (old-session resurrection fix)', () => {
  it('resumes ONLY the newest row when a slot has stale exited/-1 siblings', async () => {
    // slot 0: old sibling (exited/-1, started_at 1000) + current (exited/-1, started_at 2000)
    // expect: exactly ONE resumed, and it is the current row's id.
  });

  it('does NOT un-shadow an old sibling when the slot winner is a stranded error row', async () => {
    // slot 0: old sibling (exited/-1, started_at 1000) + winner (status 'error', started_at 2000)
    // expect: resumed = [], failed = [] — the slot yields NOTHING (the error row
    // is the winner but ineligible; the old conversation must NOT come back).
  });

  it('does NOT un-shadow an open sibling when the slot winner is closed', async () => {
    // slot 0: open old row (exited/-1, started_at 1000) + closed newest (closed_at set, started_at 2000)
    // expect: resumed = [] (rank-then-filter, PR #221 semantics).
  });

  it('keeps NULL pane_index legacy rows eligible as before', async () => {
    // one row with pane_index null, exited/-1 → still resumed.
  });
});
```

Each test body must be real code following the file's existing `resumeWorkspacePanes` test shape (fake registry deps, `resolve` stub returning a fake ptySession).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/main/core/pty/resume-launcher.test.ts`
Expected: the new describe FAILS (multiple rows resumed / old sibling resumed); pre-existing tests may also fail until Step 3 — that is fine ONLY for the fake-mirror change; do not proceed if unrelated suites break.

- [ ] **Step 3: Rewrite `listEligibleRows`**

```ts
function listEligibleRows(db: Database.Database, workspaceId: string): ResumeRow[] {
  // session-persistence fix (2026-07-18) — SLOT-AWARE eligibility. The old
  // query returned EVERY open running/exited(-1) row, so a slot that had
  // accumulated stale siblings (relaunch leaks, historical crashes) respawned
  // ALL of them each boot: the old conversation won markResumeRunning, flipped
  // 'running', and out-ranked the operator's actual-latest row in
  // listForWorkspace — the reported "relaunch resumes an OLD irrelevant
  // session" bug. Mirror of panes.lastResumePlan / panes.listForWorkspace
  // (rpc-router.ts): rank ALL rows per (workspace_id, pane_index) live-first →
  // started_at DESC → id DESC, THEN filter closed/eligibility (rank-then-filter,
  // PR #221 — a closed/ineligible winner hides its slot, never un-shadows an
  // older sibling). NULL pane_index (legacy) rows are exempt from ranking.
  return db
    .prepare(
      `WITH ranked AS (
         SELECT
           s.id,
           s.workspace_id AS workspaceId,
           s.provider_id AS providerId,
           s.provider_effective AS providerEffective,
           s.cwd,
           s.worktree_path AS worktreePath,
           s.branch AS branch,
           w.root_path AS workspaceRoot,
           w.repo_root AS repoRoot,
           s.external_session_id AS externalSessionId,
           s.auto_approve AS autoApprove,
           s.status,
           s.exit_code,
           s.closed_at,
           s.pane_index,
           s.started_at,
           ROW_NUMBER() OVER (
             PARTITION BY s.workspace_id, s.pane_index
             ORDER BY
               CASE WHEN s.status IN ('running', 'starting') THEN 0 ELSE 1 END ASC,
               s.started_at DESC,
               s.id DESC
           ) AS rn
         FROM agent_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.workspace_id = ?
       )
       SELECT id, workspaceId, providerId, providerEffective, cwd, worktreePath,
              branch, workspaceRoot, repoRoot, externalSessionId, autoApprove
       FROM ranked
       WHERE (pane_index IS NULL OR rn = 1)
         AND closed_at IS NULL
         AND (status = 'running' OR (status = 'exited' AND exit_code = -1))
       ORDER BY started_at ASC`,
    )
    .all(workspaceId) as ResumeRow[];
}
```

- [ ] **Step 4: Run the FULL pty suite**

Run: `npx vitest run src/main/core/pty/`
Expected: PASS (all files)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/resume-launcher.ts src/main/core/pty/resume-launcher.test.ts
git commit -m "fix(panes): slot-aware boot resume — only the per-slot winner row respawns"
```

### Task 4: Janitor supersession sweep (heals the stale-sibling backlog)

**Files:**
- Modify: `app/src/main/core/db/janitor.ts` (new exported function + call in `runBootJanitor` after the zombie/swarm marking; extend `JanitorReport`)
- Test: `app/src/main/core/db/janitor.test.ts` (extend `fakeRaw` to capture the sweep; assert report plumbing + SQL contract)

**Interfaces:**
- Produces: `closeSupersededPaneRows(raw: Pick<Database.Database, 'prepare'>, now: number): number` and `JanitorReport.supersededRowsClosed: number`.

- [ ] **Step 1: Write the failing test**

In `janitor.test.ts`: extend `fakeRaw` so `prepare(sql)` records the SQL and `run(now)` records binds, returning `{ changes: 7 }` for the sweep statement (regex `/SET closed_at = \?/`). Add:

```ts
it('closes every open row that is not its slot rank-winner and reports the count', async () => {
  const report = await runBootJanitor();
  expect(report.supersededRowsClosed).toBe(7);
  const sweepSql = preparedSqls.find((s) => /SET closed_at = \?/.test(s))!;
  // Contract assertions — the sweep must mirror the slot-rank twins:
  expect(sweepSql).toMatch(/PARTITION BY workspace_id, pane_index/);
  expect(sweepSql).toMatch(/closed_at IS NULL/);          // only open rows get closed
  expect(sweepSql).toMatch(/pane_index IS NOT NULL/);     // legacy NULL-index rows untouched
  expect(sweepSql).toMatch(/started_at DESC/);
});
```

(Import `getRawDb` mock plumbing is already in the file's `vi.mock('./client', …)` — extend that mock, do not add a second.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/db/janitor.test.ts`
Expected: FAIL — `supersededRowsClosed` undefined

- [ ] **Step 3: Implement**

In `janitor.ts` (import `getRawDb` from `./client`, and `type Database from 'better-sqlite3'`):

```ts
/**
 * session-persistence fix (2026-07-18) — close (soft-delete) every open pane
 * row that is NOT its slot's rank-winner. Stale siblings accumulate from
 * relaunch leaks and historical crashes; boot auto-resume used to respawn ALL
 * of them (old-conversation resurrection). The rank mirrors
 * panes.lastResumePlan / listForWorkspace / listEligibleRows: live-first →
 * started_at DESC → id DESC per (workspace_id, pane_index); ranking runs over
 * ALL rows (open + closed) so a closed winner keeps its slot dark
 * (rank-then-filter, PR #221). Runs every boot; the first run heals the
 * accumulated backlog. Legacy pane_index-NULL rows are untouched.
 */
export function closeSupersededPaneRows(
  raw: Pick<Database.Database, 'prepare'>,
  now: number,
): number {
  try {
    const res = raw
      .prepare(
        `UPDATE agent_sessions
         SET closed_at = ?
         WHERE closed_at IS NULL
           AND pane_index IS NOT NULL
           AND id NOT IN (
             SELECT id FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY workspace_id, pane_index
                        ORDER BY
                          CASE WHEN status IN ('running', 'starting') THEN 0 ELSE 1 END ASC,
                          started_at DESC,
                          id DESC
                      ) AS rn
               FROM agent_sessions
               WHERE pane_index IS NOT NULL
             )
             WHERE rn = 1
           )`,
      )
      .run(now);
    return Number(res.changes ?? 0);
  } catch {
    /* best-effort — a sweep failure must never block boot */
    return 0;
  }
}
```

In `runBootJanitor`: add `supersededRowsClosed: number` to `JanitorReport`; after the zombie-swarm loop, call `const supersededRowsClosed = closeSupersededPaneRows(getRawDb(), now);` and include it in the returned report.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/db/`
Expected: PASS (all db suites — bootstrap/pragma tests must stay green)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/db/janitor.ts src/main/core/db/janitor.test.ts
git commit -m "fix(db): boot janitor closes superseded pane rows — one open row per slot"
```

### Task 5: `handleRelaunch` closes the crashed row in the DB

**Files:**
- Modify: `app/src/renderer/features/command-room/CommandRoom.tsx:286-309` (`handleRelaunch`)
- Test: `app/src/renderer/features/command-room/CommandRoom.test.tsx` (extend the existing relaunch test; the file already mocks `rpc`)

**Interfaces:**
- Consumes: existing RPC `rpc.panes.close(sessionId)` (rpc-router `panes.close` — writes `closed_at` via `markPaneClosed` then best-effort kills; both idempotent). Verify the renderer rpc client exposes `panes.close` (grep `rpc.panes.close` — the pane × button uses it); if the surface name differs, use the × button's exact call.

- [ ] **Step 1: Write the failing test**

In the existing relaunch test (mocked `rpc.swarms.addAgent` resolves), add an assertion that the crashed session's row is closed in the DB:

```ts
expect(mockPanesClose).toHaveBeenCalledWith(crashedSession.id);
```

wiring `mockPanesClose` into the file's existing `rpc` mock exactly like its `addAgent` mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/command-room/CommandRoom.test.tsx`
Expected: the extended test FAILS (`mockPanesClose` not called)

- [ ] **Step 3: Implement**

In `handleRelaunch`, after the `addAgent` succeeds (inside the `try`, before `REMOVE_SESSION`):

```ts
      // session-persistence fix (2026-07-18) — close the crashed ROW in the DB,
      // not just the renderer (REMOVE_SESSION is UI-only). Without this the row
      // lingers open (closed_at NULL) and haunts the slot as a stale sibling:
      // boot auto-resume used to respawn its OLD conversation. markPaneClosed
      // is idempotent (WHERE closed_at IS NULL); the kill inside panes.close is
      // a no-op on an already-dead pane.
      void rpc.panes.close(session.id).catch(() => {
        /* best-effort — the janitor supersession sweep is the backstop */
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/command-room/CommandRoom.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/CommandRoom.tsx src/renderer/features/command-room/CommandRoom.test.tsx
git commit -m "fix(panes): relaunch closes the crashed row — stop stale-sibling leaks"
```

### Task 6: `name` + `display_provider_id` carry-forward on the picker resume lane

**Files:**
- Modify: `app/src/main/core/workspaces/launcher.ts` (~line 527 before the insert txn; the `.values({...})` at 532-557; the `sessions.push` at 650-666)
- Test: `app/src/main/core/workspaces/launcher.test.ts` (extend the existing `getRawDb` mock + insert-values capture)

**Interfaces:**
- Consumes: `resumeSessionId` (already in scope — the launch plan's resume entry, line 527).
- Produces: resumed panes keep the operator's rename + CLI label override across the picker lane.

- [ ] **Step 1: Write the failing test**

Following the file's mock idiom (`vi.mock('../db/client')`, `getRawDb` returning `prepare: vi.fn(...)`, drizzle `insert().values()` captured): make the mocked `getRawDb().prepare` answer the carry-forward SELECT (regex `/SELECT name, display_provider_id/`) with `{ name: 'Frontend-Agent', display_provider_id: null }`, run a launch plan whose pane carries a `resumeSessionId`, and assert the captured insert values include `name: 'Frontend-Agent'`:

```ts
it('carries the operator rename forward when resuming by session id', async () => {
  // arrange: prepare-mock returns { name: 'Frontend-Agent', display_provider_id: null }
  // for the carry-forward SELECT; launch plan pane has resume entry.
  // act: executeLaunchPlan(...)
  // assert:
  expect(capturedInsertValues.name).toBe('Frontend-Agent');
  expect(returnedSessions[0].name).toBe('Frontend-Agent');
});

it('inserts name: null on a fresh (non-resume) spawn', async () => {
  expect(capturedInsertValues.name).toBeNull();
});
```

Real code per the file's existing helpers — both tests must exercise `executeLaunchPlan` the same way the file's existing insert tests do.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspaces/launcher.test.ts`
Expected: new test FAILS (`capturedInsertValues.name` undefined)

- [ ] **Step 3: Implement**

In `launcher.ts`, directly after `const insertExternalSessionId = resumeSessionId ?? rec.externalSessionId ?? null;` (line 527):

```ts
      // session-persistence fix (2026-07-18) — the picker resume lane INSERTs a
      // NEW row; without carry-forward the operator's rename (BSP-O4 `name`)
      // and CLI label override (SF-10) silently reset to NULL and the new row
      // shadows the old named row in listForWorkspace's rank. Copy both from
      // the newest open row holding this external session id.
      let carriedName: string | null = null;
      let carriedDisplayProviderId: string | null = null;
      if (resumeSessionId) {
        try {
          const prev = getRawDb()
            .prepare(
              `SELECT name, display_provider_id FROM agent_sessions
               WHERE workspace_id = ? AND external_session_id = ? AND closed_at IS NULL
               ORDER BY started_at DESC LIMIT 1`,
            )
            .get(wsRow.id, resumeSessionId) as
            | { name: string | null; display_provider_id: string | null }
            | undefined;
          carriedName = prev?.name ?? null;
          carriedDisplayProviderId = prev?.display_provider_id ?? null;
        } catch {
          /* carry-forward is best-effort — a fresh alias is the safe fallback */
        }
      }
```

In the `.values({...})` insert add:

```ts
              name: carriedName,
              displayProviderId: carriedDisplayProviderId,
```

In the `sessions.push({...})` (line ~650), replace `name: null` (and its "fresh spawns" comment) with:

```ts
        // BSP-O4 — fresh spawns start unnamed; picker resumes carry the rename forward.
        name: carriedName,
```

- [ ] **Step 4: Run the full workspaces suite**

Run: `npx vitest run src/main/core/workspaces/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/launcher.ts src/main/core/workspaces/launcher.test.ts
git commit -m "fix(panes): carry rename + display provider forward on picker resume"
```

### Task 7: Full gate + docs

- [ ] **Step 1: Full local gate** (in `app/`)

Run each, capture exit codes separately (never pipe-mask):
`npx tsc -b` → 0 · `npx eslint . --max-warnings 0` → 0 · `npx vitest run` → all green · `npm run build` → 0

- [ ] **Step 2: Update WISHLIST**

In `WISHLIST.md`, strike through the two promoted findings (quit-race stranding, rename loss) in the 2026-07-18 section with `→ **fixed on fix/session-persistence-correctness** (2026-07-18)`, and append the two NEW findings this investigation confirmed (slot-blind boot resume resurrecting old conversations; relaunch leak) as fixed same-branch — with `file:line` receipts.

- [ ] **Step 3: Commit**

```bash
git add WISHLIST.md
git commit -m "docs(wishlist): session-persistence audit findings fixed on branch"
```
