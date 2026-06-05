// ADR-007 — per-workspace worktree-mode KV contract, shared by main + renderer.
//
// The KV key builder and the mode type live here (in `shared/`) so the main
// process (core/workspaces/worktree-mode.ts) and the renderer
// (features/workspace-launcher/Launcher.tsx) read/write the EXACT same key with
// no hand-rolled duplication. The renderer can't import the main-only
// `readWorktreeMode` (it pulls in `getRawDb`), so previously the renderer
// hand-copied the key string — a drift hazard. This module is the single source
// of truth for both.

export type WorktreeMode = 'worktree' | 'in-place';

/** KV key for a workspace's worktree mode: `workspace.worktreeMode.${id}`. */
export function worktreeModeKey(workspaceId: string): string {
  return `workspace.worktreeMode.${workspaceId}`;
}
