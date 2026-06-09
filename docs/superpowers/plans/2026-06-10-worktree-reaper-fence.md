# Worktree Reaper Fence (keep ⊇ use) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SF-13 worktree reaper's keep-set a strict superset of every consumer's use-set (resume, respawn, sibling workspaces on a shared repo) by extracting ONE shared keep-predicate, fix the kill-order trap in `removeWorkspaceAndGc`, make pruning dirs-only, and reap crash-orphaned scrollback `.log.tmp` files.

**Architecture:** The keep-predicate (running/starting OR exited/-1 OR exited within 7 days) becomes a single exported source of truth in `worktree-cleanup.ts` (a plain JS predicate over one all-rows SQL fetch — no SQL/JS duality to drift). `cleanup.ts` (SF-13 operator actions) and `worktree-cleanup.ts` (boot sweep) both consume it; an explicit keep⊇use invariant test derives the resume/respawn use-predicates and asserts superset, with a source-tripwire on `resume-launcher.ts` so predicate drift fails CI. `removeWorkspaceAndGc` is reordered kill→delete-rows→prune so a nuked workspace's worktrees are reaped in the same pass instead of becoming permanently unreapable orphans.

**Tech Stack:** TypeScript (Electron main process), vitest. Vitest CANNOT load better-sqlite3 (Electron ABI) — all DB-touching tests use the existing MockDb/fake patterns from `cleanup.test.ts` / `worktree-cleanup.test.ts`; `node:fs` is fully mocked.

**Evidence check (2026-06-10, all confirmed at HEAD — none refuted):**

1. **CRIT** `app/src/main/core/workspaces/cleanup.ts:79-90` — `liveWorktreePaths` fences only `status IN ('starting','running') AND workspace_id = ?`; `pruneRepoDir` (`:99-149`) then rm-rf's every dir under `<worktreeBase>/<repoHash>/` not in that set. (a) keep ⊉ use: resume eligibility is `running OR (exited AND exit_code=-1)` (`app/src/main/core/pty/resume-launcher.ts:296-321`) and respawn uses `exited AND exit_code=-1` (`:427-454`) — the 93fbca6 regression class. The boot sibling `worktree-cleanup.ts:54-96` already has the broad fence with the explicit "must stay at least as broad as resume-launcher" comment; `cleanup.ts` is the drifted twin. (b) `repoHash = sha1(repoRoot).slice(0,12)` (`app/src/main/core/git/git-ops.ts:38-40`, consumed by `app/src/main/core/git/worktree.ts:71-73`) is SHARED by all workspaces on one repo since migration 0034 — pruning for workspace A (RPC `cleanup.pruneWorktrees`, `app/src/main/rpc-router.ts:2379-2393`) rm-rf's workspace B's RUNNING worktrees.
2. `cleanup.ts:280-358` — `removeWorkspaceAndGc` with `stopLiveSessions` prunes (`:311-323`) BEFORE killing live sessions + deleting all rows (`:326-347`); spared live worktrees become permanently unreapable because the boot sweep's cold-install guard (`worktree-cleanup.ts:80-96`) sees zero rows for the repo and skips it forever.
3. `cleanup.ts:114-131` — `pruneRepoDir` doesn't check entries are directories; a stray FILE in the repoHash dir gets rm-rf'd. Same flaw in the sibling `worktree-cleanup.ts:46-52,102-115` (grep-sibling-call-sites: fix the twin too).
4. `app/src/main/core/pty/scrollback-store.ts:82-105` — `gcScrollback` only matches `*.log` (`:92`); crash-orphaned `*.log.tmp` (from the tmp→rename atomic write, `:45-48`) are never reaped.

---

## File Structure

**Create: NONE** (the shared predicate lives in `worktree-cleanup.ts` — it is already DB-handle-threaded, vitest-safe, and imported by nobody that would cycle; `cleanup.ts` → `worktree-cleanup.ts` is a new one-way import).

**Modify:**

| File | Responsibility after this plan |
|---|---|
| `app/src/main/core/workspaces/worktree-cleanup.ts` | Boot-time orphan sweep + **the single-source keep-predicate exports**: `WORKTREE_KEEP_WINDOW_MS`, `WorktreeSessionRow`, `isWorktreeKeepEligible`, `listWorktreeSessionRows`, `collectKeptWorktreePaths`. Dirs-only readdir. (~270 lines, <500 ✓) |
| `app/src/main/core/workspaces/cleanup.ts` | SF-13 operator actions. `pruneOrphanWorktreesForWorkspace` fences with the GLOBAL shared keep-set; `removeWorkspaceAndGc` kills→deletes rows→prunes with `excludeSessionIds`; `pruneRepoDir` dirs-only; local `liveWorktreePaths` deleted. (~360 lines, <500 ✓) |
| `app/src/main/core/pty/scrollback-store.ts` | `gcScrollback` also reaps `.log.tmp`. |
| `app/src/main/core/workspaces/worktree-cleanup.test.ts` | Dirent mocks, simplified single-SQL MockDb, keep⊇use invariant matrix + resume-launcher source tripwire. |
| `app/src/main/core/workspaces/cleanup.test.ts` | Dirent mocks, MockDb keep-fence branch, CRIT fence tests, kill→delete→prune order tests. |
| `app/src/main/core/pty/scrollback-store.test.ts` | `.log.tmp` GC tests. |

**NOT modified:** `rpc-router.ts` (handler signatures/result shapes unchanged — `PruneOrphanWorktreesInput.workspaceId` is retained for RPC compatibility), `resume-launcher.ts`, `git-ops.ts`, `worktree.ts`.

All commands below run from `/Users/aisigma/projects/SigmaLink/app`.

---

### Task 1: Dirs-only pruning in `pruneRepoDir` (finding 3, cleanup.ts side)

**Files:**
- Modify: `app/src/main/core/workspaces/cleanup.ts:113-131` (`pruneRepoDir` readdir + loop)
- Test: `app/src/main/core/workspaces/cleanup.test.ts`

- [ ] **Step 1: Write the failing test + dirent helpers**

In `cleanup.test.ts`, change the readdir mock type at line 14 and add helpers below line 24 (after the `vi.mock('node:fs', …)` block):

```ts
// line 14 — was: vi.fn<(...args: unknown[]) => Promise<string[]>>()
const readdirMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
```

```ts
// After the vi.mock block (~line 25):
// pruneRepoDir reads with { withFileTypes: true } — mocks return Dirent-ish objects.
function dirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir };
}
const dirents = (...names: string[]) => names.map((n) => dirent(n));
```

Add this test inside the existing `describe('pruneOrphanWorktreesForWorkspace — live', …)` block (after the fail-open test ending at line 373):

```ts
  it('never rm-rfs a stray FILE in the repoHash dir — dirs only (2026-06-10 audit, finding 3)', async () => {
    const db = makeDb([]);
    readdirMock.mockResolvedValue([dirent('stray-file.txt', false), dirent('orphan-dir', true)]);

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(1);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      path.join(REPO_DIR, 'orphan-dir'),
      { recursive: true, force: true },
    );
    expect(rmMock).not.toHaveBeenCalledWith(
      path.join(REPO_DIR, 'stray-file.txt'),
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts -t "never rm-rfs a stray FILE"`
Expected: FAIL — current `pruneRepoDir` does `path.join(repoDir, entry)` on a Dirent object (TypeError) or treats the file as removable.

- [ ] **Step 3: Implement dirs-only readdir in `pruneRepoDir`**

Replace `cleanup.ts:113-131` (from `let entries: string[];` through the end of the `for` loop) with:

```ts
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = (await fs.readdir(repoDir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
  } catch {
    return { wouldRemove: [], liveBlocked: [], removed: 0, errors: 0 };
  }

  const wouldRemove: string[] = [];
  const liveBlocked: string[] = [];

  for (const entry of entries) {
    // 2026-06-10 audit (finding 3): dirs only. A stray FILE in the repoHash
    // dir (.DS_Store, crash artifact, …) must never be rm-rf'd by the reaper.
    if (!entry.isDirectory()) continue;
    const full = path.join(repoDir, entry.name);
    if (livePaths.has(canonicalPathKey(full))) {
      liveBlocked.push(full);
    } else {
      wouldRemove.push(full);
    }
  }
```

- [ ] **Step 4: Migrate the existing string[] readdir mocks to dirents**

In `cleanup.test.ts`, every `readdirMock.mockResolvedValue([...strings])` now feeds the `withFileTypes` read. Replace each:

| Line (pre-edit) | Old | New |
|---|---|---|
| 221 | `readdirMock.mockResolvedValue(['pane-a', 'pane-b']);` | `readdirMock.mockResolvedValue(dirents('pane-a', 'pane-b'));` |
| 245 | `readdirMock.mockResolvedValue(['live-pane', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));` |
| 269 | `readdirMock.mockResolvedValue(['Live-Pane', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('Live-Pane', 'orphan-pane'));` |
| 311 | `readdirMock.mockResolvedValue(['orphan', 'live']);` | `readdirMock.mockResolvedValue(dirents('orphan', 'live'));` |
| 333 | `readdirMock.mockResolvedValue(['starting-pane']);` | `readdirMock.mockResolvedValue(dirents('starting-pane'));` |
| 359 | `readdirMock.mockResolvedValue(['bad-perm-dir']);` | `readdirMock.mockResolvedValue(dirents('bad-perm-dir'));` |
| 457 | `readdirMock.mockResolvedValue(['live-pane', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));` |
| 481 | `readdirMock.mockResolvedValue(['exited-pane']);` | `readdirMock.mockResolvedValue(dirents('exited-pane'));` |
| 502 | `readdirMock.mockResolvedValue(['live-pane', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-pane'));` |

- [ ] **Step 5: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts`
Expected: PASS (all existing + 1 new test)

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspaces/cleanup.ts src/main/core/workspaces/cleanup.test.ts
git commit -m "fix(reaper): pruneRepoDir reaps directories only — stray files in the repoHash dir are never rm-rf'd"
```

---

### Task 2: Dirs-only pruning in `cleanupOrphanWorktrees` (finding 3, sibling twin)

**Files:**
- Modify: `app/src/main/core/workspaces/worktree-cleanup.ts:46-52,102-115`
- Test: `app/src/main/core/workspaces/worktree-cleanup.test.ts`

- [ ] **Step 1: Move the `dirent` helper up + write the failing test**

In `worktree-cleanup.test.ts`: delete the `dirent` function currently at lines 299-301 and re-declare it in the Helpers section (after line 98), together with a vararg form:

```ts
// Dirent-ish factory — cleanupOrphanWorktrees and sweepAllReposOnBoot both
// read with { withFileTypes: true } now.
function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}
const dirents = (...names: string[]) => names.map((n) => dirent(n, true));
```

Add this test at the end of the `describe('cleanupOrphanWorktrees', …)` block (after test 8, line 283):

```ts
  it('never removes a stray FILE in the repoDir — dirs only (2026-06-10 audit, finding 3)', async () => {
    readdirMock.mockResolvedValue([dirent('stray-file.txt', false), dirent('orphan-dir', true)]);
    const db = makeDb([
      // One running session elsewhere in this repo so the cold-install guard is bypassed.
      { worktree_path: path.join(REPO_DIR, 'some-other-pane'), status: 'running', exited_at: null },
    ]);

    const result = await cleanupOrphanWorktrees(BASE, HASH, db);

    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(String(rmMock.mock.calls[0]![0])).toContain('orphan-dir');
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1); // the stray file is counted as kept, never touched
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx vitest run src/main/core/workspaces/worktree-cleanup.test.ts -t "never removes a stray FILE"`
Expected: FAIL — current code does `path.join(repoDir, entry)` on a Dirent object.

- [ ] **Step 3: Implement dirs-only readdir in `cleanupOrphanWorktrees`**

Replace `worktree-cleanup.ts:46-52` with:

```ts
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = (await fs.readdir(repoDir, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
  } catch {
    // dir doesn't exist — nothing to clean up
    return { removed: 0, kept: 0, errors: 0 };
  }
```

Replace the removal loop (`worktree-cleanup.ts:102-115`) with:

```ts
  for (const entry of entries) {
    // 2026-06-10 audit (finding 3): dirs only — mirror of cleanup.ts pruneRepoDir.
    if (!entry.isDirectory()) {
      kept++;
      continue;
    }
    const full = path.join(repoDir, entry.name);
    if (liveSet.has(canonicalPathKey(full))) {
      kept++;
      continue;
    }
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn('[worktree-cleanup] Failed to remove %s:', full, err);
      errors++;
    }
  }
```

- [ ] **Step 4: Migrate the existing readdir mocks**

In `worktree-cleanup.test.ts`, update `wireReaddir` (the per-repo branch at lines 322-324) so per-repo entries become dirents (callers stay `string[]`-typed):

```ts
    // per-repo readdir → Dirent-ish worktree entries (all dirs)
    const hash = path.basename(p);
    return (perRepo[hash] ?? []).map((n) => dirent(n, true));
```

Replace each plain `mockResolvedValue` in the `cleanupOrphanWorktrees` tests:

| Line (pre-edit) | Old | New |
|---|---|---|
| 124 | `readdirMock.mockResolvedValue([]);` | `readdirMock.mockResolvedValue([]);` (unchanged — empty) |
| 131 | `readdirMock.mockResolvedValue(['dir-a', 'dir-b', 'dir-c']);` | `readdirMock.mockResolvedValue(dirents('dir-a', 'dir-b', 'dir-c'));` |
| 142 | `readdirMock.mockResolvedValue(['pane-0', 'pane-1']);` | `readdirMock.mockResolvedValue(dirents('pane-0', 'pane-1'));` |
| 153 | `readdirMock.mockResolvedValue(['live-pane', 'orphan-1', 'orphan-2']);` | `readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-1', 'orphan-2'));` |
| 167 | `readdirMock.mockResolvedValue(['orphan-perm-fail']);` | `readdirMock.mockResolvedValue(dirents('orphan-perm-fail'));` |
| 181 | `readdirMock.mockResolvedValue(['recently-exited-pane', 'old-exited-pane']);` | `readdirMock.mockResolvedValue(dirents('recently-exited-pane', 'old-exited-pane'));` |
| 201 | `readdirMock.mockResolvedValue(['crashed-pane', 'old-clean-pane']);` | `readdirMock.mockResolvedValue(dirents('crashed-pane', 'old-clean-pane'));` |
| 229 | `readdirMock.mockResolvedValue(['starting-pane', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('starting-pane', 'orphan-pane'));` |
| 248 | `readdirMock.mockResolvedValue(['Pane-0', 'orphan-pane']);` | `readdirMock.mockResolvedValue(dirents('Pane-0', 'orphan-pane'));` |
| 268 | `readdirMock.mockResolvedValue(['pane-x']);` | `readdirMock.mockResolvedValue(dirents('pane-x'));` |

- [ ] **Step 5: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/workspaces/worktree-cleanup.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspaces/worktree-cleanup.ts src/main/core/workspaces/worktree-cleanup.test.ts
git commit -m "fix(reaper): boot orphan-cleanup reaps directories only — sibling twin of pruneRepoDir"
```

---

### Task 3: Extract the shared keep-predicate + keep⊇use invariant test

**Files:**
- Modify: `app/src/main/core/workspaces/worktree-cleanup.ts` (new exports after the `CleanupResult` interface; rewire `cleanupOrphanWorktrees:54-96`)
- Test: `app/src/main/core/workspaces/worktree-cleanup.test.ts` (MockDb rewrite + new invariant suite)

- [ ] **Step 1: Write the failing tests**

In `worktree-cleanup.test.ts`:

(a) Extend the imports (lines 1-3):

```ts
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupOrphanWorktrees,
  sweepAllReposOnBoot,
  isWorktreeKeepEligible,
  collectKeptWorktreePaths,
  WORKTREE_KEEP_WINDOW_MS,
} from './worktree-cleanup';
import { canonicalPathKey } from '../util/path-key';
```

(b) Extend the test-local `SessionRow` interface (lines 29-34) with optional identity fields:

```ts
interface SessionRow {
  id?: string;
  workspace_id?: string;
  worktree_path: string;
  status: string;
  exit_code?: number | null;
  exited_at: number | null;
}
```

(c) Append this suite at the end of the file:

```ts
// ---------------------------------------------------------------------------
// keep ⊇ use invariant (2026-06-10 audit, finding 1).
//
// The reaper keep-set MUST be a superset of every consumer's use-set, or the
// reaper deletes worktrees a consumer is about to spawn into (the 93fbca6
// regression class; memory: feedback_reaper_keep_superset_of_use). The USE
// predicates below are direct transcriptions of resume-launcher.ts:
//   - listEligibleRows  (resume-launcher.ts:296-321):
//       status='running' OR (status='exited' AND exit_code=-1)
//   - listRespawnableRows (resume-launcher.ts:427-454):
//       status='exited' AND exit_code=-1
// The tripwire test below pins those source predicates: if resume-launcher
// changes them, the tripwire fails and BOTH the transcriptions here AND
// isWorktreeKeepEligible must be re-verified together.
// ---------------------------------------------------------------------------

describe('keep ⊇ use invariant — reaper keep-predicate covers every consumer', () => {
  type PredicateRow = { status: string; exit_code: number | null; exited_at: number | null };

  const resumeUses = (r: PredicateRow) =>
    r.status === 'running' || (r.status === 'exited' && r.exit_code === -1);
  const respawnUses = (r: PredicateRow) => r.status === 'exited' && r.exit_code === -1;

  const T0 = Date.now();
  const OLD = T0 - WORKTREE_KEEP_WINDOW_MS - 60_000;
  const statuses = ['starting', 'running', 'exited', 'error'];
  const exitCodes: Array<number | null> = [null, -1, 0, 1, 137];
  const exitedAts: Array<number | null> = [null, T0 - 1000, OLD];

  it('every row a resume/respawn consumer can use is keep-eligible (superset over the full matrix)', () => {
    for (const status of statuses) {
      for (const exit_code of exitCodes) {
        for (const exited_at of exitedAts) {
          const row: PredicateRow = { status, exit_code, exited_at };
          if (resumeUses(row) || respawnUses(row)) {
            expect(isWorktreeKeepEligible(row, T0), `use-eligible row must be kept: ${JSON.stringify(row)}`).toBe(true);
          }
        }
      }
    }
  });

  it('keep is strictly broader than use: starting and recent-exited rows are kept too', () => {
    expect(isWorktreeKeepEligible({ status: 'starting', exit_code: null, exited_at: null }, T0)).toBe(true);
    expect(isWorktreeKeepEligible({ status: 'exited', exit_code: 0, exited_at: T0 - 1000 }, T0)).toBe(true);
    // …while a clean old exit is reapable:
    expect(isWorktreeKeepEligible({ status: 'exited', exit_code: 0, exited_at: OLD }, T0)).toBe(false);
  });

  it('tripwire: resume-launcher.ts still uses exactly the transcribed use-predicates', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const src = realFs.readFileSync(
      fileURLToPath(new URL('../pty/resume-launcher.ts', import.meta.url)),
      'utf8',
    );
    // listEligibleRows + listRespawnableRows predicate fragments:
    expect(src).toContain("s.status = 'running'");
    expect(src).toContain("s.exit_code = -1");
    // If this fails: resume-launcher's use-predicate changed. Update the
    // transcriptions in this file AND verify isWorktreeKeepEligible still
    // covers the new predicate before changing these assertions.
  });

  it('collectKeptWorktreePaths returns canonical keys and honors excludeSessionIds', () => {
    const a = path.join(REPO_DIR, 'pane-a');
    const b = path.join(REPO_DIR, 'pane-b');
    const db = makeDb([
      { id: 's-live', worktree_path: a, status: 'running', exited_at: null },
      { id: 's-crash', worktree_path: b, status: 'exited', exit_code: -1, exited_at: oldExited() },
    ]);

    const keepAll = collectKeptWorktreePaths(db);
    expect(keepAll.has(canonicalPathKey(a))).toBe(true);
    expect(keepAll.has(canonicalPathKey(b))).toBe(true);

    // Rows about to be deleted by a caller are excluded from the fence:
    const keepMinus = collectKeptWorktreePaths(db, { excludeSessionIds: new Set(['s-crash']) });
    expect(keepMinus.has(canonicalPathKey(a))).toBe(true);
    expect(keepMinus.has(canonicalPathKey(b))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/main/core/workspaces/worktree-cleanup.test.ts`
Expected: FAIL — `isWorktreeKeepEligible` / `collectKeptWorktreePaths` / `WORKTREE_KEEP_WINDOW_MS` are not exported (the import throws, failing the whole file).

- [ ] **Step 3: Implement the shared keep-predicate exports**

In `worktree-cleanup.ts`, insert after the `CleanupResult` interface (line 13):

```ts
// ---------------------------------------------------------------------------
// Keep-predicate — SINGLE SOURCE OF TRUTH for the worktree reaper fence.
//
// INVARIANT (keep ⊇ use): this predicate MUST stay at least as broad as every
// consumer of worktree dirs, or the reaper deletes what a consumer needs
// (feedback_reaper_keep_superset_of_use; 93fbca6 regression class):
//   - resume-launcher.listEligibleRows (resume-launcher.ts:296-321):
//       running OR (exited AND exit_code=-1)
//   - resume-launcher.listRespawnableRows (resume-launcher.ts:427-454):
//       exited AND exit_code=-1
//   - boot janitor candidates: starting/running rows
//   - 7-day uncommitted-work guard for other recently-exited rows
//
// Implemented as a plain JS predicate over a single all-rows fetch (NOT a
// second SQL copy) so the SQL and the predicate cannot drift apart. The
// keep ⊇ use invariant test lives in worktree-cleanup.test.ts.
// ---------------------------------------------------------------------------

export const WORKTREE_KEEP_WINDOW_MS = 7 * 86400 * 1000;

export interface WorktreeSessionRow {
  id: string;
  workspace_id: string;
  status: string;
  exit_code: number | null;
  exited_at: number | null;
  worktree_path: string;
}

export function isWorktreeKeepEligible(
  row: Pick<WorktreeSessionRow, 'status' | 'exit_code' | 'exited_at'>,
  now: number,
): boolean {
  if (row.status === 'running' || row.status === 'starting') return true;
  if (row.status === 'exited' && row.exit_code === -1) return true;
  if (row.exited_at !== null && row.exited_at > now - WORKTREE_KEEP_WINDOW_MS) return true;
  return false;
}

/** All sessions that reference a worktree dir, across ALL workspaces. */
export function listWorktreeSessionRows(db: Database.Database): WorktreeSessionRow[] {
  return db
    .prepare(
      `SELECT id, workspace_id, status, exit_code, exited_at, worktree_path
       FROM agent_sessions
       WHERE worktree_path IS NOT NULL`,
    )
    .all() as WorktreeSessionRow[];
}

/**
 * The reaper fence: canonical path keys of every worktree the app may still
 * need, across ALL workspaces (repoHash dirs are shared per-repo since
 * migration 0034 — a per-workspace fence stomps sibling workspaces).
 *
 * `excludeSessionIds` lets a caller that is about to delete specific rows
 * (removeWorkspaceAndGc) drop exactly those rows from the fence so their
 * dirs are reaped in the same pass.
 */
export function collectKeptWorktreePaths(
  db: Database.Database,
  opts: { now?: number; excludeSessionIds?: ReadonlySet<string> } = {},
): Set<string> {
  const now = opts.now ?? Date.now();
  const keep = new Set<string>();
  for (const row of listWorktreeSessionRows(db)) {
    if (opts.excludeSessionIds?.has(row.id)) continue;
    if (isWorktreeKeepEligible(row, now)) keep.add(canonicalPathKey(row.worktree_path));
  }
  return keep;
}
```

Then rewire `cleanupOrphanWorktrees` — replace lines 54-96 (the `sevenDaysMs` const, the `liveRows` query, the `liveSet` build, and the cold-install guard's `anyRows` query) with:

```ts
  // Fence = the shared keep-predicate (single source of truth above).
  const allRows = listWorktreeSessionRows(db);
  const now = Date.now();
  const liveSet = new Set(
    allRows
      .filter((r) => isWorktreeKeepEligible(r, now))
      .filter((r) => pathKeyIsWithin(r.worktree_path, repoDir))
      .map((r) => canonicalPathKey(r.worktree_path)),
  );

  // Cold-install guard: if no rows reference any path in this repoDir, skip.
  // This avoids deleting dirs from a fresh install where DB hasn't caught up.
  if (liveSet.size === 0) {
    const anyUnderRepo = allRows.some((r) => pathKeyIsWithin(r.worktree_path, repoDir));
    if (!anyUnderRepo) {
      // Genuinely cold install — skip cleanup.
      return { removed: 0, kept: entries.length, errors: 0 };
    }
  }
```

(Also update the function's doc comment, lines 15-31: replace the sentence beginning "Fetch all worktree_paths…" rationale with "Keep-fence = `isWorktreeKeepEligible` — the exported single source of truth shared with cleanup.ts (SF-13).")

- [ ] **Step 4: Rewrite the test MockDb for the single-SQL surface**

The module now issues exactly one SQL. Replace `makeDb` (`worktree-cleanup.test.ts:36-80`) with:

```ts
function makeDb(sessions: SessionRow[]) {
  const db = {
    prepare(sql: string) {
      if (sql.includes('FROM agent_sessions') && sql.includes('worktree_path IS NOT NULL')) {
        return {
          all() {
            return sessions.map((s, i) => ({
              id: s.id ?? `sess-${i}`,
              workspace_id: s.workspace_id ?? 'ws-test',
              status: s.status,
              exit_code: s.exit_code ?? null,
              exited_at: s.exited_at,
              worktree_path: s.worktree_path,
            }));
          },
        };
      }
      throw new Error(`Unhandled SQL in test: ${sql}`);
    },
  };
  return db as unknown as import('better-sqlite3').Database;
}
```

(The keep/reap filtering that the old MockDb re-implemented in JS now runs in REAL module code — strictly better coverage. All existing tests keep their assertions unchanged.)

- [ ] **Step 5: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/workspaces/worktree-cleanup.test.ts`
Expected: PASS (existing sweep + cleanup tests, plus the 4 new invariant tests)

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspaces/worktree-cleanup.ts src/main/core/workspaces/worktree-cleanup.test.ts
git commit -m "fix(reaper): extract shared worktree keep-predicate + explicit keep⊇use invariant test"
```

---

### Task 4 (CRIT): `pruneOrphanWorktreesForWorkspace` fence → global shared keep-set

**Files:**
- Modify: `app/src/main/core/workspaces/cleanup.ts:74-90` (doc), `:155-180` (`PruneOrphanWorktreesInput` + `pruneOrphanWorktreesForWorkspace`), imports at `:17-22`
- Test: `app/src/main/core/workspaces/cleanup.test.ts`

- [ ] **Step 1: Write the failing tests + MockDb keep-fence branch**

(a) In `cleanup.test.ts`, extend the test `SessionRow` (lines 31-37) and `makeSession` (lines 185-194):

```ts
interface SessionRow {
  id: string;
  workspace_id: string;
  worktree_path: string | null;
  status: string;
  exit_code: number | null;
  exited_at: number | null;
}
```

```ts
function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: `sess-${Math.random().toString(36).slice(2)}`,
    workspace_id: WS_ID,
    worktree_path: path.join(REPO_DIR, `pane-${Math.random().toString(36).slice(2)}`),
    status: 'exited',
    exit_code: 0,
    exited_at: Date.now() - 1000,
    ...overrides,
  };
}
```

(b) Add a MockDb branch for the shared keep-fence query as the FIRST branch inside `prepare(sql)` (before the existing `select distinct worktree_path` branch at line 67):

```ts
      // Shared keep-fence fetch (worktree-cleanup.listWorktreeSessionRows):
      // SELECT id, workspace_id, status, exit_code, exited_at, worktree_path
      // FROM agent_sessions WHERE worktree_path IS NOT NULL
      // Matched on the distinctive select list — NOT on 'worktree_path is not
      // null', which would also match the old liveWorktreePaths fence SQL
      // that removeWorkspaceAndGc still issues until Task 5.
      if (s.includes('select id, workspace_id, status, exit_code, exited_at, worktree_path')) {
        return {
          all() {
            return sessions
              .filter((r) => r.worktree_path !== null)
              .map((r) => ({
                id: r.id,
                workspace_id: r.workspace_id,
                status: r.status,
                exit_code: r.exit_code,
                exited_at: r.exited_at,
                worktree_path: r.worktree_path,
              }));
          },
        };
      }
```

(Keep the old `status in ('starting','running')` branch for now — `removeWorkspaceAndGc` still uses it until Task 5.)

(c) Add the new describe block after the existing `pruneOrphanWorktreesForWorkspace — live` block:

```ts
// ---------------------------------------------------------------------------
// 2026-06-10 audit, finding 1 (CRIT): keep ⊇ use fence.
// The prune fence must spare (a) resume/respawn-eligible exited/-1 worktrees
// and (b) sibling workspaces' worktrees in the SHARED <repoHash> dir
// (repoHash = sha1(repoRoot) — shared by all workspaces on one repo since
// migration 0034).
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktreesForWorkspace — keep ⊇ use fence', () => {
  it('spares a worktree owned by an exited/-1 (resume-eligible) session, even outside the 7-day window', async () => {
    const crashedPath = path.join(REPO_DIR, 'crashed-pane');
    const crashed = makeSession({
      worktree_path: crashedPath,
      status: 'exited',
      exit_code: -1,
      exited_at: Date.now() - 30 * 86400 * 1000, // 30 days — far outside the 7-day window
    });
    const db = makeDb([crashed]);
    readdirMock.mockResolvedValue(dirents('crashed-pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.liveBlocked.map((p) => path.basename(p))).toEqual(['crashed-pane']);
    expect(result.removed).toBe(1); // only orphan-pane
    expect(rmMock).not.toHaveBeenCalledWith(crashedPath, expect.anything());
  });

  it("spares ANOTHER workspace's running worktree in the shared repoHash dir", async () => {
    const siblingPath = path.join(REPO_DIR, 'sibling-live-pane');
    const sibling = makeSession({
      workspace_id: 'ws-OTHER',
      worktree_path: siblingPath,
      status: 'running',
      exited_at: null,
    });
    const db = makeDb([sibling]);
    readdirMock.mockResolvedValue(dirents('sibling-live-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID, // pruning on behalf of ws-001 must NOT stomp ws-OTHER
      db,
      dryRun: false,
    });

    expect(result.removed).toBe(0);
    expect(result.liveBlocked).toEqual([siblingPath]);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('spares a recently-exited (within 7 days) worktree — uncommitted-work guard', async () => {
    const recentPath = path.join(REPO_DIR, 'recent-pane');
    const recent = makeSession({
      worktree_path: recentPath,
      status: 'exited',
      exit_code: 0,
      exited_at: Date.now() - 1000,
    });
    const db = makeDb([recent]);
    readdirMock.mockResolvedValue(dirents('recent-pane', 'orphan-pane'));

    const result = await cleanupModule.pruneOrphanWorktreesForWorkspace({
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      workspaceId: WS_ID,
      db,
      dryRun: false,
    });

    expect(result.liveBlocked).toEqual([recentPath]);
    expect(result.removed).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts -t "keep ⊇ use fence"`
Expected: FAIL — the current `liveWorktreePaths` fence is `starting|running AND workspace_id = ?`, so the exited/-1 dir, the sibling workspace's running dir, and the recent-exit dir all get rm'd (`removed` too high / `rmMock` called).

- [ ] **Step 3: Implement the global shared fence**

In `cleanup.ts`:

(a) Add the import (after line 20, next to the other relative imports):

```ts
import { collectKeptWorktreePaths } from './worktree-cleanup';
```

(b) Replace `pruneOrphanWorktreesForWorkspace` (lines 168-180 including its doc comment) with:

```ts
/**
 * Exposes the orphan worktree cleanup as a manual trigger (RPC
 * `cleanup.pruneWorktrees`). Safe: the keep-fence applies; no DB rows are
 * touched.
 *
 * 2026-06-10 audit (finding 1, CRIT): the fence is GLOBAL and uses the shared
 * keep-predicate from worktree-cleanup.ts (keep ⊇ use):
 *  (a) resume (resume-launcher.listEligibleRows) and respawn
 *      (listRespawnableRows) still consume exited/-1 rows — a fence of only
 *      starting|running deletes worktrees resume will re-spawn into
 *      (the 93fbca6 regression class).
 *  (b) `<worktreeBase>/<repoHash>/` is keyed by repoHash(repoRoot)
 *      (git-ops.ts:38) and is SHARED by every workspace on the same repo
 *      since migration 0034 — a per-workspace fence rm-rf's sibling
 *      workspaces' RUNNING worktrees. `input.workspaceId` is retained for
 *      RPC compatibility but deliberately does NOT scope the fence.
 */
export async function pruneOrphanWorktreesForWorkspace(
  input: PruneOrphanWorktreesInput,
): Promise<PruneWorktreeResult> {
  const { worktreeBase, repoHash, db, dryRun } = input;

  const keep = collectKeptWorktreePaths(db);
  return pruneRepoDir(worktreeBase, repoHash, keep, dryRun);
}
```

(c) Update the `workspaceId` field doc in `PruneOrphanWorktreesInput` (line 160-161):

```ts
  /** Workspace id — retained for RPC compatibility; the keep-fence is global
   *  (shared repoHash dir per repo since migration 0034). */
  workspaceId: string;
```

(d) Rename `pruneRepoDir`'s third parameter `livePaths` → `keepPaths` (signature line 99-104 and the single use at the `keepPaths.has(...)` membership check) and update its doc comment ("cross-references the live fence" → "cross-references the keep-fence (live, resume-eligible, or recently-exited sessions)"). Also update the `PruneWorktreeResult.liveBlocked` doc (line 32-33):

```ts
  /** Paths skipped because the keep-fence holds them (live, resume-eligible exited/-1, or exited <7d ago). */
  liveBlocked: string[];
```

Do NOT delete `liveWorktreePaths` yet — `removeWorkspaceAndGc` still calls it until Task 5.

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts`
Expected: PASS — new fence tests green; existing prune tests still green (running/starting dirs are kept by the broader fence too; orphan dirs still have no rows).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspaces/cleanup.ts src/main/core/workspaces/cleanup.test.ts
git commit -m "fix(reaper): prune fence = global shared keep-predicate — spares resume-eligible exited/-1 and sibling-workspace worktrees in the shared repoHash dir"
```

---

### Task 5: `removeWorkspaceAndGc` — kill → delete rows → prune (finding 2)

**Files:**
- Modify: `app/src/main/core/workspaces/cleanup.ts:74-90` (delete `liveWorktreePaths`), `:311-347` (reorder steps 2-4)
- Test: `app/src/main/core/workspaces/cleanup.test.ts`

- [ ] **Step 1: Write the failing tests**

Add at the end of the existing `describe('removeWorkspaceAndGc', …)` block in `cleanup.test.ts` (a type-only import is safe — it is erased at compile time, no native module loads):

```ts
  // 2026-06-10 audit, finding 2: with stopLiveSessions the old order was
  // prune → kill → delete-rows, so live worktrees were spared by the fence,
  // then their rows were deleted — leaving dirs the boot sweep's cold-install
  // guard (worktree-cleanup.ts) can never reap (zero rows for the repo →
  // guard skips it forever). New order: kill → delete rows → prune.
  function makePty() {
    return {
      stop: vi.fn(),
      processSnapshot: vi.fn(() => null),
    };
  }
  type MockPty = ReturnType<typeof makePty>;
  const asPty = (p: MockPty) =>
    p as unknown as import('../pty/registry').PtyRegistry;

  it('stopLiveSessions: kills the live PTY and prunes its worktree in the SAME pass', async () => {
    const liveWorktree = path.join(REPO_DIR, 'live-pane');
    const liveSession = makeSession({ id: 'live-s', worktree_path: liveWorktree, status: 'running', exited_at: null });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([liveSession], [wsRow]);
    const pty = makePty();
    readdirMock.mockResolvedValue(dirents('live-pane'));

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: false,
      pty: asPty(pty),
      stopLiveSessions: true,
    });

    expect(pty.stop).toHaveBeenCalledWith('live-s', { tree: true, forget: true });
    // The killed session's worktree is reaped in the same pass:
    expect(rmMock).toHaveBeenCalledWith(liveWorktree, { recursive: true, force: true });
    expect(result.worktreeCount).toBe(1);
    expect(db._deletedSessionIds).toContain('live-s');
    expect(db._deletedWorkspaceIds).toContain(WS_ID);
    // Ordering: the PTY is stopped BEFORE its dir is removed.
    expect(pty.stop.mock.invocationCallOrder[0]!).toBeLessThan(rmMock.mock.invocationCallOrder[0]!);
  });

  it('stopLiveSessions dry-run: reports live worktrees as removable but mutates nothing', async () => {
    const liveWorktree = path.join(REPO_DIR, 'live-pane');
    const liveSession = makeSession({ id: 'live-s', worktree_path: liveWorktree, status: 'running', exited_at: null });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([liveSession], [wsRow]);
    const pty = makePty();
    readdirMock.mockResolvedValue(dirents('live-pane'));

    const result = await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: true,
      pty: asPty(pty),
      stopLiveSessions: true,
    });

    expect(result.worktreeCount).toBe(1); // wouldRemove includes the live pane
    expect(pty.stop).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
    expect(db._deletedSessionIds).toHaveLength(0);
    expect(db._deletedWorkspaceIds).toHaveLength(0);
  });

  it("stopLiveSessions: still fences ANOTHER workspace's running worktree in the shared repoHash dir", async () => {
    const myWorktree = path.join(REPO_DIR, 'my-live-pane');
    const siblingWorktree = path.join(REPO_DIR, 'sibling-live-pane');
    const mySession = makeSession({ id: 'my-s', worktree_path: myWorktree, status: 'running', exited_at: null });
    const sibling = makeSession({
      id: 'sibling-s',
      workspace_id: 'ws-OTHER',
      worktree_path: siblingWorktree,
      status: 'running',
      exited_at: null,
    });
    const wsRow: WorkspaceRow = { id: WS_ID, name: 'test-ws', root_path: '/some/path', repo_root: '/some/path' };
    const db = makeDb([mySession, sibling], [wsRow]);
    const pty = makePty();
    readdirMock.mockResolvedValue(dirents('my-live-pane', 'sibling-live-pane'));

    await cleanupModule.removeWorkspaceAndGc({
      workspaceId: WS_ID,
      worktreeBase: WORKTREE_BASE,
      repoHash: REPO_HASH,
      db,
      dryRun: false,
      pty: asPty(pty),
      stopLiveSessions: true,
    });

    expect(rmMock).toHaveBeenCalledWith(myWorktree, { recursive: true, force: true });
    expect(rmMock).not.toHaveBeenCalledWith(siblingWorktree, expect.anything());
    expect(pty.stop).not.toHaveBeenCalledWith('sibling-s', expect.anything());
    expect(db._deletedSessionIds).not.toContain('sibling-s');
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts -t "stopLiveSessions"`
Expected: FAIL — current order prunes first with the live fence, so `rmMock` is never called for `live-pane` (`worktreeCount` 0) and the dry-run reports 0.

- [ ] **Step 3: Implement kill → delete rows → prune**

In `cleanup.ts`, replace steps 2-4 of `removeWorkspaceAndGc` (lines 311-347, from `// Step 2: GC orphan worktrees…` through the end of the `if (!dryRun)` block) with:

```ts
  // Step 2 — 2026-06-10 audit (finding 2): when stopLiveSessions is set,
  // kill the PTYs and delete the rows BEFORE the worktree GC. The old order
  // (prune → kill → delete) spared live worktrees then deleted their rows,
  // leaving dirs the boot sweep's cold-install guard (worktree-cleanup.ts)
  // can never reap once the repo has zero remaining rows.
  if (!dryRun && stopLiveSessions) {
    for (const id of liveBlockedSessionIds) {
      pty?.stop(id, { tree: true, forget: true });
    }
    if (sessionRows.length > 0) {
      db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId);
    }
  }

  // Step 3: GC orphan worktrees (only when we have a repoHash to key on).
  // Fence = the shared keep-predicate across ALL sessions, minus exactly the
  // rows this call deletes (or would delete on dryRun) — deleted rows' dirs
  // are reaped in the same pass while sibling workspaces' worktrees in the
  // shared repoHash dir stay fenced.
  const effectiveHash = repoHash ?? null;
  let worktreeCount = 0;
  let liveBlockedWorktrees: string[] = [];
  let worktreeErrors = 0;

  if (effectiveHash) {
    const excludeSessionIds = new Set(
      (stopLiveSessions ? sessionRows : nonLiveSessionRows).map((r) => r.id),
    );
    const keep = collectKeptWorktreePaths(db, { excludeSessionIds });
    const pruneResult = await pruneRepoDir(worktreeBase, effectiveHash, keep, dryRun);
    worktreeCount = dryRun ? pruneResult.wouldRemove.length : pruneResult.removed;
    liveBlockedWorktrees = pruneResult.liveBlocked;
    worktreeErrors = pruneResult.errors;
  }

  // Step 4: remaining DB mutations (skipped in dry-run).
  if (!dryRun) {
    if (stopLiveSessions) {
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    } else {
      if (nonLiveSessionRows.length > 0) {
        db.prepare(
          `DELETE FROM agent_sessions
           WHERE workspace_id = ?
             AND status NOT IN ('starting','running')`,
        ).run(workspaceId);
      }
      if (liveBlockedSessionIds.length === 0) {
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      }
    }
  }
```

Then delete the now-unused `liveWorktreePaths` function (`cleanup.ts:74-90`) — `collectKeptWorktreePaths` replaced its last caller. (Leaving it would fail `eslint --max-warnings 0` as unused.)

- [ ] **Step 4: Delete the dead MockDb branch**

In `cleanup.test.ts`, delete the now-dead `SELECT live worktree paths` branch (the `s.includes("status in ('starting','running')")` SELECT branch, lines 66-80 pre-edit). If any test now throws `[MockDb] Unhandled SQL`, a production caller of the old fence survived — find and fix it before proceeding.

- [ ] **Step 5: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/workspaces/cleanup.test.ts`
Expected: PASS — the 3 new tests green; existing `removeWorkspaceAndGc` tests still green (dry-run `worktreeCount >= 0`; non-stop path semantics: non-live rows' dirs are now pruned in the same pass their rows are deleted, live rows still block the workspace row).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspaces/cleanup.ts src/main/core/workspaces/cleanup.test.ts
git commit -m "fix(reaper): removeWorkspaceAndGc kills + deletes rows before pruning — nuked sessions' worktrees are reaped in the same pass instead of becoming unreapable orphans"
```

---

### Task 6: `gcScrollback` reaps crash-orphaned `.log.tmp` (finding 4)

**Files:**
- Modify: `app/src/main/core/pty/scrollback-store.ts:91-101`
- Test: `app/src/main/core/pty/scrollback-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('gcScrollback()', …)` in `scrollback-store.test.ts`:

```ts
  it('removes crash-orphaned .log.tmp files for dead sessions (2026-06-10 audit, finding 4)', () => {
    readdirSync.mockReturnValue(['dead.log.tmp', 'live.log.tmp', 'dead2.log', 'notlog.txt']);
    const liveIds = new Set(['live']);
    gcScrollback('/userData', liveIds);
    expect(unlinkSync).toHaveBeenCalledTimes(2);
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/dead\.log\.tmp$/));
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/dead2\.log$/));
    expect(unlinkSync).not.toHaveBeenCalledWith(expect.stringMatching(/live\.log\.tmp$/));
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/core/pty/scrollback-store.test.ts -t "crash-orphaned"`
Expected: FAIL — `dead.log.tmp` is skipped by the `.log`-only filter, so `unlinkSync` is called once, not twice.

- [ ] **Step 3: Implement the `.log.tmp` sweep**

Replace the loop body in `gcScrollback` (`scrollback-store.ts:91-101`) with:

```ts
    for (const entry of entries) {
      // 2026-06-10 audit (finding 4): also reap crash-orphaned `.log.tmp`.
      // persistScrollback writes tmp → rename, so any tmp that survives to
      // the next boot is debris from a mid-write crash. Same liveness rule
      // as `.log`: a live session's stale tmp is overwritten by its next
      // persist anyway.
      const suffix = entry.endsWith('.log.tmp')
        ? '.log.tmp'
        : entry.endsWith('.log')
          ? '.log'
          : null;
      if (suffix === null) continue;
      const sessionId = entry.slice(0, -suffix.length);
      if (!liveSessionIds.has(sessionId)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          /* best-effort; ignore */
        }
      }
    }
```

Also update the `gcScrollback` doc comment (lines 73-81): change "Any `.log` files whose base names are NOT in `liveSessionIds` are deleted best-effort." to "Any `.log` or crash-orphaned `.log.tmp` files whose base names are NOT in `liveSessionIds` are deleted best-effort."

- [ ] **Step 4: Run the whole file to verify it passes**

Run: `npx vitest run src/main/core/pty/scrollback-store.test.ts`
Expected: PASS (existing tests unaffected: `notlog.txt` is still skipped; live `.log` files still kept)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/pty/scrollback-store.ts src/main/core/pty/scrollback-store.test.ts
git commit -m "fix(reaper): gcScrollback reaps crash-orphaned .log.tmp files"
```

---

### Task 7: Full gate

**Files:** none (verification only). All commands from `/Users/aisigma/projects/SigmaLink/app`. **NO local e2e** — `npx playwright test` launches competing Electron windows on the operator's machine; e2e runs in the CI e2e-matrix on the PR.

- [ ] **Step 1: Typecheck**

Run: `npx tsc -b`
Expected: exit 0, no output. (Run in MAIN, not a worktree — main's `tsc -b` also checks test files.)

- [ ] **Step 2: Lint**

Run: `npx eslint . --max-warnings 0`
Expected: exit 0. (Watch for: unused `workspaceId` bindings — we never destructure it; the deleted `liveWorktreePaths`.)

- [ ] **Step 3: Full unit suite**

Run: `npx vitest run`
Expected: all green. If an unrelated heavy file (swarms/factory, VoiceTab) times out under load, re-run that file in isolation before reacting — known flake pattern.

- [ ] **Step 4: Product check**

Run: `npm run product:check`
Expected: exit 0.

- [ ] **Step 5: Commit any gate fixups**

```bash
git add -A
git commit -m "fix(reaper): gate fixups (tsc/eslint/vitest/product:check)"
```

(Skip if the gate needed no changes.)

---

## Coordination notes

- **Sibling batch overlap — db-bootstrap plan:** that plan touches `factory.ts`/`client.ts` and MIRRORS `removeWorkspaceAndGc`. Task 5 here changes `removeWorkspaceAndGc`'s **mutation order** (kill → delete rows → prune) and its fence semantics (`excludeSessionIds` over the shared keep-predicate). Any mirror of workspace removal in `factory.ts` (`removeWorkspace`) must NOT re-introduce prune-before-kill or a `workspace_id`-scoped fence — grep-sibling-call-sites applies. Coordinate so the db-bootstrap lane rebases onto this.
- **Sibling batch overlap — pty-lifecycle plan:** that plan touches `resume-launcher.ts`. Task 3's tripwire test reads `resume-launcher.ts` source and pins the use-predicate fragments (`s.status = 'running'`, `s.exit_code = -1`). If that plan changes resume/respawn eligibility, the tripwire fails **by design** — the lane must update the transcribed predicates in `worktree-cleanup.test.ts` AND re-verify `isWorktreeKeepEligible` covers the new use-set, in the same commit.
- **Land THIS plan FIRST among reaper-adjacent work.** It establishes the shared keep-predicate (`collectKeptWorktreePaths` / `isWorktreeKeepEligible` in `worktree-cleanup.ts`) that the other lanes should consume instead of writing their own fence queries.
- **rpc-router.ts is deliberately untouched:** `cleanup.pruneWorktrees` / `cleanup.removeWorkspace` handler signatures and result shapes are unchanged (`PruneOrphanWorktreesInput.workspaceId` retained; `liveBlocked` field name kept, doc updated).
- **Out of scope, park in WISHLIST:** (a) `clearPanesForWorkspace` deletes non-live rows without pruning their dirs — the boot sweep reaps them later UNLESS the workspace was the repo's sole user (cold-install guard then sees zero rows; same trap class as finding 2). (b) The cold-install guard itself could record a "repo was managed" marker so an emptied repo dir remains reapable. Neither blocks this plan.
- **Regression provenance:** finding 1a is the `93fbca6` class (memory: `feedback_reaper_keep_superset_of_use`); the invariant test in Task 3 is the articulated guard the first fix lacked.
