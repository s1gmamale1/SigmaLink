// DOM terminal presenter P1b — pure ANSI → CSS color mapping for FlowView.
// Phase 17: the 16 base colors + defaults resolve through the ACTIVE
// TerminalPalette — the same object terminal-cache builds the xterm theme
// from — so a pane looks the same under either renderer for EVERY theme;
// the all-themes parity test enforces it. Presenter views re-render on
// palette change via the epoch key DomTerminalView passes down.

import type { RunColor } from '@/renderer/lib/terminal-engine';
import { activeTerminalPalette } from '@/renderer/lib/terminal-palette';

/** Default foreground of the active terminal palette (was const DEFAULT_FG). */
export function defaultFg(): string {
  return activeTerminalPalette().foreground;
}

/** Default background of the active terminal palette (was const DEFAULT_BG). */
export function defaultBg(): string {
  return activeTerminalPalette().background;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** xterm 256-color palette: 16 theme + 6×6×6 cube + 24-step grayscale. */
export function paletteColor(index: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(index)));
  if (i < 16) return activeTerminalPalette().ansi[i]!;
  if (i < 232) {
    const v = i - 16;
    const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const r = step(Math.floor(v / 36));
    const g = step(Math.floor((v % 36) / 6));
    const b = step(v % 6);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const gray = 8 + (i - 232) * 10;
  return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`;
}

/** Resolve a run color to CSS, or null for "default" (inherit the view's
 *  fg/bg) — keeps default-styled spans free of inline color styles. The
 *  `kind` arg is part of the call contract (FlowView passes 'fg'/'bg') and
 *  reserved for future fg/bg-specific defaults; it does not branch today. */
export function colorFor(c: RunColor, kind: 'fg' | 'bg'): string | null {
  void kind;
  if (c.mode === 'palette') return paletteColor(c.value);
  if (c.mode === 'rgb') return `#${c.value.toString(16).padStart(6, '0')}`;
  return null;
}
