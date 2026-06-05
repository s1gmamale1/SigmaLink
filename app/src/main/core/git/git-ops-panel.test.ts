// BSP-G2 — Unit tests for the Git panel backend functions.
// All tests mock `execCmd` and `fs.existsSync` so no real git process is spawned.
// Mirrors the mock pattern in `git-ops-diff.test.ts` (the established working pattern).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks must be declared before importing the tested module.

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));

import fs from 'node:fs';
import { execCmd } from '../../lib/exec';
import {
  gitDiffStaged,
  gitDiffUnstaged,
  gitLog,
  listBranches,
  switchBranch,
} from './git-ops';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecCmd = execCmd as any as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExistsSync = (fs as any as { existsSync: ReturnType<typeof vi.fn> }).existsSync;

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  maxBufferExceeded: boolean;
};

function ok(stdout = '', stderr = ''): ExecResult {
  return { stdout, stderr, code: 0, maxBufferExceeded: false };
}

function fail(stderr = 'error', code = 1): ExecResult {
  return { stdout: '', stderr, code, maxBufferExceeded: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(true);
});

// --- gitDiffStaged -------------------------------------------------------

describe('gitDiffStaged', () => {
  it('returns null when path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await gitDiffStaged('/no/repo')).toBeNull();
  });

  it('returns null when not a git repo (rev-parse fails)', async () => {
    mockExecCmd.mockResolvedValueOnce(fail('not a git repo'));
    expect(await gitDiffStaged('/some/path')).toBeNull();
  });

  it('returns GitDiff with staged patches', async () => {
    // getRepoRoot → rev-parse --show-toplevel
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    // git diff --cached --stat
    mockExecCmd.mockResolvedValueOnce(ok('1 file changed'));
    // git diff --cached --no-color
    mockExecCmd.mockResolvedValueOnce(ok('diff --git a/foo.ts b/foo.ts\n+added'));

    const result = await gitDiffStaged('/repo');
    expect(result).not.toBeNull();
    expect(result!.patches).toContain('+added');
    expect(result!.stat).toBe('1 file changed');
    expect(result!.untrackedFiles).toEqual([]);
    expect(result!.truncated).toBe(false);
  });

  it('marks truncated when maxBufferExceeded', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    mockExecCmd.mockResolvedValueOnce(ok('stat'));
    mockExecCmd.mockResolvedValueOnce({ stdout: 'x', stderr: '', code: 0, maxBufferExceeded: true });

    const result = await gitDiffStaged('/repo');
    expect(result!.truncated).toBe(true);
  });
});

// --- gitDiffUnstaged -----------------------------------------------------

describe('gitDiffUnstaged', () => {
  it('returns null when path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await gitDiffUnstaged('/no/repo')).toBeNull();
  });

  it('returns GitDiff with unstaged patches', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    mockExecCmd.mockResolvedValueOnce(ok('1 file changed'));
    mockExecCmd.mockResolvedValueOnce(ok('diff --git a/bar.ts b/bar.ts\n-removed'));

    const result = await gitDiffUnstaged('/repo');
    expect(result).not.toBeNull();
    expect(result!.patches).toContain('-removed');
    expect(result!.untrackedFiles).toEqual([]);
  });
});

// --- gitLog --------------------------------------------------------------

describe('gitLog', () => {
  it('returns empty array when path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await gitLog('/no/repo')).toEqual([]);
  });

  it('returns empty array when not a git repo', async () => {
    mockExecCmd.mockResolvedValueOnce(fail());
    expect(await gitLog('/repo')).toEqual([]);
  });

  it('parses NUL-delimited log output into GitLogEntry[]', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo')); // getRepoRoot
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const line = [sha, 'a1b2c3d', 'Fix typo', 'Alice', '2 hours ago', 'HEAD -> main'].join('\x00');
    mockExecCmd.mockResolvedValueOnce(ok(line));

    const result = await gitLog('/repo', 10);
    expect(result).toHaveLength(1);
    expect(result[0].sha).toBe(sha);
    expect(result[0].shortSha).toBe('a1b2c3d');
    expect(result[0].subject).toBe('Fix typo');
    expect(result[0].author).toBe('Alice');
    expect(result[0].relDate).toBe('2 hours ago');
    expect(result[0].refs).toBe('HEAD -> main');
  });

  it('clamps limit to 500', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    mockExecCmd.mockResolvedValueOnce(ok(''));

    await gitLog('/repo', 9999);
    // The second call (git log) should use -n 500.
    const [, args] = mockExecCmd.mock.calls[1] as [string, string[]];
    const nIdx = args.indexOf('-n');
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(args[nIdx + 1]).toBe('500');
  });

  it('skips malformed lines (fewer than 6 NUL-separated fields)', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    // Only 3 fields (needs 6)
    mockExecCmd.mockResolvedValueOnce(ok('sha\x00short\x00subject'));

    expect(await gitLog('/repo')).toEqual([]);
  });
});

// --- listBranches --------------------------------------------------------

describe('listBranches', () => {
  it('returns empty list when path not found', async () => {
    mockExistsSync.mockReturnValue(false);
    const r = await listBranches('/no/repo');
    expect(r.branches).toEqual([]);
    expect(r.current).toBe('');
  });

  it('parses branch list with current marker', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo')); // rev-parse
    const output = [
      '*\x00main\x00origin/main',
      ' \x00feature/foo\x00',
    ].join('\n');
    mockExecCmd.mockResolvedValueOnce(ok(output));

    const r = await listBranches('/repo');
    expect(r.current).toBe('main');
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toMatchObject({ name: 'main', current: true, upstream: 'origin/main' });
    expect(r.branches[1]).toMatchObject({ name: 'feature/foo', current: false });
    expect(r.branches[1].upstream).toBeUndefined();
  });
});

// --- switchBranch --------------------------------------------------------

describe('switchBranch', () => {
  it('refuses a branch name starting with -', async () => {
    const r = await switchBranch('/repo', '-x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid/);
  });

  it('refuses branch names with shell metacharacters', async () => {
    for (const bad of ['foo;bar', 'foo|bar', 'a$(cmd)']) {
      const r = await switchBranch('/repo', bad);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/invalid/);
    }
  });

  it('refuses when working tree is dirty', async () => {
    // rev-parse for getRepoRoot (inside gitStatus→getRepoRoot)
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    // gitStatus internal calls: rev-parse branch + status + ahead/behind
    mockExecCmd.mockResolvedValueOnce(ok('main')); // branch
    mockExecCmd.mockResolvedValueOnce(ok('M  dirty.ts')); // porcelain
    mockExecCmd.mockResolvedValueOnce(ok('0\t0')); // ahead/behind

    const r = await switchBranch('/repo', 'feature/clean');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('working tree dirty');
  });

  it('succeeds on a clean tree', async () => {
    // rev-parse for getRepoRoot
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    // gitStatus: branch, porcelain (empty = clean), ahead/behind
    mockExecCmd.mockResolvedValueOnce(ok('main'));
    mockExecCmd.mockResolvedValueOnce(ok(''));
    mockExecCmd.mockResolvedValueOnce(ok('0\t1'));
    // git switch
    mockExecCmd.mockResolvedValueOnce(ok(''));

    const r = await switchBranch('/repo', 'feature/clean');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with error when git switch fails', async () => {
    mockExecCmd.mockResolvedValueOnce(ok('/repo'));
    mockExecCmd.mockResolvedValueOnce(ok('main'));
    mockExecCmd.mockResolvedValueOnce(ok(''));
    mockExecCmd.mockResolvedValueOnce(ok('0\t0'));
    mockExecCmd.mockResolvedValueOnce(fail('branch not found'));

    const r = await switchBranch('/repo', 'nonexistent');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('branch not found');
  });
});
