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

import { WorktreePool } from './worktree';

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
