// BSP-G5 — post-swarm worktree auto-teardown.
//
// Invoked from factory-spawn.ts once the last swarm agent exits. Reads the
// per-workspace policy from the KV store, then conditionally removes worktrees
// for sessions that match the policy predicate.
//
// SAFETY FENCES (keep⊇use invariant — see memory feedback_reaper_keep_superset_of_use):
//   1. Policy 'keep-all' → immediate no-op. No DB queries, no removes.
//   2. Sessions with status IN ('starting', 'running') are NEVER destroyed.
//   3. Sessions with exit_code = -1 are NEVER destroyed (crash-recovery eligible;
//      destroying their worktrees causes black panes on resume).
//   4. Sessions without a session_review row (decision IS NULL) → KEEP (unknown).
//   5. Sessions with decision = 'passed' → KEEP (under both policies).
//   6. The 7-day uncommitted-work window from worktree-cleanup.ts is respected:
//      recently-exited sessions (exited_at > now - 7d) are kept UNLESS the
//      session has an explicit decision = 'failed' (operator-confirmed failure).
//   7. CO-TENANT fence: split-pane children share their parent's worktree_path.
//      A worktree is removed ONLY when EVERY session referencing it (across all
//      swarms) is itself teardown-eligible — one failed co-tenant must never
//      orphan a sibling that should be kept (→ black panes on resume).
//   8. All removes are best-effort (try/catch per path); never throw out of
//      applyTeardownPolicy — it must never propagate into the onExit handler.

import { getRawDb } from '../db/client';
import { readSwarmTeardownPolicy } from '../../../shared/swarm-teardown-policy';
import type { WorktreePool } from '../git/worktree';

export interface TeardownDeps {
  worktreePool: Pick<WorktreePool, 'removeAndPrune'>;
}

export interface ApplyTeardownPolicyArgs {
  swarmId: string;
  workspaceId: string;
  /** Absolute path to the workspace git repo root. */
  repoRoot: string;
  /** A raw-db accessor — passed as injection point so tests never need better-sqlite3. */
  rawDb: ReturnType<typeof getRawDb>;
  worktreePool: TeardownDeps['worktreePool'];
}


/**
 * Apply the per-workspace post-swarm teardown policy.
 *
 * Called by the onExit hook in factory-spawn.ts after the last swarm agent
 * exits. The function is intentionally best-effort — it never throws.
 *
 * Policy semantics:
 *   - keep-all        → no-op.
 *   - keep-passing    → destroy worktrees of sessions that have
 *                       session_review.decision = 'failed'.
 *   - destroy-failing → same as keep-passing (operator-intent alias).
 *
 * Safety fences applied in order (all must pass for a worktree to be removed):
 *   ✓ Session status NOT IN ('starting', 'running')
 *   ✓ exit_code != -1  (never destroy crash-eligible sessions)
 *   ✓ NOT within 7-day window  (unless decision = 'failed')
 *   ✓ session_review.decision = 'failed'  (unknown/passed always kept)
 *   ✓ worktree_path must be non-null
 */
export async function applyTeardownPolicy(args: ApplyTeardownPolicyArgs): Promise<void> {
  const { swarmId, workspaceId, repoRoot, rawDb, worktreePool } = args;

  // Fence 0: read policy; bail immediately on keep-all.
  const policy = readSwarmTeardownPolicy(rawDb, workspaceId);
  if (policy === 'keep-all') return;

  // Both 'keep-passing' and 'destroy-failing' use the same predicate:
  // only remove sessions with an explicit decision = 'failed'.


  // Join swarm_agents → agent_sessions → session_review to collect candidates.
  // The LEFT JOIN on session_review means rows without a review get decision=NULL.
  type CandidateRow = {
    session_id: string;
    worktree_path: string | null;
    status: string;
    exit_code: number | null;
    exited_at: number | null;
    decision: string | null;
  };

  let candidates: CandidateRow[];
  try {
    candidates = rawDb
      .prepare(
        `SELECT
           sa.session_id,
           ases.worktree_path,
           ases.status,
           ases.exit_code,
           ases.exited_at,
           sr.decision
         FROM swarm_agents sa
         JOIN agent_sessions ases ON ases.id = sa.session_id
         LEFT JOIN session_review sr ON sr.session_id = sa.session_id
         WHERE sa.swarm_id = ?
           AND ases.worktree_path IS NOT NULL`,
      )
      .all(swarmId) as CandidateRow[];
  } catch (err) {
    console.warn('[swarm-teardown] failed to query candidates swarm=%s:', swarmId, err);
    return;
  }

  // Phase 1 — collect the UNIQUE worktree paths whose THIS-swarm session is
  // itself teardown-eligible (terminal, not crash-eligible, decision='failed').
  // NOTE: the 7-day uncommitted-work window is intentionally NOT applied to
  // 'failed' sessions — 'failed' is an operator-confirmed mark, so the user has
  // already signalled the worktree can be discarded.
  const candidatePaths = new Set<string>();
  for (const row of candidates) {
    if (!row.worktree_path) continue;
    if (row.status === 'starting' || row.status === 'running') continue; // Fence 1
    if (row.exit_code === -1) continue; // Fence 2 (crash-recovery eligible)
    if (row.decision !== 'failed') continue; // Fence 3 (unknown/passed → keep)
    candidatePaths.add(row.worktree_path);
  }

  // Phase 2 — CO-TENANT FENCE (keep⊇use). A split-pane child shares its parent's
  // `worktree_path`; one failed co-tenant must NOT take down the shared worktree
  // of a sibling that should be kept (live / crash-eligible / unknown / passed),
  // or that sibling resumes into a missing cwd → black panes. A worktree is
  // removed ONLY when EVERY session referencing it (across ALL swarms, not just
  // this one) is itself teardown-eligible.
  type TenantRow = { status: string; exit_code: number | null; decision: string | null };
  for (const worktreePath of candidatePaths) {
    let tenants: TenantRow[];
    try {
      tenants = rawDb
        .prepare(
          `SELECT ases.status, ases.exit_code, sr.decision
             FROM agent_sessions ases
             LEFT JOIN session_review sr ON sr.session_id = ases.id
            WHERE ases.worktree_path = ?`,
        )
        .all(worktreePath) as TenantRow[];
    } catch (err) {
      console.warn('[swarm-teardown] failed to query co-tenants path=%s:', worktreePath, err);
      continue;
    }

    const everyTenantEligible =
      tenants.length > 0 &&
      tenants.every(
        (t) =>
          t.status !== 'starting' &&
          t.status !== 'running' &&
          t.exit_code !== -1 &&
          t.decision === 'failed',
      );
    if (!everyTenantEligible) {
      console.info(
        '[swarm-teardown] kept shared worktree=%s (a co-tenant session is not teardown-eligible)',
        worktreePath,
      );
      continue;
    }

    // All fences passed for every tenant — remove the worktree.
    try {
      await worktreePool.removeAndPrune(repoRoot, worktreePath);
      console.info(
        '[swarm-teardown] removed worktree=%s policy=%s swarm=%s',
        worktreePath,
        policy,
        swarmId,
      );
    } catch (err) {
      console.warn(
        '[swarm-teardown] removeAndPrune failed worktree=%s swarm=%s:',
        worktreePath,
        swarmId,
        err,
      );
    }
  }
}
