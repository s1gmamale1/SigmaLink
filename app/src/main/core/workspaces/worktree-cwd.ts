import path from 'node:path';

export interface WorkspaceWorktreeCwdInput {
  workspaceRoot: string;
  repoRoot: string | null | undefined;
  worktreePath: string | null | undefined;
}

function isInsideRepo(repoRoot: string, workspaceRoot: string): boolean {
  const rel = path.relative(repoRoot, workspaceRoot);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the cwd a provider should see inside an isolated git worktree.
 *
 * Git worktrees are created at the repository root, but SigmaLink workspaces
 * may point at a subdirectory inside that repo (for this repo, `app/`). In
 * that case the provider must spawn in `<worktree>/<relative workspace path>`
 * so workspace-local config such as `CLAUDE.md`, `.claude/`, and `.mcp.json`
 * stays visible.
 */
export function workspaceCwdInWorktree(input: WorkspaceWorktreeCwdInput): string {
  const { workspaceRoot, repoRoot, worktreePath } = input;
  if (!worktreePath) return workspaceRoot;
  if (!repoRoot || !isInsideRepo(repoRoot, workspaceRoot)) return worktreePath;

  const rel = path.relative(repoRoot, workspaceRoot);
  return rel ? path.join(worktreePath, rel) : worktreePath;
}
