/**
 * worktree-gui.ts — BSP-G1
 *
 * DI-style controller for the `worktreeCreate` RPC handler.
 * Takes WorktreePool as a parameter so it can be unit-tested
 * without loading rpc-router or better-sqlite3.
 */

import type { WorktreePool } from './worktree';

export interface WorktreeCreateInput {
  repoRoot: string;
  hint?: string;
  base?: string;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
}

/**
 * Create a new worktree via the pool, using role:'manual' (user-initiated).
 * The sessionId from the pool result is intentionally omitted — the lead
 * injects it into the session layer at wiring time.
 */
export async function worktreeCreate(
  pool: WorktreePool,
  input: WorktreeCreateInput,
): Promise<WorktreeCreateResult> {
  const r = await pool.create({
    repoRoot: input.repoRoot,
    role: 'manual',
    hint: input.hint,
    base: input.base,
  });
  return { worktreePath: r.worktreePath, branch: r.branch };
}
