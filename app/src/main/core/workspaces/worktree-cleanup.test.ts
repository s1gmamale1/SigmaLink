import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupOrphanWorktrees,
  sweepAllReposOnBoot,
  isWorktreeKeepEligible,
  collectKeptWorktreePaths,
  WORKTREE_KEEP_WINDOW_MS,
} from './worktree-cleanup';
import { canonicalPathKey } from '../util/path-key';

// ---------------------------------------------------------------------------
// Mock node:fs/promises so we don't touch the real filesystem.
//
// readdirMock receives the real args so path-aware tests (the boot-sweep)
// can return different entries per path. The existing cleanup tests use
// `mockResolvedValue`, which ignores args, so they are unaffected.
// ---------------------------------------------------------------------------

const readdirMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const rmMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const statfsMock = vi.fn<(...args: unknown[]) => Promise<{ bavail: number; bsize: number }>>();

vi.mock('node:fs', () => ({
  promises: {
    readdir: (...args: unknown[]) => readdirMock(...args),
    rm: (...args: unknown[]) => rmMock(...args),
    statfs: (...args: unknown[]) => statfsMock(...args),
  },
}));

// ---------------------------------------------------------------------------
// Minimal better-sqlite3-like mock DB.
// ---------------------------------------------------------------------------

interface SessionRow {
  id?: string;
  workspace_id?: string;
  worktree_path: string;
  status: string;
  exit_code?: number | null;
  exited_at: number | null;
}

function makeDb(sessions: SessionRow[]) {
  const db = {
    prepare(sql: string) {
      if (sql.includes('FROM agent_sessions') && sql.includes('worktree_path IS NOT NULL')) {
        return {
          all() {
            return sessions.map((s, i) => ({
              id: s.id ?? `sess-${i}`,
              workspace_id: s.workspace_id ?? 'ws-test',
              status: s.status,
              exit_code: s.exit_code ?? null,
              exited_at: s.exited_at,
              worktree_path: s.worktree_path,
            }));
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

// Dirent-ish factory — cleanupOrphanWorktrees and sweepAllReposOnBoot both
// read with { withFileTypes: true } now.
function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}
const dirents = (...names: string[]) => names.map((n) => dirent(n, true));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  rmMock.mockResolvedValue(undefined);
  // C7: default statfs returns a non-NaN free-disk value (100 GiB).
  statfsMock.mockResolvedValue({ bavail: 100 * 1024, bsize: 1024 * 1024 });
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
    readdirMock.mockResolvedValue(dirents('dir-a', 'dir-b', 'dir-c'));
    const db = makeDb([]); // no sessions at all
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    // Cold install guard: no rows → skip, return kept = number of dirs
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.kept).toBe(3);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('4. All dirs referenced by running sessions — removed=0, kept=N, errors=0', async () => {
    readdirMock.mockResolvedValue(dirents('pane-0', 'pane-1'));
    const db = makeDb([
      { worktree_path: path.join(REPO_DIR, 'pane-0'), status: 'running', exited_at: null },
      { worktree_path: path.join(REPO_DIR, 'pane-1'), status: 'running', exited_at: null },
    ]);
    const result = await cleanupOrphanWorktrees(BASE, HASH, db);
    expect(result).toEqual({ removed: 0, kept: 2, errors: 0 });
    expect(rmMock).not.toHaveBeenCalled();
  });

  it('5. Mix referenced + orphan — orphans removed, referenced kept', async () => {
    readdirMock.mockResolvedValue(dirents('live-pane', 'orphan-1', 'orphan-2'));
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
    readdirMock.mockResolvedValue(dirents('orphan-perm-fail'));
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
    readdirMock.mockResolvedValue(dirents('recently-exited-pane', 'old-exited-pane'));
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

  it('keeps exited/-1 worktrees because resume still treats those panes as eligible', async () => {
    readdirMock.mockResolvedValue(dirents('crashed-pane', 'old-clean-pane'));
    const db = makeDb([
      {
        worktree_path: path.join(REPO_DIR, 'crashed-pane'),
        status: 'exited',
        exit_code: -1,
        exited_at: oldExited(),
      },
      {
        worktree_path: path.join(REPO_DIR, 'old-clean-pane'),
        status: 'exited',
        exit_code: 0,
        exited_at: oldExited(),
      },
    ]);

    const result = await cleanupOrphanWorktrees(BASE, HASH, db);

    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(
      path.join(REPO_DIR, 'old-clean-pane'),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('keeps starting worktrees if cleanup runs after a janitor miss', async () => {
    readdirMock.mockResolvedValue(dirents('starting-pane', 'orphan-pane'));
    const db = makeDb([
      {
        worktree_path: path.join(REPO_DIR, 'starting-pane'),
        status: 'starting',
        exit_code: null,
        exited_at: null,
      },
    ]);

    const result = await cleanupOrphanWorktrees(BASE, HASH, db);

    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('win32: keeps a live worktree when DB path case/separators differ from fs path', async () => {
    const base = 'C:\\Users\\Me\\AppData\\Roaming\\SigmaLink\\worktrees';
    const hash = 'abc123def456';
    readdirMock.mockResolvedValue(dirents('Pane-0', 'orphan-pane'));
    const db = makeDb([
      {
        worktree_path: 'c:/users/me/appdata/roaming/sigmalink/worktrees/ABC123DEF456/pane-0',
        status: 'running',
        exited_at: null,
      },
    ]);

    const result = await cleanupOrphanWorktrees(base, hash, db);

    expect(result.kept).toBe(1);
    expect(result.removed).toBe(1);
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(String(rmMock.mock.calls[0]![0])).toContain('orphan-pane');
  });

  it('8. LIKE pattern matches subdirs but not unrelated repos — SQL safety', async () => {
    const hashA = 'aaaaaa000000';
    const hashB = 'bbbbbb000000';
    readdirMock.mockResolvedValue(dirents('pane-x'));

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

  it('never removes a stray FILE in the repoDir — dirs only (2026-06-10 audit, finding 3)', async () => {
    readdirMock.mockResolvedValue([dirent('stray-file.txt', false), dirent('orphan-dir', true)]);
    const db = makeDb([
      // One running session elsewhere in this repo so the cold-install guard is bypassed.
      { worktree_path: path.join(REPO_DIR, 'some-other-pane'), status: 'running', exited_at: null },
    ]);

    const result = await cleanupOrphanWorktrees(BASE, HASH, db);

    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(String(rmMock.mock.calls[0]![0])).toContain('orphan-dir');
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(1); // the stray file is counted as kept, never touched
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
    // per-repo readdir → Dirent-ish worktree entries (all dirs)
    const hash = path.basename(p);
    return (perRepo[hash] ?? []).map((n) => dirent(n, true));
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

  it('keeps resume-eligible crashed panes during boot sweep even after the 7-day window', async () => {
    const hashA = 'aaaaaa000000';
    wireReaddir(BASE, [dirent(hashA, true)], {
      [hashA]: ['crashed-pane', 'old-clean-pane'],
    });
    const db = makeDb([
      {
        worktree_path: path.join(BASE, hashA, 'crashed-pane'),
        status: 'exited',
        exit_code: -1,
        exited_at: oldExited(),
      },
      {
        worktree_path: path.join(BASE, hashA, 'old-clean-pane'),
        status: 'exited',
        exit_code: 0,
        exited_at: oldExited(),
      },
    ]);

    const result = await sweepAllReposOnBoot(BASE, db);

    expect(result).toEqual({ repos: 1, removed: 1, kept: 1, errors: 0 });
    expect(rmMock).toHaveBeenCalledWith(
      path.join(BASE, hashA, 'old-clean-pane'),
      expect.objectContaining({ recursive: true, force: true }),
    );
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

  // C7 obs — boot-sweep must emit the structured log even on a clean (0-removed) sweep
  it('C7: always emits console.info with [worktree-cleanup] boot-sweep prefix even on clean sweep', async () => {
    wireReaddir(BASE, [], {});
    const db = makeDb([]);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await sweepAllReposOnBoot(BASE, db);
      const bootCalls = infoSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[worktree-cleanup] boot-sweep'),
      );
      expect(bootCalls.length).toBeGreaterThanOrEqual(1);
      // repos=0, removed=0, kept=0, errors=0 on an empty base
      const call = bootCalls[0]!;
      expect(call[1]).toBe(0); // repos
      expect(call[2]).toBe(0); // removed
      expect(call[3]).toBe(0); // kept
      expect(call[4]).toBe(0); // errors
      // freeGiB should be numeric (statfsMock returns 100 * 1024 * 1024 * 1024 bytes free)
      expect(typeof call[5]).toBe('number');
      expect(isNaN(call[5] as number)).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// keep ⊇ use invariant (2026-06-10 audit, finding 1).
//
// The reaper keep-set MUST be a superset of every consumer's use-set, or the
// reaper deletes worktrees a consumer is about to spawn into (the 93fbca6
// regression class; memory: feedback_reaper_keep_superset_of_use). The USE
// predicates below are direct transcriptions of resume-launcher.ts:
//   - listEligibleRows  (resume-launcher.ts:296-321):
//       status='running' OR (status='exited' AND exit_code=-1)
//   - listRespawnableRows (resume-launcher.ts:427-454):
//       status='exited' AND exit_code=-1
// The tripwire test below pins those source predicates: if resume-launcher
// changes them, the tripwire fails and BOTH the transcriptions here AND
// isWorktreeKeepEligible must be re-verified together.
// ---------------------------------------------------------------------------

describe('keep ⊇ use invariant — reaper keep-predicate covers every consumer', () => {
  type PredicateRow = { status: string; exit_code: number | null; exited_at: number | null };

  const resumeUses = (r: PredicateRow) =>
    r.status === 'running' || (r.status === 'exited' && r.exit_code === -1);
  const respawnUses = (r: PredicateRow) => r.status === 'exited' && r.exit_code === -1;

  const T0 = Date.now();
  const OLD = T0 - WORKTREE_KEEP_WINDOW_MS - 60_000;
  const statuses = ['starting', 'running', 'exited', 'error'];
  const exitCodes: Array<number | null> = [null, -1, 0, 1, 137];
  const exitedAts: Array<number | null> = [null, T0 - 1000, OLD];

  it('every row a resume/respawn consumer can use is keep-eligible (superset over the full matrix)', () => {
    for (const status of statuses) {
      for (const exit_code of exitCodes) {
        for (const exited_at of exitedAts) {
          const row: PredicateRow = { status, exit_code, exited_at };
          if (resumeUses(row) || respawnUses(row)) {
            expect(isWorktreeKeepEligible(row, T0), `use-eligible row must be kept: ${JSON.stringify(row)}`).toBe(true);
          }
        }
      }
    }
  });

  it('keep is strictly broader than use: starting and recent-exited rows are kept too', () => {
    expect(isWorktreeKeepEligible({ status: 'starting', exit_code: null, exited_at: null }, T0)).toBe(true);
    expect(isWorktreeKeepEligible({ status: 'exited', exit_code: 0, exited_at: T0 - 1000 }, T0)).toBe(true);
    // …while a clean old exit is reapable:
    expect(isWorktreeKeepEligible({ status: 'exited', exit_code: 0, exited_at: OLD }, T0)).toBe(false);
  });

  it('tripwire: resume-launcher.ts still uses exactly the transcribed use-predicates', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const src = realFs.readFileSync(
      fileURLToPath(new URL('../pty/resume-launcher.ts', import.meta.url)),
      'utf8',
    );
    // listEligibleRows + listRespawnableRows predicate fragments:
    expect(src).toContain("s.status = 'running'");
    expect(src).toContain("s.exit_code = -1");
    // If this fails: resume-launcher's use-predicate changed. Update the
    // transcriptions in this file AND verify isWorktreeKeepEligible still
    // covers the new predicate before changing these assertions.
  });

  it('collectKeptWorktreePaths returns canonical keys and honors excludeSessionIds', () => {
    const a = path.join(REPO_DIR, 'pane-a');
    const b = path.join(REPO_DIR, 'pane-b');
    const db = makeDb([
      { id: 's-live', worktree_path: a, status: 'running', exited_at: null },
      { id: 's-crash', worktree_path: b, status: 'exited', exit_code: -1, exited_at: oldExited() },
    ]);

    const keepAll = collectKeptWorktreePaths(db);
    expect(keepAll.has(canonicalPathKey(a))).toBe(true);
    expect(keepAll.has(canonicalPathKey(b))).toBe(true);

    // Rows about to be deleted by a caller are excluded from the fence:
    const keepMinus = collectKeptWorktreePaths(db, { excludeSessionIds: new Set(['s-crash']) });
    expect(keepMinus.has(canonicalPathKey(a))).toBe(true);
    expect(keepMinus.has(canonicalPathKey(b))).toBe(false);
  });
});
