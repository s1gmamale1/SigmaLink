// Per-theme terminal palette — the single source of truth for BOTH terminal
// renderers: the xterm theme (terminal-cache builds its ITheme from the active
// palette) and the DOM presenter's ANSI map (ansi-palette reads it per color
// resolve). Dark legacy themes all share DEFAULT_TERMINAL, whose values are
// the historical hardcoded constants byte-for-byte, so existing dark themes
// render identically. Light themes get contrast-checked light palettes
// (GitHub-Light-derived ANSI — proven legible, not a naive inversion).
//
// Palettes are plain data; the module also carries the ACTIVE palette store
// (module-level, useSyncExternalStore-compatible) so pane components can
// re-render on theme switch without threading React context through the
// terminal render path.

import { useSyncExternalStore } from 'react';

export interface TerminalPalette {
  /** Always a solid hex — terminals stay opaque (allowTransparency: false). */
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** 16 ANSI colors: black,red,green,yellow,blue,magenta,cyan,white, then the 8 brights. */
  ansi: readonly string[];
}

export const DEFAULT_TERMINAL: TerminalPalette = {
  background: '#0a0c12',
  foreground: '#e6e8f0',
  cursor: '#a78bfa',
  cursorAccent: '#0a0c12',
  selectionBackground: 'rgba(167, 139, 250, 0.35)',
  ansi: [
    '#0a0c12', '#ef4444', '#22c55e', '#eab308',
    '#60a5fa', '#c084fc', '#22d3ee', '#e6e8f0',
    '#525a73', '#f87171', '#4ade80', '#facc15',
    '#93c5fd', '#d8b4fe', '#67e8f9', '#f8fafc',
  ],
};

// Aurora — velvet floor + ramp-tinted accents (sigma-designs 9-stop ramp).
export const AURORA_TERMINAL: TerminalPalette = {
  background: '#08070d',
  foreground: '#e9e8f2',
  cursor: '#bc82f3',
  cursorAccent: '#08070d',
  selectionBackground: 'rgba(188, 130, 243, 0.32)',
  ansi: [
    '#08070d', '#ff646a', '#3ecf8e', '#ff9a0f',
    '#67a7ff', '#bc82f3', '#6cc9e8', '#e9e8f2',
    '#585670', '#ff8578', '#5fe3a8', '#ffb44d',
    '#8dbcff', '#d1a8f7', '#9be0f5', '#f8f7ff',
  ],
};

// Cupertino light — GitHub-Light-derived ANSI (AA-legible on white).
export const CUPERTINO_LIGHT_TERMINAL: TerminalPalette = {
  background: '#ffffff',
  foreground: '#262626',
  cursor: '#007aff',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0, 122, 255, 0.22)',
  ansi: [
    '#24292f', '#cf222e', '#116329', '#4d2d00',
    '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01',
    '#218bff', '#a475f9', '#3192aa', '#8c959f',
  ],
};

// Cupertino dark — Apple system colors on elevated gray.
export const CUPERTINO_DARK_TERMINAL: TerminalPalette = {
  background: '#1c1c1e',
  foreground: '#e5e5e7',
  cursor: '#0a84ff',
  cursorAccent: '#1c1c1e',
  selectionBackground: 'rgba(10, 132, 255, 0.32)',
  ansi: [
    '#1c1c1e', '#ff453a', '#32d74b', '#ffd60a',
    '#409cff', '#bf5af2', '#64d2ff', '#e5e5e7',
    '#636366', '#ff6961', '#31de4b', '#ffea61',
    '#70b8ff', '#da8fff', '#8fe1ff', '#ffffff',
  ],
};

// Light legacy retrofits — same GH-Light ANSI, surface-matched bg/cursor.
export const LIGHT_LEGACY_TERMINAL_PARCHMENT: TerminalPalette = {
  ...CUPERTINO_LIGHT_TERMINAL,
  background: '#f6f1e7',
  foreground: '#1a1814',
  cursor: '#b75a2c',
  cursorAccent: '#f6f1e7',
  selectionBackground: 'rgba(183, 90, 44, 0.25)',
};

export const LIGHT_LEGACY_TERMINAL_CLEAN: TerminalPalette = {
  ...CUPERTINO_LIGHT_TERMINAL,
  background: '#f7f8fa',
  foreground: '#1a1d22',
  cursor: '#d4711f',
  cursorAccent: '#f7f8fa',
  selectionBackground: 'rgba(212, 113, 31, 0.25)',
};

// ── Active-palette store.
let active: TerminalPalette = DEFAULT_TERMINAL;
let epoch = 0;
const listeners = new Set<() => void>();

export function activeTerminalPalette(): TerminalPalette {
  return active;
}

export function setActiveTerminalPalette(p: TerminalPalette): void {
  if (p === active) return;
  active = p;
  epoch += 1;
  for (const l of listeners) l();
}

export function subscribeTerminalPalette(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Epoch bump per palette change — use as a remount key for presenter views. */
export function useTerminalPaletteEpoch(): number {
  return useSyncExternalStore(subscribeTerminalPalette, () => epoch);
}
