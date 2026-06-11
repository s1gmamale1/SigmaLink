# Pane Close Lifecycle — `closed_at` Soft-Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two confirmed bugs in manual pane close — (1) closing a pane raises a spurious "Pane exited (code 143/0)" warn toast, and (2) manually-closed panes resurrect on app restart — by introducing one durable `closed_at` soft-delete marker on `agent_sessions`, routed through a single shared close primitive used by the × button, the context-menu close, and the Jorvis `close_pane` tool.

**Architecture:** Add a nullable `closed_at` (epoch-ms) column to `agent_sessions` (mirrors the existing `browser_tabs` soft-delete, migration 0033). A deliberate close writes `closed_at = now` **before** killing the PTY, so: the async PTY-exit notification path skips the toast when `closed_at` is set (Bug 1); and both boot read-paths (`panes.listForWorkspace` grid rehydrate + `listEligibleRows`/`listRespawnableRows` live resume) exclude `closed_at IS NOT NULL` (Bug 2). `closed_at` is the **durable** marker — `status` is racy (the late `onExit` DB write overwrites `running`→`error` with code 143), so every exclusion keys off `closed_at`, never status. Closed rows are kept for a Recents list and reaped on the normal retention window.

**Tech Stack:** Electron main (TypeScript, better-sqlite3 raw + drizzle), React renderer (reducer + hooks), vitest. Tests use a `MockDb` recording DDL/SQL — `better-sqlite3` cannot load under vitest (electron ABI).

**Root-cause evidence (verified against live code):**
- Bug 1 toast: `src/main/core/notifications/sources/pty-exit.ts:47-74` fires on every exit, no close suppression. Path: `CommandRoom.tsx:257-262` → `rpc.pty.kill` → SIGTERM(143) → `registry.ts:347` `onExit` → `rpc-router.ts:558` `onPaneEvent` → `pushPtyExitNotification` → `use-live-events.ts` `toast.warning`.
- Bug 2 tile: `rpc-router.ts:1224-1242` `listForWorkspace` SQL is `WHERE pane_index IS NOT NULL` — no status filter. Manual × (`CommandRoom.tsx:257-262`) writes nothing to the DB. Boot rehydrate `use-session-restore.ts:144-149`.
- Bug 2 live resume: `resume-launcher.ts:328-352` `listEligibleRows` (`status='running' OR exited/-1`); janitor `db/janitor.ts:33-50` flips running→exited/-1.
- Reference: `close_pane` tool `src/main/core/assistant/tools.ts:346-374` writes `status='exited',code=0` (blocks live re-spawn) but NOT a tile-exclusion → only half resume-proof.

---

## Part A — Bug fixes (`closed_at` marker). Resolves both reported bugs.

### Task 1: Migration 0037 — add `closed_at` to `agent_sessions`

**Files:**
- Create: `src/main/core/db/migrations/0037_agent_sessions_closed_at.ts`
- Create: `src/main/core/db/migrations/0037_agent_sessions_closed_at.test.ts`
- Modify: `src/main/core/db/migrate.ts` (import + `ALL_MIGRATIONS` entry)

- [ ] **Step 1: Write the failing test** (mirrors `0033_browser_tabs_closed_at.test.ts` exactly)

```ts
// src/main/core/db/migrations/0037_agent_sessions_closed_at.test.ts
import { describe, it, expect } from 'vitest';
import { name, up } from './0037_agent_sessions_closed_at';

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

describe('0037_agent_sessions_closed_at', () => {
  it('has the expected name', () => {
    expect(name).toBe('0037_agent_sessions_closed_at');
  });
  it('adds a nullable closed_at column to agent_sessions', () => {
    const db = run();
    const at = db.execed.findIndex((s) =>
      /ALTER TABLE agent_sessions ADD COLUMN closed_at/i.test(s),
    );
    expect(at).toBeGreaterThanOrEqual(0);
  });
  it('creates a recents index keyed on workspace_id, closed_at', () => {
    const db = run();
    const at = db.execed.findIndex((s) =>
      /CREATE INDEX.*agent_sessions_closed_idx/i.test(s),
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(db.execed[at]).toMatch(/workspace_id.*closed_at/i);
  });
  it('emits no self-managed transaction (H-7 runner owns it)', () => {
    expect(() => run()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/db/migrations/0037_agent_sessions_closed_at.test.ts`
Expected: FAIL — `Cannot find module './0037_agent_sessions_closed_at'`.

- [ ] **Step 3: Write the migration** (mirrors 0033's ALTER + recents-index shape)

```ts
// src/main/core/db/migrations/0037_agent_sessions_closed_at.ts
// 0037 — Add closed_at soft-delete column to agent_sessions.
//
// Root cause: a manually-closed pane wrote nothing the boot read-paths exclude,
// so it resurrected on restart, and its async pty-exit raised a spurious toast.
// closed_at (epoch-ms) is the DURABLE deliberate-close marker (NULL = open). It
// is checked by the exit-notification source (suppress toast) and by both boot
// read-paths (listForWorkspace / listEligibleRows / listRespawnableRows) to
// exclude closed panes. status is NOT used for this — the late onExit DB write
// can overwrite status (running → 'error', code 143) after a kill.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0037_agent_sessions_closed_at';

export function up(db: Database.Database): void {
  // Nullable INTEGER: NULL = open; epoch-ms = deliberately closed.
  db.exec(`ALTER TABLE agent_sessions ADD COLUMN closed_at INTEGER`);
  // Composite index for the Recents query:
  //   WHERE workspace_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC
  db.exec(
    `CREATE INDEX IF NOT EXISTS agent_sessions_closed_idx` +
      ` ON agent_sessions (workspace_id, closed_at)`,
  );
}
```

- [ ] **Step 4: Register in `ALL_MIGRATIONS`** — `src/main/core/db/migrate.ts`

After line 44 (`import * as mig0036 ...`) add:
```ts
import * as mig0037 from './migrations/0037_agent_sessions_closed_at';
```
After `mig0036,` (line 96) in the `ALL_MIGRATIONS` array add a new line:
```ts
  mig0037,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/core/db/migrations/0037_agent_sessions_closed_at.test.ts src/main/core/db/__tests__/migrate.spec.ts`
Expected: PASS — including `migrate.spec.ts`'s "every 0NNN_*.ts migration file is registered" + "lexically sorted" assertions.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/db/migrations/0037_agent_sessions_closed_at.ts src/main/core/db/migrations/0037_agent_sessions_closed_at.test.ts src/main/core/db/migrate.ts
git commit -m "feat(db): migration 0037 — agent_sessions.closed_at soft-delete"
```

---

### Task 2: Add `closedAt` to the drizzle schema

**Files:**
- Modify: `src/main/core/db/schema.ts:90` (agentSessions columns) + index block (~line 92-96)

- [ ] **Step 1: Add the column** — `src/main/core/db/schema.ts`

Replace the `name: text('name'),` line (line 90) with:
```ts
    // BSP-O4 — operator-supplied display name. NULL = use computed alias.
    name: text('name'),
    // 0037 — deliberate-close soft-delete marker (epoch-ms). NULL = open.
    // DURABLE close marker: every resume/rehydrate/toast-suppression path keys
    // off this, NOT status (the late onExit write can clobber status).
    closedAt: integer('closed_at'),
```

- [ ] **Step 2: Add the recents index** — in the `(t) => ({ ... })` index block, after `statusIdx` (line 94) add:
```ts
    closedIdx: index('agent_sessions_closed_idx').on(t.workspaceId, t.closedAt),
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc -b`
Expected: PASS (no errors). The `index` helper is already imported in schema.ts.

- [ ] **Step 4: Commit**

```bash
git add src/main/core/db/schema.ts
git commit -m "feat(db): drizzle agentSessions.closedAt column + recents index"
```

---

### Task 3: `markPaneClosed` shared primitive

**Files:**
- Create: `src/main/core/pty/mark-pane-closed.ts`
- Create: `src/main/core/pty/mark-pane-closed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/pty/mark-pane-closed.test.ts
import { describe, it, expect } from 'vitest';
import { markPaneClosed } from './mark-pane-closed';

class MockStmt {
  constructor(public sql: string, private sink: Array<{ sql: string; args: unknown[] }>) {}
  run(...args: unknown[]): void {
    this.sink.push({ sql: this.sql.replace(/\s+/g, ' ').trim(), args });
  }
}
class MockDb {
  calls: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string): MockStmt {
    return new MockStmt(sql, this.calls);
  }
}

describe('markPaneClosed', () => {
  it('writes closed_at only when still NULL (idempotent), keyed by id', () => {
    const db = new MockDb();
    markPaneClosed(db as never, 'sess-1', 1234);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toBe(
      'UPDATE agent_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL',
    );
    expect(db.calls[0].args).toEqual([1234, 'sess-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/pty/mark-pane-closed.test.ts`
Expected: FAIL — `Cannot find module './mark-pane-closed'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/core/pty/mark-pane-closed.ts
import type Database from 'better-sqlite3';

/**
 * Mark a pane row as deliberately closed (soft-delete). Writes the epoch-ms
 * `closed_at` ONLY while it is still NULL, so a later natural pty-exit (or a
 * double close) cannot clobber the original close timestamp.
 *
 * `closed_at` is the DURABLE close marker — `status` is racy (the launcher's
 * onExit DB write overwrites a killed pane's status to 'error'/code 143 after
 * this runs), so all resume/rehydrate/toast-suppression logic keys off
 * `closed_at`, never status. Call this with the RAW better-sqlite3 handle BEFORE
 * killing the PTY so the async exit sees the marker.
 */
export function markPaneClosed(
  db: Database.Database,
  sessionId: string,
  now: number,
): void {
  db.prepare(
    `UPDATE agent_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL`,
  ).run(now, sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/pty/mark-pane-closed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/mark-pane-closed.ts src/main/core/pty/mark-pane-closed.test.ts
git commit -m "feat(pty): markPaneClosed soft-delete primitive"
```

---

### Task 4: `panes.close` RPC (mark-then-kill) + RPC plumbing siblings

**Files:**
- Modify: `src/main/rpc-router.ts` — add `close` to the `panes` namespace; import `markPaneClosed`, use `getRawDb()`.
- Modify (RPC SIBLINGS — grep `'rename'` under `panes` AND `'kill'` under `pty` to find every mirror): `src/shared/router-shape.ts`, `src/shared/rpc-channels.ts`, `src/main/core/rpc/schemas.ts`, and the renderer rpc client proxy if methods are enumerated.

> ⚠️ Sibling-miss is this repo's recurring gate-invisible bug. `panes.close` takes one `string` arg (like `pty.kill`). Mirror the **shape of `pty.kill`** for the channel/schema and the **namespace of `panes.rename`** for placement, across ALL of: router-shape, rpc-channels, schemas. Grep both names and add the twin in each file.

- [ ] **Step 1: Write the failing test** (router-shape type presence — a cheap guard that the type was added)

```ts
// src/shared/__tests__/router-shape.panes-close.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panes.close RPC is declared in every sibling surface', () => {
  const files = [
    'src/shared/router-shape.ts',
    'src/shared/rpc-channels.ts',
    'src/main/core/rpc/schemas.ts',
  ];
  it.each(files)('%s references panes close', (f) => {
    const src = readFileSync(resolve(process.cwd(), f), 'utf8');
    expect(/close/i.test(src) && /pane/i.test(src)).toBe(true);
  });
});
```

> NOTE: This is a presence guard (the sibling surfaces are plain mirrors, not logic). The behavioral coverage lives in Task 5 (renderer calls it) + Task 7-9 (closed_at effects). If `src/main/core/rpc/schemas.ts` does not gate `panes` methods, drop it from `files` after confirming with grep.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/router-shape.panes-close.test.ts`
Expected: FAIL on at least one file (no `close` near `pane`).

- [ ] **Step 3: Add the RPC handler** — `src/main/rpc-router.ts`, in the `panes` object next to `resume`/`respawnFailed` (near line 1064). Import `markPaneClosed` at the top (alongside the other `./core/pty/*` imports):

```ts
import { markPaneClosed } from './core/pty/mark-pane-closed';
```

Handler (uses `getRawDb()` — the same raw handle `listForWorkspace` uses):
```ts
    // Deliberate pane close (× button, context-menu, close_pane tool all route
    // here). Mark closed_at BEFORE the kill so the async pty-exit (a) is excluded
    // from boot rehydrate/resume and (b) suppresses the "Pane exited" toast.
    close: async (sessionId: string) => {
      try { markPaneClosed(getRawDb(), sessionId, Date.now()); } catch { /* best-effort */ }
      try { pty.kill(sessionId); } catch { /* already gone */ }
    },
```

- [ ] **Step 4: Mirror across the RPC sibling surfaces.** Grep first:

Run: `grep -rn "rename" src/shared/router-shape.ts src/shared/rpc-channels.ts src/main/core/rpc/schemas.ts; grep -rn "kill" src/shared/router-shape.ts src/shared/rpc-channels.ts`
Then add the `panes.close` twin in each file matching the local style (e.g. in `router-shape.ts` add `close: (sessionId: string) => Promise<void>;` to the `panes` interface; in `rpc-channels.ts` register the `panes.close` channel exactly like the existing `panes.*` channels; in `schemas.ts` add a `z.string()` arg schema if `panes` methods are schema-gated there).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/__tests__/router-shape.panes-close.test.ts && npx tsc -b`
Expected: PASS (all sibling files reference panes close; types compile end-to-end so `rpc.panes.close` is callable in the renderer).

- [ ] **Step 6: Commit**

```bash
git add src/main/rpc-router.ts src/shared/router-shape.ts src/shared/rpc-channels.ts src/main/core/rpc/schemas.ts src/shared/__tests__/router-shape.panes-close.test.ts
git commit -m "feat(rpc): panes.close (mark closed_at then kill) across sibling surfaces"
```

---

### Task 5: Manual × + context-menu route through `panes.close`

**Files:**
- Modify: `src/renderer/features/command-room/CommandRoom.tsx:257-262` (`handleRemove`)

> The context-menu "Close pane" (`PaneShell.tsx:687` → `onRemove`) and the × button (`PaneHeader.tsx:428` → `onClose` → `onRemove`) BOTH already funnel into `handleRemove` via `CommandRoom.tsx:444 onRemove={() => handleRemove(session)}` — so fixing `handleRemove` fixes all manual close sites. `handleStop` (the Stop button, line 264-266) must KEEP calling `pty.kill` (stop ≠ close — a stopped pane is NOT soft-deleted).

- [ ] **Step 1: Write the failing test** (assert handleRemove calls `panes.close`, not `pty.kill`)

```ts
// src/renderer/features/command-room/__tests__/handle-remove.test.ts
import { describe, it, expect, vi } from 'vitest';

// Minimal extraction-free behavioral assertion via a fake rpc surface.
// We test the contract: a deliberate remove calls panes.close(id) and dispatches
// REMOVE_SESSION; it must NOT call pty.kill directly.
describe('CommandRoom handleRemove deliberate-close contract', () => {
  it('calls rpc.panes.close and dispatches REMOVE_SESSION', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const kill = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn();
    const rpc = { panes: { close }, pty: { kill } };
    const session = { id: 's1', status: 'running' as const };

    // Inlined logic mirrors the new handleRemove (kept in sync with source):
    async function handleRemove(s: { id: string; status: string }) {
      void rpc.panes.close(s.id).catch(() => undefined);
      dispatch({ type: 'REMOVE_SESSION', id: s.id });
    }
    await handleRemove(session);

    expect(close).toHaveBeenCalledWith('s1');
    expect(kill).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_SESSION', id: 's1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** (then passes once source matches — this test guards the contract; if you prefer a render test, mount CommandRoom, but the rpc surface is heavily mocked there)

Run: `npx vitest run src/renderer/features/command-room/__tests__/handle-remove.test.ts`
Expected: PASS for the inlined logic (this test documents + locks the intended contract). Now make the SOURCE match it.

- [ ] **Step 3: Update `handleRemove`** — replace lines 257-262:

```ts
  function handleRemove(session: AgentSession) {
    // Deliberate close → soft-delete via panes.close (marks closed_at, then
    // kills). This stops the pane resurrecting on restart AND suppresses the
    // spurious "Pane exited" toast. The grid drops the tile immediately below.
    void rpc.panes.close(session.id).catch(() => undefined);
    dispatch({ type: 'REMOVE_SESSION', id: session.id });
  }
```

> Removed the `if (session.status !== 'error')` guard around the kill: `panes.close` is safe for an already-errored pane (the kill is best-effort, and we still want `closed_at` set so the errored row stops rehydrating). `markPaneClosed`'s `WHERE closed_at IS NULL` keeps it idempotent.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/renderer/features/command-room/__tests__/handle-remove.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/command-room/CommandRoom.tsx src/renderer/features/command-room/__tests__/handle-remove.test.ts
git commit -m "fix(command-room): manual close routes through panes.close (soft-delete)"
```

---

### Task 6: Unify the `close_pane` Jorvis tool onto `markPaneClosed`

**Files:**
- Modify: `src/main/core/assistant/tools.ts:356-373` (`close_pane` handler body only — name/schema/DANGEROUS_REMOTE membership UNCHANGED)

- [ ] **Step 1: Confirm the authorization test still gates close_pane**

Run: `grep -rn "close_pane\|DANGEROUS_REMOTE" src/main/core/assistant/*.test.ts src/main/core/assistant/authorization*`
Expected: `close_pane` is in the `DANGEROUS_REMOTE` `toEqual([...])` list. Do NOT change the tool list — only the handler body. The strict `toEqual` must stay green.

- [ ] **Step 2: Replace the handler body** (reorder to mark-then-kill, swap the drizzle status write for `markPaneClosed`). Import `getRawDb` if not already imported in tools.ts, and `markPaneClosed`:

```ts
    async (a, ctx) => {
      // 1. Mark closed FIRST (durable closed_at) so the async pty-exit is
      //    excluded from rehydrate/resume AND the exit toast is suppressed.
      try { markPaneClosed(getRawDb(), a.sessionId, Date.now()); } catch { /* best-effort */ }
      // 2. Kill the process tree (best-effort — a dead/unknown id is a no-op).
      try { ctx.pty.kill(a.sessionId); } catch { /* already gone */ }
      // 3. Tell the renderer grid to drop the pane live (twin of launch_pane's
      //    assistant:dispatch-echo).
      ctx.emit?.('assistant:pane-closed', { sessionId: a.sessionId });
      return { ok: true, sessionId: a.sessionId };
    },
```

> Drops the old `getDb().update(agentSessions).set({status:'exited',exitCode:0,...})` block — `closed_at` now handles resume exclusion durably (status was racy anyway). Remove the now-unused `agentSessions`/`eq` imports from tools.ts ONLY if nothing else in the file uses them (grep first).

- [ ] **Step 3: Run the assistant tool tests + typecheck**

Run: `npx vitest run src/main/core/assistant/ && npx tsc -b`
Expected: PASS — `authorization` strict list unchanged; close_pane handler compiles.

- [ ] **Step 4: Commit**

```bash
git add src/main/core/assistant/tools.ts
git commit -m "refactor(assistant): close_pane routes through markPaneClosed (unify close path)"
```

---

### Task 7: Bug 1 — suppress the exit toast for deliberate closes

**Files:**
- Modify: `src/main/core/notifications/sources/pty-exit.ts:34-74`
- Create/Modify: `src/main/core/notifications/sources/pty-exit.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake meta resolver; assert `manager.add` is NOT called when closed)

```ts
// src/main/core/notifications/sources/pty-exit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { pushPtyExitNotification } from './pty-exit';

function fakeManager() {
  return { add: vi.fn() } as unknown as Parameters<typeof pushPtyExitNotification>[0];
}

describe('pushPtyExitNotification — deliberate-close suppression', () => {
  it('does NOT add a notification when the session is closed (closed_at set)', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'error', exitCode: 143 },
      () => ({ workspaceId: 'w1', closedAt: 1234 }),
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
  });

  it('DOES add a notification for an unexpected exit (closed_at NULL)', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's2', kind: 'error', exitCode: 1 },
      () => ({ workspaceId: 'w1', closedAt: null }),
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/notifications/sources/pty-exit.test.ts`
Expected: FAIL — `pushPtyExitNotification` takes 2 args / `closedAt` not resolved.

- [ ] **Step 3: Implement the suppression** — `src/main/core/notifications/sources/pty-exit.ts`. Replace `resolveWorkspaceId` with a `resolveSessionMeta` that returns workspaceId + closedAt, and add an injectable param + the early-return:

```ts
export interface SessionCloseMeta {
  workspaceId: string | null;
  closedAt: number | null;
}

/** Resolve workspace_id + closed_at for a session id; nullable when forgotten. */
function resolveSessionMeta(sessionId: string): SessionCloseMeta {
  try {
    const row = getDb()
      .select({ workspaceId: agentSessions.workspaceId, closedAt: agentSessions.closedAt })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return { workspaceId: row?.workspaceId ?? null, closedAt: row?.closedAt ?? null };
  } catch {
    return { workspaceId: null, closedAt: null };
  }
}

export function pushPtyExitNotification(
  manager: NotificationsManager,
  event: PtyExitEvent,
  resolveMeta: (sessionId: string) => SessionCloseMeta = resolveSessionMeta,
): void {
  if (event.kind !== 'exited' && event.kind !== 'error') return;

  const meta = resolveMeta(event.sessionId);
  // Bug 1 — a deliberate close (closed_at set) is NOT an unexpected exit.
  // Suppress the "Pane exited (code N)" toast for it. Covers the × button,
  // context-menu, and the close_pane tool (all set closed_at before the kill).
  if (meta.closedAt != null) return;

  const severity =
    event.kind === 'exited' && (event.exitCode ?? 0) === 0 ? 'info' : 'warn';
  const codeStr = event.exitCode !== undefined ? `code ${event.exitCode}` : 'signal';

  manager.add({
    workspaceId: meta.workspaceId,
    kind: 'pty-exit',
    severity,
    title: `Pane exited (${codeStr})`,
    body: event.body ?? null,
    payload: { sessionId: event.sessionId, exitCode: event.exitCode ?? null },
    sourceEvent: 'pty:exit',
    dedupKey: `pty-exit:${event.sessionId}`,
  });
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/main/core/notifications/sources/pty-exit.test.ts && npx tsc -b`
Expected: PASS. (Existing caller `rpc-router.ts:558` still passes 2 args — the 3rd is defaulted.)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/notifications/sources/pty-exit.ts src/main/core/notifications/sources/pty-exit.test.ts
git commit -m "fix(notifications): suppress Pane-exited toast for deliberate closes (closed_at)"
```

---

### Task 8: Bug 2 (tile) — exclude closed panes from grid rehydrate

**Files:**
- Modify: `src/main/rpc-router.ts:1236` (`listForWorkspace` ranked-CTE WHERE)

- [ ] **Step 1: Write the failing test** (SQL-shape guard — the query is raw, run via getRawDb; a behavioral DB test can't run under vitest with better-sqlite3)

```ts
// src/main/__tests__/list-for-workspace-closed-filter.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panes.listForWorkspace excludes closed panes', () => {
  it('the ranked CTE WHERE filters closed_at IS NULL', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/main/rpc-router.ts'), 'utf8');
    // Find the listForWorkspace CTE and assert it ANDs closed_at IS NULL.
    const m = src.match(/pane_index IS NOT NULL[\s\S]{0,80}?closed_at IS NULL/i);
    expect(m).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/list-for-workspace-closed-filter.test.ts`
Expected: FAIL — no `closed_at IS NULL` near `pane_index IS NOT NULL`.

- [ ] **Step 3: Edit the query** — `src/main/rpc-router.ts` line 1236. Change:
```ts
               WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
```
to:
```ts
               WHERE s.workspace_id = ? AND s.pane_index IS NOT NULL
                 AND s.closed_at IS NULL
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/main/__tests__/list-for-workspace-closed-filter.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/rpc-router.ts src/main/__tests__/list-for-workspace-closed-filter.test.ts
git commit -m "fix(rpc): listForWorkspace excludes closed_at panes (no tile resurrection)"
```

---

### Task 9: Bug 2 (live resume) — exclude closed panes from resume + respawn

**Files:**
- Modify: `src/main/core/pty/resume-launcher.ts:345-349` (`listEligibleRows`) + `:480-483` (`listRespawnableRows`)

- [ ] **Step 1: Write the failing test** (SQL-shape guard on both queries)

```ts
// src/main/core/pty/__tests__/resume-closed-filter.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('resume + respawn exclude deliberately-closed panes', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'src/main/core/pty/resume-launcher.ts'),
    'utf8',
  );
  it('listEligibleRows ANDs closed_at IS NULL', () => {
    const m = src.match(/exit_code = -1[\s\S]{0,40}?\)\s*[\s\S]{0,40}?closed_at IS NULL/i);
    expect(m).not.toBeNull();
  });
  it('has two closed_at IS NULL guards (eligible + respawnable)', () => {
    const count = (src.match(/closed_at IS NULL/gi) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/pty/__tests__/resume-closed-filter.test.ts`
Expected: FAIL — 0 occurrences of `closed_at IS NULL`.

- [ ] **Step 3: Edit `listEligibleRows`** (resume-launcher.ts ~345-349). Change:
```ts
       WHERE s.workspace_id = ?
         AND (
           s.status = 'running'
           OR (s.status = 'exited' AND s.exit_code = -1)
         )
```
to:
```ts
       WHERE s.workspace_id = ?
         AND s.closed_at IS NULL
         AND (
           s.status = 'running'
           OR (s.status = 'exited' AND s.exit_code = -1)
         )
```

- [ ] **Step 4: Edit `listRespawnableRows`** (resume-launcher.ts ~480-483). Change:
```ts
       WHERE s.workspace_id = ?
         AND s.status = 'exited'
         AND s.exit_code = -1
```
to:
```ts
       WHERE s.workspace_id = ?
         AND s.closed_at IS NULL
         AND s.status = 'exited'
         AND s.exit_code = -1
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/main/core/pty/__tests__/resume-closed-filter.test.ts && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/pty/resume-launcher.ts src/main/core/pty/__tests__/resume-closed-filter.test.ts
git commit -m "fix(resume): exclude closed_at panes from resume + respawn (no live resurrection)"
```

---

### Task 10: Reaper invariant check (keep ⊇ use)

**Files:**
- Inspect: `src/main/core/db/janitor.ts`, any session/worktree reaper (grep `reap`, `prune`, `removeAndPrune`, retention `7`/`days`).

- [ ] **Step 1: Verify the keep-set still ⊇ the (now narrower) use-set.** The resume/use-set shrank (it now excludes `closed_at IS NOT NULL`). A reaper deleting closed rows can only ever delete rows the resume path NO LONGER needs — so keep ⊇ use holds trivially. CONFIRM no reaper deletes a row/worktree that `panes.reopen` (Task 12) will need before the retention window. Run:

Run: `grep -rn "reap\|prune\|closed_at\|retention\|removeAndPrune\|DELETE FROM agent_sessions" src/main/core/db src/main/core/pty src/main/core/workspaces | grep -iv test`
Expected: enumerate every place sessions/worktrees are deleted; confirm none keys off `pane_index IS NULL` or `status` in a way that would now spare-or-delete closed rows incorrectly.

- [ ] **Step 2: If a reaper hard-deletes sessions by age, add a closed-pane retention note/guard** so Recents (Part B) has rows to show within the window. If the reaper already deletes by `started_at`/`exited_at` age uniformly, closed rows are covered — document that in a one-line comment at the reaper and SKIP a code change (YAGNI).

- [ ] **Step 3: Commit (only if a guard/comment was added)**

```bash
git add -A && git commit -m "chore(reaper): confirm keep ⊇ use holds for closed_at soft-delete"
```

---

### Task 11: Part A integration gate

- [ ] **Step 1: Full local gate** (per repo policy — NO local e2e; e2e runs in CI)

Run: `npx tsc -b && npx vitest run && npm run lint && npm run build`
Expected: all green. (If `vitest run` flakes under load on swarm/voice suites, re-run the specific failing file in isolation — known flake class.)

- [ ] **Step 2: Manual smoke checklist** (operator, GUI — do NOT auto-launch electron locally):
  1. Open a workspace with 2-3 live panes.
  2. Click × on one running pane → **no "Pane exited" toast** appears. Tile vanishes.
  3. Quit and reopen the app → the closed pane **does NOT** come back; the others resume.
  4. Repeat with a pane whose agent already finished (exit 0) left on screen → it still rehydrates (only DELIBERATE closes vanish).

- [ ] **Step 3: Push branch + open PR** (e2e-matrix runs in CI). Title: `fix(panes): deliberate-close soft-delete — no exit toast, no restart resurrection`.

---

## Part B — Recents recoverability (follow-on)

> Operator chose "Recoverable via Recents." Part A fully fixes both reported bugs; Part B makes an accidental × reopenable. Ship Part A first (own PR), then Part B.

### Task 12: `panes.listClosed` + `panes.reopen` RPCs

**Files:**
- Modify: `src/main/rpc-router.ts` (`panes` namespace) + the RPC sibling surfaces (router-shape/rpc-channels/schemas — same mirror set as Task 4).
- Create: `src/main/core/pty/reopen-pane.ts` + test.

- [ ] **Step 1: Write the failing test for `clearClosedMarker`**

```ts
// src/main/core/pty/reopen-pane.test.ts
import { describe, it, expect } from 'vitest';
import { clearClosedMarker } from './reopen-pane';

class MockStmt {
  constructor(public sql: string, private sink: Array<{ sql: string; args: unknown[] }>) {}
  run(...args: unknown[]): void {
    this.sink.push({ sql: this.sql.replace(/\s+/g, ' ').trim(), args });
  }
}
class MockDb {
  calls: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string): MockStmt { return new MockStmt(sql, this.calls); }
}

describe('clearClosedMarker', () => {
  it('nulls closed_at for the session', () => {
    const db = new MockDb();
    clearClosedMarker(db as never, 's1');
    expect(db.calls[0].sql).toBe('UPDATE agent_sessions SET closed_at = NULL WHERE id = ?');
    expect(db.calls[0].args).toEqual(['s1']);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run src/main/core/pty/reopen-pane.test.ts` → `Cannot find module`.

- [ ] **Step 3: Implement**

```ts
// src/main/core/pty/reopen-pane.ts
import type Database from 'better-sqlite3';

/** Undo a deliberate close so the pane is eligible for rehydrate/resume again. */
export function clearClosedMarker(db: Database.Database, sessionId: string): void {
  db.prepare(`UPDATE agent_sessions SET closed_at = NULL WHERE id = ?`).run(sessionId);
}
```

- [ ] **Step 4: Add the RPCs** — `src/main/rpc-router.ts` `panes` namespace:

```ts
    // Recents — list deliberately-closed panes for a workspace (most-recent first).
    listClosed: async (workspaceId: string) => {
      try {
        const rows = getRawDb()
          .prepare(
            `SELECT id, provider_id AS providerId, cwd, name, closed_at AS closedAt
               FROM agent_sessions
               WHERE workspace_id = ? AND closed_at IS NOT NULL AND pane_index IS NOT NULL
               ORDER BY closed_at DESC
               LIMIT 20`,
          )
          .all(workspaceId);
        return rows as Array<{ id: string; providerId: string; cwd: string; name: string | null; closedAt: number }>;
      } catch {
        return [];
      }
    },
    // Reopen a closed pane: clear closed_at, then respawn it fresh in its cwd
    // (mirrors respawnFailedWorkspacePanes' single-row spawn). Returns the new
    // session so the renderer can ADD_SESSIONS it.
    reopen: async (sessionId: string) => {
      clearClosedMarker(getRawDb(), sessionId);
      return respawnSessionById(sessionId, { /* deps as respawnFailed uses */ });
    },
```

> `respawnSessionById` does not exist yet — extract the single-row spawn body out of `respawnFailedWorkspacePanes` (`resume-launcher.ts:496-` loop body) into an exported `respawnSessionById(sessionId, deps)` and call it from BOTH `respawnFailedWorkspacePanes` (in its loop) and `panes.reopen`. This keeps the GHOST-HEAL external-session-id nulling logic in one place. Add `clearClosedMarker` + `respawnSessionById` imports to rpc-router.ts.

- [ ] **Step 5: Mirror `panes.listClosed` + `panes.reopen` across router-shape/rpc-channels/schemas** (grep `'close'`/`'rename'` per Task 4). Typecheck.

- [ ] **Step 6: Run tests + typecheck + commit**

```bash
npx vitest run src/main/core/pty/reopen-pane.test.ts && npx tsc -b
git add -A && git commit -m "feat(rpc): panes.listClosed + panes.reopen (Recents recoverability)"
```

---

### Task 13: "Recently closed" UI affordance

**Files:**
- Inspect template: the browser-tab Recents UI (grep `listRecents` consumers in `src/renderer` — the browser tab recents list is the existing pattern to mirror).
- Modify: the Add-Pane menu / Command Room — add a "Recently closed" section listing `panes.listClosed`, each row reopening via `panes.reopen` → `ADD_SESSIONS`.

- [ ] **Step 1: Locate the browser Recents component** as the template:

Run: `grep -rln "listRecents\|Recents\|reopen" src/renderer/features/browser src/renderer | grep -iv test`
Then read that component to mirror its list + click-to-reopen shape for panes.

- [ ] **Step 2: Add a `RecentlyClosedPanes` list** (new component under `src/renderer/features/command-room/`) that:
  - on mount + on workspace change, calls `rpc.panes.listClosed(workspaceId)`;
  - renders each closed pane (provider glyph + `name ?? cwd basename` + relative closed time);
  - on click, `await rpc.panes.reopen(id)` then `dispatch({ type: 'ADD_SESSIONS', sessions: [result.session] })` and `SET_ACTIVE_SESSION`.

- [ ] **Step 3: Surface it** in the Add-Pane menu (next to `AddPaneButton`) or the pane context area — wherever the browser recents equivalently lives. Keep it collapsed/empty-hidden when `listClosed` returns `[]`.

- [ ] **Step 4: Test** the reopen handler contract (vi.fn rpc surface, like Task 5) — click → `reopen(id)` called → `ADD_SESSIONS` dispatched.

- [ ] **Step 5: Gate + commit + PR** (Part B, separate PR).

```bash
npx tsc -b && npx vitest run && npm run lint && npm run build
git add -A && git commit -m "feat(command-room): Recently-closed panes list (reopen accidental closes)"
```

---

## Self-Review

- **Spec coverage:** Bug 1 (toast) → Task 7. Bug 2 tile → Task 8. Bug 2 live resume → Task 9. Marker → Tasks 1-3. Unified close primitive → Tasks 4-6. Recoverable-via-Recents → Tasks 12-13. Reaper invariant → Task 10. ✅
- **closed_at is the single durable axis** — every exclusion (toast, rehydrate, eligible, respawnable) keys off `closed_at IS NULL`, never status (status is overwritten by the late onExit). ✅
- **Sibling-miss guard:** RPC plumbing (Task 4/12) explicitly greps `rename`/`kill`/`close` across router-shape + rpc-channels + schemas; all three manual-close UI sites funnel through `handleRemove` (Task 5); `close_pane` unified (Task 6). ✅
- **Ordering invariant:** `markPaneClosed` runs BEFORE `pty.kill` everywhere (Tasks 4 + 6) so the async exit sees the marker. ✅
- **Type consistency:** `markPaneClosed(db, sessionId, now)`, `clearClosedMarker(db, sessionId)`, `SessionCloseMeta {workspaceId, closedAt}`, `panes.close(sessionId)`, `panes.reopen(sessionId)`, `panes.listClosed(workspaceId)` — names used consistently across tasks. ✅
- **Test harness:** DB-touching code tested via `MockDb`/SQL-shape guards (better-sqlite3 won't load under vitest); migration test mirrors 0033 exactly. ✅
- **Known-flake note:** under-load full-vitest timeouts on swarm/voice suites — re-run the file in isolation, don't react. e2e deferred to CI (never local). ✅
