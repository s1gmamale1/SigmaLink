# Win32 DB lifecycle — boot crash on reopen (orphan-held sigmalink.db) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Single-owner plan (lead executes directly, no lanes).

**Goal:** SigmaLink on Windows must reopen cleanly after a close: no "JavaScript error in the main process / database is locked" dialog, workspace state resumes, and the WAL no longer grows unboundedly across runs.

**Root cause (operator-confirmed 2026-06-11 on the W-4 device — all three predictions confirmed: ① crash dialog mentions database locked/busy, ② leftover SigmaLink/node processes linger after close, ③ `sigmalink.db-wal` is tens of MB):**

Every agent CLI spawns its own `mcp-memory-server.cjs` (per `MemoryMcpSupervisor.serverCommand` design), and that child runs the **full `initializeDatabase()`** — a persistent better-sqlite3 **writer** on the same `sigmalink.db` (`mcp-server.ts:191`). On quit, `registry.killAll()` → `stopProcessTrees()` → win32 `taskkill /PID <root> /T /F`, but `/T` only walks **surviving ppid links** — the `.cmd`-shim chain (cmd.exe → node) exits early on Windows, reparenting the memory-server grandchildren, so they are structurally unreachable and survive the quit. Consequences:

1. **Reopen crash:** orphans hold the DB/`-shm`. `openAndCheck()` runs `PRAGMA journal_mode = WAL` **before** `busy_timeout` is set (`client.ts:225` vs `:238`) → an orphan-held lock throws `SQLITE_BUSY` instantly; `isCorruptionError()` is false → rethrow; `bootstrapAndMigrate`/`registerRouter` boot path is uncaught (`rpc-router.ts:285`) → main-process crash dialog. No resume.
2. **WAL bloat:** quit's `wal_checkpoint(TRUNCATE)` (`closeDatabase`) requires all readers gone; orphans always present → checkpoint fails (best-effort, silent) **every** Windows quit → `-wal` grows run over run.

macOS is unaffected: the darwin `ps`-walk tree-kill works leaves-first, and POSIX advisory locks are forgiving.

**Design (alternatives considered):**
- *Reparenting-proof quit kill* (Job Objects / `taskkill /IM`) — rejected: Job Objects need native bindings; `/IM node.exe` is a shotgun that would kill the operator's unrelated node processes.
- *Boot sweep by CommandLine marker* — chosen: CIM rows carry `CommandLine`; `mcp-memory-server.cjs` is a unique, SigmaLink-owned filename. Kills exactly our orphans even when reparented, regardless of which (old) build spawned them.
- *Single shared memory-server / readonly child connections* — correct long-term (N concurrent DDL writers by design is a smell) but a behavioral redesign; → WISHLIST, not this fix.
- All five fixes are at real fault sites (not symptom patches); each is independently testable on the windows-latest vitest CI leg.

**Tech stack:** Electron main (esbuild), better-sqlite3 (cannot load under vitest → source-text/pure-helper/injected-deps test patterns, per `client.bootstrap-index.test.ts` precedent), vitest (+ windows-latest CI leg, ADR-006).

---

### Task 1: `openAndCheck` pragma order — `busy_timeout` FIRST

`client.ts:225-238`: move `sqlite.pragma('busy_timeout = 5000')` to the first statement after `new Database(...)`, before `journal_mode = WAL`. The H-7 timeout was added to protect contended writes but the first lock-acquiring statement ran unprotected. Test: `client.pragma-order.test.ts` — source-text assertion that `busy_timeout` appears before `journal_mode` inside `openAndCheck` (mirrors the bootstrap-index source-parse pattern).

### Task 2: win32 boot orphan sweep (the lock-holders)

New `src/main/core/process/orphan-sweep.ts`:
- `findDbOrphanPids(nodes: ProcessTreeNode[], opts: { marker: string; selfPid: number }): number[]` — pure: rows whose `args` (CIM `CommandLine`) contains `marker`, excluding `selfPid`. Marker: `'mcp-memory-server.cjs'`.
- `sweepWin32DbOrphans(deps)` — win32-only (no-op elsewhere), best-effort, never throws: exec CIM ps query (`buildCimPsArgs`), `parseCimProcessRows`, `findDbOrphanPids`, `taskkill /PID <p> /T /F` each (`buildTaskkillArgs`), then a short injected sleep (~300 ms) for handle release. Injected `{ platform, exec, selfPid, sleep, log }` so the whole thing unit-tests cross-platform.
- Wire in `rpc-router.ts buildRouter()` **before** `initializeDatabase` (win32-only, awaited, `.catch`-logged).

Tests: marker matching incl. self-exclusion + empty/garbage rows; non-win32 no-op; exec-throw → fail-open no-throw; taskkill argv per match.

### Task 3: boot DB-open retry on BUSY

New `src/main/core/db/boot-open.ts`: `openDatabaseWithBootRetry({ userData, initialize, attempts = 4, delayMs = 1500, sleep, log })` — call `initialize(userData)`; if the error is a busy/locked signal (`err.code === 'SQLITE_BUSY'` or message contains `database is locked`), sleep + retry up to `attempts`; any other error rethrows immediately; exhausted → rethrow last. Covers orphans that beat the sweep (old-build orphans exist on devices the moment this update lands), AV transients, and the memory-server children's own DDL races. Wire at `rpc-router.ts:285` (boot is already async).

Tests (injected fake `initialize`/`sleep`): busy ×2 → success on 3rd (sleep called twice); non-busy error → immediate rethrow, no retry; busy ×attempts → throws last error.

### Task 4: boot WAL reclaim

On successful open (inside `openDatabaseWithBootRetry`, post-`initialize`): best-effort `raw.pragma('wal_checkpoint(TRUNCATE)')` + log — reclaims the bloated WAL accumulated by historic failed quit-checkpoints. Cheap when the WAL is small. Test: fake raw asserts the pragma fires on success and a pragma-throw doesn't fail the boot.

### Task 5: quit ordering — wait for PTY trees to die before `closeDatabase`

`waitForPidsExit(pids, { timeoutMs = 2500, intervalMs = 100, isAlive, sleep })` in `orphan-sweep.ts` (poll until all dead or timeout; returns survivors). In `shutdownRouter()`: capture `pty.list()` root pids **before** `killAll()`, and `await waitForPidsExit(...)` immediately **before** `closeDatabase()` (the awaited daemon drains in between give the kill free overlap time). Gives `taskkill`-initiated terminations time to release file handles so the quit checkpoint can actually TRUNCATE. Bounded — cannot hang quit (before-quit already self-bounds).

Tests (fake isAlive/sleep): all-dead-immediately → no sleeps; flips-after-N-polls; timeout → returns survivors.

### Task 6: gate + docs

- Full gate in worktree: `npx tsc -b` · `npx vitest run` · `npx eslint . --max-warnings 0` · `npm run product:check`. NO local e2e (CI owns it). The new unit tests also execute for real on the windows-latest CI leg.
- ROADMAP hotlist row + phase section; WISHLIST captures (memory-server full-bootstrap-per-spawn redesign; WAL-size telemetry).
- **Device verification owed (operator, post-merge):** on Windows — close app → Task Manager shows no lingering SigmaLink node processes (or boot sweep clears them) → reopen → no dialog, workspaces resume → `-wal` shrinks.

## Execution Log

(filled at execution)
