import { describe, it, expect } from 'vitest';
import { worktreeModeKey, type WorktreeMode } from './worktree-mode';

describe('worktreeModeKey (shared)', () => {
  it('builds the canonical KV key', () => {
    expect(worktreeModeKey('ws-123')).toBe('workspace.worktreeMode.ws-123');
  });

  it('is stable for the same id and distinct per workspace', () => {
    expect(worktreeModeKey('a')).toBe(worktreeModeKey('a'));
    expect(worktreeModeKey('a')).not.toBe(worktreeModeKey('b'));
  });

  it('WorktreeMode admits exactly the two modes', () => {
    const a: WorktreeMode = 'worktree';
    const b: WorktreeMode = 'in-place';
    expect([a, b]).toEqual(['worktree', 'in-place']);
  });
});
