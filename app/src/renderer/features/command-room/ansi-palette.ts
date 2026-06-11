// DOM terminal presenter P1b — pure ANSI → CSS color mapping for FlowView.
// The 16 base colors MUST stay byte-identical to terminal-cache's THEME so a
// pane looks the same under either renderer; the parity test enforces it.

import type { RunColor } from '@/renderer/lib/terminal-engine';

export const DEFAULT_FG = '#e6e8f0';
export const DEFAULT_BG = '#0a0c12';

export const ANSI_16: readonly string[] = [
  '#0a0c12', '#ef4444', '#22c55e', '#eab308',
  '#60a5fa', '#c084fc', '#22d3ee', '#e6e8f0',
  '#525a73', '#f87171', '#4ade80', '#facc15',
  '#93c5fd', '#d8b4fe', '#67e8f9', '#f8fafc',
];

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** xterm 256-color palette: 16 theme + 6×6×6 cube + 24-step grayscale. */
export function paletteColor(index: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(index)));
  if (i < 16) return ANSI_16[i]!;
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
 *  fg/bg) — keeps default-styled spans free of inline color styles. */
export function colorFor(c: RunColor, _kind: 'fg' | 'bg'): string | null {
  if (c.mode === 'palette') return paletteColor(c.value);
  if (c.mode === 'rgb') return `#${c.value.toString(16).padStart(6, '0')}`;
  return null;
}
