// SigmaLink Dev (2026-06-11) — the special singleton dev workspace contract,
// shared by main + renderer (same single-source-of-truth rationale as
// shared/worktree-mode.ts: the renderer can't import main-only DB readers,
// and a hand-copied key string is a drift hazard).
//
// The KV row `workspace.devWorkspace.id → <workspaceId>` marks THE dev
// workspace: a forced-`plain` row at os.homedir() holding only plain shell
// panes. If the pointed-at row is deleted, openDevWorkspace self-heals by
// inserting a fresh row and re-pointing the KV.

export const DEV_WORKSPACE_KV_KEY = 'workspace.devWorkspace.id';
export const DEV_WORKSPACE_NAME = 'SigmaLink Dev';
export const DEV_WORKSPACE_MAX_PANES = 12;
