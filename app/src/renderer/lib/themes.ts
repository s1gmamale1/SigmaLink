// Theme catalog + persistence helpers. The visible UI tokens (background,
// foreground, primary, sidebar, etc.) are CSS custom properties declared per
// theme in `src/index.css` — this module is the metadata layer (id, label,
// description, swatches) used by the Appearance tab + command palette.

export type ThemeId =
  | 'obsidian'
  | 'parchment'
  | 'nord'
  | 'synthwave'
  // Glass family — translucent Liquid-Glass material (glass-material.css applies
  // to every `[data-theme^='glass']`). Variants hue-shift the mesh + accents.
  | 'glass'
  | 'glass-teal'
  | 'glass-violet'
  | 'glass-slate'
  | 'glass-frost'
  // Clean family (BSP-T1) — flat, opaque, zero-blur (no glass-material match).
  // Base is dark/amber; variants swap the accent; `clean-light` is the light cut.
  | 'clean'
  | 'clean-light'
  | 'clean-violet'
  | 'clean-blue'
  | 'clean-rose'
  | 'clean-emerald';

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  description: string;
  swatch: { bg: string; fg: string; primary: string; accent: string };
  /**
   * Whether the theme is dark or light. Used to set `<html>`'s `class`
   * attribute alongside `data-theme` so Tailwind's `dark:` variant + any
   * Radix portals that read the class still work.
   */
  appearance: 'dark' | 'light';
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'obsidian',
    label: 'Obsidian',
    description: 'Default — deep neutral with violet primary.',
    swatch: { bg: '#0a0c10', fg: '#fafafa', primary: '#a86bff', accent: '#E07F4F' },
    appearance: 'dark',
  },
  {
    id: 'parchment',
    label: 'Parchment',
    description: 'Warm light theme with rust accents.',
    swatch: { bg: '#f6f1e7', fg: '#1a1814', primary: '#b75a2c', accent: '#5b7fe0' },
    appearance: 'light',
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Cool, low-saturation blue/teal palette.',
    swatch: { bg: '#1e2530', fg: '#eceff4', primary: '#88c0d0', accent: '#a3be8c' },
    appearance: 'dark',
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    description: 'High-contrast neon dark theme.',
    swatch: { bg: '#10081f', fg: '#f5f3ff', primary: '#ff5bbf', accent: '#5be7ff' },
    appearance: 'dark',
  },
  {
    id: 'glass',
    label: 'Glass',
    description: 'Neon glassmorphism — translucent blurred panels over a cyan/violet glow.',
    swatch: { bg: '#070a14', fg: '#eaf6ff', primary: '#22d3ee', accent: '#a855f7' },
    appearance: 'dark',
  },
  // ── Glass Spectrum (BSP-T2) — same Liquid-Glass material, hue-shifted mesh + accent.
  {
    id: 'glass-teal',
    label: 'Glass Teal',
    description: 'Glass — aqua/teal mesh over a deep teal base.',
    swatch: { bg: '#061412', fg: '#eafcf6', primary: '#2ed6a8', accent: '#22d3ee' },
    appearance: 'dark',
  },
  {
    id: 'glass-violet',
    label: 'Glass Violet',
    description: 'Glass — violet/magenta neon mesh.',
    swatch: { bg: '#0c0716', fg: '#f3eafc', primary: '#b06bff', accent: '#e85bd0' },
    appearance: 'dark',
  },
  {
    id: 'glass-slate',
    label: 'Glass Slate',
    description: 'Glass — muted, low-saturation slate glass.',
    swatch: { bg: '#0a0d12', fg: '#e8eef5', primary: '#a6bace', accent: '#8aa0b8' },
    appearance: 'dark',
  },
  {
    id: 'glass-frost',
    label: 'Glass Frost',
    description: 'Glass — bright frosted white-blue.',
    swatch: { bg: '#08111c', fg: '#f0f8ff', primary: '#7fd4f5', accent: '#b0d8f7' },
    appearance: 'dark',
  },
  // ── Clean family (BSP-T1) — flat, opaque, hairline dividers, single accent ring.
  {
    id: 'clean',
    label: 'Clean',
    description: 'Flat opaque near-black — amber accent, zero blur.',
    swatch: { bg: '#0c0d0f', fg: '#e6e8ea', primary: '#e8833a', accent: '#e8833a' },
    appearance: 'dark',
  },
  {
    id: 'clean-light',
    label: 'Clean Light',
    description: 'Flat light surface — amber accent.',
    swatch: { bg: '#f7f8fa', fg: '#1a1d22', primary: '#d4711f', accent: '#d4711f' },
    appearance: 'light',
  },
  {
    id: 'clean-violet',
    label: 'Clean Violet',
    description: 'Flat dark — violet accent (SigmaLink brand).',
    swatch: { bg: '#0c0d0f', fg: '#e6e8ea', primary: '#a86bff', accent: '#a86bff' },
    appearance: 'dark',
  },
  {
    id: 'clean-blue',
    label: 'Clean Blue',
    description: 'Flat dark — cool blue accent.',
    swatch: { bg: '#0c0d0f', fg: '#e6e8ea', primary: '#4aa3e0', accent: '#4aa3e0' },
    appearance: 'dark',
  },
  {
    id: 'clean-rose',
    label: 'Clean Rose',
    description: 'Flat dark — rose accent.',
    swatch: { bg: '#0c0d0f', fg: '#e6e8ea', primary: '#e05299', accent: '#e05299' },
    appearance: 'dark',
  },
  {
    id: 'clean-emerald',
    label: 'Clean Emerald',
    description: 'Flat dark — emerald accent.',
    swatch: { bg: '#0c0d0f', fg: '#e6e8ea', primary: '#3ecf8e', accent: '#3ecf8e' },
    appearance: 'dark',
  },
];

export const DEFAULT_THEME: ThemeId = 'glass';

/**
 * P5.2 — global density scale. Drives `<html data-density>`, which rescales
 * the `--space-*` tokens declared in `src/index.css`. `comfortable` is the
 * roomy default (Mac density-is-a-feature); `cozy`/`compact` tighten spacing.
 */
export type DensityId = 'comfortable' | 'cozy' | 'compact';

export const DENSITIES: ReadonlyArray<{ id: DensityId; label: string; description: string }> = [
  { id: 'comfortable', label: 'Comfortable', description: 'Roomy — the default.' },
  { id: 'cozy', label: 'Cozy', description: 'Slightly tighter spacing.' },
  { id: 'compact', label: 'Compact', description: 'Maximum information density.' },
];

export const DEFAULT_DENSITY: DensityId = 'comfortable';

export const KV_KEYS = {
  theme: 'app.theme',
  onboarded: 'app.onboarded',
  sidebarCollapsed: 'app.sidebar.collapsed',
  density: 'app.density',
  fontSize: 'app.fontSize',
  zoomFactor: 'app.zoomFactor',
} as const;

export function isDensityId(v: unknown): v is DensityId {
  return typeof v === 'string' && DENSITIES.some((d) => d.id === v);
}

export function isThemeId(v: unknown): v is ThemeId {
  return (
    typeof v === 'string' && THEMES.some((t) => t.id === v)
  );
}

export function findTheme(id: string | null | undefined): ThemeDefinition {
  const defaultTheme = THEMES.find((t) => t.id === DEFAULT_THEME) ?? THEMES[0];
  if (!id) return defaultTheme;
  return THEMES.find((t) => t.id === id) ?? defaultTheme;
}

/**
 * Apply a theme to the document root. Sets `data-theme` (drives the CSS var
 * blocks) and the `dark`/`light` class so any `dark:` Tailwind utility still
 * resolves correctly across themes.
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  const t = findTheme(id);
  const root = document.documentElement;
  root.setAttribute('data-theme', t.id);
  root.classList.toggle('dark', t.appearance === 'dark');
  root.classList.toggle('light', t.appearance === 'light');
}

/**
 * P5.2 — apply the global density to the document root. Sets `data-density`
 * on `<html>`, which selects the matching `--space-scale` override block in
 * `src/index.css` (comfortable = the :root default). Module-level so React
 * code stays free of direct DOM mutations, mirroring `applyTheme`.
 */
export function applyDensity(id: DensityId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', id);
}

/**
 * Apply a numeric base font size (px) to the document root. Module-level
 * helper so React component code can stay free of direct DOM mutations.
 */
export function applyFontSize(px: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${px}px`;
}

/**
 * Set a CSS variable on the document root. Used by AppearanceTab to push
 * the chosen terminal font into a `--terminal-font` token.
 */
export function setRootCssVar(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(name, value);
}
