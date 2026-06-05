// v1.5.5-A — Unit tests for WorktreePool.create with the new sessionId parameter.
//
// We mock worktreeAdd (the actual git I/O) and fs.existsSync so no filesystem
// or git state is required. The test asserts:
//   1. The returned sessionId matches the input sessionId.
//   2. The worktree path ends with the first 8 hex chars of the sessionId.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock git-ops so worktreeAdd is a no-op.
vi.mock('./git-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-ops')>();
  return {
    ...actual,
    worktreeAdd: vi.fn(async () => undefined),
    worktreePruneRepo: vi.fn(async () => undefined),
  };
});

// Mock fs.existsSync so there are no collisions in tests.
import fs from 'node:fs';
vi.spyOn(fs, 'existsSync').mockReturnValue(false);
vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

import { WorktreePool, WorktreeDiskGuardError } from './worktree';
import { worktreeAdd } from './git-ops';

describe('WorktreePool.create — v1.5.5-A sessionId contract', () => {
  const REPO_ROOT = '/fake/repo';
  const BASE_DIR = '/fake/worktrees';
  let pool: WorktreePool;

  beforeEach(() => {
    pool = new WorktreePool({ baseDir: BASE_DIR });
    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the input sessionId unchanged when no collision occurs', async () => {
    const sessionId = 'aabbccdd-1122-4334-8556-778899aabbcc';
    const result = await pool.create({
      repoRoot: REPO_ROOT,
      role: 'claude',
      hint: 'pane-0',
      sessionId,
    });

    expect(result.sessionId).toBe(sessionId);
  });

  it('worktree path ends with the first 8 hex chars of the sessionId', async () => {
    const sessionId = 'aabbccdd-1122-4334-8556-778899aabbcc';
    // Strip dashes, first 8 chars: 'aabbccdd'
    const expectedSuffix = 'aabbccdd';

    const result = await pool.create({
      repoRoot: REPO_ROOT,
      role: 'claude',
      hint: 'pane-0',
      sessionId,
    });

    expect(result.worktreePath.endsWith(expectedSuffix)).toBe(true);
  });

  it('generates a random sessionId when none is provided', async () => {
    const result = await pool.create({
      repoRoot: REPO_ROOT,
      role: 'gemini',
      hint: 'pane-1',
    });

    // A random UUID was generated internally — result must have one.
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
    // Branch and worktreePath are present.
    expect(result.branch.startsWith('sigmalink/')).toBe(true);
    expect(result.worktreePath.length).toBeGreaterThan(0);
  });

  it('regenerates sessionId on collision and returns the new one', async () => {
    // First call to existsSync returns true (collision), then false (success).
    let callCount = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation(() => {
      callCount += 1;
      return callCount === 1; // collision on first attempt
    });

    const inputSessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const result = await pool.create({
      repoRoot: REPO_ROOT,
      role: 'claude',
      hint: 'pane-0',
      sessionId: inputSessionId,
    });

    // The pool regenerated a new UUID after collision, so returned id differs.
    expect(result.sessionId).not.toBe(inputSessionId);
    // But it's still a non-empty string.
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Lane A — disk-pressure + count guard in WorktreePool.create.
//
// These guards run at the TOP of create() so a refused create leaves NOTHING
// on disk. We mock fs.promises.readdir (pool-dir entry count) and
// fs.promises.statfs (free-space probe) to drive the guard decisions.
// ---------------------------------------------------------------------------

const GiB = 1024 ** 3;

function mockStatfs(freeBytes: number) {
  // statfs free bytes = bavail * bsize. Pick bsize=4096 and derive bavail.
  const bsize = 4096;
  const bavail = Math.ceil(freeBytes / bsize);
  return vi
    .spyOn(fs.promises, 'statfs')
    .mockResolvedValue({ bavail, bsize } as unknown as import('node:fs').StatsFs);
}

function mockReaddirEntries(count: number) {
  const entries = Array.from({ length: count }, (_, i) => `pane-${i}`);
  return vi
    .spyOn(fs.promises, 'readdir')
    .mockResolvedValue(entries as unknown as never);
}

describe('WorktreePool.create — Lane A disk-pressure + count guard', () => {
  const REPO_ROOT = '/fake/repo';
  const BASE_DIR = '/fake/worktrees';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('WorktreeDiskGuardError is a subclass of Error with a code', () => {
    const err = new WorktreeDiskGuardError('WORKTREE_CAP', 'too many');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('WORKTREE_CAP');
    expect(err.name).toBe('WorktreeDiskGuardError');
    expect(err.message).toContain('too many');
  });

  it('proceeds normally when under cap and above floor', async () => {
    mockReaddirEntries(3); // well under cap
    mockStatfs(100 * GiB); // well above floor
    const pool = new WorktreePool({ baseDir: BASE_DIR });

    const result = await pool.create({ repoRoot: REPO_ROOT, role: 'claude', hint: 'pane-0' });

    expect(result.worktreePath.length).toBeGreaterThan(0);
    expect(worktreeAdd).toHaveBeenCalledTimes(1);
  });

  it('refuses with WORKTREE_CAP when pool dir already has >= cap entries', async () => {
    mockReaddirEntries(5); // at cap
    mockStatfs(100 * GiB); // floor is fine
    const pool = new WorktreePool({ baseDir: BASE_DIR, maxWorktreesPerRepo: 5 });

    await expect(
      pool.create({ repoRoot: REPO_ROOT, role: 'claude', hint: 'pane-0' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CAP' });

    // Refused BEFORE any git/mkdir.
    expect(worktreeAdd).not.toHaveBeenCalled();
  });

  it('cap message includes the count and the cap', async () => {
    mockReaddirEntries(7);
    mockStatfs(100 * GiB);
    const pool = new WorktreePool({ baseDir: BASE_DIR, maxWorktreesPerRepo: 5 });

    await expect(
      pool.create({ repoRoot: REPO_ROOT, role: 'claude' }),
    ).rejects.toThrow(/7.*5|5.*7/);
  });

  it('counts 0 when the pool dir does not exist (readdir ENOENT) — proceeds', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mockStatfs(100 * GiB);
    const pool = new WorktreePool({ baseDir: BASE_DIR, maxWorktreesPerRepo: 5 });

    const result = await pool.create({ repoRoot: REPO_ROOT, role: 'claude' });
    expect(result.worktreePath.length).toBeGreaterThan(0);
    expect(worktreeAdd).toHaveBeenCalledTimes(1);
  });

  it('refuses with DISK_FLOOR when free space is below the floor', async () => {
    mockReaddirEntries(0); // cap fine
    mockStatfs(1 * GiB); // below the 2 GiB default floor
    const pool = new WorktreePool({ baseDir: BASE_DIR });

    await expect(
      pool.create({ repoRoot: REPO_ROOT, role: 'claude' }),
    ).rejects.toMatchObject({ code: 'DISK_FLOOR' });

    expect(worktreeAdd).not.toHaveBeenCalled();
  });

  it('disk-floor message includes free GB and floor GB', async () => {
    mockReaddirEntries(0);
    mockStatfs(0.5 * GiB);
    const pool = new WorktreePool({ baseDir: BASE_DIR, minFreeDiskBytes: 2 * GiB });

    await expect(pool.create({ repoRoot: REPO_ROOT, role: 'claude' })).rejects.toThrow(/GB/);
  });

  it('honors a custom minFreeDiskBytes floor', async () => {
    mockReaddirEntries(0);
    mockStatfs(5 * GiB); // above default 2 GiB but below custom 10 GiB
    const pool = new WorktreePool({ baseDir: BASE_DIR, minFreeDiskBytes: 10 * GiB });

    await expect(
      pool.create({ repoRoot: REPO_ROOT, role: 'claude' }),
    ).rejects.toMatchObject({ code: 'DISK_FLOOR' });
  });

  it('skips the disk-floor check gracefully when statfs fails entirely', async () => {
    mockReaddirEntries(0);
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const pool = new WorktreePool({ baseDir: BASE_DIR });

    // Cannot probe disk → do not block the create.
    const result = await pool.create({ repoRoot: REPO_ROOT, role: 'claude' });
    expect(result.worktreePath.length).toBeGreaterThan(0);
    expect(worktreeAdd).toHaveBeenCalledTimes(1);
  });

  it('checks the cap BEFORE the disk floor (cap wins when both fail)', async () => {
    mockReaddirEntries(50); // over cap
    mockStatfs(0.1 * GiB); // also below floor
    const pool = new WorktreePool({ baseDir: BASE_DIR, maxWorktreesPerRepo: 40 });

    await expect(
      pool.create({ repoRoot: REPO_ROOT, role: 'claude' }),
    ).rejects.toMatchObject({ code: 'WORKTREE_CAP' });
  });
});
