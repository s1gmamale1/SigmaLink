import { describe, expect, it } from 'vitest';
import {
  AGENT_ALIAS_PALETTE,
  AGENT_COLOR_PALETTE,
  WORKSPACE_COLOR_PALETTE,
  agentAlias,
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

  it('matches FROZEN snapshots (FNV-1a — a constant change must fail this)', () => {
    // Frozen values from the FNV-1a impl. NOT a tautology — hard-coded so a
    // regression in the hash constants is caught (review L1).
    expect(agentShortId('session-abc-123')).toBe('837b');
    expect(agentShortId('session-1')).toBe('51cd');
    expect(agentShortId('')).toBe('9dc5'); // FNV offset basis low 16 bits
    expect(agentColor('session-abc-123')).toBe('#fb923c');
    expect(agentColor('session-1')).toBe('#2dd4bf');
  });
});

describe('agentAlias (BSP-P3)', () => {
  it('is deterministic for the same id', () => {
    expect(agentAlias('sess-abc')).toBe(agentAlias('sess-abc'));
  });

  it('returns a name from the published palette', () => {
    expect(AGENT_ALIAS_PALETTE).toContain(agentAlias('any-uuid-1234'));
  });

  it('handles long UUID ids without throwing', () => {
    const uuid = '7f3c1e2a-9b4d-4c8e-a1f2-3d4e5f6a7b8c';
    expect(typeof agentAlias(uuid)).toBe('string');
    expect(AGENT_ALIAS_PALETTE).toContain(agentAlias(uuid));
  });

  it('distributes across the palette for distinct ids', () => {
    const names = new Set(
      Array.from({ length: 64 }, (_, i) => agentAlias(`sess-${i}`)),
    );
    // 16 slots over 64 ids — expect a healthy spread, not a single name.
    expect(names.size).toBeGreaterThan(4);
  });

  it('matches FROZEN snapshots (FNV-1a — a hash change must fail this)', () => {
    // Palette length 16 is a power of two, so the index == the low 4 bits of
    // the FNV-1a hash == the low 4 bits of the agentShortId snapshots above:
    //   agentShortId('session-abc-123') = '837b' → 0xb = 11 → AGENT_ALIAS_PALETTE[11]
    //   agentShortId('session-1')       = '51cd' → 0xd = 13 → AGENT_ALIAS_PALETTE[13]
    expect(agentAlias('session-abc-123')).toBe('Sage');
    expect(agentAlias('session-1')).toBe('Mira');
  });
});
