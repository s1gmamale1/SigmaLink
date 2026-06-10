import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalPathKey, pathKeyIsWithin } from '../util/path-key';

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
 * its absolute path is referenced by any agent_sessions row where the session
 * is live, resume-eligible after a crash, or exited within the last 7 days
 * (to protect users with uncommitted work in recently-exited sessions). If
 * not referenced, removes the dir.
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
  if (!/^[a-f0-9]{12}$/i.test(repoHash) || !pathKeyIsWithin(repoDir, normalBase)) {
    console.warn(`[worktree-cleanup] repoDir ${repoDir} is not under worktreeBase ${worktreeBase}; skipping`);
    return { removed: 0, kept: 0, errors: 0 };
  }

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

  // Fetch all worktree_paths referenced by sessions the app may still need.
  // This must stay at least as broad as resume-launcher's eligibility:
  //   - running/starting rows are live or boot-janitor candidates
  //   - exited/-1 rows are crash/failed-resume panes that resumeWorkspacePanes
  //     will re-spawn
  //   - other recently-exited rows keep the original 7-day uncommitted-work guard
  const sevenDaysMs = 7 * 86400 * 1000;
  const liveRows = db
    .prepare(
      `SELECT DISTINCT worktree_path FROM agent_sessions
       WHERE worktree_path IS NOT NULL
         AND (
           status = 'running'
           OR status = 'starting'
           OR (status = 'exited' AND exit_code = -1)
           OR exited_at > ?
         )`,
    )
    .all(Date.now() - sevenDaysMs) as Array<{ worktree_path: string }>;

  const liveSet = new Set(
    liveRows
      .filter((r) => pathKeyIsWithin(r.worktree_path, repoDir))
      .map((r) => canonicalPathKey(r.worktree_path)),
  );

  // Cold-install guard: if no rows reference any path in this repoDir, skip.
  // This avoids deleting dirs from a fresh install where DB hasn't caught up.
  if (liveSet.size === 0) {
    // Check whether ANY rows at all reference this repoDir (not just live ones).
    const anyRows = db
      .prepare(
        `SELECT worktree_path FROM agent_sessions
         WHERE worktree_path IS NOT NULL`,
      )
      .all() as Array<{ worktree_path: string }>;

    const anyUnderRepo = anyRows.some((r) => pathKeyIsWithin(r.worktree_path, repoDir));
    if (!anyUnderRepo) {
      // Genuinely cold install — skip cleanup.
      return { removed: 0, kept: entries.length, errors: 0 };
    }
  }

  let removed = 0;
  let kept = 0;
  let errors = 0;

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

  if (removed > 0 || errors > 0) {
    console.info(
      `[worktree-cleanup] repo=${repoHash} removed=${removed} kept=${kept} errors=${errors}`,
    );
  }

  return { removed, kept, errors };
}

export interface BootSweepResult {
  /** number of repoHash dirs swept */
  repos: number;
  /** total dirs deleted across all repos */
  removed: number;
  /** total dirs kept (referenced / cold-install) across all repos */
  kept: number;
  /** total errored dirs across all repos */
  errors: number;
}

/**
 * Lane A — boot-time all-repo sweep.
 *
 * Orphan cleanup historically ran only once per workspace-open, against the
 * single repo being opened. Leaked worktrees in OTHER repos (e.g. a spawn-retry
 * loop that created worktrees with no surviving `agent_sessions` row) were never
 * reaped until that specific repo happened to be opened again. This sweep runs
 * the existing per-repo keep/reap logic against EVERY repoHash dir under
 * `worktreeBase` at boot, so leaked worktrees get reaped across all repos.
 *
 * Reuses `cleanupOrphanWorktrees`, so the 7-day uncommitted-work protection and
 * the cold-install short-circuit apply unchanged per repo. Removal via
 * `fs.rm(..., {recursive:true})` already takes any untracked `node_modules`
 * down with the dir — no special handling needed.
 *
 * Best-effort: a readdir/cleanup failure on one repo increments `errors` and
 * the sweep continues. It NEVER throws — boot must not be blocked. A missing
 * `worktreeBase` (or any failure reading it) returns all-zeros.
 */
export async function sweepAllReposOnBoot(
  worktreeBase: string,
  db: Database.Database,
): Promise<BootSweepResult> {
  const total: BootSweepResult = { repos: 0, removed: 0, kept: 0, errors: 0 };

  let baseEntries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    baseEntries = (await fs.readdir(worktreeBase, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
  } catch {
    // worktreeBase doesn't exist or is unreadable — nothing to sweep.
    return total;
  }

  for (const entry of baseEntries) {
    // Only descend into directories — a repoHash dir. Skip stray files.
    if (!entry.isDirectory()) continue;
    total.repos++;
    try {
      const res = await cleanupOrphanWorktrees(worktreeBase, entry.name, db);
      total.removed += res.removed;
      total.kept += res.kept;
      total.errors += res.errors;
    } catch (err) {
      // cleanupOrphanWorktrees is already best-effort, but guard anyway so one
      // repo's failure can never abort the boot sweep. Constant format string;
      // the repoHash and error are passed as args (not concatenated) to avoid
      // any format-string injection from a dir name (CWE-134).
      console.warn('[worktree-cleanup] boot-sweep failed for repo %s:', entry.name, err);
      total.errors++;
    }
  }

  // C7 obs — always emit a boot-sweep log with free-disk baseline so a future
  // disk runaway leaves a clear breadcrumb even on clean (0-removed) boots.
  let freeGiB = NaN;
  try {
    if (typeof fs.statfs === 'function') {
      const s = await fs.statfs(worktreeBase);
      freeGiB = (s.bavail * s.bsize) / (1024 ** 3);
    }
  } catch {
    /* non-fatal — freeGiB stays NaN */
  }
  console.info(
    '[worktree-cleanup] boot-sweep repos=%d removed=%d kept=%d errors=%d freeGiB=%.2f',
    total.repos,
    total.removed,
    total.kept,
    total.errors,
    freeGiB,
  );

  return total;
}
