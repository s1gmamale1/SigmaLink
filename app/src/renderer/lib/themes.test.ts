// @vitest-environment jsdom
// (P5.2: applyDensity touches document.documentElement, so this file needs a DOM.)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  DEFAULT_DENSITY,
  applyDensity,
  isDensityId,
  isThemeId,
  findTheme,
  THEMES,
} from './themes';
import {
  AURORA_TERMINAL,
  CUPERTINO_LIGHT_TERMINAL,
  DEFAULT_TERMINAL,
  LIGHT_LEGACY_TERMINAL_CLEAN,
  LIGHT_LEGACY_TERMINAL_PARCHMENT,
} from './terminal-palette';

describe('themes — DEFAULT_THEME is glass', () => {
  it('DEFAULT_THEME === glass', () => {
    expect(DEFAULT_THEME).toBe('glass');
  });

  it('isThemeId("glass") === true', () => {
    expect(isThemeId('glass')).toBe(true);
  });

  it('findTheme(null) falls back to glass', () => {
    expect(findTheme(null).id).toBe('glass');
  });

  it('findTheme("nonsense") falls back to glass', () => {
    expect(findTheme('nonsense').id).toBe('glass');
  });

  it('findTheme("obsidian") still resolves correctly', () => {
    expect(findTheme('obsidian').id).toBe('obsidian');
  });

  it('findTheme(undefined) falls back to glass', () => {
    expect(findTheme(undefined).id).toBe('glass');
  });
});

// P5.2 — global density scale.
describe('themes — density (P5.2)', () => {
  it('DEFAULT_DENSITY === comfortable', () => {
    expect(DEFAULT_DENSITY).toBe('comfortable');
  });

  it('isDensityId accepts the three canonical ids', () => {
    expect(isDensityId('comfortable')).toBe(true);
    expect(isDensityId('cozy')).toBe(true);
    expect(isDensityId('compact')).toBe(true);
  });

  it('isDensityId rejects unknown / non-string values', () => {
    expect(isDensityId('dense')).toBe(false); // dense is a GRID tier, not a density
    expect(isDensityId('')).toBe(false);
    expect(isDensityId(null)).toBe(false);
    expect(isDensityId(undefined)).toBe(false);
    expect(isDensityId(2)).toBe(false);
  });

  it('applyDensity sets <html data-density>', () => {
    applyDensity('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    applyDensity('comfortable');
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable');
  });
});

// BSP-T1/T2 — the Clean + Glass-Spectrum theme library.
describe('themes — catalog (BSP-T1/T2 theme library)', () => {
  it('ships 20 themes (4 classic + 5 glass + 6 clean + 3 aurora + 2 cupertino)', () => {
    expect(THEMES.length).toBe(20);
  });

  it('every theme id is unique', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isThemeId accepts every catalog id + the new families, rejects unknowns', () => {
    for (const t of THEMES) expect(isThemeId(t.id)).toBe(true);
    expect(isThemeId('glass-teal')).toBe(true);
    expect(isThemeId('clean')).toBe(true);
    expect(isThemeId('clean-light')).toBe(true);
    expect(isThemeId('bogus')).toBe(false);
  });

  it('every swatch field is a 6-digit hex', () => {
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const t of THEMES) {
      for (const k of ['bg', 'fg', 'primary', 'accent'] as const) {
        expect(hex.test(t.swatch[k]), `${t.id}.swatch.${k}`).toBe(true);
      }
    }
  });

  it('appearance is dark|light for every theme; clean-light is the only light Clean', () => {
    for (const t of THEMES) {
      expect(t.appearance === 'dark' || t.appearance === 'light').toBe(true);
    }
    expect(THEMES.find((t) => t.id === 'clean-light')?.appearance).toBe('light');
    expect(THEMES.find((t) => t.id === 'clean')?.appearance).toBe('dark');
  });

  it('registers the aurora + cupertino families (Phase 17)', () => {
    for (const id of ['aurora', 'aurora-ember', 'aurora-ice', 'cupertino-light', 'cupertino-dark']) {
      expect(isThemeId(id), id).toBe(true);
    }
    expect(findTheme('cupertino-light').appearance).toBe('light');
    expect(findTheme('cupertino-dark').appearance).toBe('dark');
    expect(findTheme('aurora').appearance).toBe('dark');
  });

  it('every theme carries a complete terminal palette', () => {
    for (const t of THEMES) {
      expect(t.terminal.ansi, t.id).toHaveLength(16);
      expect(t.terminal.background, t.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('dark legacy themes keep the byte-identical default terminal; light + new families diverge', () => {
    for (const id of ['obsidian', 'nord', 'synthwave', 'glass', 'glass-frost', 'clean', 'clean-violet'] as const) {
      expect(findTheme(id).terminal, id).toBe(DEFAULT_TERMINAL);
    }
    expect(findTheme('aurora').terminal).toBe(AURORA_TERMINAL);
    expect(findTheme('cupertino-light').terminal).toBe(CUPERTINO_LIGHT_TERMINAL);
    expect(findTheme('parchment').terminal).toBe(LIGHT_LEGACY_TERMINAL_PARCHMENT);
    expect(findTheme('clean-light').terminal).toBe(LIGHT_LEGACY_TERMINAL_CLEAN);
  });

  // Drift guard (Phase 1 risk): a catalog theme with no CSS block renders
  // invisibly. Assert each id is reachable in index.css — either an explicit
  // `[data-theme='id']` block or its family prefix `[data-theme^='fam']`.
  it('every theme id has a matching CSS block in index.css (no drift)', () => {
    // vitest runs with cwd = app/, so the stylesheet is at src/index.css.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    for (const t of THEMES) {
      // A variant (id contains '-') MUST have its own explicit block — the
      // family-prefix `^=` selector only proves the base exists, so without this
      // an id whose override block was deleted would silently render as the base
      // (e.g. clean-light → the dark clean base despite appearance:'light').
      const reachable = t.id.includes('-')
        ? css.includes(`data-theme='${t.id}'`)
        : css.includes(`data-theme='${t.id}'`) || css.includes(`data-theme^='${t.id}'`);
      expect(reachable, `no CSS block for theme '${t.id}'`).toBe(true);
    }
  });
});
