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
  /**
   * Lane A — hard cap on the number of worktree dirs allowed per repo. When the
   * pool dir already holds this many entries, `create` refuses with a
   * WorktreeDiskGuardError('WORKTREE_CAP') BEFORE touching disk. Defaults to 40
   * (≈ 2× the 20 max-swarm-agents) so a spawn-retry loop physically cannot
   * fan out into thousands of worktrees.
   */
  maxWorktreesPerRepo?: number;
  /**
   * Lane A — minimum free bytes that must remain on the volume backing
   * `baseDir` for a `create` to proceed. When free space drops below this floor
   * `create` refuses with a WorktreeDiskGuardError('DISK_FLOOR') BEFORE touching
   * disk. Defaults to 2 GiB.
   */
  minFreeDiskBytes?: number;
}

/** Default per-repo worktree cap (≈ 2× the 20 max-swarm-agents). */
export const DEFAULT_MAX_WORKTREES_PER_REPO = 40;
/** Default free-disk floor below which new worktrees are refused (2 GiB). */
export const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;

export type WorktreeDiskGuardCode = 'WORKTREE_CAP' | 'DISK_FLOOR';

/**
 * Lane A — typed error thrown by WorktreePool.create when a defense-in-depth
 * guard refuses a create. Distinguishable from real git/fs failures by its
 * `code` so callers can surface a clear "disk guard" message rather than a
 * confusing low-level error. Refused creates leave NOTHING on disk.
 */
export class WorktreeDiskGuardError extends Error {
  readonly code: WorktreeDiskGuardCode;
  constructor(code: WorktreeDiskGuardCode, message: string) {
    super(message);
    this.name = 'WorktreeDiskGuardError';
    this.code = code;
  }
}

export class WorktreePool {
  private readonly opts: WorktreePoolOptions;
  private readonly maxWorktreesPerRepo: number;
  private readonly minFreeDiskBytes: number;
  constructor(opts: WorktreePoolOptions) {
    this.opts = opts;
    this.maxWorktreesPerRepo = opts.maxWorktreesPerRepo ?? DEFAULT_MAX_WORKTREES_PER_REPO;
    this.minFreeDiskBytes = opts.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
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
    // Lane A — defense-in-depth guards. Both run BEFORE the retry loop (i.e.
    // before any mkdir / `git worktree add`), so a refused create leaves
    // NOTHING on disk. The disk physically cannot fill via a spawn-retry loop.
    const count = await this.assertUnderCap(input.repoRoot);
    const freeBytes = await this.assertAboveDiskFloor();
    const GiB = 1024 ** 3;
    const repoHashStr = repoHash(input.repoRoot);
    // C5 obs — always log the guard decision state (count/cap/free/floor) at the
    // create site so a future disk runaway leaves a clear breadcrumb.
    console.info(
      '[worktree] create ws=%s repo=%s count=%d cap=%d freeGiB=%.2f floorGiB=%.2f',
      input.sessionId ?? '?',
      repoHashStr,
      count,
      this.maxWorktreesPerRepo,
      freeBytes !== null ? freeBytes / GiB : NaN,
      this.minFreeDiskBytes / GiB,
    );

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

  /**
   * Lane A — count cap. Counts entries currently in the repo's pool dir. A
   * missing dir counts as 0 (nothing created yet). Throws
   * WorktreeDiskGuardError('WORKTREE_CAP') when the count is at/over the cap.
   * Returns the current count (for observability logging).
   */
  private async assertUnderCap(repoRoot: string): Promise<number> {
    const poolDir = this.poolPathForRepo(repoRoot);
    let count = 0;
    try {
      const entries = await fs.promises.readdir(poolDir);
      count = entries.length;
    } catch {
      // Pool dir doesn't exist yet (or is unreadable) → count is 0.
      count = 0;
    }
    if (count >= this.maxWorktreesPerRepo) {
      throw new WorktreeDiskGuardError(
        'WORKTREE_CAP',
        `worktree cap reached for repo: ${count} existing worktrees >= cap ${this.maxWorktreesPerRepo} ` +
          `(in ${poolDir}). Refusing to create another to prevent disk exhaustion.`,
      );
    }
    return count;
  }

  /**
   * Lane A — disk floor. Probes free space on the volume backing `baseDir`
   * (or its nearest existing ancestor when baseDir itself does not yet exist).
   * Throws WorktreeDiskGuardError('DISK_FLOOR') when free bytes < the floor. If
   * the probe cannot run at all (no statfs / no resolvable ancestor), the check
   * is skipped gracefully — we never block a create on an un-probable volume.
   * Returns the free bytes (or null when unable to probe).
   */
  private async assertAboveDiskFloor(): Promise<number | null> {
    const free = await this.freeBytesForBase();
    if (free === null) return null; // could not probe → skip gracefully
    if (free < this.minFreeDiskBytes) {
      const freeGb = (free / 1024 ** 3).toFixed(2);
      const floorGb = (this.minFreeDiskBytes / 1024 ** 3).toFixed(2);
      throw new WorktreeDiskGuardError(
        'DISK_FLOOR',
        `disk floor reached: ${freeGb} GB free < ${floorGb} GB required on the volume ` +
          `backing ${this.opts.baseDir}. Refusing to create a worktree to prevent disk exhaustion.`,
      );
    }
    return free;
  }

  /**
   * Free bytes (bavail * bsize) on the volume backing `baseDir`. When `baseDir`
   * does not exist yet, walks up to the nearest existing ancestor and probes
   * that (same volume in practice). Returns null when no probe is possible.
   */
  private async freeBytesForBase(): Promise<number | null> {
    if (typeof fs.promises.statfs !== 'function') return null;
    let dir = path.resolve(this.opts.baseDir);
    // Walk up at most a bounded number of levels to find an existing dir.
    for (let i = 0; i < 64; i++) {
      try {
        const s = await fs.promises.statfs(dir);
        return s.bavail * s.bsize;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return null; // reached filesystem root, give up
        dir = parent;
      }
    }
    return null;
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
