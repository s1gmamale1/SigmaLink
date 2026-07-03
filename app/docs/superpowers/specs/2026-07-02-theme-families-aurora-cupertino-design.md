# Theme Families: Aurora + Cupertino — Design

**Date:** 2026-07-02 · **Branch:** `feat/theme-families-aurora-cupertino` (off `5681f5e` v2.9.0)
**Approved scope (operator, AskUserQuestion):** both families + per-theme terminal palettes; Cupertino light-first.

## Goal

Two new **material families** — not color swaps — plus per-theme terminal palettes so a
theme governs the whole surface (chrome, panes, *and* terminal content). Each family has
its own material physics, motion language, and terminal palette, following the proven
family pattern established by `glass-material.css` (scoped `[data-theme^='family']`,
token-parameterized, shared chrome contract classes, a11y collapse rules).

## Current state (verified 2026-07-02)

- `src/renderer/lib/themes.ts` — registry of 15 themes: glass ×5 (material:
  `src/styles/glass-material.css`), clean ×6 (flat), 4 legacy color themes.
- `ThemeProvider` applies `data-theme` + `dark`/`light` class; KV `app.theme`;
  ThemeGallery in Settings; CommandPalette switching; density + fontSize orthogonal.
- **Terminal colors are theme-blind:** xterm `THEME` const (`terminal-cache.ts:174`) and
  the DOM presenter `ANSI_16` (`command-room/ansi-palette.ts`) are hardcoded dark,
  byte-parity enforced by test. Light themes get dark terminals.
- Terminals are opaque by hard constraint (`allowTransparency: false`) — unchanged here.
- Chrome contract classes applied by components: `.sl-glass`, `.sl-glass-heavy`,
  `.sl-glass-toolbar`, `.sl-nav-active`; focus state rides the #208 theme-aware glow.

## Design

### 1. Aurora family (sigma-designs — "everything is alive, nothing is neon")

**IDs:** `aurora` (full-spectrum), `aurora-ember` (warm end of ramp), `aurora-ice`
(cool end). All `appearance: 'dark'`.

**Tokens (index.css per-variant blocks):** velvet floor base `#08070d`; fg near-white;
primary/accent picked from the 9-stop ramp (`#ff9a0f…#98aeea`); four per-variant rim/bloom
hues `--aurora-light-{1..4}` (HSL triples, same convention as `--glass-mesh-*`).

**Material (`src/styles/aurora-material.css`, scoped `[data-theme^='aurora']`):**

- **Atmosphere:** blooms-on-velvet body background — 3–4 radial bloom layers on the
  velvet base, each breathing on independent multi-second periods (2.8–4.6s opacity +
  slow transform drift; `transform`/`opacity` only, GPU-cheap). A subtle noise overlay
  (tiny data-URI PNG, low alpha) prevents gradient banding. Corners stay dark — color
  exists as light ON darkness, never flat fills.
- **Chrome:** the contract classes restyle to near-opaque velvet panels with faint
  gradient hairlines and a soft bloom edge. Little to no backdrop blur — blur is the
  glass family's identity; Aurora's identity is *living light*.
- **The living rim (signature):** the focused pane's ring becomes 3–4 independent
  colored lights sliding along the border — stacked conic-gradient layers rotating at
  mixed speeds/directions (ω ≈ 0.52 / −0.69 / 0.83 / −0.47 rad/s → periods ≈ 12.1 /
  9.1 / 7.6 / 13.4 s), each pulsing on 2.8–4.6s periods, masked to a ring. NEVER a single
  traveling highlight, NEVER a static rainbow border, NEVER whole-edge hue rotation.
  Implemented on the existing focus-glow hook (no new component wiring where avoidable).
- **Attention flare:** the agent-attention glow adopts the asymmetric envelope — sharp
  attack, soft decay (solar flare, not sine) — via asymmetric keyframe timing.
- **Motion tokens:** arrivals use emphasized-decelerate `cubic-bezier(0.05, 0.7, 0.1, 1)`.
- **A11y:** `prefers-reduced-motion` → all animation off, static soft rim + static blooms.
  Overlapping lights must not blow to white (alpha caps per layer).

### 2. Cupertino family (apple-design — HIG restraint, Liquid Glass on chrome only)

**IDs:** `cupertino-light` (`appearance: 'light'`, the family face), `cupertino-dark`.

**Tokens:** HIG semantic neutrals (light: near-white surfaces / near-black labels; dark:
elevated grays); ONE accent — systemBlue (`#007AFF` light / `#0A84FF` dark); hairline
borders (1px, ~50% alpha separator); larger continuous-corner radii on chrome (10–12px
feel); type stack override `--font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text',
'Helvetica Neue', system-ui, sans-serif`.

**Material (`src/styles/cupertino-material.css`, scoped `[data-theme^='cupertino']`):**

- **Glass = chrome only:** sidebar/toolbar/popovers get a *quiet* frosted material —
  backdrop blur + high luminosity + desaturation over a plain (not neon-mesh) background.
  Content panes and list rows stay opaque and crisp. Deference: chrome recedes.
- **No decoration:** no glow, no gradient text, no bloom. Hierarchy is carried by type,
  spacing, and hairlines. Elevation = soft diffuse shadows only.
- **Motion:** utility-surface budget — springs/transitions ≤300ms, near-invisible;
  no scroll-driven or ambient animation anywhere.
- **A11y:** `prefers-reduced-transparency` collapses frost to near-opaque;
  `prefers-contrast` thickens hairlines. Light theme text meets AA on all surfaces.
- CSS-only in v1 — **real macOS window vibrancy is out of scope** (wishlisted).

### 3. Per-theme terminal palettes (all themes)

- `ThemeDefinition` gains `terminal: TerminalPalette` — `{ background, foreground,
  cursor, cursorAccent, selectionBackground, ansi: [16 hex] }`. `background` is always a
  solid hex (opacity constraint).
- `DEFAULT_TERMINAL` = today's exact values; ALL existing dark themes (obsidian, nord,
  synthwave, clean-dark variants, glass family) reference it unchanged —
  **byte-identical rendering for existing dark themes**. Tinted dark variants are a
  possible later polish, not part of this unit.
- New families define their own: Aurora = velvet-matched blacks + ramp-tinted ANSI;
  Cupertino-light = light terminal (near-white bg, dark fg, Xcode-light-adjacent ANSI);
  Cupertino-dark = neutral dark. Light legacy themes (`parchment`, `clean-light`) get
  matching light palettes — data-only retrofit riding the same mechanism.
- **Wiring:** `terminal-cache` resolves the active theme's palette instead of the
  `THEME` const; on theme change every cached xterm live-updates via
  `term.options.theme = …`. The DOM presenter's `ansi-palette` resolves through the
  active palette; theme switch triggers presenter re-render.
- **Parity:** the existing xterm↔DOM byte-parity test extends to iterate ALL themes.

### 4. Registry + gallery

New `ThemeId`s and `THEMES` entries (label, description, swatch, appearance). Total
15 → 20 themes. ThemeGallery/CommandPalette pick the new entries up from the registry;
if the gallery needs family grouping headers, add an optional `family` field — decided
in the plan, not here.

### 5. Testing

- `themes.test.ts`: new ids resolve, `isThemeId`, swatch/appearance sanity, every theme
  has a complete `terminal` palette (16 ANSI entries, valid hex).
- Extended xterm↔DOM parity test per theme.
- ThemeGallery renders 20 entries; theme switch applies `data-theme` (existing pattern).
- Local gate: `tsc -b` + full vitest + `eslint .` + build. E2E via CI, not locally.
- **Live verification:** operator eyeballs both families via safe isolated Electron
  launch (`--user-data-dir` recipe), dialing one change at a time — motion claims
  (living rim, breathing blooms) cannot be proven by jsdom.

## Out of scope (→ WISHLIST on this branch)

- macOS real window `vibrancy` for Cupertino + win32 degrade path (main-process).
- Per-theme Electron window `backgroundColor` sync (pre-existing dark boot flash on
  light themes; `electron/main.ts:627,676,682`).
- Aurora synthesized SFX (sigma-designs sfx-palette).
- Additional variants of either family; gallery family-grouping polish beyond need.
- The parked glass cosmetic bug (WISHLIST 2026-07-02, opaque header blur) — separate fix.

## Risks

- **GPU cost of the living rim:** conic-gradient rotation animates cheap properties but
  N panes × 4 layers could add compositing load — rim is FOCUSED PANE ONLY, blooms are
  body-level singletons. Budget verified during live-dial.
- **Light terminal legibility:** bright-ANSI-on-light needs contrast-checked palette
  (Xcode-light-adjacent values, not naive inversions).
- **Parity drift:** the per-theme palette map is a new mirror surface; the extended
  parity test is the guard.
