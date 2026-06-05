// ADR-007 — per-workspace worktree mode flag.
//
// KV key: `workspace.worktreeMode.${workspaceId}`
// Values: 'worktree' (default) | 'in-place'
//
// In-place mode short-circuits BOTH worktree-creation gates (launcher.ts Gate A
// and factory-spawn.ts Gate B) so agents run directly in the workspace repo root
// instead of an isolated git worktree. The no-worktree path already works:
// `workspaceCwdInWorktree` returns `workspaceRoot` when `worktreePath` is null.
//
// Default is 'worktree' (fail-safe — any unrecognised value falls back to the
// safe default, keeping the worktree isolation invariant unless explicitly opted out).

import { getRawDb } from '../db/client';

export type WorktreeMode = 'worktree' | 'in-place';

/** KV key convention — exported so the Settings UI can write the same key. */
export function worktreeModeKey(workspaceId: string): string {
  return `workspace.worktreeMode.${workspaceId}`;
}

/**
 * Read the per-workspace worktree mode from the KV store.
 *
 * Mirrors the `readRufloAutowrite` / `readShowLegacy` pattern in `launcher.ts`:
 * accepts a raw-db instance (so it can be called before `getDb()` is available
 * and so test stubs can inject a fake db without connecting to better-sqlite3).
 *
 * @param rawDb - The raw sqlite db handle (or a test stub).
 * @param workspaceId - The workspace row id.
 * @returns `'in-place'` only when the KV row holds exactly that string;
 *          `'worktree'` for any other value or when the row is absent.
 */
export function readWorktreeMode(
  rawDb: ReturnType<typeof getRawDb>,
  workspaceId: string,
): WorktreeMode {
  try {
    const row = rawDb
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(worktreeModeKey(workspaceId)) as { value?: string } | undefined;
    return row?.value === 'in-place' ? 'in-place' : 'worktree';
  } catch {
    return 'worktree';
  }
}
