import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { workspaceCwdInWorktree } from './worktree-cwd';

describe('workspaceCwdInWorktree', () => {
  it('maps repo-root worktrees back to the selected workspace subdirectory', () => {
    const cwd = workspaceCwdInWorktree({
      workspaceRoot: '/Users/dev/projects/SigmaLink/app',
      repoRoot: '/Users/dev/projects/SigmaLink',
      worktreePath: '/Users/dev/Library/Application Support/SigmaLink/worktrees/hash/claude-pane-0',
    });

    expect(cwd).toBe(
      path.join(
        '/Users/dev/Library/Application Support/SigmaLink/worktrees/hash/claude-pane-0',
        'app',
      ),
    );
  });

  it('uses the worktree root when the workspace is the repo root', () => {
    const cwd = workspaceCwdInWorktree({
      workspaceRoot: '/repo',
      repoRoot: '/repo',
      worktreePath: '/tmp/worktree',
    });

    expect(cwd).toBe('/tmp/worktree');
  });

  it('falls back safely for plain workspaces and inconsistent repo metadata', () => {
    expect(
      workspaceCwdInWorktree({
        workspaceRoot: '/plain/project',
        repoRoot: null,
        worktreePath: null,
      }),
    ).toBe('/plain/project');

    expect(
      workspaceCwdInWorktree({
        workspaceRoot: '/outside/project',
        repoRoot: '/repo',
        worktreePath: '/tmp/worktree',
      }),
    ).toBe('/tmp/worktree');
  });
});
