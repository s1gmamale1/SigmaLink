# DB Bootstrap Index Convergence + Workspace Remove Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `BOOTSTRAP_SQL` from re-creating the unique `workspaces_root_idx` on every boot after migration 0034 dropped it (which breaks `workspaces.openNew` and can crash boot outright), and make `removeWorkspace` stop the workspace's live PTYs and delete its `agent_sessions` rows so nothing keeps running headless or orphans forever.

**Architecture:** Finding 1 is a boot-order bug: `bootstrapAndMigrate()` (`client.ts`) exec's `BOOTSTRAP_SQL` on EVERY boot BEFORE `migrate()`, but migration 0034 (recorded once in `schema_migrations`) drops the unique index exactly once — so the next boot silently resurrects it, and if duplicate `root_path` rows already exist (legal since DEV-W3a), `CREATE UNIQUE INDEX` throws and the app fails to boot. The fix makes the bootstrap converge with 0034's end-state (non-unique `workspaces_root_lookup_idx`) plus a defensive `DROP INDEX IF EXISTS workspaces_root_idx` so already-poisoned installs self-heal. Finding 2 is a lifecycle gap: `removeWorkspace` (`factory.ts`) stops the ruflo daemon then deletes only the `workspaces` row; `agent_sessions` has NO foreign key (bootstrap DDL, unlike `swarms`/`browser_tabs` which cascade), so live PTYs survive headless and orphaned rows get flipped to `exited/-1` by the boot janitor — a state the worktree keep-predicate protects with no time bound. The fix mirrors `cleanup.ts#removeWorkspaceAndGc`'s `stopLiveSessions` path inside `removeWorkspace`: stop live PTY trees (fail-open), delete the workspace's session rows, then the workspace row, and threads the live `PtyRegistry` through the one RPC call site.

**Tech Stack:** TypeScript (Electron main process), better-sqlite3 (Electron-ABI native — NEVER loaded in tests), drizzle-orm, vitest with hand-rolled DB fakes (source-text parsing + fake index engine + drizzle-shaped mocks, per `migrate.runner.test.ts` / `factory.test.ts` precedent).

---

## Findings Verification (2026-06-10, evidence at HEAD)

Both findings were re-verified against the working tree before planning. **Nothing is refuted.**

1. **CRIT [db] — CONFIRMED.** `app/src/main/core/db/client.ts:28` still reads `CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_idx ON workspaces(root_path);` inside `BOOTSTRAP_SQL`; `bootstrapAndMigrate()` (client.ts:246-253) execs it before `migrate()`; 0034 (`migrations/0034_drop_workspaces_root_idx.ts:21-25`) drops it once and creates the non-unique `workspaces_root_lookup_idx`. The drizzle schema (`schema.ts:33`) was already updated to the non-unique `workspaces_root_lookup_idx` — only `BOOTSTRAP_SQL` is stale. Fresh-install boot 1 works (bootstrap creates unique → 0034 drops it same boot); from boot 2 onward the unique index is back (`IF NOT EXISTS` no longer guards because 0034 never re-runs). `openWorkspaceNew` (factory.ts:83-110) then throws `UNIQUE constraint failed`; with pre-existing duplicate rows, `sqlite.exec(BOOTSTRAP_SQL)` itself throws → `initializeDatabase` (client.ts:333) throws unwrapped → `registerRouter` rejects → boot failure.
2. **MED [ws] — CONFIRMED.** `removeWorkspace` (factory.ts:359-377) stops the ruflo daemon then `db.delete(workspaces)` only. `agent_sessions` bootstrap DDL (client.ts:30-43) has no FK. Janitor (janitor.ts:33-50) flips orphans to `exited`/`-1`; the keep-predicate (worktree-cleanup.ts:61-72) protects `exited AND exit_code = -1` rows' worktrees with NO time bound → kept on disk permanently. Mirror target `removeWorkspaceAndGc` read in full (cleanup.ts:280-358) — its `stopLiveSessions` path does `pty.stop(id, { tree: true, forget: true })` then `DELETE FROM agent_sessions WHERE workspace_id = ?` then the workspace row. **A sibling plan owns cleanup.ts's prune-ordering bug — this plan only mirrors and does NOT modify cleanup.ts.**
3. **Sub-question "does 0034 need an idempotence tweak?" — No change needed.** 0034 already uses `DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS` and its idempotence is pinned by `migrations/0034_drop_workspaces_root_idx.test.ts` ("is idempotent — two runs safe"). The convergence fix lives entirely in `BOOTSTRAP_SQL`.

## Test Constraint (read before writing any test)

vitest CANNOT load better-sqlite3 (compiled for Electron's ABI via electron-builder install-app-deps; see `reference_better_sqlite3_electron_abi`). `client.ts` imports it at module top, so tests must NEVER import `client.ts` and NEVER call `new Database()`. This plan uses the two established patterns:
- **Source-text parsing** (precedent: `db/__tests__/migrate.spec.ts`): read `client.ts` as text, extract `BOOTSTRAP_SQL`, replay it against a tiny fake.
- **Module mocks** (precedent: `workspaces/factory.test.ts`, `factory.rename.test.ts`): `vi.mock('../db/client', ...)` with drizzle-shaped fakes before importing `factory.ts`.

All commands below run from `/Users/aisigma/projects/SigmaLink/app`.

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `app/src/main/core/db/client.bootstrap-index.test.ts` | Bootstrap×0034 index-convergence regression suite (fake index engine, no native module) |
| Create | `app/src/main/core/workspaces/factory.remove.test.ts` | `removeWorkspace` lifecycle suite (PTY stop + row deletion order, fail-open) |
| Modify | `app/src/main/core/db/client.ts:28` | Replace the unique-index line in `BOOTSTRAP_SQL` with `DROP` + non-unique lookup index |
| Modify | `app/src/main/core/workspaces/factory.ts:7-8` (imports), `:38-40` (`RemoveWorkspaceDeps`), `:359-377` (`removeWorkspace`) | Stop live PTYs, delete session rows before the workspace row |
| Modify | `app/src/main/rpc-router.ts:1455-1458` | Thread the live `pty` registry into `workspaces.remove` |

**Deliberately NOT touched** (sibling-plan territory / verified no change needed): `workspaces/cleanup.ts`, `workspaces/worktree-cleanup.ts`, `db/janitor.ts`, `db/migrations/0034_drop_workspaces_root_idx.ts`, `db/migrate.ts`, `db/schema.ts` (already non-unique), `pty/registry.ts` (type-imported only).

---

### Task 1: BOOTSTRAP_SQL × 0034 index convergence (CRIT [db])

**Files:**
- Create: `src/main/core/db/client.bootstrap-index.test.ts`
- Modify: `src/main/core/db/client.ts:28` (the one line inside `BOOTSTRAP_SQL`)
- Test: `src/main/core/db/client.bootstrap-index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/db/client.bootstrap-index.test.ts` with exactly:

```typescript
// CRIT [db] 2026-06-10 audit — BOOTSTRAP_SQL re-created the UNIQUE
// workspaces_root_idx on EVERY boot after migration 0034 dropped it once.
// bootstrapAndMigrate() execs BOOTSTRAP_SQL before migrate(); 0034 is
// recorded in schema_migrations and never re-runs, so from boot 2 onward the
// unique index is back: workspaces.openNew (DEV-W3a duplicate root_path by
// design) throws UNIQUE constraint, and if duplicate rows ALREADY exist the
// CREATE UNIQUE INDEX itself throws -> initializeDatabase throws ->
// registerRouter rejects -> the app fails to boot.
//
// better-sqlite3 cannot load under vitest (Electron ABI) and client.ts
// imports it at module top — so, following the migrate.spec.ts precedent,
// this suite parses BOOTSTRAP_SQL out of client.ts SOURCE TEXT and replays
// the boot sequence (bootstrap -> 0034 -> bootstrap -> ...) against a fake
// index engine that models exactly the SQLite behaviours at stake:
//   - CREATE [UNIQUE] INDEX IF NOT EXISTS <name> ON workspaces(root_path)
//   - DROP INDEX IF EXISTS <name>
//   - CREATE UNIQUE INDEX over duplicate root_path rows THROWS
// No `new Database()` is ever called.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { up as up0034 } from './migrations/0034_drop_workspaces_root_idx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf8');

function bootstrapSql(): string {
  const m = clientSrc.match(/const BOOTSTRAP_SQL = `([\s\S]*?)`;/);
  if (!m) throw new Error('BOOTSTRAP_SQL template literal not found in client.ts');
  return m[1];
}

interface IndexState {
  unique: boolean;
}

/**
 * Models ONLY the workspaces(root_path) index DDL out of any SQL batch.
 * Every other statement (CREATE TABLE, indexes on other tables, `--`
 * comments) is ignored — faithful enough to reproduce the boot-order bug.
 */
class FakeIndexEngine {
  indexes = new Map<string, IndexState>();
  /** Simulates duplicate root_path rows in workspaces (legal since DEV-W3a:
   *  openWorkspaceNew inserts duplicates by design). */
  hasDuplicateRootPaths = false;

  exec(sql: string): void {
    for (const raw of sql.split(';')) {
      const stmt = raw
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join(' ')
        .trim()
        .replace(/\s+/g, ' ');
      if (!stmt) continue;

      const create =
        /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON workspaces\s*\(\s*root_path\s*\)$/i.exec(
          stmt,
        );
      if (create) {
        const unique = Boolean(create[1]);
        const name = create[2];
        if (this.indexes.has(name)) continue; // IF NOT EXISTS
        if (unique && this.hasDuplicateRootPaths) {
          // Real SQLite: building a UNIQUE index over duplicate values throws.
          // In production that aborts sqlite.exec(BOOTSTRAP_SQL) ->
          // initializeDatabase throws (client.ts, unwrapped) -> boot failure.
          throw new Error(
            `UNIQUE constraint failed: workspaces.root_path (creating ${name})`,
          );
        }
        this.indexes.set(name, { unique });
        continue;
      }

      const drop = /^DROP INDEX IF EXISTS (\w+)$/i.exec(stmt);
      if (drop) {
        this.indexes.delete(drop[1]);
        continue;
      }
      /* anything else: not modelled */
    }
  }

  /** Lets the engine stand in for better-sqlite3 where only exec() is used
   *  (0034's up() calls db.exec exactly twice). */
  asDb(): Database.Database {
    return this as unknown as Database.Database;
  }

  uniqueIndexNames(): string[] {
    return [...this.indexes.entries()]
      .filter(([, s]) => s.unique)
      .map(([name]) => name);
  }
}

describe('BOOTSTRAP_SQL x migration 0034 — workspaces(root_path) index convergence', () => {
  it('source: BOOTSTRAP_SQL no longer declares the UNIQUE workspaces_root_idx', () => {
    expect(bootstrapSql()).not.toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+workspaces_root_idx/i,
    );
  });

  it('source: BOOTSTRAP_SQL defensively drops the unique twin and creates the non-unique lookup index', () => {
    const sql = bootstrapSql();
    expect(sql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+workspaces_root_idx/i);
    expect(sql).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+workspaces_root_lookup_idx\s+ON\s+workspaces\s*\(\s*root_path\s*\)/i,
    );
  });

  it('fresh install: boot 2 (bootstrap re-runs, 0034 already recorded) leaves NO unique index', () => {
    const eng = new FakeIndexEngine();
    // Boot 1 — bootstrapAndMigrate(): BOOTSTRAP_SQL, then pending 0034 runs once.
    eng.exec(bootstrapSql());
    up0034(eng.asDb());
    // Boot 2 — BOOTSTRAP_SQL re-runs; 0034 is recorded and never re-runs.
    eng.exec(bootstrapSql());

    expect(eng.uniqueIndexNames()).toEqual([]);
    expect(eng.indexes.has('workspaces_root_lookup_idx')).toBe(true);
    expect(eng.indexes.has('workspaces_root_idx')).toBe(false);
  });

  it('duplicate root_path rows already inserted (DEV-W3a): the next boot must not throw', () => {
    const eng = new FakeIndexEngine();
    eng.exec(bootstrapSql());
    up0034(eng.asDb());
    // Operator used workspaces.openNew — two rows now share a root_path.
    eng.hasDuplicateRootPaths = true;
    // Boot 2: with the old SQL this threw (CREATE UNIQUE INDEX over dupes)
    // and the app failed to boot.
    expect(() => eng.exec(bootstrapSql())).not.toThrow();
    expect(eng.uniqueIndexNames()).toEqual([]);
  });

  it('self-heal: an install where a past boot already re-created the unique twin converges', () => {
    const eng = new FakeIndexEngine();
    // State left behind by the buggy build: BOTH indexes exist.
    eng.indexes.set('workspaces_root_idx', { unique: true });
    eng.indexes.set('workspaces_root_lookup_idx', { unique: false });
    // Next boot with the fixed SQL (0034 recorded, only bootstrap runs).
    eng.exec(bootstrapSql());

    expect(eng.indexes.has('workspaces_root_idx')).toBe(false);
    expect(eng.indexes.has('workspaces_root_lookup_idx')).toBe(true);
    expect(eng.uniqueIndexNames()).toEqual([]);
  });

  it('pre-0034 upgrade converges to the same end-state as a fresh install', () => {
    // Upgrading install: legacy unique index live, 0034 still pending.
    const upgraded = new FakeIndexEngine();
    upgraded.indexes.set('workspaces_root_idx', { unique: true });
    upgraded.exec(bootstrapSql());
    up0034(upgraded.asDb()); // pending migration applies on this boot
    upgraded.exec(bootstrapSql()); // ...and the boot after

    // Fresh install, two boots.
    const fresh = new FakeIndexEngine();
    fresh.exec(bootstrapSql());
    up0034(fresh.asDb());
    fresh.exec(bootstrapSql());

    expect([...upgraded.indexes.entries()].sort()).toEqual(
      [...fresh.indexes.entries()].sort(),
    );
    expect(upgraded.uniqueIndexNames()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/core/db/client.bootstrap-index.test.ts`

Expected: **FAIL — all 6 tests fail.** Representative messages: test 1 `expected ... not to match /CREATE\s+UNIQUE\s+INDEX.../` (the unique line is still in the source); test 3 `expected [ 'workspaces_root_idx' ] to deeply equal []` (boot 2 resurrected the unique index); test 4 `expected [Function] to not throw an error but 'UNIQUE constraint failed: workspaces.root_path (creating workspaces_root_idx)' was thrown`.

- [ ] **Step 3: Write the minimal implementation**

In `src/main/core/db/client.ts`, replace the single line 28:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_idx ON workspaces(root_path);
```

with:

```sql
-- DEV-W3a / migration 0034: root_path is intentionally NON-unique (two
-- workspaces may share one directory, disambiguated by custom name).
-- BOOTSTRAP_SQL runs on EVERY boot BEFORE migrate(), so it must converge with
-- 0034's end-state: the old CREATE UNIQUE INDEX here re-created the dropped
-- index on every boot after 0034 had run once (breaking workspaces.openNew),
-- and CRASHED boot outright when duplicate root_path rows already existed.
-- The DROP self-heals installs where an older build's bootstrap already
-- re-created the unique twin.
DROP INDEX IF EXISTS workspaces_root_idx;
CREATE INDEX IF NOT EXISTS workspaces_root_lookup_idx ON workspaces(root_path);
```

(`--` comments are valid SQLite inside `exec`; `DROP INDEX IF EXISTS` is a no-op on fresh databases. The drizzle schema at `schema.ts:33` already declares only the non-unique `workspaces_root_lookup_idx`, so no schema change is needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/core/db/client.bootstrap-index.test.ts`

Expected: PASS — 6 passed.

- [ ] **Step 5: Run the neighbouring DB suites to catch collateral damage**

Run: `npx vitest run src/main/core/db/migrations/0034_drop_workspaces_root_idx.test.ts src/main/core/db/__tests__/migrate.runner.test.ts src/main/core/db/client.kv-migration.test.ts src/main/core/db/corruption.test.ts src/main/core/db/janitor.test.ts`

Expected: PASS — all suites green (none of them reference the bootstrap index line; `corruption.test.ts:63` mentions `workspaces_root_idx` only inside a fake quick_check string, unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/db/client.ts src/main/core/db/client.bootstrap-index.test.ts
git commit -m "fix(db): stop BOOTSTRAP_SQL resurrecting the unique workspaces_root_idx every boot after 0034 — converge on the non-unique lookup index + self-heal poisoned installs"
```

---

### Task 2: removeWorkspace stops live PTYs and deletes its agent_sessions rows (MED [ws])

**Files:**
- Create: `src/main/core/workspaces/factory.remove.test.ts`
- Modify: `src/main/core/workspaces/factory.ts:7-8` (imports), `:38-40` (`RemoveWorkspaceDeps`), `:359-377` (`removeWorkspace`)
- Test: `src/main/core/workspaces/factory.remove.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/workspaces/factory.remove.test.ts` with exactly:

```typescript
// MED [ws] 2026-06-10 audit — removeWorkspace stopped the ruflo daemon then
// deleted ONLY the workspaces row: live PTYs kept running headless and
// agent_sessions rows orphaned forever (the bootstrap agent_sessions DDL has
// no FK/cascade, unlike swarms/browser_tabs). Next boot the janitor flips the
// orphans to exited/-1, whose worktrees the keep-predicate protects with no
// time bound. The fixed removeWorkspace mirrors cleanup.ts
// removeWorkspaceAndGc's stopLiveSessions semantics: stop live
// (starting|running) PTYs with {tree:true, forget:true}, delete the
// workspace's agent_sessions rows, THEN delete the workspace row.
//
// better-sqlite3 cannot load under vitest (Electron ABI) — every external
// module factory.ts touches is mocked, same harness as factory.test.ts.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  },
}));
vi.mock('../git/git-ops', () => ({ getRepoRoot: vi.fn(async () => null) }));
vi.mock('./mcp-autowrite', () => ({
  KV_RUFLO_AUTOWRITE_MCP: 'ruflo.autowriteMcp',
  KV_RUFLO_AUTOTRUST_MCP: 'ruflo.autotrustMcp',
  writeWorkspaceMcpConfig: vi.fn(),
}));
vi.mock('./mcp-trust', () => ({ ensureRufloTrusted: vi.fn() }));
vi.mock('./ruflo-fallback-notice', () => ({ maybeNotifyStdioFallback: vi.fn() }));
vi.mock('../ruflo/seed-workspace-memory', () => ({
  seedWorkspaceMemory: vi.fn(async () => {}),
}));
vi.mock('../ruflo/verify', () => ({
  KV_RUFLO_STRICT_MCP_VERIFICATION: 'ruflo.strictMcpVerification',
  verifyForWorkspace: vi.fn(async () => ({ ok: true })),
}));

// ── Fake drizzle db — captures delete-call order by TABLE OBJECT identity ──

interface FakeSessionRow {
  id: string;
  status: string;
  workspaceId: string;
}

let _sessions: FakeSessionRow[] = [];
/** drizzle table objects passed to db.delete(), in call order. */
let _deletedTables: unknown[] = [];

vi.mock('../db/client', () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => _sessions),
          get: vi.fn(() => undefined),
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        run: vi.fn(() => {
          _deletedTables.push(table);
        }),
      })),
    })),
    insert: vi.fn(),
    update: vi.fn(),
  })),
  getRawDb: vi.fn(() => ({
    pragma: vi.fn(),
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
  })),
}));

import { removeWorkspace } from './factory';
// schema.ts is pure drizzle-orm/sqlite-core (no native module) — safe to
// import; factory.ts imports the SAME module instance, so identity comparison
// of table objects is sound.
import { agentSessions, workspaces } from '../db/schema';

describe('removeWorkspace — session lifecycle (2026-06-10 audit MED [ws])', () => {
  let ptyStop: Mock<
    (id: string, opts?: { tree?: boolean; forget?: boolean }) => null
  >;

  beforeEach(() => {
    _sessions = [];
    _deletedTables = [];
    ptyStop = vi.fn(
      (_id: string, _opts?: { tree?: boolean; forget?: boolean }) => null,
    );
  });

  it('stops live (starting|running) PTYs with {tree:true, forget:true} and skips dead ones', async () => {
    _sessions = [
      { id: 's-running', status: 'running', workspaceId: 'ws-1' },
      { id: 's-starting', status: 'starting', workspaceId: 'ws-1' },
      { id: 's-exited', status: 'exited', workspaceId: 'ws-1' },
      { id: 's-error', status: 'error', workspaceId: 'ws-1' },
    ];

    await removeWorkspace('ws-1', { pty: { stop: ptyStop } });

    expect(ptyStop).toHaveBeenCalledTimes(2);
    expect(ptyStop).toHaveBeenCalledWith('s-running', { tree: true, forget: true });
    expect(ptyStop).toHaveBeenCalledWith('s-starting', { tree: true, forget: true });
  });

  it('deletes the agent_sessions rows BEFORE the workspaces row', async () => {
    _sessions = [{ id: 's-1', status: 'exited', workspaceId: 'ws-1' }];

    await removeWorkspace('ws-1', { pty: { stop: ptyStop } });

    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('still deletes both row sets when no pty registry is provided', async () => {
    _sessions = [{ id: 's-1', status: 'running', workspaceId: 'ws-1' }];

    await expect(removeWorkspace('ws-1')).resolves.toBeUndefined();

    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('a throwing pty.stop does not abort removal and later sessions are still stopped (fail-open)', async () => {
    _sessions = [
      { id: 's-boom', status: 'running', workspaceId: 'ws-1' },
      { id: 's-2', status: 'running', workspaceId: 'ws-1' },
    ];
    ptyStop.mockImplementation((id: string) => {
      if (id === 's-boom') throw new Error('kill failed');
      return null;
    });

    await expect(
      removeWorkspace('ws-1', { pty: { stop: ptyStop } }),
    ).resolves.toBeUndefined();

    expect(ptyStop).toHaveBeenCalledTimes(2);
    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('stops the ruflo HTTP daemon and its failure never blocks removal (pre-existing contract)', async () => {
    const daemonStop = vi.fn(async (_workspaceId: string) => {
      throw new Error('daemon stop failed');
    });

    await expect(
      removeWorkspace('ws-1', { rufloHttpDaemonSupervisor: { stop: daemonStop } }),
    ).resolves.toBeUndefined();

    expect(daemonStop).toHaveBeenCalledWith('ws-1');
    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/core/workspaces/factory.remove.test.ts`

Expected: **FAIL — all 5 tests fail.** Representative messages: test 1 `expected "spy" to be called 2 times, but got 0 times` (current code never touches the PTY registry — `RemoveWorkspaceDeps` has no `pty` field yet, but the extra object property is structurally ignored at runtime); tests 2-5 `expected [ workspaces-table ] to deeply equal [ agentSessions-table, workspaces-table ]` (current code deletes only the `workspaces` row). NOTE: until Step 3 adds the `pty` field, `tsc` would reject `{ pty: ... }` — that is fine; vitest transpiles without typechecking and the full `tsc -b` gate runs after the implementation lands.

- [ ] **Step 3: Write the minimal implementation**

In `src/main/core/workspaces/factory.ts`, make three edits.

Edit 3a — extend the schema import (line 8):

```typescript
// OLD:
import { workspaces } from '../db/schema';
// NEW:
import { agentSessions, workspaces } from '../db/schema';
```

Edit 3b — add the PtyRegistry type import (next to the other type-only imports, after line 15 `import type { RufloHttpDaemonSupervisor } from '../ruflo/http-daemon-supervisor';`):

```typescript
import type { PtyRegistry } from '../pty/registry';
```

Edit 3c — replace the `RemoveWorkspaceDeps` interface (lines 38-40) and the whole `removeWorkspace` function (lines 359-377) with:

```typescript
export interface RemoveWorkspaceDeps {
  rufloHttpDaemonSupervisor?: Pick<RufloHttpDaemonSupervisor, 'stop'>;
  /** 2026-06-10 audit — live PTY registry so removal can stop the workspace's
   *  running panes. Optional: callers without a registry still get the DB-row
   *  cleanup (the stop loop is skipped per-row via optional chaining). */
  pty?: Pick<PtyRegistry, 'stop'>;
}
```

```typescript
export async function removeWorkspace(id: string, deps: RemoveWorkspaceDeps = {}): Promise<void> {
  // v1.6.0-A — stop the per-workspace Ruflo HTTP daemon BEFORE deleting the
  // DB row so the supervisor's map entry is cleared on the same operation.
  // Stop is best-effort; failures are logged and never block workspace
  // removal.
  if (deps.rufloHttpDaemonSupervisor) {
    try {
      await deps.rufloHttpDaemonSupervisor.stop(id);
    } catch (err) {
      console.warn(
        `[ruflo-http] daemon stop failed for workspace ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const db = getDb();
  // 2026-06-10 audit (MED ws) — agent_sessions has NO foreign key to
  // workspaces (its bootstrap DDL predates the cascading tables), so deleting
  // only the workspace row leaked: live PTYs kept running headless, and the
  // orphaned rows were flipped to exited/-1 by the boot janitor — a state the
  // worktree keep-predicate protects with no time bound. Mirror
  // cleanup.ts#removeWorkspaceAndGc's stopLiveSessions path: stop live PTY
  // trees (fail-open, one bad session never aborts the batch), delete the
  // session rows, THEN the workspace row. Sessions first so a crash between
  // the two deletes leaves the workspace visible and remove retryable —
  // the reverse order would orphan the rows this fix exists to clean up.
  // (session_review rows cascade off agent_sessions via FK; foreign_keys=ON.)
  const sessionRows = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.workspaceId, id))
    .all();
  for (const row of sessionRows) {
    if (row.status === 'starting' || row.status === 'running') {
      try {
        deps.pty?.stop(row.id, { tree: true, forget: true });
      } catch (err) {
        console.warn(
          `[workspaces.remove] pty stop failed for session ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  db.delete(agentSessions).where(eq(agentSessions.workspaceId, id)).run();
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
}
```

(`eq` is already imported at factory.ts line 6; `getDb` at line 7. Disk-level worktree GC intentionally stays out of `removeWorkspace` — that is what the separate `cleanup.removeWorkspace` RPC / `removeWorkspaceAndGc` is for. YAGNI.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/core/workspaces/factory.remove.test.ts`

Expected: PASS — 5 passed.

- [ ] **Step 5: Run the sibling workspace suites to catch collateral damage**

Run: `npx vitest run src/main/core/workspaces/factory.test.ts src/main/core/workspaces/factory.rename.test.ts src/main/core/workspaces/cleanup.test.ts src/main/core/workspaces/launcher.test.ts`

Expected: PASS — all green (`factory.test.ts` exercises only `openWorkspaceNew`; its `../db/client` mock already stubs `delete`, so the module still loads cleanly).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspaces/factory.ts src/main/core/workspaces/factory.remove.test.ts
git commit -m "fix(workspaces): removeWorkspace stops live PTYs and deletes agent_sessions rows before dropping the workspace row"
```

---

### Task 3: Thread the live PtyRegistry into workspaces.remove (rpc-router)

**Files:**
- Modify: `src/main/rpc-router.ts:1455-1458`
- Test: typecheck only — rpc-router.ts is the Electron-bound mega-module and is not vitest-loadable (documented constraint); behaviour is pinned by Task 2's unit suite.

- [ ] **Step 1: Edit the workspaces.remove handler**

In `src/main/rpc-router.ts`, inside `workspacesCtl` (lines 1455-1458), replace:

```typescript
    remove: async (id: string) => {
      await removeWorkspace(id, { rufloHttpDaemonSupervisor });
      markWorkspaceClosed(id);
    },
```

with:

```typescript
    remove: async (id: string) => {
      // 2026-06-10 audit — pass the live PTY registry so removeWorkspace can
      // stop the workspace's running panes before deleting their rows (no
      // headless PTYs, no orphaned agent_sessions). cleanup.removeWorkspace
      // (removeWorkspaceAndGc) already threads its own `pty` input.
      await removeWorkspace(id, { rufloHttpDaemonSupervisor, pty });
      markWorkspaceClosed(id);
    },
```

(`pty` is already a local binding in this scope — the sibling `providersCtl.spawnInstall` handler calls `pty.create(...)` and `workspacesCtl.launch` passes `pty` to `executeLaunchPlan`.)

- [ ] **Step 2: Verify there are no other call sites of factory's removeWorkspace (sibling-call-site discipline)**

Run: `grep -rn "removeWorkspace(" src/main --include="*.ts" | grep -v "removeWorkspaceAndGc" | grep -v "\.test\.ts"`

Expected output — exactly two lines: the definition in `src/main/core/workspaces/factory.ts` and the single call in `src/main/rpc-router.ts` (now passing `pty`). The `cleanup.removeWorkspace` RPC handler (rpc-router.ts:2343) calls `removeWorkspaceAndGc` — a different, already-PTY-aware path owned by a sibling plan; do not touch it.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`

Expected: exit 0, no output. (This also retroactively typechecks Task 2's test file — `tsc -b` checks tests; the worktree tsc is laxer than main, so re-gate in main if executing from a worktree.)

- [ ] **Step 4: Commit**

```bash
git add src/main/rpc-router.ts
git commit -m "fix(workspaces): thread the live pty registry into workspaces.remove so panes are stopped on removal"
```

---

### Task 4: Full gate

**Files:** none (verification only). All commands from `/Users/aisigma/projects/SigmaLink/app`. NO local playwright/e2e — the CI e2e-matrix owns that (operator rule: never launch competing Electron windows locally).

- [ ] **Step 1: Typecheck**

Run: `npx tsc -b`
Expected: exit 0.

- [ ] **Step 2: Lint**

Run: `npx eslint . --max-warnings 0`
Expected: exit 0, no warnings. (If the new test files trip a rule, fix the test code — do not add eslint-disable pragmas beyond what neighbouring suites already use.)

- [ ] **Step 3: Full unit suite**

Run: `npx vitest run`
Expected: all suites pass. Known flake note: under machine load, `swarms/factory` and `VoiceTab` files can time out — re-run that single file in isolation before treating it as a regression.

- [ ] **Step 4: Product check**

Run: `npm run product:check`
Expected: build + electron:compile succeed, exit 0.

---

## Coordination notes (sibling plan batch, 2026-06-10 audit)

**Files this plan touches → sibling overlap:**

| File | This plan | Sibling overlap |
|------|-----------|-----------------|
| `src/main/core/db/client.ts` | BOOTSTRAP_SQL index block only | None known — safe to land first |
| `src/main/core/workspaces/factory.ts` | imports + `RemoveWorkspaceDeps` + `removeWorkspace` | None known |
| `src/main/rpc-router.ts` | 1 handler (`workspaces.remove`, ~4 lines) | **rpc-boundary-hardening** also edits rpc-router.ts — coordinate; this diff is tiny, rebases trivially in either order |
| `src/main/core/pty/registry.ts` | NOT edited (type-import + `stop()` call only) | **pty-lifecycle-resume-fixes** owns registry/resume-launcher; if it changes `stop()`'s signature, re-run `factory.remove.test.ts` |
| `src/main/core/workspaces/cleanup.ts`, `worktree-cleanup.ts` | NOT edited (cleanup.ts read as a mirror only) | **worktree-reaper-fence** owns both, including cleanup.ts's prune-ordering bug — explicitly out of scope here |
| win32 plans / dead-code-removal | No overlap (no path/spawn logic touched; factory.ts and cleanup.ts are live code) | — |

**Behavioural interplay to flag to the worktree-reaper-fence plan:** after Task 2, `removeWorkspace` deletes the workspace's `agent_sessions` rows, which removes the keep-predicate's permanent protection of those worktree dirs — they become reapable by the boot sweep. Caveat: `worktree-cleanup.ts`'s cold-install guard skips a repoDir with ZERO referencing rows, so the disk dirs of a fully-removed sole-workspace repo are only reclaimed once the fence plan addresses that guard. Do NOT fix that here.

**Recommended ordering within the batch:**
1. **This plan, Task 1** (CRIT, self-contained, no overlaps) — land first; it removes a boot-crash class.
2. **This plan, Tasks 2-3** (factory + the 1-line router thread) — land together.
3. **worktree-reaper-fence** after this plan (it benefits from rows actually being deleted on remove).
4. **rpc-boundary-hardening** before or after — whichever lands second rebases the trivial `workspaces.remove` hunk.
5. pty-lifecycle-resume-fixes / win32 / dead-code-removal: independent.

**Self-review (writing-plans checklist) — performed before saving:**
- *Spec coverage:* Finding 1 → Task 1 (non-unique bootstrap index + defensive DROP + fresh/upgraded convergence tests + 0034-idempotence question answered "no change needed"). Finding 2 → Tasks 2-3 (PTY stop mirroring `removeWorkspaceAndGc`, session-row deletion, router threading; cleanup.ts read-but-not-modified per the sibling-plan instruction). Gates → Task 4. No gaps.
- *Placeholder scan:* no TBD/TODO/"similar to Task N"/"add validation" anywhere; every code step carries complete code; every run step carries the exact command + expected result.
- *Type consistency:* `RemoveWorkspaceDeps.pty?: Pick<PtyRegistry, 'stop'>` matches registry.ts `stop(id: string, opts?: { tree?: boolean; forget?: boolean }): ProcessTreeSnapshot | null` (test mock returns `null`, assignable); daemon mock `async (_workspaceId: string) => { throw ... }` infers `Promise<never>`, assignable to `stop(workspaceId: string): Promise<void>`; `eq`/`getDb`/`agentSessions` import paths verified against factory.ts lines 6-8; `up0034(db: Database.Database)` satisfied by `FakeIndexEngine.asDb()` since 0034 only calls `db.exec`; the fake index engine strips `--` comment lines so the new commented SQL block parses.
