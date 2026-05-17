# 04 — Worktree Dedupe / Orphan Cleanup (P2)

**Severity**: P2 — housekeeping; prevents `<userData>/SigmaLink/worktrees/` from accumulating orphans
**Effort**: S (~2hr)
**Cluster**: B (pane-lifecycle — bundled with #02 and #03 in ONE PR)
**Suggested delegate**: Sonnet (Claude Code) or Qwen (if scope allows)
**Depends on**: #02 (rehydration must be accurate so we know which worktrees are still live), #03 (status='running' must be truthful)
**Blocks**: nothing

## Context

User report (continuation of the persistence bug): "creating another worktrees and creating a mess."

Investigation showed `~/Library/Application Support/SigmaLink/worktrees/373b48ed20cd/` contains **34 dirs** for ONE workspace's history — 7× `claude-pane-0-*`, 6× `gemini-pane-3-*`, etc. Each "re-create" of a pane spawned a fresh worktree because `WorktreePool.create` always emits a random suffix on the hint. Once #02 fixes rehydration, re-creates stop happening but the historical orphans remain.

This packet adds a one-shot cleanup on `workspaces.open` that removes worktree dirs not referenced by any live `agent_sessions.worktree_path`. Best-effort, non-fatal.

## File:line targets

### NEW `app/src/main/core/workspaces/worktree-cleanup.ts`

```ts
import { promises as fs } from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';

export interface CleanupResult {
  removed: number;       // dirs deleted
  kept: number;          // dirs still referenced by agent_sessions
  errors: number;        // dirs that errored during rm; logged + ignored
}

/**
 * v1.4.3 worktree dedupe — orphan cleanup on workspace open.
 *
 * Lists dirs under `<worktreeBase>/<repoHash>/*`. For each dir, checks if
 * its absolute path is referenced by any agent_sessions row where
 * `worktree_path = <dir>` AND `status='running'`. If not referenced, removes
 * the dir.
 *
 * Skips cleanup entirely if no agent_sessions rows reference any dir under
 * `<worktreeBase>/<repoHash>/` (cold install / first-ever workspace open).
 *
 * Best-effort: errors logged + ignored. Cleanup failures never block app boot.
 */
export async function cleanupOrphanWorktrees(
  worktreeBase: string,
  repoHash: string,
  db: Database.Database
): Promise<CleanupResult> {
  const repoDir = path.join(worktreeBase, repoHash);
  let entries: string[];
  try {
    entries = await fs.readdir(repoDir);
  } catch {
    return { removed: 0, kept: 0, errors: 0 }; // dir doesn't exist
  }

  // Fetch all worktree_paths referenced by live agent_sessions for this repo
  const liveSet = new Set(
    db.prepare(`
      SELECT DISTINCT worktree_path FROM agent_sessions
      WHERE worktree_path IS NOT NULL
        AND worktree_path LIKE ?
        AND status = 'running'
    `).all(`${repoDir}%`).map(r => (r as any).worktree_path)
  );

  // Cold-install guard: if no rows reference any path in this repoDir, skip.
  if (liveSet.size === 0) {
    return { removed: 0, kept: entries.length, errors: 0 };
  }

  let removed = 0, kept = 0, errors = 0;
  for (const entry of entries) {
    const full = path.join(repoDir, entry);
    if (liveSet.has(full)) {
      kept++;
      continue;
    }
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn(`[worktree-cleanup] Failed to remove ${full}:`, err);
      errors++;
    }
  }

  if (removed > 0 || errors > 0) {
    console.info(`[worktree-cleanup] repo=${repoHash} removed=${removed} kept=${kept} errors=${errors}`);
  }

  return { removed, kept, errors };
}
```

### Integration — `app/src/main/rpc-router.ts:720` (or wherever `workspaces.open` handler lives)

Inside the `workspaces.open` handler, after the workspace row is loaded but BEFORE any pane resume:

```ts
import { cleanupOrphanWorktrees } from './core/workspaces/worktree-cleanup';

'workspaces.open': async (workspaceId: string) => {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) throw new Error('workspace not found');

  // ... existing logic ...

  // NEW: best-effort orphan worktree cleanup. Non-fatal.
  if (workspace.repo_hash) {
    try {
      const worktreeBase = path.join(app.getPath('userData'), 'worktrees');
      await cleanupOrphanWorktrees(worktreeBase, workspace.repo_hash, db);
    } catch (err) {
      console.warn('[workspaces.open] Worktree cleanup failed (non-fatal):', err);
    }
  }

  // ... continue with pane resume etc ...
};
```

## Tests

NEW `app/src/main/core/workspaces/worktree-cleanup.test.ts`:

1. **No worktreeBase dir** — returns `{removed:0, kept:0, errors:0}`; doesn't throw.
2. **Empty repoDir** — same as above.
3. **No live agent_sessions for this repo** (cold install) — skips cleanup; returns `{removed:0, kept:N, errors:0}`.
4. **All dirs referenced** — `removed=0, kept=N, errors=0`.
5. **Mix referenced + orphan** — orphans removed, referenced kept.
6. **Orphan removal failure (permission denied, etc.)** — logged + counted as error; doesn't throw.
7. **No `status='running'` rows but dirs exist** — treated as cold install (skip cleanup).
8. **`LIKE` pattern matches subdirs but not unrelated repos** — verify SQL safety.

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-02-04-pane-lifecycle/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # +8 new cases
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
```

**Manual smoke**:
1. Pre-fix: `ls ~/Library/Application\ Support/SigmaLink/worktrees/<repoHash>/ | wc -l` → e.g. 34.
2. Build + launch app, open the workspace.
3. Re-query: count should be reduced to N (one per live session row).
4. Verify each remaining dir corresponds to a `status='running'` row in `agent_sessions`.

## Risks

- **R-04-1** Cleanup races with a concurrent spawn — pane spawns in the middle of cleanup, its worktree gets removed. Mitigation: cleanup runs on `workspaces.open` BEFORE any resume/spawn. Workspaces only open one-at-a-time per Electron process (lock). Low risk.
- **R-04-2** Cleanup of a worktree dir while its parent git repo has uncommitted changes in that worktree — user loses work. Mitigation: cleanup only removes worktrees whose `worktree_path` is NOT in `agent_sessions` (i.e. genuinely orphaned). If a session was just exited but its worktree wasn't yet cleaned up by `git worktree remove`, the row is still there with `status='exited'` — guard accordingly: only `status='running'` IS the "keep" signal. Treat `status='exited'` as also-keep to avoid this risk. **Revise the SQL**: `WHERE status IN ('running', 'exited') AND exited_at > (now - 7d)` — keep recently-exited too.
- **R-04-3** `fs.rm` with `recursive: true` is destructive. The repoDir prefix check prevents cleanup outside the worktree base. But: validate `repoDir` is under `worktreeBase` (sanity check) before iterating.

## Pairs with

- #02, #03 — same PR, same cluster

## Closes

- The "mess accumulates" complaint from the user's dogfood report
- Latent disk-space leak from every version of SigmaLink that had per-pane worktrees

## Doc source

New file — no prior brief.
