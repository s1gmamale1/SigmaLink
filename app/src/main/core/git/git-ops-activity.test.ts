// P6 FEAT-8 — behavior tests for `gitActivityLog` (per-worktree git-activity
// heatmap source). We mock `../../lib/exec` (the argument-array git runner)
// exactly as git-ops-checkpoint.test.ts / git-ops-merge.test.ts do, plus
// `node:fs` for the `existsSync` guard, so no real git or filesystem is needed.
//
// Load-bearing assertions:
//   - the exact git argv (no-merges, --numstat, --date=unix, COMMIT marker, -n 500)
//   - day-bucketing: numstat lines accumulate into the marker-commit's LOCAL day
//   - binary files (`-` add/del) count as a changed file but add 0 lines
//   - oldest→newest ordering with one bucket per active day
//   - empty history → []
//   - missing worktree path → [] (no git runs)
//   - git failure (non-zero) / thrown error → []

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));
vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
  existsSync: vi.fn(() => true),
}));

import { execCmd } from '../../lib/exec';
import fs from 'node:fs';
import { gitActivityLog } from './git-ops';

const mockExecCmd = execCmd as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

function res(stdout = '', opts: { code?: number; stderr?: string } = {}) {
  return {
    stdout,
    stderr: opts.stderr ?? '',
    code: opts.code ?? 0,
    timedOut: false,
    maxBufferExceeded: false,
  };
}

/** Pull the git argument array out of the Nth execCmd call. */
function argsOf(callIndex: number): string[] {
  return mockExecCmd.mock.calls[callIndex][1] as string[];
}

/** Local-day `YYYY-MM-DD` for an epoch-seconds value — mirrors the SUT so the
 *  assertion is timezone-independent (the bucketing uses the operator's TZ). */
function localDay(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

// Two epochs guaranteed to fall on different LOCAL calendar days (~2 days apart).
const T1 = 1_700_000_000; // some fixed instant
const T2 = T1 + 2 * 86_400; // +2 days

beforeEach(() => {
  mockExecCmd.mockReset();
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(true);
  // Default: getRepoRoot's `git rev-parse --show-toplevel` succeeds.
  mockExecCmd.mockResolvedValue(res('/repo\n', { code: 0 }));
});

describe('gitActivityLog', () => {
  it('runs the expected git log argv (no-merges, numstat, unix date, COMMIT marker, -n 500)', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 })) // getRepoRoot
      .mockResolvedValueOnce(res('', { code: 0 })); // git log (empty)

    await gitActivityLog('/wt', 14);

    // call 0 = rev-parse --show-toplevel (getRepoRoot); call 1 = the log.
    const logArgs = argsOf(1);
    expect(logArgs[0]).toBe('log');
    expect(logArgs).toContain('--no-merges');
    expect(logArgs).toContain('--numstat');
    expect(logArgs).toContain('--date=unix');
    expect(logArgs).toContain('--since=14.days.ago');
    expect(logArgs).toContain('--pretty=format:COMMIT %H %at');
    // `-n 500` cap, as two adjacent argv tokens.
    const nIdx = logArgs.indexOf('-n');
    expect(nIdx).toBeGreaterThan(-1);
    expect(logArgs[nIdx + 1]).toBe('500');

    // exec options carry the cwd, timeout, and maxBuffer.
    const opts = mockExecCmd.mock.calls[1][2] as {
      cwd: string;
      timeoutMs: number;
      maxBuffer: number;
    };
    expect(opts.cwd).toBe('/wt');
    expect(opts.timeoutMs).toBe(15_000);
    expect(opts.maxBuffer).toBe(2 * 1024 * 1024);
  });

  it('buckets numstat lines into the marker commit’s local day and sums churn', async () => {
    // Two commits on day T2 (newer), one on day T1 (older). git log is
    // newest-first; the result must come back oldest→newest.
    const stdout = [
      `COMMIT aaa ${T2}`,
      '10\t2\tsrc/a.ts',
      '5\t0\tsrc/b.ts',
      `COMMIT bbb ${T2}`,
      '3\t1\tsrc/c.ts',
      `COMMIT ccc ${T1}`,
      '1\t1\tREADME.md',
    ].join('\n');

    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 })) // getRepoRoot
      .mockResolvedValueOnce(res(stdout, { code: 0 })); // git log

    const out = await gitActivityLog('/wt', 30);

    expect(out).toHaveLength(2);
    // oldest first
    expect(out[0].date).toBe(localDay(T1));
    expect(out[1].date).toBe(localDay(T2));

    // older day: 1 commit, 1 file, 1 add, 1 del, churn 2
    expect(out[0]).toMatchObject({
      commitCount: 1,
      filesChanged: 1,
      linesAdded: 1,
      linesDeleted: 1,
      churn: 2,
    });

    // newer day: 2 commits, 3 files; adds 10+5+3=18, dels 2+0+1=3, churn 21
    expect(out[1]).toMatchObject({
      commitCount: 2,
      filesChanged: 3,
      linesAdded: 18,
      linesDeleted: 3,
      churn: 21,
    });
  });

  it('treats binary files (“-” numstat) as a changed file with zero lines', async () => {
    const stdout = [
      `COMMIT aaa ${T1}`,
      '-\t-\tassets/logo.png', // binary: 0 add / 0 del, but a changed file
      '4\t1\tsrc/x.ts',
    ].join('\n');

    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 }))
      .mockResolvedValueOnce(res(stdout, { code: 0 }));

    const out = await gitActivityLog('/wt');

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      commitCount: 1,
      filesChanged: 2, // both the binary + the text file count
      linesAdded: 4, // binary contributes 0
      linesDeleted: 1,
      churn: 5,
    });
  });

  it('returns [] for empty history', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 }))
      .mockResolvedValueOnce(res('', { code: 0 }));
    const out = await gitActivityLog('/wt');
    expect(out).toEqual([]);
  });

  it('returns [] when the worktree path is missing (no git runs)', async () => {
    mockExistsSync.mockReturnValue(false);
    const out = await gitActivityLog('/gone');
    expect(out).toEqual([]);
    expect(mockExecCmd).not.toHaveBeenCalled();
  });

  it('returns [] when not a git repo (getRepoRoot fails)', async () => {
    mockExecCmd.mockResolvedValueOnce(res('', { code: 128 })); // rev-parse fails
    const out = await gitActivityLog('/wt');
    expect(out).toEqual([]);
  });

  it('returns [] when git log exits non-zero', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 })) // getRepoRoot ok
      .mockResolvedValueOnce(res('', { code: 1, stderr: 'boom' })); // log fails
    const out = await gitActivityLog('/wt');
    expect(out).toEqual([]);
  });

  it('returns [] (never throws) when execCmd rejects', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('/repo\n', { code: 0 })) // getRepoRoot ok
      .mockRejectedValueOnce(new Error('spawn ENOENT')); // log throws
    await expect(gitActivityLog('/wt')).resolves.toEqual([]);
  });
});
