// Worktree pool: each repo gets a per-hash directory under userData/worktrees,
// each session gets a sub-directory keyed by its branch's last path segment.

import path from 'node:path';
import fs from 'node:fs';
import { generateBranchName, repoHash, sanitizeBranchSegment, worktreeAdd, worktreeRemove } from './git-ops';

export interface WorktreePoolOptions {
  baseDir: string; // e.g. <userData>/worktrees
}

export class WorktreePool {
  private readonly opts: WorktreePoolOptions;
  constructor(opts: WorktreePoolOptions) {
    this.opts = opts;
  }

  poolPathForRepo(repoRoot: string): string {
    return path.join(this.opts.baseDir, repoHash(repoRoot));
  }

  pathForBranch(repoRoot: string, branch: string): string {
    const seg = sanitizeBranchSegment(branch.split('/').slice(1).join('-') || branch);
    return path.join(this.poolPathForRepo(repoRoot), seg);
  }

  async create(input: {
    repoRoot: string;
    role: string;
    hint?: string;
    base?: string;
  }): Promise<{ worktreePath: string; branch: string }> {
    const branch = generateBranchName(input.role, input.hint);
    const worktreePath = this.pathForBranch(input.repoRoot, branch);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await worktreeAdd({
      repoRoot: input.repoRoot,
      worktreePath,
      branch,
      base: input.base ?? 'HEAD',
    });
    return { worktreePath, branch };
  }

  async remove(repoRoot: string, worktreePath: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      await worktreeRemove(repoRoot, worktreePath);
    }
  }
}
