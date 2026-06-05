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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies a worktree dir that was spared because a live session owns it. */
export interface PruneWorktreeResult {
  /** Paths that were (or would be) removed. */
  wouldRemove: string[];
  /** Paths that were skipped because a live (starting|running) session owns them. */
  liveBlocked: string[];
  /** Number of dirs actually deleted (0 on dryRun). */
  removed: number;
  /** Number of dirs that failed to delete (fail-open; logged). */
  errors: number;
}

export interface ClearPanesResult {
  /** Session ids that were (or would be) deleted. */
  sessionIds: string[];
  /** Number of session rows actually deleted (0 on dryRun). */
  deleted: number;
}

export interface RemoveWorkspaceAndGcResult {
  /** Number of agent_sessions rows deleted (0 on dryRun). */
  sessionCount: number;
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
 * Returns the set of worktree paths currently held by live (starting|running)
 * sessions that belong to `workspaceId`.  This is the safety fence — we never
 * delete these dirs.
 */
function liveWorktreePaths(db: Database.Database, workspaceId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT worktree_path
       FROM agent_sessions
       WHERE workspace_id = ?
         AND worktree_path IS NOT NULL
         AND status IN ('starting','running')`,
    )
    .all(workspaceId) as Array<{ worktree_path: string }>;
  return new Set(rows.map((r) => canonicalPathKey(r.worktree_path)));
}

/**
 * Core dir-level prune logic, shared by `pruneOrphanWorktreesForWorkspace`
 * and the GC pass inside `removeWorkspaceAndGc`.
 *
 * Lists dirs under `<worktreeBase>/<repoHash>/`, cross-references the live
 * fence, then removes (or dry-runs) anything outside it.
 */
async function pruneRepoDir(
  worktreeBase: string,
  repoHash: string,
  livePaths: Set<string>,
  dryRun: boolean,
): Promise<Omit<PruneWorktreeResult, 'liveBlocked'> & { liveBlocked: string[] }> {
  const normalBase = path.normalize(worktreeBase);
  const repoDir = path.join(normalBase, repoHash);

  // Path-traversal guard: repoDir must be a direct child of worktreeBase.
  if (!/^[a-f0-9]{12}$/i.test(repoHash) || !pathKeyIsWithin(repoDir, normalBase)) {
    console.warn(`[cleanup] repoDir ${repoDir} escapes worktreeBase — skipping`);
    return { wouldRemove: [], liveBlocked: [], removed: 0, errors: 0 };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(repoDir);
  } catch {
    return { wouldRemove: [], liveBlocked: [], removed: 0, errors: 0 };
  }

  const wouldRemove: string[] = [];
  const liveBlocked: string[] = [];

  for (const entry of entries) {
    const full = path.join(repoDir, entry);
    if (livePaths.has(canonicalPathKey(full))) {
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
  /** Workspace id — used to scope the live-session fence query. */
  workspaceId: string;
  /** Raw better-sqlite3 handle (never import getDb here — testability). */
  db: Database.Database;
  /** When true, report what would happen without mutating anything. */
  dryRun: boolean;
}

/**
 * Exposes the best-effort orphan worktree cleanup already run on
 * `workspaces.open` as a manual trigger.  Safe: live sessions fence applies;
 * no DB rows are touched.
 */
export async function pruneOrphanWorktreesForWorkspace(
  input: PruneOrphanWorktreesInput,
): Promise<PruneWorktreeResult> {
  const { worktreeBase, repoHash, workspaceId, db, dryRun } = input;

  const live = liveWorktreePaths(db, workspaceId);
  return pruneRepoDir(worktreeBase, repoHash, live, dryRun);
}

// ---------------------------------------------------------------------------

export interface ClearPanesInput {
  workspaceId: string;
  db: Database.Database;
  dryRun: boolean;
}

/**
 * Clears all agent_sessions rows for a workspace (closes/clears all panes).
 * Live sessions (status IN ('starting','running')) are INCLUDED in the list
 * so the operator can see them — the renderer should confirm before calling
 * with `dryRun:false`.  We trust the operator; the confirm dialog is the
 * UI-level gate.
 */
export async function clearPanesForWorkspace(
  input: ClearPanesInput,
): Promise<ClearPanesResult> {
  const { workspaceId, db, dryRun } = input;

  const rows = db
    .prepare('SELECT id FROM agent_sessions WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ id: string }>;

  const sessionIds = rows.map((r) => r.id);

  if (!dryRun && sessionIds.length > 0) {
    db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId);
  }

  return {
    sessionIds,
    deleted: dryRun ? 0 : sessionIds.length,
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
  const { workspaceId, worktreeBase, db, dryRun, repoHash } = input;

  // Step 0: resolve workspace row.
  const wsRow = db
    .prepare('SELECT id, name, root_path, repo_root FROM workspaces WHERE id = ?')
    .get(workspaceId) as
    | { id: string; name: string; root_path: string; repo_root: string | null }
    | undefined;

  if (!wsRow) {
    throw new Error(`[cleanup] Workspace not found: ${workspaceId}`);
  }

  // Step 1: count sessions.
  const sessionRows = db
    .prepare('SELECT id FROM agent_sessions WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ id: string }>;

  // Step 2: GC orphan worktrees (only when we have a repoHash to key on).
  const effectiveHash = repoHash ?? null;
  let worktreeCount = 0;
  let liveBlockedWorktrees: string[] = [];
  let worktreeErrors = 0;

  if (effectiveHash) {
    const live = liveWorktreePaths(db, workspaceId);
    const pruneResult = await pruneRepoDir(worktreeBase, effectiveHash, live, dryRun);
    worktreeCount = dryRun ? pruneResult.wouldRemove.length : pruneResult.removed;
    liveBlockedWorktrees = pruneResult.liveBlocked;
    worktreeErrors = pruneResult.errors;
  }

  // Step 3+4: Mutate DB (skipped in dry-run).
  if (!dryRun) {
    if (sessionRows.length > 0) {
      db.prepare('DELETE FROM agent_sessions WHERE workspace_id = ?').run(workspaceId);
    }
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
  }

  return {
    sessionCount: sessionRows.length,
    worktreeCount,
    liveBlockedWorktrees,
    worktreeErrors,
  };
}
