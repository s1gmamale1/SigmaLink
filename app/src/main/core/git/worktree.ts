// Worktree pool: each repo gets a per-hash directory under userData/worktrees,
// each session gets a sub-directory keyed by its branch's last path segment.
//
// Cross-platform notes: every path is built with `path.join` so Windows /
// macOS / Linux all produce native separators. Branch names always use `/`
// (Git's own convention) regardless of host OS.

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  generateBranchName,
  repoHash,
  sanitizeBranchSegment,
  worktreeAdd,
  worktreeRemove,
  worktreePruneRepo,
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
    /**
     * v1.5.5-A — pre-allocated session UUID. When provided, the first 8 hex
     * chars (dashes stripped) are used as the worktree path suffix so the
     * filesystem path encodes the same id stored in agent_sessions.id.
     *
     * Retry semantics: if a collision occurs the loop regenerates a fresh UUID
     * for the next attempt. The returned sessionId reflects whichever attempt
     * actually succeeded, so callers must use the return value — not the input.
     */
    sessionId?: string;
  }): Promise<{ worktreePath: string; branch: string; sessionId: string }> {
    // Retry up to 3 times in the (extremely unlikely) event of a directory
    // collision. With 8 random UUID hex chars per branch this should never
    // actually trigger but the guard makes the failure mode loud rather than
    // a confusing `git worktree add: path already exists`.
    //
    // On collision: regenerate sessionId so the next attempt gets a fresh
    // suffix. The caller MUST read r.sessionId (not the input) to learn which
    // UUID was ultimately used.
    let effectiveSessionId = input.sessionId ?? randomUUID();
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const branch = generateBranchName(input.role, input.hint, effectiveSessionId);
      const worktreePath = this.pathForBranch(input.repoRoot, branch);
      if (fs.existsSync(worktreePath)) {
        // Collision: regenerate UUID for next attempt.
        effectiveSessionId = randomUUID();
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
        return { worktreePath, branch, sessionId: effectiveSessionId };
      } catch (err) {
        lastErr = err;
        // If the directory exists post-failure, leave it for `git worktree
        // remove` cleanup elsewhere; loop will pick a new branch.
        effectiveSessionId = randomUUID();
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

  /**
   * Remove a worktree and immediately run `git worktree prune` so that any
   * stale administrative directories left behind after a forced removal (or a
   * crash) are reaped. Safe to call when the worktree no longer exists on
   * disk — `prune` still runs.
   */
  async removeAndPrune(repoRoot: string, worktreePath: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      try {
        await worktreeRemove(repoRoot, worktreePath);
      } catch {
        /* fallthrough — prune still runs below */
      }
    }
    await worktreePruneRepo(repoRoot);
  }
}
