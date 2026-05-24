import { describe, it, expect } from 'vitest';
import { computeSessionStats, appendSessionStat } from './voice-stats';

describe('computeSessionStats', () => {
  it('computes words + wpm from segments', () => {
    const s = computeSessionStats([{ t0: 0, t1: 30_000, text: 'one two three' }]);
    expect(s.words).toBe(3);
    expect(s.durationMs).toBe(30_000);
    expect(Math.round(s.wpm)).toBe(6);
  });

  it('empty → zeros, no divide-by-zero', () => {
    expect(computeSessionStats([])).toEqual({ words: 0, durationMs: 0, wpm: 0 });
  });

  it('counts across multiple segments', () => {
    const segs = [
      { t0: 0, t1: 10_000, text: 'hello world' },
      { t0: 10_000, t1: 20_000, text: 'foo bar baz' },
    ];
    const s = computeSessionStats(segs);
    expect(s.words).toBe(5);
    expect(s.durationMs).toBe(20_000);
  });
});

describe('appendSessionStat', () => {
  it('appends a stat to an empty store', () => {
    const kv = new Map<string, string>();
    const kvAccessor = {
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => { kv.set(k, v); },
    };
    const stat = { words: 10, durationMs: 5000, wpm: 120 };
    appendSessionStat(kvAccessor, stat);
    const stored = JSON.parse(kv.get('voice.stats') ?? '[]') as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('caps the list at 200 entries', () => {
    const kv = new Map<string, string>();
    const existing = Array.from({ length: 200 }, (_, i) => ({
      words: i, durationMs: 1000, wpm: 60, timestamp: i,
    }));
    kv.set('voice.stats', JSON.stringify(existing));
    const kvAccessor = {
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => { kv.set(k, v); },
    };
    appendSessionStat(kvAccessor, { words: 999, durationMs: 1000, wpm: 60 });
    const stored = JSON.parse(kv.get('voice.stats') ?? '[]') as unknown[];
    expect(stored).toHaveLength(200);
    // newest entry at the end
    expect((stored[199] as { words: number }).words).toBe(999);
  });
});
