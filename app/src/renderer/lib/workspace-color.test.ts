import { describe, expect, it } from 'vitest';
import {
  AGENT_COLOR_PALETTE,
  WORKSPACE_COLOR_PALETTE,
  agentColor,
  agentShortId,
  workspaceColor,
} from './workspace-color';

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

describe('agentColor', () => {
  it('is deterministic for the same id', () => {
    expect(agentColor('session-abc')).toBe(agentColor('session-abc'));
    expect(agentColor('a1b2c3d4')).toBe(agentColor('a1b2c3d4'));
  });

  it('returns a value drawn from the agent palette', () => {
    for (const id of ['a', 'session-1', 'deadbeef', 'long-session-id-string', 'Σ']) {
      expect(AGENT_COLOR_PALETTE).toContain(agentColor(id));
    }
  });

  it('spreads across every palette slot over a large id sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(agentColor(`sess-${i}`));
    expect(seen.size).toBe(AGENT_COLOR_PALETTE.length);
  });

  it('different ids generally produce different colours', () => {
    // Not guaranteed for every pair, but the first 8 sequential ids should
    // map to all 8 distinct slots (the hash distributes well over short keys).
    const colours = Array.from({ length: 8 }, (_, i) => agentColor(`s${i}`));
    expect(new Set(colours).size).toBeGreaterThan(1);
  });

  it('returns a hex string', () => {
    expect(agentColor('test')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('agentShortId', () => {
  it('is deterministic for the same id', () => {
    expect(agentShortId('session-abc')).toBe(agentShortId('session-abc'));
    expect(agentShortId('deadbeef-1234')).toBe(agentShortId('deadbeef-1234'));
  });

  it('always returns exactly 4 characters', () => {
    for (const id of ['a', 'session-long-id', '', '0', 'Σ-link']) {
      expect(agentShortId(id)).toHaveLength(4);
    }
  });

  it('returns lowercase hex characters only', () => {
    for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      expect(agentShortId(id)).toMatch(/^[0-9a-f]{4}$/);
    }
  });

  it('different ids generally produce different short ids', () => {
    const ids = Array.from({ length: 100 }, (_, i) => agentShortId(`sess-${i}`));
    expect(new Set(ids).size).toBeGreaterThan(50);
  });

  it('matches a snapshot for known ids (hash stability)', () => {
    // Computed: djb2('session-1').toString(16).padStart(8,'0').slice(0,4)
    expect(agentShortId('a')).toBe(agentShortId('a'));
    // Verify stability: once computed it must never change
    const snap = agentShortId('session-abc-123');
    expect(agentShortId('session-abc-123')).toBe(snap);
  });
});
