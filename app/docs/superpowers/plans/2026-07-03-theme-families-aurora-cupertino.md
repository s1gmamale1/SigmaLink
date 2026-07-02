# Aurora + Cupertino Theme Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new material theme families (Aurora — sigma-designs living light; Cupertino — apple-design HIG light-first) plus per-theme terminal palettes so every theme governs chrome AND terminal content.

**Architecture:** Follow the proven glass-family pattern — per-family material CSS scoped `[data-theme^='family']`, tokens in `index.css`, registry metadata in `themes.ts`. Terminal colors move from two hardcoded constants (xterm `THEME`, DOM `ANSI_16`) to a single `TerminalPalette` per theme, applied live to cached xterm instances and read by the DOM presenter through a module-level active palette + epoch (useSyncExternalStore, no React context needed in pane code).

**Tech Stack:** React 18, Tailwind + CSS custom properties, @xterm/xterm, vitest (jsdom for renderer).

**Spec:** `app/docs/superpowers/specs/2026-07-02-theme-families-aurora-cupertino-design.md`
**Worktree:** `/Users/aisigma/projects/SigmaLink-wt-themes` · branch `feat/theme-families-aurora-cupertino`. All paths below relative to `app/`.

## Global Constraints

- Existing dark themes keep **byte-identical** terminal rendering (they all get `DEFAULT_TERMINAL`, whose values are today's constants verbatim).
- Terminals stay opaque: `TerminalPalette.background` is always a solid hex; `allowTransparency: false` untouched.
- Aurora rim: 3–4 independent lights, mixed directions (12.1s / 9.1s-reverse / 7.6s / 13.4s-reverse), NEVER one traveling highlight, NEVER whole-edge hue-rotate.
- Cupertino: ONE accent (systemBlue `#007AFF` light / `#0A84FF` dark), glass on chrome only, no glow/gradient decoration, motion ≤300ms.
- All new animation collapses under `prefers-reduced-motion`; frost/bloom collapse under `prefers-reduced-transparency`.
- Local gate before push: `npx tsc -b && npx vitest run && npx eslint . && npm run build` — run from `app/`, capture real exit codes (no `| tail`).
- Files ≤500 lines. No `constructor(private x)` (erasableSyntaxOnly). Renderer tests: jsdom docblock + `vi.hoisted()` mocks + `afterEach(cleanup)`.

---

### Task 1: `terminal-palette.ts` — palette data + active-state + epoch

**Files:**
- Create: `src/renderer/lib/terminal-palette.ts`
- Test: `src/renderer/lib/terminal-palette.test.ts`

**Interfaces (produced):**
- `interface TerminalPalette { background; foreground; cursor; cursorAccent; selectionBackground: string; ansi: readonly string[] }` (ansi length 16, order: black,red,green,yellow,blue,magenta,cyan,white + bright×8)
- `DEFAULT_TERMINAL, AURORA_TERMINAL, CUPERTINO_LIGHT_TERMINAL, CUPERTINO_DARK_TERMINAL, LIGHT_LEGACY_TERMINAL_PARCHMENT, LIGHT_LEGACY_TERMINAL_CLEAN: TerminalPalette`
- `setActiveTerminalPalette(p): void` · `activeTerminalPalette(): TerminalPalette` · `subscribeTerminalPalette(cb): () => void` · `useTerminalPaletteEpoch(): number`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/lib/terminal-palette.test.ts
import { describe, expect, it } from 'vitest';
import {
  activeTerminalPalette, AURORA_TERMINAL, CUPERTINO_DARK_TERMINAL,
  CUPERTINO_LIGHT_TERMINAL, DEFAULT_TERMINAL, LIGHT_LEGACY_TERMINAL_CLEAN,
  LIGHT_LEGACY_TERMINAL_PARCHMENT, setActiveTerminalPalette,
  subscribeTerminalPalette,
} from './terminal-palette';

const HEX = /^#[0-9a-f]{6}$/i;
const ALL = [DEFAULT_TERMINAL, AURORA_TERMINAL, CUPERTINO_LIGHT_TERMINAL,
  CUPERTINO_DARK_TERMINAL, LIGHT_LEGACY_TERMINAL_PARCHMENT, LIGHT_LEGACY_TERMINAL_CLEAN];

describe('terminal-palette', () => {
  it('every palette is complete: 16 valid ANSI hex + solid bg', () => {
    for (const p of ALL) {
      expect(p.ansi).toHaveLength(16);
      for (const c of p.ansi) expect(c).toMatch(HEX);
      expect(p.background).toMatch(HEX); // solid — terminals stay opaque
      expect(p.foreground).toMatch(HEX);
    }
  });
  it('DEFAULT_TERMINAL is byte-identical to the historical constants', () => {
    expect(p0(DEFAULT_TERMINAL)).toEqual({
      background: '#0a0c12', foreground: '#e6e8f0', cursor: '#a78bfa',
    });
    expect(DEFAULT_TERMINAL.ansi[0]).toBe('#0a0c12');
    expect(DEFAULT_TERMINAL.ansi[15]).toBe('#f8fafc');
    function p0(p: typeof DEFAULT_TERMINAL) {
      return { background: p.background, foreground: p.foreground, cursor: p.cursor };
    }
  });
  it('active palette defaults to DEFAULT_TERMINAL, set notifies subscribers', () => {
    expect(activeTerminalPalette()).toBe(DEFAULT_TERMINAL);
    let calls = 0;
    const off = subscribeTerminalPalette(() => { calls += 1; });
    setActiveTerminalPalette(AURORA_TERMINAL);
    expect(activeTerminalPalette()).toBe(AURORA_TERMINAL);
    expect(calls).toBe(1);
    off();
    setActiveTerminalPalette(DEFAULT_TERMINAL); // reset for other suites
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/renderer/lib/terminal-palette.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/renderer/lib/terminal-palette.ts
// Per-theme terminal palette — the single source of truth for BOTH terminal
// renderers (xterm theme + DOM presenter ANSI map). Dark legacy themes all
// share DEFAULT_TERMINAL (today's historical constants, byte-identical).
import { useSyncExternalStore } from 'react';

export interface TerminalPalette {
  background: string;   // always a solid hex — terminals stay opaque
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** 16 ANSI colors: black,red,green,yellow,blue,magenta,cyan,white, then brights. */
  ansi: readonly string[];
}

export const DEFAULT_TERMINAL: TerminalPalette = {
  background: '#0a0c12', foreground: '#e6e8f0',
  cursor: '#a78bfa', cursorAccent: '#0a0c12',
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
  background: '#08070d', foreground: '#e9e8f2',
  cursor: '#bc82f3', cursorAccent: '#08070d',
  selectionBackground: 'rgba(188, 130, 243, 0.32)',
  ansi: [
    '#08070d', '#ff646a', '#3ecf8e', '#ff9a0f',
    '#67a7ff', '#bc82f3', '#6cc9e8', '#e9e8f2',
    '#585670', '#ff8578', '#5fe3a8', '#ffb44d',
    '#8dbcff', '#d1a8f7', '#9be0f5', '#f8f7ff',
  ],
};

// Cupertino light — GitHub-Light-derived ANSI (proven AA-legible on white).
export const CUPERTINO_LIGHT_TERMINAL: TerminalPalette = {
  background: '#ffffff', foreground: '#262626',
  cursor: '#007aff', cursorAccent: '#ffffff',
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
  background: '#1c1c1e', foreground: '#e5e5e7',
  cursor: '#0a84ff', cursorAccent: '#1c1c1e',
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
  background: '#f6f1e7', foreground: '#1a1814',
  cursor: '#b75a2c', cursorAccent: '#f6f1e7',
  selectionBackground: 'rgba(183, 90, 44, 0.25)',
};
export const LIGHT_LEGACY_TERMINAL_CLEAN: TerminalPalette = {
  ...CUPERTINO_LIGHT_TERMINAL,
  background: '#f7f8fa', foreground: '#1a1d22',
  cursor: '#d4711f', cursorAccent: '#f7f8fa',
  selectionBackground: 'rgba(212, 113, 31, 0.25)',
};

// ── Active-palette store (module-level; useSyncExternalStore-compatible so
// pane components can re-render on theme switch without React context).
let active: TerminalPalette = DEFAULT_TERMINAL;
let epoch = 0;
const listeners = new Set<() => void>();

export function activeTerminalPalette(): TerminalPalette { return active; }
export function setActiveTerminalPalette(p: TerminalPalette): void {
  if (p === active) return;
  active = p;
  epoch += 1;
  for (const l of listeners) l();
}
export function subscribeTerminalPalette(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** Epoch bump per palette change — use as a remount key for presenter views. */
export function useTerminalPaletteEpoch(): number {
  return useSyncExternalStore(subscribeTerminalPalette, () => epoch);
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/renderer/lib/terminal-palette.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/renderer/lib/terminal-palette.{ts,test.ts} && git commit -m "feat(themes): TerminalPalette data + active-palette store"`

---

### Task 2: registry — 5 new themes + `terminal` field on all 20

**Files:**
- Modify: `src/renderer/lib/themes.ts`
- Test: `src/renderer/lib/themes.test.ts` (extend)

**Interfaces:**
- Consumes: palette constants from Task 1.
- Produces: `ThemeId` extended with `'aurora' | 'aurora-ember' | 'aurora-ice' | 'cupertino-light' | 'cupertino-dark'`; `ThemeDefinition.terminal: TerminalPalette` (required field).

- [ ] **Step 1: Write the failing test** — extend `themes.test.ts`:

```ts
import { AURORA_TERMINAL, CUPERTINO_LIGHT_TERMINAL, DEFAULT_TERMINAL } from './terminal-palette';

it('registers the aurora + cupertino families', () => {
  for (const id of ['aurora', 'aurora-ember', 'aurora-ice', 'cupertino-light', 'cupertino-dark']) {
    expect(isThemeId(id)).toBe(true);
  }
  expect(findTheme('cupertino-light').appearance).toBe('light');
  expect(findTheme('aurora').appearance).toBe('dark');
});
it('every theme carries a complete terminal palette', () => {
  for (const t of THEMES) {
    expect(t.terminal.ansi).toHaveLength(16);
    expect(t.terminal.background).toMatch(/^#[0-9a-f]{6}$/i);
  }
});
it('dark legacy themes keep the byte-identical default terminal', () => {
  for (const id of ['obsidian', 'nord', 'synthwave', 'glass', 'clean'] as const) {
    expect(findTheme(id).terminal).toBe(DEFAULT_TERMINAL);
  }
  expect(findTheme('aurora').terminal).toBe(AURORA_TERMINAL);
  expect(findTheme('cupertino-light').terminal).toBe(CUPERTINO_LIGHT_TERMINAL);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run src/renderer/lib/themes.test.ts`
- [ ] **Step 3: Implement in `themes.ts`:**
  - Extend the `ThemeId` union with the 5 ids (comment each family like the existing glass/clean comments).
  - Add `terminal: TerminalPalette;` to `ThemeDefinition` (import type + constants from `./terminal-palette`).
  - Every existing dark entry gets `terminal: DEFAULT_TERMINAL`; `parchment` → `LIGHT_LEGACY_TERMINAL_PARCHMENT`; `clean-light` → `LIGHT_LEGACY_TERMINAL_CLEAN`.
  - Append 5 new entries:

```ts
// ── Aurora family (sigma-designs) — living light on velvet; material in aurora-material.css.
{ id: 'aurora', label: 'Aurora', description: 'Living light on velvet — breathing blooms, spectrum rim.',
  swatch: { bg: '#08070d', fg: '#e9e8f2', primary: '#bc82f3', accent: '#67a7ff' },
  appearance: 'dark', terminal: AURORA_TERMINAL },
{ id: 'aurora-ember', label: 'Aurora Ember', description: 'Aurora — warm end of the ramp (amber/coral light).',
  swatch: { bg: '#08070d', fg: '#e9e8f2', primary: '#ff8578', accent: '#ff9a0f' },
  appearance: 'dark', terminal: AURORA_TERMINAL },
{ id: 'aurora-ice', label: 'Aurora Ice', description: 'Aurora — cool end of the ramp (blue/periwinkle light).',
  swatch: { bg: '#08070d', fg: '#e9e8f2', primary: '#67a7ff', accent: '#98aeea' },
  appearance: 'dark', terminal: AURORA_TERMINAL },
// ── Cupertino family (apple-design HIG) — light-first restraint; material in cupertino-material.css.
{ id: 'cupertino-light', label: 'Cupertino', description: 'HIG light — quiet frost chrome, one systemBlue accent.',
  swatch: { bg: '#f7f7f9', fg: '#1b1b1e', primary: '#007aff', accent: '#007aff' },
  appearance: 'light', terminal: CUPERTINO_LIGHT_TERMINAL },
{ id: 'cupertino-dark', label: 'Cupertino Dark', description: 'HIG dark — elevated grays, systemBlue accent.',
  swatch: { bg: '#1b1b1d', fg: '#e5e5e7', primary: '#0a84ff', accent: '#0a84ff' },
  appearance: 'dark', terminal: CUPERTINO_DARK_TERMINAL },
```

- [ ] **Step 4: Run to verify PASS** + run gallery/palette suites: `npx vitest run src/renderer/lib/themes.test.ts src/renderer/features/settings src/renderer/features/command-palette` — fix any tile-count assertions (ThemeGallery/SettingsRoom tests) to derive from `THEMES.length`, never a literal.
- [ ] **Step 5: Commit** — `git commit -m "feat(themes): register aurora + cupertino families, terminal palette per theme"`

---

### Task 3: xterm side — derive from active palette + live apply

**Files:**
- Modify: `src/renderer/lib/terminal-cache.ts` (`THEME` const at :174, `theme: THEME` at :240)

**Interfaces:**
- Consumes: `activeTerminalPalette`, `setActiveTerminalPalette`, `TerminalPalette` (Task 1).
- Produces: `xtermThemeFrom(p: TerminalPalette)` (exported, replaces `THEME`); `applyTerminalPalette(p: TerminalPalette): void` — sets the shared active palette AND live-updates every cached xterm.

- [ ] **Step 1: Replace the `THEME` const with:**

```ts
import { activeTerminalPalette, setActiveTerminalPalette, type TerminalPalette } from './terminal-palette';

/** Build the xterm ITheme for a TerminalPalette. Exported for the parity test. */
export function xtermThemeFrom(p: TerminalPalette) {
  const [black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite] = p.ansi;
  return {
    background: p.background, foreground: p.foreground,
    cursor: p.cursor, cursorAccent: p.cursorAccent,
    selectionBackground: p.selectionBackground,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  } as const;
}

/** Theme switch entry point: update the shared palette store (DOM presenter
 *  reads it) and restyle every LIVE cached terminal in place. */
export function applyTerminalPalette(p: TerminalPalette): void {
  setActiveTerminalPalette(p);
  const theme = xtermThemeFrom(p);
  for (const entry of cache.values()) {
    entry.term.options.theme = theme;
  }
}
```

  In `buildTerminalOptions`, replace `theme: THEME,` with `theme: xtermThemeFrom(activeTerminalPalette()),`.
  Check `entry.term` is the field name on `CacheEntry` (read the interface near :140) — use the actual xterm Terminal field.

- [ ] **Step 2: Fix the old parity test** — `src/renderer/features/command-room/ansi-palette.test.ts` imports `THEME`; leave it failing for now (Task 4 rewrites it). Verify compile: `npx tsc -b` → only the parity test should reference the removed `THEME`; grep to confirm no other consumer: `grep -rn "\bTHEME\b" src --include="*.ts*" | grep -v test`.
- [ ] **Step 3: Commit** — `git commit -m "feat(terminal): xterm theme derives from active TerminalPalette + live apply"`

---

### Task 4: DOM presenter — theme-aware ANSI + remount on palette change

**Files:**
- Modify: `src/renderer/features/command-room/ansi-palette.ts` (consts → active-palette reads)
- Modify: `src/renderer/features/command-room/FlowView.tsx` (:20 import, :269/:327 usages)
- Modify: `src/renderer/features/command-room/GridView.tsx` (:14 import, :87-88 usages)
- Modify: `src/renderer/features/command-room/DomTerminalView.tsx` (key GridView :447 / FlowView :449 by epoch)
- Test: rewrite `ansi-palette.test.ts`

**Interfaces:**
- Consumes: `activeTerminalPalette`, `useTerminalPaletteEpoch` (Task 1), `xtermThemeFrom` (Task 3).
- Produces: `defaultFg(): string`, `defaultBg(): string` (replace `DEFAULT_FG`/`DEFAULT_BG` consts); `paletteColor(i)` now reads `activeTerminalPalette().ansi` for i<16. `ANSI_16` export is removed.

- [ ] **Step 1: Rewrite `ansi-palette.ts` color sources:**

```ts
import { activeTerminalPalette } from '@/renderer/lib/terminal-palette';

export function defaultFg(): string { return activeTerminalPalette().foreground; }
export function defaultBg(): string { return activeTerminalPalette().background; }

export function paletteColor(index: number): string {
  const i = Math.max(0, Math.min(255, Math.trunc(index)));
  if (i < 16) return activeTerminalPalette().ansi[i]!;
  // …6×6×6 cube + grayscale branches unchanged…
}
```

  Update FlowView/GridView call sites (`DEFAULT_FG` → `defaultFg()`, `DEFAULT_BG` → `defaultBg()`).
- [ ] **Step 2: Remount presenters on palette change** — in `DomTerminalView.tsx`:

```tsx
import { useTerminalPaletteEpoch } from '@/renderer/lib/terminal-palette';
// inside the component:
const paletteEpoch = useTerminalPaletteEpoch();
// …
<GridView key={`g${paletteEpoch}`} engine={entry.engine} />
<FlowView key={`f${paletteEpoch}`} /* existing props unchanged */ …
```

  (Remount is the deterministic route past row memoization; theme switch is rare and the view re-hydrates from the engine buffer. Scroll snaps to follow-tail — acceptable, note in the commit body.)
- [ ] **Step 3: Rewrite the parity test** (`ansi-palette.test.ts`) — parity is now structural; assert the two renderers read the SAME palette object and the xterm mapping is positionally correct:

```ts
import { activeTerminalPalette, AURORA_TERMINAL, DEFAULT_TERMINAL, setActiveTerminalPalette } from '@/renderer/lib/terminal-palette';
import { defaultBg, defaultFg, paletteColor, colorFor } from './ansi-palette';

it('ANSI 0–15 track the ACTIVE palette for every theme (xterm ↔ DOM parity)', async () => {
  const { xtermThemeFrom } = await import('@/renderer/lib/terminal-cache');
  const { THEMES } = await import('@/renderer/lib/themes');
  try {
    for (const t of THEMES) {
      setActiveTerminalPalette(t.terminal);
      const x = xtermThemeFrom(t.terminal);
      expect([
        x.black, x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan, x.white,
        x.brightBlack, x.brightRed, x.brightGreen, x.brightYellow,
        x.brightBlue, x.brightMagenta, x.brightCyan, x.brightWhite,
      ]).toEqual(Array.from({ length: 16 }, (_, i) => paletteColor(i)));
      expect(defaultBg()).toBe(x.background);
      expect(defaultFg()).toBe(x.foreground);
    }
  } finally { setActiveTerminalPalette(DEFAULT_TERMINAL); }
});
```

  Keep the 256-cube/grayscale + `colorFor` cases as-is (cube is palette-independent ≥16). Drop the `DEFAULT_FG`/`DEFAULT_BG` literal test; update `FlowView.test.tsx` if it imports the removed consts.
- [ ] **Step 4: Run** — `npx vitest run src/renderer/features/command-room/ src/renderer/lib/` → PASS, then FULL suite `npx vitest run` (sibling-mock rule: new imports can break mocked suites).
- [ ] **Step 5: Commit** — `git commit -m "feat(terminal): DOM presenter reads active palette; presenters remount on palette epoch"`

---

### Task 5: ThemeProvider — pair palette apply with theme apply

**Files:**
- Modify: `src/renderer/app/ThemeProvider.tsx` (default effect :38-41, hydrate :57-64, `setTheme` :113-117)

**Interfaces:** Consumes `applyTerminalPalette` (Task 3), `findTheme` (existing).

- [ ] **Step 1: Add a local helper and use it at ALL THREE sites** (sibling-sites rule — grep `applyTheme(` in the file afterward; zero direct calls may remain except inside the helper):

```tsx
import { applyTerminalPalette } from '@/renderer/lib/terminal-cache';
import { findTheme } from '@/renderer/lib/themes'; // add to existing import

function applyThemeAndPalette(id: ThemeId): void {
  applyTheme(id);
  applyTerminalPalette(findTheme(id).terminal);
}
```

- [ ] **Step 2: Run ThemeProvider suites + full suite** — `npx vitest run src/renderer/app/` then `npx vitest run`. terminal-cache loads under jsdom (the old parity test proved it); if a ThemeProvider test still explodes on xterm, `vi.mock('@/renderer/lib/terminal-cache', …)` with a spy and assert it's called with `findTheme(id).terminal`.
- [ ] **Step 3: Add a regression test** (in an existing ThemeProvider test file): `setTheme('aurora')` → spy sees `AURORA_TERMINAL`.
- [ ] **Step 4: Commit** — `git commit -m "feat(themes): theme switch applies terminal palette live"`

---

### Task 6: index.css — token blocks + chrome-tint exclusions + imports

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Imports** — line 1 area, after the glass import:

```css
@import './styles/aurora-material.css';
@import './styles/cupertino-material.css';
```

(Files created empty-with-header in this step so the import resolves; filled in Tasks 7–8.)

- [ ] **Step 2: Five token blocks** after the clean family blocks (~line 585). Each is a FULL block like obsidian's (all tokens listed there). Key values:

```css
/* ── Aurora family (sigma-designs living light) — material in aurora-material.css. */
:root[data-theme='aurora'] {
  --background: 252 30% 4%;        /* velvet #08070d */
  --foreground: 246 24% 93%;
  --card: 250 24% 7%;
  --card-foreground: 246 24% 93%;
  --popover: 250 24% 6%;
  --popover-foreground: 246 24% 93%;
  --primary: 271 82% 73%;          /* #bc82f3 */
  --primary-foreground: 252 30% 6%;
  --secondary: 250 18% 11%;
  --secondary-foreground: 246 24% 93%;
  --muted: 250 16% 13%;
  --muted-foreground: 248 12% 58%;
  --accent: 221 100% 70%;          /* #67a7ff */
  --accent-foreground: 252 30% 6%;
  --destructive: 358 100% 66%;
  --destructive-foreground: 0 0% 98%;
  --border: 250 18% 13%;
  --input: 250 18% 13%;
  --ring: 271 82% 73%;
  --sidebar-background: 252 28% 5%;
  --sidebar-foreground: 246 18% 88%;
  --sidebar-primary: 271 82% 73%;
  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 250 18% 11%;
  --sidebar-accent-foreground: 246 18% 88%;
  --sidebar-border: 250 18% 12%;
  --sidebar-ring: 271 82% 73%;
  /* The 4 independent rim/bloom lights (law of the rim — mixed hues). */
  --aurora-light-1: 33 100% 53%;   /* #ff9a0f  amber   */
  --aurora-light-2: 358 100% 70%;  /* #ff646a  coral   */
  --aurora-light-3: 271 82% 73%;   /* #bc82f3  violet  */
  --aurora-light-4: 221 100% 70%;  /* #67a7ff  blue    */
}
:root[data-theme='aurora-ember'] {  /* inherit-by-repetition like glass variants: repeat full block */
  /* same structural tokens as aurora; swap: */
  --primary: 6 100% 74%;   /* #ff8578 */  --accent: 33 100% 53%;  --ring: 6 100% 74%;
  --aurora-light-1: 33 100% 53%; --aurora-light-2: 35 77% 54%;  /* #e9922b */
  --aurora-light-3: 6 100% 74%;  --aurora-light-4: 341 82% 66%; /* #ef638a */
}
:root[data-theme='aurora-ice'] {
  --primary: 221 100% 70%; --accent: 227 66% 76%; /* #98aeea */ --ring: 221 100% 70%;
  --aurora-light-1: 237 39% 64%;  /* #8186c7 */ --aurora-light-2: 221 100% 70%;
  --aurora-light-3: 227 66% 76%;  --aurora-light-4: 271 82% 73%;
}

/* ── Cupertino family (apple-design HIG) — material in cupertino-material.css. */
:root[data-theme='cupertino-light'] {
  --background: 240 8% 97%;   --foreground: 240 5% 11%;
  --card: 0 0% 100%;          --card-foreground: 240 5% 11%;
  --popover: 0 0% 100%;       --popover-foreground: 240 5% 11%;
  --primary: 211 100% 50%;    /* systemBlue #007aff */
  --primary-foreground: 0 0% 100%;
  --secondary: 240 6% 93%;    --secondary-foreground: 240 5% 11%;
  --muted: 240 6% 93%;        --muted-foreground: 240 4% 42%;
  --accent: 211 100% 50%;     --accent-foreground: 0 0% 100%;
  --destructive: 3 100% 59%;  /* systemRed light #ff3b30 */
  --destructive-foreground: 0 0% 100%;
  --border: 240 6% 87%;       --input: 240 6% 87%;
  --ring: 211 100% 50%;
  --radius: 0.625rem;         /* continuous-corner feel */
  --sidebar-background: 240 7% 95%;
  --sidebar-foreground: 240 5% 20%;
  --sidebar-primary: 211 100% 50%;  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 240 6% 90%;     --sidebar-accent-foreground: 240 5% 15%;
  --sidebar-border: 240 6% 88%;     --sidebar-ring: 211 100% 50%;
}
:root[data-theme='cupertino-dark'] {
  --background: 240 3% 11%;   --foreground: 240 4% 91%;
  --card: 240 3% 14%;         --card-foreground: 240 4% 91%;
  --popover: 240 3% 13%;      --popover-foreground: 240 4% 91%;
  --primary: 211 100% 52%;    /* systemBlue dark #0a84ff */
  --primary-foreground: 0 0% 100%;
  --secondary: 240 3% 17%;    --secondary-foreground: 240 4% 91%;
  --muted: 240 3% 18%;        --muted-foreground: 240 4% 62%;
  --accent: 211 100% 52%;     --accent-foreground: 0 0% 100%;
  --destructive: 4 100% 61%;  /* systemRed dark #ff453a */
  --destructive-foreground: 0 0% 100%;
  --border: 240 3% 22%;       --input: 240 3% 22%;
  --ring: 211 100% 52%;
  --radius: 0.625rem;
  --sidebar-background: 240 4% 9%;
  --sidebar-foreground: 240 4% 85%;
  --sidebar-primary: 211 100% 52%;  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 240 3% 17%;     --sidebar-accent-foreground: 240 4% 88%;
  --sidebar-border: 240 3% 20%;     --sidebar-ring: 211 100% 52%;
}
```

  (Write ember/ice as FULL blocks in the actual file — copy aurora's block then apply the swaps; comments above compress for plan readability only. Both new-family blocks include `--role-*` tokens copied from obsidian.)
- [ ] **Step 3: chrome-tint exclusions** — the opaque `.sl-chrome-tint` wash must not clobber the new materials. At BOTH sites (index.css:183 and :831) change the selector to:

```css
:root:not([data-theme^='glass']):not([data-theme^='aurora']):not([data-theme^='cupertino']) .sl-chrome-tint {
```

  Also READ index.css:790-830 (the "backdrop blur regardless of the active theme" rule) and verify it doesn't fight cupertino frost; adjust its scope the same way ONLY if it targets chrome surfaces.
- [ ] **Step 4:** `npm run build` (vite resolves the new imports) → PASS. Commit — `git commit -m "feat(themes): aurora + cupertino token blocks, chrome-tint scope"`

---

### Task 7: aurora-material.css — atmosphere, chrome, living rim, flare

**Files:**
- Create: `src/styles/aurora-material.css` (~150 lines; every rule scoped `:root[data-theme^='aurora']`)

- [ ] **Step 1: Write the material.** Sections:

**A — Atmosphere (blooms-on-velvet, breathing).** Static velvet + faint blooms on `body`; the BREATHING lives on a fixed `body::before` overlay (transform/opacity only → compositor-cheap) plus an SVG-turbulence dither layer to stop banding:

```css
:root[data-theme^='aurora'] body {
  background-color: hsl(var(--background));
  background-image:
    radial-gradient(50rem 34rem at 16% -8%, hsl(var(--aurora-light-3) / 0.14), transparent 62%),
    radial-gradient(44rem 30rem at 98% 4%, hsl(var(--aurora-light-4) / 0.11), transparent 60%),
    radial-gradient(56rem 36rem at 55% 112%, hsl(var(--aurora-light-1) / 0.08), transparent 64%);
  background-attachment: fixed;
  background-repeat: no-repeat;
}
:root[data-theme^='aurora'] body::before {
  content: '';
  position: fixed; inset: -10%;
  z-index: -1; pointer-events: none;
  background-image:
    radial-gradient(42rem 28rem at 24% 8%, hsl(var(--aurora-light-2) / 0.10), transparent 58%),
    radial-gradient(38rem 26rem at 82% 88%, hsl(var(--aurora-light-4) / 0.09), transparent 60%),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23n)' opacity='0.045'/%3E%3C/svg%3E");
  animation: aurora-breathe 22s var(--ease-smooth) infinite;
}
@keyframes aurora-breathe {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.045); }
}
```

**B — Chrome** (contract classes; near-opaque velvet, bloom hairline, NO heavy blur):

```css
:root[data-theme^='aurora'] .sl-glass,
:root[data-theme^='aurora'] .sl-glass-heavy {
  background: hsl(var(--card) / 0.94);
  border: 1px solid hsl(var(--aurora-light-3) / 0.16);
  box-shadow: 0 0 24px -8px hsl(var(--aurora-light-3) / 0.25);
}
:root[data-theme^='aurora'] .sl-glass-toolbar {
  background: hsl(var(--background) / 0.92);
  border-bottom: 1px solid hsl(var(--aurora-light-4) / 0.14);
}
:root[data-theme^='aurora'] .sl-nav-active {
  background: linear-gradient(90deg, hsl(var(--primary) / 0.16), hsl(var(--accent) / 0.08));
}
```

**C — The living rim** (`@property`-registered angles; 4 independent lights, mixed directions; base ring so gaps never go black; window-blur pauses):

```css
@property --aurora-a1 { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
@property --aurora-a2 { syntax: '<angle>'; inherits: false; initial-value: 137deg; }
@property --aurora-a3 { syntax: '<angle>'; inherits: false; initial-value: 251deg; }
@property --aurora-a4 { syntax: '<angle>'; inherits: false; initial-value: 63deg; }

:root[data-theme^='aurora'] .sl-pane-active::after {
  box-shadow: none;
  padding: 2px;
  background:
    conic-gradient(from var(--aurora-a1), transparent 0 76%, hsl(var(--aurora-light-1) / 0.9) 88%, transparent 100%),
    conic-gradient(from var(--aurora-a2), transparent 0 72%, hsl(var(--aurora-light-2) / 0.8) 86%, transparent 100%),
    conic-gradient(from var(--aurora-a3), transparent 0 78%, hsl(var(--aurora-light-3) / 0.85) 89%, transparent 100%),
    conic-gradient(from var(--aurora-a4), transparent 0 74%, hsl(var(--aurora-light-4) / 0.75) 87%, transparent 100%),
    linear-gradient(hsl(var(--ring) / 0.30) 0 0);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation:
    aurora-rot-1 12.1s linear infinite,
    aurora-rot-2 9.1s linear infinite reverse,
    aurora-rot-3 7.6s linear infinite,
    aurora-rot-4 13.4s linear infinite reverse,
    aurora-rim-breathe 3.7s ease-in-out infinite;
}
@keyframes aurora-rot-1 { to { --aurora-a1: 360deg; } }
@keyframes aurora-rot-2 { to { --aurora-a2: 497deg; } }
@keyframes aurora-rot-3 { to { --aurora-a3: 611deg; } }
@keyframes aurora-rot-4 { to { --aurora-a4: 423deg; } }
@keyframes aurora-rim-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.72; } }

:root[data-theme^='aurora'][data-window-focused='false'] .sl-pane-active::after,
:root[data-theme^='aurora'][data-window-focused='false'] body::before {
  animation-play-state: paused;  /* battery: nothing self-animates in a blurred window */
}
```

**D — Attention flare** (asymmetric envelope — sharp attack, soft decay — overriding `.sl-attention`'s symmetric flicker):

```css
:root[data-theme^='aurora'] .sl-attention {
  animation: aurora-flare 2.6s cubic-bezier(0.05, 0.7, 0.1, 1) 4;
}
@keyframes aurora-flare {
  0%   { box-shadow: 0 0 0 1px hsl(var(--ring) / 0.35), 0 0 4px 0 hsl(var(--ring) / 0.1); }
  12%  { box-shadow: 0 0 0 1.5px hsl(var(--ring) / 0.9), 0 0 16px 4px hsl(var(--ring) / 0.5); }
  100% { box-shadow: 0 0 0 1px hsl(var(--ring) / 0.35), 0 0 4px 0 hsl(var(--ring) / 0.1); }
}
```

**E — A11y collapse** (mirrors glass-material's contract):

```css
@media (prefers-reduced-motion: reduce) {
  :root[data-theme^='aurora'] body::before,
  :root[data-theme^='aurora'] .sl-pane-active::after { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  :root[data-theme^='aurora'] .sl-pane-active::after {
    background: none; padding: 0; mask: none; -webkit-mask: none;
    box-shadow: inset 0 0 0 1.5px hsl(var(--ring));
  }
  :root[data-theme^='aurora'] .sl-glass,
  :root[data-theme^='aurora'] .sl-glass-heavy,
  :root[data-theme^='aurora'] .sl-glass-toolbar { background: hsl(var(--card)); }
}
```

- [ ] **Step 2:** `npm run build && npx vitest run src/renderer/features/command-room/` → PASS (CSS is presentational; the suites guard against import breakage).
- [ ] **Step 3: Commit** — `git commit -m "feat(themes): aurora material — breathing atmosphere, 4-light living rim, flare envelope"`

---

### Task 8: cupertino-material.css — quiet frost, hairlines, restraint

**Files:**
- Create: `src/styles/cupertino-material.css` (~90 lines; every rule scoped `:root[data-theme^='cupertino']`)

- [ ] **Step 1: Write the material:**

```css
/* Chrome-only frost. Luminosity-first (no neon mesh): blur + saturate over the
   flat surface; visibly frosts wherever chrome overlaps content (popovers,
   right-rail, fullscreen-pane chrome), reads as quiet solid elsewhere. */
:root[data-theme^='cupertino'] .sl-glass,
:root[data-theme^='cupertino'] .sl-glass-heavy {
  background: hsl(var(--sidebar-background) / 0.78);
  -webkit-backdrop-filter: blur(24px) saturate(1.35);
  backdrop-filter: blur(24px) saturate(1.35);
  border: 1px solid hsl(var(--border) / 0.7);
  box-shadow: 0 1px 3px hsl(240 5% 10% / 0.07);
}
:root[data-theme^='cupertino'] .sl-glass-toolbar {
  background: hsl(var(--background) / 0.82);
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  backdrop-filter: blur(20px) saturate(1.3);
  border-bottom: 1px solid hsl(var(--border) / 0.8);
}
:root[data-theme^='cupertino'] .sl-nav-active {
  background: hsl(var(--primary) / 0.12);
  color: hsl(var(--primary));
}
/* Deference: the focus ring is a crisp 2px accent — no bloom. */
:root[data-theme^='cupertino'] .sl-pane-active::after {
  box-shadow: inset 0 0 0 2px hsl(var(--ring) / 0.9);
}
/* Subtle body wash so light chrome never sits on a dead-flat field. */
:root[data-theme='cupertino-light'] body {
  background: linear-gradient(180deg, hsl(240 9% 98%), hsl(var(--background)));
}
@media (prefers-reduced-transparency: reduce) {
  :root[data-theme^='cupertino'] .sl-glass,
  :root[data-theme^='cupertino'] .sl-glass-heavy,
  :root[data-theme^='cupertino'] .sl-glass-toolbar {
    -webkit-backdrop-filter: none; backdrop-filter: none;
    background: hsl(var(--sidebar-background));
  }
}
@media (prefers-contrast: more) {
  :root[data-theme^='cupertino'] .sl-glass,
  :root[data-theme^='cupertino'] .sl-glass-heavy,
  :root[data-theme^='cupertino'] .sl-glass-toolbar { border-color: hsl(var(--border)); }
}
```

  No new animation — cupertino rides the existing `--motion*`/`--ease-*` tokens (already ≤350ms).
- [ ] **Step 2:** `npm run build` → PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(themes): cupertino material — chrome-only frost, hairlines, crisp focus ring"`

---

### Task 9: full gate + fixups

- [ ] **Step 1:** From `app/`: `npx tsc -b` → 0 errors; `npx vitest run` → all green (fix any count/mock fallout — derive counts from `THEMES.length`); `npx eslint .` → 0 errors (memory: tsc+vitest miss lint classes); `npm run build` → success. Capture each exit code separately — NEVER pipe to tail.
- [ ] **Step 2:** Grep the sibling-site checklist:
  - `grep -rn "DEFAULT_FG\|DEFAULT_BG\|ANSI_16\b" src/` → zero hits outside terminal-palette internals.
  - `grep -rn "\bTHEME\b" src/renderer/lib/terminal-cache.ts` → only `xtermThemeFrom` remains.
  - `grep -n "sl-chrome-tint" src/index.css` → both sites carry the aurora+cupertino exclusions.
- [ ] **Step 3: Commit any fixups** — `git commit -m "test(themes): gate fixups"`

---

### Task 10: docs + verification handoff

- [ ] **Step 1:** ROADMAP entry via the roadmap skill (phase: theme families), committed on this branch.
- [ ] **Step 2:** Offer the operator a live look: safe isolated Electron launch (`npx electron . --user-data-dir=<scratch>` from `app/`, run_in_background per memory recipe) to eyeball: aurora rim (4 lights, mixed directions), bloom breathing, cupertino-light frost + light terminal, theme switch live-recoloring an OPEN terminal.
- [ ] **Step 3:** Push + PR via sigma-check (operator's standing default) — includes the parity/count receipts in the PR body.

## Self-review (done at write time)

- **Spec coverage:** families ✓ (T6-8), terminal palettes ✓ (T1-5), registry/gallery ✓ (T2), a11y ✓ (T7E/T8), tests ✓ (each task + T9), out-of-scope items already wishlisted ✓.
- **Type consistency:** `TerminalPalette` field names match across T1 (def), T3 (xtermThemeFrom), T4 (ansi-palette reads); `applyTerminalPalette` defined T3, consumed T5. `useTerminalPaletteEpoch` defined T1, consumed T4.
- **Known judgment calls:** presenter remount-on-epoch (vs threading props through row memo) — deterministic, rare-path; documented in T4. `aurora-ember`/`aurora-ice` blocks written full-length in the file despite compressed plan notation (T6 note).
