// SF-13 — Operator-facing cleanup actions (main-process only).
//
// Three exported functions consumed by the cleanup.* RPC handlers that the
// Lead agent registers in rpc-router.ts.  All three are:
//   - DRY-RUN-ABLE:  pass `dryRun: true` to get what WOULD be done.
//   - SAFE:          live sessions (status IN ('starting','running')) are never
//                    disturbed or deleted.
//   - FAIL-OPEN:     one bad dir/row never aborts the batch; errors are counted
//                    and logged.
//   - IDEMPOTENT:    re-running after a partial failure is safe.
//
// This module must NOT import `getDb` / `getRawDb` (which call
// `better-sqlite3` at module load time) — the DB handle is threaded in as a
// parameter so this module stays testable in vitest without the Electron ABI
// native module.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { canonicalPathKey, pathKeyIsWithin } from '../util/path-key';
import type { PtyRegistry } from '../pty/registry';
import type { ProcessTreeSnapshot } from '../process/process-tree';
import { collectKeptWorktreePaths } from './worktree-cleanup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies a worktree dir that was spared because a live session owns it. */
export interface PruneWorktreeResult {
  /** Paths that were (or would be) removed. */
  wouldRemove: string[];
  /** Paths skipped because the keep-fence holds them (live, resume-eligible exited/-1, or exited <7d ago). */
  liveBlocked: string[];
  /** Number of dirs actually deleted (0 on dryRun). */
  removed: number;
  /** Number of dirs that failed to delete (fail-open; logged). */
  errors: number;
}

export interface ClearPanesResult {
  /** Session ids that were (or would be) deleted. */
  sessionIds: string[];
  /** Live session ids that were preserved because their PTY may still be running. */
  liveBlockedSessionIds: string[];
  /** Best-effort process-tree telemetry for live sessions. */
  liveProcessSnapshots: ProcessTreeSnapshot[];
  /** Sum of live process-tree RSS in bytes when telemetry is supported. */
  liveRssBytes: number;
  /** Number of session rows actually deleted (0 on dryRun). */
  deleted: number;
}

export interface RemoveWorkspaceAndGcResult {
  /** Number of agent_sessions rows deleted (0 on dryRun). */
  sessionCount: number;
  /** Live session ids that blocked workspace-row deletion. */
  liveBlockedSessionIds: string[];
  /** Best-effort process-tree telemetry for live sessions. */
  liveProcessSnapshots: ProcessTreeSnapshot[];
  /** Sum of live process-tree RSS in bytes when telemetry is supported. */
  liveRssBytes: number;
  /** Number of orphan worktree dirs deleted (0 on dryRun). */
  worktreeCount: number;
  /** Worktree paths that were spared because of live sessions. */
  liveBlockedWorktrees: string[];
  /** Worktree removal errors (fail-open). */
  worktreeErrors: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Core dir-level prune logic, shared by `pruneOrphanWorktreesForWorkspace`
 * and the GC pass inside `removeWorkspaceAndGc`.
 *
 * Lists dirs under `<worktreeBase>/<repoHash>/`, cross-references the keep-fence
 * (live, resume-eligible, or recently-exited sessions), then removes (or
 * dry-runs) anything outside it.
 */
async function pruneRepoDir(
  worktreeBase: string,
  repoHash: string,
  keepPaths: Set<string>,
  dryRun: boolean,
): Promise<Omit<PruneWorktreeResult, 'liveBlocked'> & { liveBlocked: string[] }> {
  const normalBase = path.normalize(worktreeBase);
  const repoDir = path.join(normalBase, repoHash);

  // Path-traversal guard: repoDir must be a direct child of worktreeBase.
  if (!/^[a-f0-9]{12}$/i.test(repoHash) || !pathKeyIsWithin(repoDir, normalBase)) {
    console.warn(`[cleanup] repoDir ${repoDir} escapes worktreeBase — skipping`);
    return { wouldRemove: [], liveBlocked: [], removed: 0, errors: 0 };
  }

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
    if (keepPaths.has(canonicalPathKey(full))) {
      liveBlocked.push(full);
    } else {
      wouldRemove.push(full);
    }
  }

  let removed = 0;
  let errors = 0;

  if (!dryRun) {
    for (const p of wouldRemove) {
      try {
        await fs.rm(p, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.warn('[cleanup] Failed to remove worktree dir:', p, err);
        errors++;
      }
    }
  }

  return { wouldRemove, liveBlocked, removed, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PruneOrphanWorktreesInput {
  /** Base dir, e.g. `<userData>/worktrees`. */
  worktreeBase: string;
  /** SHA-like hash segment of the repo root (computed by `repoHash()`). */
  repoHash: string;
  /** Workspace id — retained for RPC compatibility; the keep-fence is global
   *  (shared repoHash dir per repo since migration 0034). */
  workspaceId: string;
  /** Raw better-sqlite3 handle (never import getDb here — testability). */
  db: Database.Database;
  /** When true, report what would happen without mutating anything. */
  dryRun: boolean;
}

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

// ---------------------------------------------------------------------------

export interface ClearPanesInput {
  workspaceId: string;
  db: Database.Database;
  dryRun: boolean;
  pty?: PtyRegistry;
  stopLiveSessions?: boolean;
}

/**
 * Clears agent_sessions rows for a workspace. Live sessions are reported and
 * preserved by default; callers must pass stopLiveSessions to terminate their
 * process tree before deleting live rows.
 */
export async function clearPanesForWorkspace(
  input: ClearPanesInput,
): Promise<ClearPanesResult> {
  const { workspaceId, db, dryRun, pty, stopLiveSessions } = input;

  const rows = db
    .prepare('SELECT id, status FROM agent_sessions WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ id: string; status: string }>;

  const liveBlockedSessionIds = rows
    .filter((r) => r.status === 'starting' || r.status === 'running')
    .map((r) => r.id);
  const liveProcessSnapshots = liveBlockedSessionIds
    .map((id) => pty?.processSnapshot(id) ?? null)
    .filter((snapshot): snapshot is ProcessTreeSnapshot => snapshot !== null);
  const liveRssBytes = liveProcessSnapshots.reduce((sum, snapshot) => sum + snapshot.rssBytes, 0);
  const nonLiveSessionIds = rows
    .filter((r) => r.status !== 'starting' && r.status !== 'running')
    .map((r) => r.id);
  const sessionIds = stopLiveSessions ? rows.map((r) => r.id) : nonLiveSessionIds;

  if (!dryRun && stopLiveSessions) {
    for (const id of liveBlockedSessionIds) {
      pty?.stop(id, { tree: true, forget: true });
    }
  }

  if (!dryRun) {
    if (stopLiveSessions) {
      if (sessionIds.length > 0) {
        db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId);
      }
    } else if (nonLiveSessionIds.length > 0) {
      db.prepare(
        `DELETE FROM agent_sessions
         WHERE workspace_id = ?
           AND status NOT IN ('starting','running')`,
      ).run(workspaceId);
    }
  }

  return {
    sessionIds,
    liveBlockedSessionIds,
    liveProcessSnapshots,
    liveRssBytes,
    deleted: dryRun
      ? 0
      : stopLiveSessions
        ? sessionIds.length
        : nonLiveSessionIds.length,
  };
}

// ---------------------------------------------------------------------------

export interface RemoveWorkspaceAndGcInput {
  workspaceId: string;
  worktreeBase: string;
  db: Database.Database;
  dryRun: boolean;
  /** Optional repo hash override.  When omitted the workspace row's
   *  `repo_root` is used to derive the hash via a simple basename hash-like
   *  lookup.  The caller (rpc-router handler) should pass the computed hash
   *  via `computeRepoHash(repoRoot)` since that function lives in git-ops.ts.
   */
  repoHash?: string;
  pty?: PtyRegistry;
  stopLiveSessions?: boolean;
}

/**
 * Hard cleanup of one workspace:
 *  1. Identifies all agent_sessions rows.
 *  2. GC's orphan worktree dirs (live sessions fenced).
 *  3. Deletes all agent_sessions rows for the workspace.
 *  4. Deletes the workspace row itself.
 *
 * This calls the DB directly and does NOT invoke `removeWorkspace()` from
 * factory.ts (which also stops the Ruflo HTTP daemon via its deps).  The RPC
 * handler is responsible for calling the Ruflo daemon stop before invoking
 * this — include that note in the registration snippet.
 */
export async function removeWorkspaceAndGc(
  input: RemoveWorkspaceAndGcInput,
): Promise<RemoveWorkspaceAndGcResult> {
  const { workspaceId, worktreeBase, db, dryRun, repoHash, pty, stopLiveSessions } = input;

  // Step 0: resolve workspace row.
  const wsRow = db
    .prepare('SELECT id, name, root_path, repo_root FROM workspaces WHERE id = ?')
    .get(workspaceId) as
    | { id: string; name: string; root_path: string; repo_root: string | null }
    | undefined;

  if (!wsRow) {
    throw new Error(`[cleanup] Workspace not found: ${workspaceId}`);
  }

  // Step 1: count sessions and split live rows from rows that can be deleted.
  const sessionRows = db
    .prepare('SELECT id, status FROM agent_sessions WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ id: string; status: string }>;
  const liveBlockedSessionIds = sessionRows
    .filter((r) => r.status === 'starting' || r.status === 'running')
    .map((r) => r.id);
  const liveProcessSnapshots = liveBlockedSessionIds
    .map((id) => pty?.processSnapshot(id) ?? null)
    .filter((snapshot): snapshot is ProcessTreeSnapshot => snapshot !== null);
  const liveRssBytes = liveProcessSnapshots.reduce((sum, snapshot) => sum + snapshot.rssBytes, 0);
  const nonLiveSessionRows = sessionRows.filter(
    (r) => r.status !== 'starting' && r.status !== 'running',
  );

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

  return {
    sessionCount: stopLiveSessions ? sessionRows.length : nonLiveSessionRows.length,
    liveBlockedSessionIds,
    liveProcessSnapshots,
    liveRssBytes,
    worktreeCount,
    liveBlockedWorktrees,
    worktreeErrors,
  };
}
