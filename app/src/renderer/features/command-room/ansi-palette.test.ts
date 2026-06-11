// @vitest-environment jsdom
// (jsdom because the THEME-parity case imports terminal-cache, which imports @xterm/xterm)
import { describe, expect, it } from 'vitest';
import { ANSI_16, colorFor, DEFAULT_BG, DEFAULT_FG, paletteColor } from './ansi-palette';

describe('ansi-palette', () => {
  it('first 16 match the xterm THEME (single visual source of truth)', async () => {
    const { THEME } = await import('@/renderer/lib/terminal-cache');
    expect(ANSI_16).toEqual([
      THEME.black, THEME.red, THEME.green, THEME.yellow,
      THEME.blue, THEME.magenta, THEME.cyan, THEME.white,
      THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow,
      THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite,
    ]);
  });

  it('256-color cube + grayscale follow the xterm formula', () => {
    expect(paletteColor(16)).toBe('#000000');       // cube origin
    expect(paletteColor(196)).toBe('#ff0000');      // pure red corner
    expect(paletteColor(231)).toBe('#ffffff');      // cube max
    expect(paletteColor(232)).toBe('#080808');      // grayscale start
    expect(paletteColor(255)).toBe('#eeeeee');      // grayscale end
  });

  it('colorFor resolves modes; default returns null (CSS inherits)', () => {
    expect(colorFor({ mode: 'default', value: 0 }, 'fg')).toBeNull();
    expect(colorFor({ mode: 'palette', value: 1 }, 'fg')).toBe(ANSI_16[1]);
    expect(colorFor({ mode: 'rgb', value: 0x102030 }, 'bg')).toBe('#102030');
  });

  it('exposes the theme defaults FlowView paints with', () => {
    expect(DEFAULT_FG).toBe('#e6e8f0');
    expect(DEFAULT_BG).toBe('#0a0c12');
  });
});
