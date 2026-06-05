// BSP-G5 — per-workspace post-swarm worktree teardown policy.
//
// KV key: `workspace.swarmTeardownPolicy.${workspaceId}`
// Values:
//   'keep-all'       (default) — no automatic teardown; worktrees persist as today.
//   'keep-passing'   — after a swarm completes, keep ONLY passed/unknown sessions;
//                      destroy worktrees for sessions whose session_review.decision = 'failed'.
//   'destroy-failing'— same semantics as 'keep-passing' (alias with same predicate,
//                      named from the operator's intent rather than what survives).
//
// Safety contract (keep⊇use invariant — see memory feedback_reaper_keep_superset_of_use):
//   NEVER destroy a worktree for any session where exit_code = -1  (crash-recovery eligible).
//   NEVER destroy a worktree for a running/starting session.
//   NEVER destroy a worktree where decision is NULL / unknown — treat as KEEP.
//   The 7-day window for recently-exited sessions is also respected in the main
//   teardown helper (swarm-teardown.ts) — unless decision='failed', which is an
//   operator-confirmed failure mark rather than incidental recency.
//
// The type + key builder live in `shared/` so the renderer (MaintenanceTab) and
// the main-process helper (swarm-teardown.ts) share the exact same key string
// with no duplication. `readSwarmTeardownPolicy` lives here too (unlike
// `readWorktreeMode` which lives in `main/core/workspaces/worktree-mode.ts`)
// because it only needs `rawDb` and returns a pure value — safe for shared/.

export type SwarmTeardownPolicy = 'keep-all' | 'keep-passing' | 'destroy-failing';

const VALID_POLICIES: ReadonlySet<string> = new Set<SwarmTeardownPolicy>([
  'keep-all',
  'keep-passing',
  'destroy-failing',
]);

/** KV key for a workspace's post-swarm teardown policy. */
export function swarmTeardownPolicyKey(workspaceId: string): string {
  return `workspace.swarmTeardownPolicy.${workspaceId}`;
}

/**
 * Read the per-workspace teardown policy from a raw SQLite DB handle.
 *
 * Mirrors `readWorktreeMode` in `core/workspaces/worktree-mode.ts`:
 *  - accepts a raw-db instance so callers can pass a stub in tests without
 *    touching `better-sqlite3`.
 *  - any unrecognised value (or absent row) → 'keep-all' (safe default that
 *    changes no behaviour unless the operator explicitly opts in).
 *  - exceptions are swallowed → 'keep-all' (fail-safe: never trigger teardown
 *    if the KV can't be read).
 *
 * @param rawDb - A raw sqlite db handle, or a test stub with a `.prepare()` method.
 * @param workspaceId - The workspace row id.
 */
export function readSwarmTeardownPolicy(
  rawDb: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  workspaceId: string,
): SwarmTeardownPolicy {
  try {
    const row = rawDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(swarmTeardownPolicyKey(workspaceId)) as { value?: string } | undefined;
    const v = row?.value;
    return typeof v === 'string' && VALID_POLICIES.has(v)
      ? (v as SwarmTeardownPolicy)
      : 'keep-all';
  } catch {
    return 'keep-all';
  }
}
