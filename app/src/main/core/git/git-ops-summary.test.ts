// perf-hot-paths Task 3 — count-only gitStatusSummary. Mocks execCmd +
// fs.existsSync (no real git proc; mirrors git-ops-panel.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(() => true) },
}));

vi.mock('../../lib/exec', () => ({
  execCmd: vi.fn(),
}));

import fs from 'node:fs';
import { execCmd } from '../../lib/exec';
import { gitStatusSummary } from './git-ops';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExecCmd = execCmd as any as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExistsSync = (fs as any as { existsSync: ReturnType<typeof vi.fn> }).existsSync;

function ok(stdout = ''): { stdout: string; stderr: string; code: number; maxBufferExceeded: boolean } {
  return { stdout, stderr: '', code: 0, maxBufferExceeded: false };
}

function fail(code = 128): { stdout: string; stderr: string; code: number; maxBufferExceeded: boolean } {
  return { stdout: '', stderr: 'fatal: not a git repository', code, maxBufferExceeded: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockExistsSync.mockReturnValue(true);
});

describe('gitStatusSummary', () => {
  it('counts with EXACT useUncommittedCount parity (MM double-counts: staged AND unstaged)', async () => {
    // 'MM a.ts' → staged + unstaged (2); ' M b.ts' → unstaged (1); '?? c.ts' → untracked (1).
    mockExecCmd.mockResolvedValue(ok('MM a.ts\n M b.ts\n?? c.ts\n'));
    expect(await gitStatusSummary('/repo')).toEqual({ uncommitted: 4, clean: false });
  });

  it('clean tree → uncommitted 0, clean true', async () => {
    mockExecCmd.mockResolvedValue(ok(''));
    expect(await gitStatusSummary('/repo')).toEqual({ uncommitted: 0, clean: true });
  });

  it('non-zero git exit (not a work tree) → null', async () => {
    mockExecCmd.mockResolvedValue(fail());
    expect(await gitStatusSummary('/not-a-repo')).toBeNull();
  });

  it('missing path → null WITHOUT spawning git', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await gitStatusSummary('/gone')).toBeNull();
    expect(mockExecCmd).not.toHaveBeenCalled();
  });

  it('spawns exactly ONE git process (vs gitStatus four)', async () => {
    mockExecCmd.mockResolvedValue(ok('?? a.ts\n'));
    await gitStatusSummary('/repo');
    expect(mockExecCmd).toHaveBeenCalledTimes(1);
    expect(mockExecCmd).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain=v1', '-uall'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
