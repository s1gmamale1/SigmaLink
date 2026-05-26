// H-15 — gitDiff truncation detection tests.
//
// `gitDiff` uses execCmd with a maxBuffer cap. When the diff output exceeds the
// cap, execCmd sets `maxBufferExceeded: true` on the result instead of throwing.
// The returned GitDiff shape must expose a `truncated` boolean so callers can
// warn users that the diff is incomplete.
//
// We mock `node:fs` and `../../lib/exec` so no real git processes or
// file-system access is needed. `getRepoRoot` is called internally by
// `gitDiff`; it also calls `execCmd`, so we control its return by making
// the first `execCmd` call return a successful `git rev-parse` result.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));

import fs from 'node:fs';
import { execCmd } from '../../lib/exec';
import { gitDiff } from './git-ops';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockExecCmd = execCmd as ReturnType<typeof vi.fn>;
const mockExistsSync = (fs as unknown as { existsSync: ReturnType<typeof vi.fn> }).existsSync;

function makeExecResult(
  stdout = '',
  opts: { maxBufferExceeded?: boolean; code?: number } = {},
) {
  return {
    stdout,
    stderr: '',
    code: opts.code ?? 0,
    timedOut: false,
    maxBufferExceeded: opts.maxBufferExceeded ?? false,
  };
}

/**
 * Set up the mock call sequence for a normal gitDiff() run:
 *   1. git rev-parse --show-toplevel  → returns fakeRoot (used by getRepoRoot)
 *   2. git diff --stat HEAD            → stat
 *   3. git diff HEAD                   → patches (may have maxBufferExceeded)
 *   4. git ls-files --others           → untracked
 */
function setupDiffMocks(opts: {
  stat?: string;
  patches?: string;
  maxBufferExceeded?: boolean;
  untracked?: string;
  repoRoot?: string;
}) {
  const {
    stat = 'stat',
    patches = 'diff --git a/foo b/foo',
    maxBufferExceeded = false,
    untracked = '',
    repoRoot = '/fake/repo',
  } = opts;

  mockExecCmd
    .mockResolvedValueOnce(makeExecResult(repoRoot + '\n'))  // git rev-parse
    .mockResolvedValueOnce(makeExecResult(stat))             // git diff --stat
    .mockResolvedValueOnce(makeExecResult(patches, { maxBufferExceeded })) // git diff
    .mockResolvedValueOnce(makeExecResult(untracked));       // git ls-files
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gitDiff() — truncation detection (H-15)', () => {
  it('normal diff — truncated is false when maxBufferExceeded is false', async () => {
    setupDiffMocks({ patches: 'diff --git a/foo b/foo' });

    const result = await gitDiff('/some/repo');

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.patches).toBe('diff --git a/foo b/foo');
  });

  it('returns truncated:true when execCmd reports maxBufferExceeded', async () => {
    const partialPatch = 'diff --git a/big b/big\n' + 'x'.repeat(100);
    setupDiffMocks({ patches: partialPatch, maxBufferExceeded: true, stat: '999 files changed' });

    const result = await gitDiff('/some/repo');

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    // Partial patches are still returned so the caller can show what was captured.
    expect(result!.patches).toBe(partialPatch);
  });

  it('returns truncated:true when output byte-length equals the 16 MiB cap', async () => {
    const CAP = 16 * 1024 * 1024;
    // Output exactly at the cap boundary (>= CAP - 1 triggers truncated).
    const hugeOutput = 'x'.repeat(CAP);
    setupDiffMocks({ patches: hugeOutput, maxBufferExceeded: false });

    const result = await gitDiff('/some/repo');

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
  });

  it('returns null when cwd does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await gitDiff('/nonexistent');

    expect(result).toBeNull();
    expect(mockExecCmd).not.toHaveBeenCalled();
  });

  it('returns null when getRepoRoot returns null (not a git repo)', async () => {
    // getRepoRoot calls execCmd; a non-zero exit code makes it return null.
    mockExecCmd.mockResolvedValueOnce(makeExecResult('', { code: 128 }));

    const result = await gitDiff('/not/a/repo');

    expect(result).toBeNull();
    // Only the rev-parse call for getRepoRoot was made; no diff calls.
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
  });

  it('untracked files are populated correctly alongside the truncated flag', async () => {
    setupDiffMocks({
      patches: 'patch',
      maxBufferExceeded: true,
      untracked: 'new-file.ts\nanother.ts\n',
    });

    const result = await gitDiff('/some/repo');

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.untrackedFiles).toEqual(['new-file.ts', 'another.ts']);
  });

  it('stat output is passed through unchanged', async () => {
    setupDiffMocks({ stat: ' 3 files changed, 42 insertions(+), 5 deletions(-)' });

    const result = await gitDiff('/some/repo');

    expect(result!.stat).toBe(' 3 files changed, 42 insertions(+), 5 deletions(-)');
  });
});
