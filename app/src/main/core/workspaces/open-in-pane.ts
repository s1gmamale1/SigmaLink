/**
 * open-in-pane.ts — BSP-G3
 *
 * DI-style controller that re-homes an IDLE pane to a new worktree cwd.
 * Safety invariant: ONLY operates on non-running panes. A live turn
 * (status === 'running') is always refused — the caller gets {ok:false}.
 *
 * All real deps (getSession / respawnInCwd / updateSessionCwd) are injected
 * by rpc-router at wiring time so this module stays pure and unit-testable
 * without loading better-sqlite3 or any PTY code.
 */

export interface OpenInPaneDeps {
  /** Returns the session record or null if not found. */
  getSession: (id: string) => { id: string; status: string; cwd: string; worktreePath: string | null } | null;
  /**
   * Kill and respawn the pane's PTY in the given cwd.
   * Injected by the lead at wiring time (no direct PTY import here).
   */
  respawnInCwd: (sessionId: string, cwd: string) => Promise<void>;
  /**
   * Persist the updated cwd + worktreePath to the session store.
   * Called BEFORE respawnInCwd so the new cwd survives a crash during respawn.
   */
  updateSessionCwd: (sessionId: string, cwd: string, worktreePath: string) => void;
}

export interface OpenInPaneInput {
  sessionId: string;
  worktreePath: string;
}

export interface OpenInPaneResult {
  ok: boolean;
}

/**
 * Re-home an idle pane to `worktreePath`.
 *
 * Returns `{ok: false}` when:
 *  - the session is not found
 *  - the session status is 'running' (live turn — safety invariant)
 *
 * On success: persists the cwd update then respawns the PTY in the new
 * directory, returning `{ok: true}`.
 */
export async function openInPane(
  deps: OpenInPaneDeps,
  input: OpenInPaneInput,
): Promise<OpenInPaneResult> {
  const s = deps.getSession(input.sessionId);
  if (!s) return { ok: false };
  if (s.status === 'running') return { ok: false }; // idle-only — never swap a live turn
  deps.updateSessionCwd(s.id, input.worktreePath, input.worktreePath);
  await deps.respawnInCwd(s.id, input.worktreePath);
  return { ok: true };
}
