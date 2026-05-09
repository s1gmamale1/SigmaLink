// Theme catalog + persistence helpers. The visible UI tokens (background,
// foreground, primary, sidebar, etc.) are CSS custom properties declared per
// theme in `src/index.css` — this module is the metadata layer (id, label,
// description, swatches) used by the Appearance tab + command palette.

export type ThemeId = 'obsidian' | 'parchment' | 'nord' | 'synthwave';

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
];

export const DEFAULT_THEME: ThemeId = 'obsidian';

export const KV_KEYS = {
  theme: 'app.theme',
  onboarded: 'app.onboarded',
  sidebarCollapsed: 'app.sidebar.collapsed',
} as const;

export function isThemeId(v: unknown): v is ThemeId {
  return (
    typeof v === 'string' && THEMES.some((t) => t.id === v)
  );
}

export function findTheme(id: string | null | undefined): ThemeDefinition {
  if (!id) return THEMES[0];
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
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
