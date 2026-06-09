import { describe, expect, it } from 'vitest';
import { agentAlias, AGENT_ALIAS_PALETTE, derivePaneName, fnv1a32 } from './agent-identity';

describe('agent-identity', () => {
  it('fnv1a32 is deterministic and 32-bit unsigned', () => {
    expect(fnv1a32('sess-1')).toBe(fnv1a32('sess-1'));
    expect(fnv1a32('a-very-long-uuid-0123456789abcdef')).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a32('a-very-long-uuid-0123456789abcdef')).toBeGreaterThanOrEqual(0);
  });

  it('agentAlias maps to a palette name, stable per id', () => {
    expect(AGENT_ALIAS_PALETTE).toContain(agentAlias('sess-1'));
    expect(agentAlias('sess-1')).toBe(agentAlias('sess-1'));
  });

  describe('derivePaneName', () => {
    it('prefers the operator-supplied name', () => {
      expect(derivePaneName({ id: 'sess-1', name: 'Telegram Monitor' })).toBe('Telegram Monitor');
    });

    it('trims whitespace on the supplied name', () => {
      expect(derivePaneName({ id: 'sess-1', name: '  Build Lane  ' })).toBe('Build Lane');
    });

    it('falls back to the deterministic alias when unnamed', () => {
      expect(derivePaneName({ id: 'sess-1' })).toBe(agentAlias('sess-1'));
      expect(derivePaneName({ id: 'sess-1', name: null })).toBe(agentAlias('sess-1'));
      expect(derivePaneName({ id: 'sess-1', name: '   ' })).toBe(agentAlias('sess-1'));
    });
  });
});
