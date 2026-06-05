import { describe, it, expect, vi } from 'vitest';
import { worktreeCreate } from './worktree-gui';
import type { WorktreePool } from './worktree';

describe('worktreeCreate', () => {
  function makePool(overrides?: Partial<{ worktreePath: string; branch: string; sessionId: string }>) {
    const defaults = { worktreePath: '/tmp/pool/abc123', branch: 'manual/hint-abc123', sessionId: 'sess-1' };
    const result = { ...defaults, ...overrides };
    const pool = {
      create: vi.fn().mockResolvedValue(result),
    } as unknown as WorktreePool;
    return { pool, result };
  }

  it('calls pool.create with role:"manual" and passes repoRoot', async () => {
    const { pool } = makePool();
    await worktreeCreate(pool, { repoRoot: '/repo' });
    expect(pool.create).toHaveBeenCalledOnce();
    expect(pool.create).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/repo', role: 'manual' }),
    );
  });

  it('forwards optional hint to pool.create', async () => {
    const { pool } = makePool();
    await worktreeCreate(pool, { repoRoot: '/repo', hint: 'my-feature' });
    expect(pool.create).toHaveBeenCalledWith(
      expect.objectContaining({ hint: 'my-feature' }),
    );
  });

  it('forwards optional base to pool.create', async () => {
    const { pool } = makePool();
    await worktreeCreate(pool, { repoRoot: '/repo', base: 'origin/main' });
    expect(pool.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'origin/main' }),
    );
  });

  it('returns worktreePath and branch from pool.create result', async () => {
    const { pool } = makePool({ worktreePath: '/tmp/pool/xyz', branch: 'manual/xyz' });
    const result = await worktreeCreate(pool, { repoRoot: '/repo' });
    expect(result).toEqual({ worktreePath: '/tmp/pool/xyz', branch: 'manual/xyz' });
  });

  it('does NOT expose sessionId in the return value', async () => {
    const { pool } = makePool();
    const result = await worktreeCreate(pool, { repoRoot: '/repo' });
    expect(result).not.toHaveProperty('sessionId');
  });

  it('propagates errors from pool.create', async () => {
    const pool = {
      create: vi.fn().mockRejectedValue(new Error('WORKTREE_CAP')),
    } as unknown as WorktreePool;
    await expect(worktreeCreate(pool, { repoRoot: '/repo' })).rejects.toThrow('WORKTREE_CAP');
  });
});
