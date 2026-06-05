// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyTint, clearTint, parseTint, hexToHslChannels } from './workspace-tint';

describe('workspace-tint', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--surface-tint');
  });
  it('applyTint sets --accent as HSL CHANNELS (consumable by hsl(var(--accent))) and --surface-tint as the raw hex', () => {
    applyTint({ accent: '#b966f5' });
    const s = document.documentElement.style;
    // --accent must be bare "H S% L%" channels — NOT a hex — so `hsl(var(--accent))` is valid.
    const accent = s.getPropertyValue('--accent').trim();
    expect(accent).toMatch(/^\d+ \d+% \d+%$/);
    expect(accent).not.toMatch(/#/);
    // --surface-tint stays the full hex — it's consumed raw inside color-mix().
    expect(s.getPropertyValue('--surface-tint').trim()).toBe('#b966f5');
  });
  it('clearTint removes the inline overrides (reverting to theme defaults)', () => {
    applyTint({ accent: '#b966f5' });
    clearTint();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--surface-tint')).toBe('');
  });
  it('parseTint validates a hex accent and rejects junk', () => {
    expect(parseTint(JSON.stringify({ accent: '#abc123' }))?.accent).toBe('#abc123');
    expect(parseTint('not json')).toBeNull();
    expect(parseTint(JSON.stringify({ accent: 'red; }html{}' }))).toBeNull(); // reject non-hex (CSS-injection guard)
  });
  it('hexToHslChannels converts hex → bare "H S% L%" channel form', () => {
    expect(hexToHslChannels('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslChannels('#000000')).toBe('0 0% 0%');
    // 3-digit shorthand expands
    expect(hexToHslChannels('#fff')).toBe('0 0% 100%');
    // a saturated hue resolves to non-zero H + S
    expect(hexToHslChannels('#b966f5')).toMatch(/^\d+ \d+% \d+%$/);
  });
});
