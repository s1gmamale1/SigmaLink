// DOM terminal presenter P1c — shared run → CSSProperties mapping for both
// presenters. `block: true` renders the run as an inline-block (background
// fills the full line box — the v2.4.2 stripe lesson); GridView always uses
// block, FlowView never does (flowing text must stay inline for selection
// and natural wrapping).

import type { CSSProperties } from 'react';
import type { StyledRun } from '@/renderer/lib/terminal-engine';
import { activeTerminalPalette } from '@/renderer/lib/terminal-palette';
import { colorFor, defaultBg, defaultFg } from './ansi-palette';

export function runStyle(run: StyledRun, block: boolean): CSSProperties {
  let color = colorFor(run.fg, 'fg');
  let background = colorFor(run.bg, 'bg');
  if (run.inverse) {
    const fgResolved = color ?? defaultFg();
    const bgResolved = background ?? defaultBg();
    color = bgResolved;
    background = fgResolved;
  }
  const style: CSSProperties = {};
  if (block) {
    style.display = 'inline-block';
    style.verticalAlign = 'top';
  }
  if (color) style.color = color;
  if (background) style.backgroundColor = background;
  if (run.bold) style.fontWeight = 700;
  if (run.dim) style.opacity = 0.6;
  if (run.italic) style.fontStyle = 'italic';
  const deco = [run.underline ? 'underline' : '', run.strikethrough ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (deco) style.textDecoration = deco;
  return style;
}

/**
 * Cursor block style, derived from the ACTIVE per-theme terminal palette so the
 * DOM presenter's cursor matches xterm's (`xtermThemeFrom` feeds the same
 * `cursor`/`cursorAccent` pair). Was a hardcoded legacy-violet constant, which
 * coincided with the default dark palette but broke renderer parity on the
 * Phase-17 light/tinted themes (e.g. cupertino-light: violet vs systemBlue).
 * A function (like `defaultFg()`), not a const — palette-epoch remounts
 * re-render the views, and each render re-reads the active palette.
 */
export function cursorStyle(): CSSProperties {
  const p = activeTerminalPalette();
  return { backgroundColor: p.cursor, color: p.cursorAccent };
}
