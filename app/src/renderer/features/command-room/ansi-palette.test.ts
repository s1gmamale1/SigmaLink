// @vitest-environment jsdom
// (jsdom because the parity case imports terminal-cache, which imports @xterm/xterm)
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTerminalPalette,
  DEFAULT_TERMINAL,
  setActiveTerminalPalette,
} from '@/renderer/lib/terminal-palette';
import { colorFor, defaultBg, defaultFg, paletteColor } from './ansi-palette';
import { cursorStyle } from './run-style';

afterEach(() => {
  setActiveTerminalPalette(DEFAULT_TERMINAL);
});

describe('ansi-palette', () => {
  // Phase 17 — parity is structural now: both renderers read the SAME
  // TerminalPalette object. This test pins the positional mapping between
  // xtermThemeFrom's named slots and paletteColor's 0–15 indices, for EVERY
  // registered theme.
  it('ANSI 0–15 + defaults track the active palette for every theme (xterm ↔ DOM parity)', async () => {
    const { xtermThemeFrom } = await import('@/renderer/lib/terminal-cache');
    const { THEMES } = await import('@/renderer/lib/themes');
    for (const t of THEMES) {
      setActiveTerminalPalette(t.terminal);
      const x = xtermThemeFrom(t.terminal);
      expect(
        [
          x.black, x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan, x.white,
          x.brightBlack, x.brightRed, x.brightGreen, x.brightYellow,
          x.brightBlue, x.brightMagenta, x.brightCyan, x.brightWhite,
        ],
        t.id,
      ).toEqual(Array.from({ length: 16 }, (_, i) => paletteColor(i)));
      expect(defaultBg(), t.id).toBe(x.background);
      expect(defaultFg(), t.id).toBe(x.foreground);
      // v2.9.1 — the DOM presenter's cursor block must track the same palette
      // slots xterm renders (was a hardcoded legacy-violet constant, invisible
      // on the default dark palette where the values coincide).
      expect(cursorStyle().backgroundColor, t.id).toBe(x.cursor);
      expect(cursorStyle().color, t.id).toBe(x.cursorAccent);
    }
  });

  it('256-color cube + grayscale follow the xterm formula (palette-independent)', () => {
    expect(paletteColor(16)).toBe('#000000');       // cube origin
    expect(paletteColor(196)).toBe('#ff0000');      // pure red corner
    expect(paletteColor(231)).toBe('#ffffff');      // cube max
    expect(paletteColor(232)).toBe('#080808');      // grayscale start
    expect(paletteColor(255)).toBe('#eeeeee');      // grayscale end
  });

  it('colorFor resolves modes; default returns null (CSS inherits)', () => {
    expect(colorFor({ mode: 'default', value: 0 }, 'fg')).toBeNull();
    expect(colorFor({ mode: 'palette', value: 1 }, 'fg')).toBe(activeTerminalPalette().ansi[1]);
    expect(colorFor({ mode: 'rgb', value: 0x102030 }, 'bg')).toBe('#102030');
  });

  it('defaults expose the historical values under the default palette', () => {
    expect(defaultFg()).toBe('#e6e8f0');
    expect(defaultBg()).toBe('#0a0c12');
  });
});
