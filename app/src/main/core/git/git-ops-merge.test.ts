// BUG-14 — Behavior tests for `commitAndMerge`.
//
// `commitAndMerge` is the destructive worktree→base-branch merge "moat" path.
// It had zero behavior tests before this file.
//
// What the function does (from reading the source):
//   1. git add -A                          in worktreePath
//   2. git diff --cached --quiet           in worktreePath
//      - exit 0 → nothing staged, skip commit, proceed to merge
//      - exit 1 → staged changes present, run git commit
//      - other  → error, early-return
//   3. git commit -m <message>             in worktreePath  (only when staged)
//   4. git merge --no-ff <branch>          in repoRoot
//
// We mock `../../lib/exec` exactly as `git-ops-diff.test.ts` does so no real
// git processes or file-system access is needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));

import { execCmd } from '../../lib/exec';
import { commitAndMerge } from './git-ops';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockExecCmd = execCmd as ReturnType<typeof vi.fn>;

function makeExecResult(
  stdout = '',
  opts: { code?: number; stderr?: string } = {},
) {
  return {
    stdout,
    stderr: opts.stderr ?? '',
    code: opts.code ?? 0,
    timedOut: false,
    maxBufferExceeded: false,
  };
}

// Standard "happy path" — staged changes, clean commit, clean merge.
//   call 1: git add -A             → code 0
//   call 2: git diff --cached      → code 1  (staged changes present)
//   call 3: git commit             → code 0
//   call 4: git merge --no-ff      → code 0
function setupHappyPath(opts: { mergeStdout?: string } = {}) {
  mockExecCmd
    .mockResolvedValueOnce(makeExecResult('', { code: 0 }))           // add -A
    .mockResolvedValueOnce(makeExecResult('', { code: 1 }))           // diff --cached (staged)
    .mockResolvedValueOnce(makeExecResult('1 file changed', { code: 0 })) // commit
    .mockResolvedValueOnce(
      makeExecResult(opts.mergeStdout ?? 'Merge made by the "no-ff" strategy.', { code: 0 }),
    ); // merge
}

// "Nothing staged" path — diff --cached exits 0 → skip commit, go straight to merge.
//   call 1: git add -A             → code 0
//   call 2: git diff --cached      → code 0  (nothing staged / already clean)
//   call 3: git merge --no-ff      → code 0
function setupNothingStagedPath(opts: { mergeStdout?: string } = {}) {
  mockExecCmd
    .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
    .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
    .mockResolvedValueOnce(
      makeExecResult(opts.mergeStdout ?? 'Already up to date.', { code: 0 }),
    );
}

const DEFAULT_INPUT = {
  worktreePath: '/wt/feature-branch',
  branch: 'sigmalink/agent/feature-abc123',
  repoRoot: '/repo',
  message: 'feat: agent work',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Benign default for any call not explicitly queued — notably the
  // `git merge --abort` cleanup commitAndMerge now issues after a failed merge
  // (BUG-14 fix). Per-test `.mockResolvedValueOnce(...)` chains take precedence.
  mockExecCmd.mockResolvedValue(makeExecResult('', { code: 0 }));
});

// ---------------------------------------------------------------------------
// 1. Happy path — staged changes, clean merge
// ---------------------------------------------------------------------------

describe('commitAndMerge() — happy path (staged changes + clean merge)', () => {
  it('returns code 0 on full success', async () => {
    setupHappyPath();
    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.code).toBe(0);
  });

  it('includes merge output in stdout', async () => {
    setupHappyPath({ mergeStdout: 'Merge made by the "no-ff" strategy.\n' });
    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.stdout).toContain('Merge made by the "no-ff" strategy.');
  });

  it('executes exactly 4 git commands in order: add, diff-cached, commit, merge', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    expect(mockExecCmd).toHaveBeenCalledTimes(4);

    // call 0 — git add -A in worktreePath
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      1,
      'git',
      ['add', '-A'],
      expect.objectContaining({ cwd: DEFAULT_INPUT.worktreePath }),
    );
    // call 1 — git diff --cached --quiet in worktreePath
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', '--cached', '--quiet'],
      expect.objectContaining({ cwd: DEFAULT_INPUT.worktreePath }),
    );
    // call 2 — git commit -m <message> in worktreePath
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      3,
      'git',
      ['commit', '-m', DEFAULT_INPUT.message],
      expect.objectContaining({ cwd: DEFAULT_INPUT.worktreePath }),
    );
    // call 3 — git merge --no-ff <branch> in repoRoot
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      4,
      'git',
      ['merge', '--no-ff', DEFAULT_INPUT.branch],
      expect.objectContaining({ cwd: DEFAULT_INPUT.repoRoot }),
    );
  });

  it('passes the commit message verbatim', async () => {
    setupHappyPath();
    const msg = 'fix: ensure idempotent migration 0026 — "double" quotes & special chars';
    await commitAndMerge({ ...DEFAULT_INPUT, message: msg });
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      3,
      'git',
      ['commit', '-m', msg],
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Nothing staged — skips commit, still merges
// ---------------------------------------------------------------------------

describe('commitAndMerge() — nothing staged (diff --cached exits 0)', () => {
  it('skips the commit step and proceeds to merge', async () => {
    setupNothingStagedPath();
    const result = await commitAndMerge(DEFAULT_INPUT);

    expect(result.code).toBe(0);
    // Only 3 calls: add, diff-cached, merge (no commit)
    expect(mockExecCmd).toHaveBeenCalledTimes(3);
    expect(mockExecCmd).toHaveBeenNthCalledWith(
      3,
      'git',
      ['merge', '--no-ff', DEFAULT_INPUT.branch],
      expect.objectContaining({ cwd: DEFAULT_INPUT.repoRoot }),
    );
  });

  it('never calls git commit when nothing is staged', async () => {
    setupNothingStagedPath();
    await commitAndMerge(DEFAULT_INPUT);

    const commitCalls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) =>
        Array.isArray(args[1]) && (args[1] as string[]).includes('commit'),
    );
    expect(commitCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. abort-on-conflict: merge failure must NOT silently continue
//    The base branch must be left UNTOUCHED — no further git commands after
//    the merge returns a non-zero exit code.
// ---------------------------------------------------------------------------

describe('commitAndMerge() — abort on conflict / merge failure', () => {
  it('returns the merge exit code (1) on conflict, not 0', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))    // add
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))    // diff-cached: staged
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))    // commit ok
      .mockResolvedValueOnce(
        makeExecResult('', {
          code: 1,
          stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
        }),
      ); // merge conflict

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.code).toBe(1);
  });

  it('surfaces the conflict stderr in the returned stderr', async () => {
    const conflictMsg = 'CONFLICT (content): Merge conflict in src/foo.ts';
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: conflictMsg }));

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.stderr).toContain(conflictMsg);
  });

  it('issues exactly the abort cleanup (no further work commands) after a failed merge', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))                       // add
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))                       // diff-cached: staged
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))                       // commit
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: 'CONFLICT' }))   // merge fails
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }));                      // merge --abort cleanup

    await commitAndMerge(DEFAULT_INPUT);

    // 5 calls: add, diff-cached, commit, merge, and the merge --abort cleanup.
    expect(mockExecCmd).toHaveBeenCalledTimes(5);
    const fifth = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls[4];
    expect(fifth[1]).toEqual(['merge', '--abort']);
  });

  // BUG-14 FIX: commitAndMerge now runs `git merge --abort` after a failed merge
  // so the base-branch repo is restored to its pre-merge HEAD instead of being
  // left in a CONFLICTED / in-progress merge state. The merge exit code is still
  // surfaced to the caller; the abort is best-effort cleanup.
  it('runs `git merge --abort` in repoRoot to restore the base branch after a conflict', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: 'CONFLICT' }))
      .mockResolvedValueOnce(makeExecResult('', { code: 0 })); // merge --abort

    await commitAndMerge(DEFAULT_INPUT);

    // Exactly one `git merge --abort` cleanup, issued against the base repo.
    const abortCalls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) =>
        Array.isArray(args[1]) &&
        (args[1] as string[]).includes('--abort'),
    );
    expect(abortCalls).toHaveLength(1);
    expect((abortCalls[0][2] as { cwd?: string }).cwd).toBe(DEFAULT_INPUT.repoRoot);
  });
});

// ---------------------------------------------------------------------------
// 4. Partial-success / mid-batch failure: early exits must be reported
// ---------------------------------------------------------------------------

describe('commitAndMerge() — partial-success / early-exit propagation', () => {
  it('exits early with add failure code when git add -A fails', async () => {
    mockExecCmd.mockResolvedValueOnce(makeExecResult('', { code: 128, stderr: 'not a git repo' }));

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.code).toBe(128);
    // No further commands issued
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
  });

  it('includes add stderr in result when add fails', async () => {
    mockExecCmd.mockResolvedValueOnce(
      makeExecResult('', { code: 128, stderr: 'fatal: not a git repository' }),
    );

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.stderr).toContain('fatal: not a git repository');
  });

  it('exits early when diff --cached returns an unexpected error code (e.g. 2)', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))            // add ok
      .mockResolvedValueOnce(
        makeExecResult('', { code: 2, stderr: 'error: object file corrupt' }),
      ); // diff --cached unexpected error

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.code).toBe(2);
    // No commit or merge attempted
    expect(mockExecCmd).toHaveBeenCalledTimes(2);
  });

  it('exits early and returns commit error code when git commit fails', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))   // add
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))   // diff-cached: staged
      .mockResolvedValueOnce(
        makeExecResult('', { code: 1, stderr: 'Aborting commit due to empty message' }),
      ); // commit fails

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.code).toBe(1);
    // Merge must NOT be called
    expect(mockExecCmd).toHaveBeenCalledTimes(3);
  });

  it('does NOT call merge when commit fails — base branch left untouched', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: 'commit failed' }));

    await commitAndMerge(DEFAULT_INPUT);

    const mergeCalls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) =>
        Array.isArray(args[1]) && (args[1] as string[]).includes('merge'),
    );
    expect(mergeCalls).toHaveLength(0);
  });

  it('includes commit stderr in returned stderr when commit fails', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(
        makeExecResult('', { code: 1, stderr: 'pre-commit hook rejected' }),
      );

    const result = await commitAndMerge(DEFAULT_INPUT);
    expect(result.stderr).toContain('pre-commit hook rejected');
  });
});

// ---------------------------------------------------------------------------
// 5. Sequential ordered merges
//    commitAndMerge is single-call, but the internal operation sequence
//    must be strictly sequential: add → diff-cached → [commit] → merge.
//    We verify the call ORDER matches the expected command sequence.
// ---------------------------------------------------------------------------

describe('commitAndMerge() — sequential operation ordering', () => {
  it('always runs add before diff-cached', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    const calls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string[],
      unknown,
    ][];
    const addIdx = calls.findIndex((c) => c[1].includes('-A'));
    const diffIdx = calls.findIndex((c) => c[1].includes('--cached'));
    expect(addIdx).toBeLessThan(diffIdx);
  });

  it('always runs commit before merge when staging is present', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    const calls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string[],
      unknown,
    ][];
    const commitIdx = calls.findIndex((c) => c[1].includes('commit'));
    const mergeIdx = calls.findIndex((c) => c[1].includes('merge'));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(mergeIdx);
  });

  it('always runs merge LAST in the happy path', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    const calls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string[],
      unknown,
    ][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toContain('merge');
  });

  it('merge is issued against repoRoot (not worktreePath)', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    const calls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string[],
      { cwd: string },
    ][];
    const mergeCall = calls.find((c) => c[1].includes('merge'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall![2].cwd).toBe(DEFAULT_INPUT.repoRoot);
    expect(mergeCall![2].cwd).not.toBe(DEFAULT_INPUT.worktreePath);
  });

  it('add and commit are issued against worktreePath (not repoRoot)', async () => {
    setupHappyPath();
    await commitAndMerge(DEFAULT_INPUT);

    const calls = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string[],
      { cwd: string },
    ][];
    const addCall = calls.find((c) => c[1].includes('-A'));
    const commitCall = calls.find((c) => c[1].includes('commit'));
    expect(addCall![2].cwd).toBe(DEFAULT_INPUT.worktreePath);
    expect(commitCall![2].cwd).toBe(DEFAULT_INPUT.worktreePath);
  });
});

// ---------------------------------------------------------------------------
// 6. Rollback / abort on failure
//    commitAndMerge auto-aborts a failed merge so the base repo is left clean,
//    while still surfacing the failure code to the caller (BUG-14 fix).
// ---------------------------------------------------------------------------

describe('commitAndMerge() — rollback / abort behavior on failure', () => {
  // BUG-14 FIX: after a merge conflict (merge returns non-zero) commitAndMerge
  // calls `git merge --abort` so repoRoot is NOT left in a conflicted
  // in-progress merge state. The failure code is still reported to the caller.
  it('issues git merge --abort after a conflict and still reports the failure', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: 'CONFLICT (content)' }))
      .mockResolvedValueOnce(makeExecResult('', { code: 0 })); // merge --abort

    const result = await commitAndMerge(DEFAULT_INPUT);

    // Must still report the error
    expect(result.code).not.toBe(0);

    const allCommands = (mockExecCmd as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (args: unknown[]) => (Array.isArray(args[1]) ? (args[1] as string[]) : []),
    );
    expect(allCommands).toContain('--abort');
  });

  // NOTE: After a failed `git add -A`, no changes have been staged, so the
  // worktree is in its pre-call state — no partial staged changes persisted.
  // This is safe because add failure aborts before any write to index.
  it('no index mutation after add failure — no rollback needed (add is atomic)', async () => {
    mockExecCmd.mockResolvedValueOnce(makeExecResult('', { code: 128, stderr: 'not a git repo' }));

    const result = await commitAndMerge(DEFAULT_INPUT);

    expect(result.code).toBe(128);
    // Only one call — no further mutation attempted
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
  });

  it('returns stdout accumulated up to failure point (not empty)', async () => {
    mockExecCmd
      .mockResolvedValueOnce(makeExecResult('add output\n', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1 }))
      .mockResolvedValueOnce(makeExecResult('commit output\n', { code: 0 }))
      .mockResolvedValueOnce(makeExecResult('', { code: 1, stderr: 'CONFLICT' }));

    const result = await commitAndMerge(DEFAULT_INPUT);
    // stdout contains the pre-failure add output AND the commit output
    expect(result.stdout).toContain('add output');
    expect(result.stdout).toContain('commit output');
  });
});
