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
//   7. All removes are best-effort (try/catch per session); never throw out of
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

  for (const row of candidates) {
    const {
      session_id: sessionId,
      worktree_path: worktreePath,
      status,
      exit_code: exitCode,
      decision,
    } = row;

    if (!worktreePath) continue;

    // Fence 1: never touch live sessions.
    if (status === 'starting' || status === 'running') continue;

    // Fence 2: never destroy crash-eligible (exit_code = -1) sessions.
    if (exitCode === -1) continue;

    // Fence 3: only sessions with explicit decision = 'failed' are eligible.
    // NULL / 'passed' → keep (safe default).
    if (decision !== 'failed') continue;

    // NOTE: the 7-day uncommitted-work window is intentionally NOT applied to
    // 'failed' sessions. 'failed' is an operator-confirmed mark, so the user
    // has already signalled that this worktree can be discarded. If the
    // per-session window is desired for failed sessions in a future policy, add
    // exited_at to the SELECT above and re-introduce the guard here.

    // All fences passed — remove this worktree.
    try {
      await worktreePool.removeAndPrune(repoRoot, worktreePath);
      console.info(
        '[swarm-teardown] removed session=%s policy=%s swarm=%s',
        sessionId,
        policy,
        swarmId,
      );
    } catch (err) {
      // Best-effort per session; log + continue.
      console.warn(
        '[swarm-teardown] removeAndPrune failed session=%s swarm=%s:',
        sessionId,
        swarmId,
        err,
      );
    }
  }

}
