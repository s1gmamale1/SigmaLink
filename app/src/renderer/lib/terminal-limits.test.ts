import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCROLLBACK_ROWS,
  ENGINE_CACHE_LIMIT,
  MAX_SCROLLBACK_ROWS,
  PARKED_SCROLLBACK_ROWS,
  TERMINAL_CACHE_LIMIT,
  resolveScrollbackRows,
} from './terminal-limits';

describe('terminal limits', () => {
  it('keeps the shipped scrollback default unchanged', () => {
    expect(DEFAULT_SCROLLBACK_ROWS).toBe(8000);
  });

  it('trims parked panes well above one screenful', () => {
    // A pane is 32 rows tall by default (providers/launcher.ts spawns 120x32).
    expect(PARKED_SCROLLBACK_ROWS).toBeGreaterThan(32 * 10);
    expect(PARKED_SCROLLBACK_ROWS).toBeLessThan(DEFAULT_SCROLLBACK_ROWS);
  });

  it('caps both caches at the same value so the presenters cannot drift', () => {
    expect(TERMINAL_CACHE_LIMIT).toBe(ENGINE_CACHE_LIMIT);
  });

  it('falls back to the default for absent or malformed settings', () => {
    expect(resolveScrollbackRows(null)).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('not-a-number')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('0')).toBe(DEFAULT_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('-100')).toBe(DEFAULT_SCROLLBACK_ROWS);
  });

  it('honours a valid configured depth', () => {
    expect(resolveScrollbackRows('2500')).toBe(2500);
  });

  it('clamps at the max so a hand-edited KV row cannot OOM the caches', () => {
    // The Settings field clamps at commit, but this resolver is the single
    // choke point EVERY reader goes through (engine-cache, terminal-cache), so
    // the bound belongs here too — a KV value written by hand or by a future
    // second writer must not be honoured verbatim.
    expect(resolveScrollbackRows(String(MAX_SCROLLBACK_ROWS))).toBe(MAX_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows(String(MAX_SCROLLBACK_ROWS + 1))).toBe(MAX_SCROLLBACK_ROWS);
    expect(resolveScrollbackRows('999999999')).toBe(MAX_SCROLLBACK_ROWS);
  });
});
