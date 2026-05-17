import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface CleanupResult {
  /** dirs deleted */
  removed: number;
  /** dirs still referenced by agent_sessions */
  kept: number;
  /** dirs that errored during rm; logged + ignored */
  errors: number;
}

/**
 * v1.4.3 worktree dedupe — orphan cleanup on workspace open.
 *
 * Lists dirs under `<worktreeBase>/<repoHash>/*`. For each dir, checks if
 * its absolute path is referenced by any agent_sessions row where the
 * session is `status='running'` OR exited within the last 7 days (to protect
 * users with uncommitted work in recently-exited sessions). If not referenced,
 * removes the dir.
 *
 * Skips cleanup entirely if no agent_sessions rows reference any dir under
 * `<worktreeBase>/<repoHash>/` (cold install / first-ever workspace open).
 *
 * R-04-3 safety: validates that `repoDir` is under `worktreeBase` before
 * iterating to guard against path-traversal if `repoHash` is adversarial.
 *
 * Best-effort: errors logged + ignored. Cleanup failures never block app boot.
 */
export async function cleanupOrphanWorktrees(
  worktreeBase: string,
  repoHash: string,
  db: Database.Database,
): Promise<CleanupResult> {
  const normalBase = path.normalize(worktreeBase);
  const repoDir = path.join(normalBase, repoHash);

  // R-04-3: sanity check — repoDir must be a direct child of worktreeBase.
  const normalRepo = path.normalize(repoDir);
  if (!normalRepo.startsWith(normalBase + path.sep) && normalRepo !== normalBase) {
    console.warn(`[worktree-cleanup] repoDir ${repoDir} is not under worktreeBase ${worktreeBase}; skipping`);
    return { removed: 0, kept: 0, errors: 0 };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(repoDir);
  } catch {
    // dir doesn't exist — nothing to clean up
    return { removed: 0, kept: 0, errors: 0 };
  }

  // Fetch all worktree_paths referenced by live/recent agent_sessions for this repo.
  // R-04-2: keep BOTH running sessions AND recently-exited ones (within 7 days)
  // to avoid deleting worktrees that may have uncommitted work.
  const sevenDaysMs = 7 * 86400 * 1000;
  const liveRows = db
    .prepare(
      `SELECT DISTINCT worktree_path FROM agent_sessions
       WHERE worktree_path IS NOT NULL
         AND worktree_path LIKE ?
         AND (status = 'running' OR exited_at > ?)`,
    )
    .all(`${repoDir}${path.sep}%`, Date.now() - sevenDaysMs) as Array<{ worktree_path: string }>;

  const liveSet = new Set(liveRows.map((r) => r.worktree_path));

  // Cold-install guard: if no rows reference any path in this repoDir, skip.
  // This avoids deleting dirs from a fresh install where DB hasn't caught up.
  if (liveSet.size === 0) {
    // Check whether ANY rows at all reference this repoDir (not just live ones).
    const anyRows = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM agent_sessions
         WHERE worktree_path IS NOT NULL AND worktree_path LIKE ?`,
      )
      .get(`${repoDir}${path.sep}%`) as { cnt: number };

    if (anyRows.cnt === 0) {
      // Genuinely cold install — skip cleanup.
      return { removed: 0, kept: entries.length, errors: 0 };
    }
  }

  let removed = 0;
  let kept = 0;
  let errors = 0;

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
    console.info(
      `[worktree-cleanup] repo=${repoHash} removed=${removed} kept=${kept} errors=${errors}`,
    );
  }

  return { removed, kept, errors };
}
