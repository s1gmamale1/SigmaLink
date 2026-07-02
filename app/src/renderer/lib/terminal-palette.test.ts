import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTerminalPalette,
  AURORA_TERMINAL,
  CUPERTINO_DARK_TERMINAL,
  CUPERTINO_LIGHT_TERMINAL,
  DEFAULT_TERMINAL,
  LIGHT_LEGACY_TERMINAL_CLEAN,
  LIGHT_LEGACY_TERMINAL_PARCHMENT,
  setActiveTerminalPalette,
  subscribeTerminalPalette,
} from './terminal-palette';

const HEX = /^#[0-9a-f]{6}$/i;
const ALL = [
  DEFAULT_TERMINAL,
  AURORA_TERMINAL,
  CUPERTINO_LIGHT_TERMINAL,
  CUPERTINO_DARK_TERMINAL,
  LIGHT_LEGACY_TERMINAL_PARCHMENT,
  LIGHT_LEGACY_TERMINAL_CLEAN,
];

afterEach(() => {
  // Module-level store — always reset so sibling suites see the default.
  setActiveTerminalPalette(DEFAULT_TERMINAL);
});

describe('terminal-palette', () => {
  it('every palette is complete: 16 valid ANSI hex + solid bg/fg', () => {
    for (const p of ALL) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
      expect(p.background).toMatch(HEX); // solid — terminals stay opaque
      expect(p.foreground).toMatch(HEX);
      expect(p.cursor).toMatch(HEX);
      expect(p.cursorAccent).toMatch(HEX);
    }
  });

  it('DEFAULT_TERMINAL is byte-identical to the historical constants', () => {
    expect(DEFAULT_TERMINAL.background).toBe('#0a0c12');
    expect(DEFAULT_TERMINAL.foreground).toBe('#e6e8f0');
    expect(DEFAULT_TERMINAL.cursor).toBe('#a78bfa');
    expect(DEFAULT_TERMINAL.cursorAccent).toBe('#0a0c12');
    expect(DEFAULT_TERMINAL.selectionBackground).toBe('rgba(167, 139, 250, 0.35)');
    expect(DEFAULT_TERMINAL.ansi).toEqual([
      '#0a0c12', '#ef4444', '#22c55e', '#eab308',
      '#60a5fa', '#c084fc', '#22d3ee', '#e6e8f0',
      '#525a73', '#f87171', '#4ade80', '#facc15',
      '#93c5fd', '#d8b4fe', '#67e8f9', '#f8fafc',
    ]);
  });

  it('active palette defaults to DEFAULT_TERMINAL; set notifies; unsubscribe stops', () => {
    expect(activeTerminalPalette()).toBe(DEFAULT_TERMINAL);
    let calls = 0;
    const off = subscribeTerminalPalette(() => {
      calls += 1;
    });
    setActiveTerminalPalette(AURORA_TERMINAL);
    expect(activeTerminalPalette()).toBe(AURORA_TERMINAL);
    expect(calls).toBe(1);
    setActiveTerminalPalette(AURORA_TERMINAL); // same object — no notify
    expect(calls).toBe(1);
    off();
    setActiveTerminalPalette(DEFAULT_TERMINAL);
    expect(calls).toBe(1);
  });
});
