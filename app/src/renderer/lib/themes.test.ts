// @vitest-environment jsdom
// (P5.2: applyDensity touches document.documentElement, so this file needs a DOM.)
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  DEFAULT_DENSITY,
  applyDensity,
  isDensityId,
  isThemeId,
  findTheme,
} from './themes';

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
