import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, isThemeId, findTheme } from './themes';

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
