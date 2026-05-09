// Worktree pool: each repo gets a per-hash directory under userData/worktrees,
// each session gets a sub-directory keyed by its branch's last path segment.
//
// Cross-platform notes: every path is built with `path.join` so Windows /
// macOS / Linux all produce native separators. Branch names always use `/`
// (Git's own convention) regardless of host OS.

import path from 'node:path';
import fs from 'node:fs';
import {
  generateBranchName,
  repoHash,
  sanitizeBranchSegment,
  worktreeAdd,
  worktreeRemove,
} from './git-ops';

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
    // Retry up to 3 times in the (extremely unlikely) event of a directory
    // collision. With 8 random base-36 chars per branch this should never
    // actually trigger but the guard makes the failure mode loud rather than
    // a confusing `git worktree add: path already exists`.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const branch = generateBranchName(input.role, input.hint);
      const worktreePath = this.pathForBranch(input.repoRoot, branch);
      if (fs.existsSync(worktreePath)) {
        // Collision (cosmically unlikely with 8 chars but possible with the
        // sanitiser collapsing dotted hints). Retry with a fresh suffix.
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        await worktreeAdd({
          repoRoot: input.repoRoot,
          worktreePath,
          branch,
          base: input.base ?? 'HEAD',
        });
        return { worktreePath, branch };
      } catch (err) {
        lastErr = err;
        // If the directory exists post-failure, leave it for `git worktree
        // remove` cleanup elsewhere; loop will pick a new branch.
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`worktree create failed: ${String(lastErr ?? 'unknown')}`);
  }

  async remove(repoRoot: string, worktreePath: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      await worktreeRemove(repoRoot, worktreePath);
    }
  }
}
