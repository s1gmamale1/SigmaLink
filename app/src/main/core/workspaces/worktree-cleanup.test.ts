import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { cleanupOrphanWorktrees, sweepAllReposOnBoot } from './worktree-cleanup';

// ---------------------------------------------------------------------------
// Mock node:fs/promises so we don't touch the real filesystem.
//
// readdirMock receives the real args so path-aware tests (the boot-sweep)
// can return different entries per path. The existing cleanup tests use
// `mockResolvedValue`, which ignores args, so they are unaffected.
// ---------------------------------------------------------------------------

const readdirMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const rmMock = vi.fn<() => Promise<void>>();

vi.mock('node:fs', () => ({
  promises: {
    readdir: (...args: unknown[]) => readdirMock(...args),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    rm: (..._args: unknown[]) => rmMock(),
  },
}));

// ---------------------------------------------------------------------------
// Minimal better-sqlite3-like mock DB.
// ---------------------------------------------------------------------------

interface SessionRow {
  worktree_path: string;
  status: string;
  exited_at: number | null;
}

function makeDb(sessions: SessionRow[]) {
  const db = {
    prepare(sql: string) {
      const isLive = sql.includes("status = 'running' OR exited_at");
      const isAny = sql.includes('SELECT COUNT(*)');

      if (isLive) {
        return {
          all(pattern: string, cutoff: number) {
            // Strip trailing glob % and sep for path prefix matching.
            const prefix = pattern.slice(0, -1); // remove trailing %
            const results = sessions.filter((s) => {
              if (!s.worktree_path.startsWith(prefix)) return false;
              if (s.status === 'running') return true;
              if (s.exited_at !== null && s.exited_at > cutoff) return true;
              return false;
            });
            return results.map((s) => ({ worktree_path: s.worktree_path }));
          },
        };
      }

      if (isAny) {
        return {
          get(pattern: string) {
            const prefix = pattern.slice(0, -1);
            const cnt = sessions.filter((s) => s.worktree_path?.startsWith(prefix)).length;
            return { cnt };
          },
        };
      }

      throw new Error(`Unhandled SQL in test: ${sql}`);
    },
  };
  return db as unknown as import('better-sqlite3').Database;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = '/userData/worktrees';
const HASH = 'abc123def456';
const REPO_DIR = path.join(BASE, HASH);
const NOW = Date.now();
const SEVEN_DAYS_MS = 7 * 86400 * 1000;

function recentlyExited(): number {
  return NOW - 1000; // 1 second ago — within 7 days
}

function oldExited(): number {
  return NOW - SEVEN_DAYS_MS - 1000; // > 7 days ago
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  rmMock.mockResolvedValue(undefined);
});

describe('cleanupOrphanWorktrees', () => {
  it('1. No worktreeBase dir — returns {removed:0, kept:0, errors:0}; does not throw', async () => {
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const db = makeDb([]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result).toEqual({ removed: 0, kept: 0, errors: 0 });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('2. Empty repoDir — returns {removed:0, kept:0, errors:0}', async () => {
    readdirMock.mockResolvedValue([]);
    const db = makeDb([]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result).toEqual({ removed: 0, kept: 0, errors: 0 });
  });

  it('3. No agent_sessions rows reference this repo (cold install) — skips cleanup; returns kept=N', async () => {
    readdirMock.mockResolvedValue(['dir-a', 'dir-b', 'dir-c']);
    const db = makeDb([]); // no sessions at all
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    // Cold install guard: no rows → skip, return kept = number of dirs
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.kept).toBe(3);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('4. All dirs referenced by running sessions — removed=0, kept=N, errors=0', async () => {
    readdirMock.mockResolvedValue(['pane-0', 'pane-1']);
    const db = makeDb([
      { worktree_path: path.join(REPO_DIR, 'pane-0'), status: 'running', exited_at: null },
      { worktree_path: path.join(REPO_DIR, 'pane-1'), status: 'running', exited_at: null },
    ]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result).toEqual({ removed: 0, kept: 2, errors: 0 });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('5. Mix referenced + orphan — orphans removed, referenced kept', async () => {
    readdirMock.mockResolvedValue(['live-pane', 'orphan-1', 'orphan-2']);
    const db = makeDb([
      { worktree_path: path.join(REPO_DIR, 'live-pane'), status: 'running', exited_at: null },
      // Rows for orphan dirs don't exist in DB (or are old enough to GC).
      // But we need at least one row so the cold-install guard doesn't fire.
    ]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.errors).toBe(0);
    expect(rmMock).toHaveBeenCalledTimes(2);
  });

  it('6. Orphan removal failure (permission denied etc.) — logged + counted as error; does not throw', async () => {
    readdirMock.mockResolvedValue(['orphan-perm-fail']);
    rmMock.mockRejectedValue(new Error('EACCES: permission denied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = makeDb([
      // One running session so cold-install guard is bypassed.
      { worktree_path: path.join(REPO_DIR, 'some-other-pane'), status: 'running', exited_at: null },
    ]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result.errors).toBe(1);
    expect(result.removed).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('7. Recently-exited sessions (within 7 days) are kept — R-04-2', async () => {
    readdirMock.mockResolvedValue(['recently-exited-pane', 'old-exited-pane']);
    const db = makeDb([
      {
        worktree_path: path.join(REPO_DIR, 'recently-exited-pane'),
        status: 'exited',
        exited_at: recentlyExited(),
      },
      {
        worktree_path: path.join(REPO_DIR, 'old-exited-pane'),
        status: 'exited',
        exited_at: oldExited(),
      },
    ]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    // recently-exited stays, old-exited gets removed
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('8. LIKE pattern matches subdirs but not unrelated repos — SQL safety', async () => {
    const hashA = 'aaaaaa000000';
    const hashB = 'bbbbbb000000';
    readdirMock.mockResolvedValue(['pane-x']);

    // Sessions only for hashB
    const sessionForB = {
      worktree_path: path.join(BASE, hashB, 'pane-x'),
      status: 'running',
      exited_at: null,
    };
    const db = makeDb([sessionForB]);

    // Cleanup for hashA should not find any matching rows → cold-install skip.
    const result = await cleanupOrphanWorktrees(BASE, hashA, db);
    // No sessions for hashA → cold install guard fires → kept=1, removed=0
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lane A — boot-time all-repo sweep.
//
// sweepAllReposOnBoot reads <worktreeBase> for repoHash dirs, then runs the
// existing per-repo cleanup against EACH, aggregating totals. This is what
// reaps leaked worktrees across every repo at boot (not just the one being
// opened).
//
// We drive a PATH-AWARE readdir mock:
//   - readdir(<base>, {withFileTypes}) → Dirent[] (the repoHash dirs)
//   - readdir(<base>/<hash>)           → string[] (worktree entries)
// ---------------------------------------------------------------------------

function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}

/**
 * Wire up a path-aware readdir:
 *  - baseEntries: Dirent-ish list returned for readdir(BASE, {withFileTypes})
 *  - perRepo: map of repoHash → string[] worktree entries for readdir(repoDir)
 */
function wireReaddir(
  base: string,
  baseEntries: ReturnType<typeof dirent>[],
  perRepo: Record<string, string[]>,
) {
  readdirMock.mockImplementation(async (target: unknown, opts?: unknown) => {
    const p = path.normalize(String(target));
    if (p === path.normalize(base)) {
      // withFileTypes path → Dirents
      if (opts && typeof opts === 'object' && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return baseEntries;
      }
      return baseEntries.map((e) => e.name);
    }
    // per-repo readdir → worktree entry names
    const hash = path.basename(p);
    return perRepo[hash] ?? [];
  });
}

describe('sweepAllReposOnBoot', () => {
  it('returns all-zeros when worktreeBase does not exist; never throws', async () => {
    readdirMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const db = makeDb([]);
    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result).toEqual({ repos: 0, removed: 0, kept: 0, errors: 0 });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('iterates multiple repoHash dirs and aggregates removed/kept', async () => {
    const hashA = 'aaaaaa000000';
    const hashB = 'bbbbbb000000';
    // repoA: 1 live pane + 2 orphans → removed=2, kept=1
    // repoB: 1 live pane              → removed=0, kept=1
    wireReaddir(
      BASE,
      [dirent(hashA, true), dirent(hashB, true)],
      {
        [hashA]: ['live-a', 'orphan-1', 'orphan-2'],
        [hashB]: ['live-b'],
      },
    );
    const db = makeDb([
      { worktree_path: path.join(BASE, hashA, 'live-a'), status: 'running', exited_at: null },
      { worktree_path: path.join(BASE, hashB, 'live-b'), status: 'running', exited_at: null },
    ]);

    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result.repos).toBe(2);
    expect(result.removed).toBe(2); // both orphans in repoA
    expect(result.kept).toBe(2); // live-a + live-b
    expect(result.errors).toBe(0);
    expect(rmMock).toHaveBeenCalledTimes(2);
  });

  it('skips non-directory entries under the base', async () => {
    const hashA = 'aaaaaa000000';
    wireReaddir(
      BASE,
      [dirent(hashA, true), dirent('stray-file.txt', false)],
      { [hashA]: ['live-a', 'orphan-1'] },
    );
    const db = makeDb([
      { worktree_path: path.join(BASE, hashA, 'live-a'), status: 'running', exited_at: null },
    ]);

    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result.repos).toBe(1); // only the dir counted
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1);
  });

  it('an rm error in one repo does not abort the others; counts errors', async () => {
    const hashA = 'aaaaaa000000';
    const hashB = 'bbbbbb000000';
    wireReaddir(
      BASE,
      [dirent(hashA, true), dirent(hashB, true)],
      {
        [hashA]: ['live-a', 'orphan-a'],
        [hashB]: ['live-b', 'orphan-b'],
      },
    );
    // First rm (repoA orphan) fails; second (repoB orphan) succeeds.
    rmMock
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = makeDb([
      { worktree_path: path.join(BASE, hashA, 'live-a'), status: 'running', exited_at: null },
      { worktree_path: path.join(BASE, hashB, 'live-b'), status: 'running', exited_at: null },
    ]);

    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result.repos).toBe(2);
    // repoB orphan removed, repoA orphan errored.
    expect(result.removed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.kept).toBe(2);
    warnSpy.mockRestore();
  });

  it('aggregates kept across repos and returns zeros for an empty base', async () => {
    wireReaddir(BASE, [], {});
    const db = makeDb([]);
    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result).toEqual({ repos: 0, removed: 0, kept: 0, errors: 0 });
  });

  it('does not throw if reading the base itself fails for non-ENOENT reasons', async () => {
    readdirMock.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const db = makeDb([]);
    const result = await sweepAllReposOnBoot(BASE, db);
    expect(result).toEqual({ repos: 0, removed: 0, kept: 0, errors: 0 });
  });
});
