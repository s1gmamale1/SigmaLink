// P6 FEAT-11 — behavior tests for `createCheckpoint` / `restoreCheckpoint`.
//
// These are the agent undo/rewind git ops. We mock `../../lib/exec` (the
// argument-array git runner) exactly as git-ops-merge.test.ts does, plus
// `node:fs` for the `existsSync` guard, so no real git or filesystem is needed.
//
// The load-bearing assertions:
//   - createCheckpoint: add -A → commit --allow-empty --no-verify → rev-parse,
//     returns the parsed sha.
//   - restoreCheckpoint VALIDATES the sha (cat-file -e + merge-base --is-ancestor)
//     BEFORE doing anything destructive, and takes the safety checkpoint BEFORE
//     `git reset --hard` (the order is what makes the rewind itself undoable).

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
import { createCheckpoint, restoreCheckpoint } from './git-ops';

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

beforeEach(() => {
  mockExecCmd.mockReset();
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(true);
});

describe('createCheckpoint', () => {
  it('runs add -A → commit (allow-empty, no-verify) → rev-parse and returns the sha', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // add -A
      .mockResolvedValueOnce(res('', { code: 0 })) // commit
      .mockResolvedValueOnce(res('abc123def456\n', { code: 0 })); // rev-parse

    const out = await createCheckpoint('/wt', 'before-refactor');
    expect(out).toEqual({ ok: true, sha: 'abc123def456' });

    expect(argsOf(0)).toEqual(['add', '-A']);
    const commitArgs = argsOf(1);
    expect(commitArgs[0]).toBe('commit');
    expect(commitArgs).toContain('--allow-empty');
    expect(commitArgs).toContain('--no-verify');
    // message carries the label
    expect(commitArgs[commitArgs.length - 1]).toContain('before-refactor');
    expect(argsOf(2)).toEqual(['rev-parse', 'HEAD']);
  });

  it('falls back to a timestamp message when no label is given', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 }))
      .mockResolvedValueOnce(res('', { code: 0 }))
      .mockResolvedValueOnce(res('sha\n', { code: 0 }));
    await createCheckpoint('/wt');
    const msg = argsOf(1)[argsOf(1).length - 1];
    expect(msg).toMatch(/sigmalink checkpoint: /);
  });

  it('returns an error when the worktree path is missing (no git runs)', async () => {
    mockExistsSync.mockReturnValue(false);
    const out = await createCheckpoint('/gone');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing/);
    expect(mockExecCmd).not.toHaveBeenCalled();
  });

  it('returns an error if commit fails', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // add
      .mockResolvedValueOnce(res('', { code: 1, stderr: 'hook failed' })); // commit
    const out = await createCheckpoint('/wt');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/commit failed/);
  });
});

describe('restoreCheckpoint', () => {
  it('validates the sha BEFORE reset, then safety-checkpoints BEFORE reset', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // cat-file -e (commit exists)
      .mockResolvedValueOnce(res('', { code: 0 })) // merge-base --is-ancestor
      // createCheckpoint('pre-rewind'): add → commit → rev-parse
      .mockResolvedValueOnce(res('', { code: 0 })) // add -A
      .mockResolvedValueOnce(res('', { code: 0 })) // commit
      .mockResolvedValueOnce(res('safetysha000\n', { code: 0 })) // rev-parse
      .mockResolvedValueOnce(res('', { code: 0 })); // reset --hard

    const out = await restoreCheckpoint('/wt', 'targetsha');
    expect(out).toEqual({ ok: true, safetySha: 'safetysha000' });

    // ORDER: validation (0,1) → safety checkpoint (2,3,4) → reset (5)
    expect(argsOf(0)).toEqual(['cat-file', '-e', 'targetsha^{commit}']);
    expect(argsOf(1)).toEqual(['merge-base', '--is-ancestor', 'targetsha', 'HEAD']);
    expect(argsOf(2)).toEqual(['add', '-A']);
    expect(argsOf(3)[0]).toBe('commit'); // safety commit
    expect(argsOf(3)[argsOf(3).length - 1]).toContain('pre-rewind');
    expect(argsOf(5)).toEqual(['reset', '--hard', 'targetsha']);
    // reset is the LAST call — destructive op happens after the snapshot.
    expect(mockExecCmd).toHaveBeenCalledTimes(6);
  });

  it('rejects a sha that is not a commit object (no reset, no safety commit)', async () => {
    mockExecCmd.mockResolvedValueOnce(res('', { code: 1 })); // cat-file -e fails
    const out = await restoreCheckpoint('/wt', 'bogus');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not found/);
    // Only the validation call ran — nothing destructive.
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
  });

  it('rejects a sha that is not an ancestor of HEAD (no reset)', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // cat-file -e ok
      .mockResolvedValueOnce(res('', { code: 1 })); // not an ancestor
    const out = await restoreCheckpoint('/wt', 'foreignsha');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ancestor/);
    expect(mockExecCmd).toHaveBeenCalledTimes(2);
    // No reset --hard was ever issued.
    const allArgs = mockExecCmd.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(allArgs.some((a) => a.includes('reset --hard'))).toBe(false);
  });

  it('returns the safety sha even when the reset itself fails (recoverable)', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // cat-file
      .mockResolvedValueOnce(res('', { code: 0 })) // ancestor
      .mockResolvedValueOnce(res('', { code: 0 })) // add
      .mockResolvedValueOnce(res('', { code: 0 })) // commit
      .mockResolvedValueOnce(res('safetysha\n', { code: 0 })) // rev-parse
      .mockResolvedValueOnce(res('', { code: 1, stderr: 'reset boom' })); // reset fails
    const out = await restoreCheckpoint('/wt', 'targetsha');
    expect(out.ok).toBe(false);
    expect(out.safetySha).toBe('safetysha'); // still recoverable
    expect(out.error).toMatch(/reset failed/);
  });

  it('aborts before reset if the safety checkpoint fails to commit', async () => {
    mockExecCmd
      .mockResolvedValueOnce(res('', { code: 0 })) // cat-file
      .mockResolvedValueOnce(res('', { code: 0 })) // ancestor
      .mockResolvedValueOnce(res('', { code: 0 })) // add
      .mockResolvedValueOnce(res('', { code: 1, stderr: 'commit fail' })); // safety commit fails
    const out = await restoreCheckpoint('/wt', 'targetsha');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/safety checkpoint failed/);
    // reset --hard never ran.
    const allArgs = mockExecCmd.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(allArgs.some((a) => a.includes('reset --hard'))).toBe(false);
  });

  it('returns an error when the worktree path is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    const out = await restoreCheckpoint('/gone', 'sha');
    expect(out.ok).toBe(false);
    expect(mockExecCmd).not.toHaveBeenCalled();
  });
});
