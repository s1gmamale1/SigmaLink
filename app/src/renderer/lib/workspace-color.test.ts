import { describe, expect, it } from 'vitest';
import { WORKSPACE_COLOR_PALETTE, workspaceColor } from './workspace-color';

describe('workspaceColor', () => {
  it('is deterministic for the same id', () => {
    expect(workspaceColor('alpha')).toBe(workspaceColor('alpha'));
    expect(workspaceColor('ws-12345')).toBe(workspaceColor('ws-12345'));
  });

  it('returns a value drawn from the published palette', () => {
    for (const id of ['a', 'workspace-1', '0123', 'long-workspace-name', 'Σ-link']) {
      expect(WORKSPACE_COLOR_PALETTE).toContain(workspaceColor(id));
    }
  });

  it('spreads across every palette slot over a large id sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(workspaceColor(`ws-${i}`));
    // All 8 palette slots should appear at least once on a uniform input set.
    expect(seen.size).toBe(WORKSPACE_COLOR_PALETTE.length);
  });

  it('matches a snapshot for five known ids', () => {
    // Frozen so a regression in the hash arithmetic is caught loudly. The
    // values were computed from the spec's hash:
    //   id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 0) >>> 0
    // then `% 8` into the palette index.
    expect(workspaceColor('a')).toBe('bg-blue-400');
    expect(workspaceColor('b')).toBe('bg-purple-400');
    expect(workspaceColor('workspace-1')).toBe('bg-pink-400');
    expect(workspaceColor('sigmalink')).toBe('bg-indigo-400');
    expect(workspaceColor('ws-005')).toBe('bg-emerald-400');
  });
});
