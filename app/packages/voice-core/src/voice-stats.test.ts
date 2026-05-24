import { describe, it, expect } from 'vitest';
import { computeSessionStats, appendSessionStat } from './voice-stats.js';

describe('computeSessionStats (C-10a)', () => {
  it('computes words + duration + wpm from segments', () => {
    const s = computeSessionStats([{ t0: 0, t1: 30_000, text: 'one two three' }]);
    expect(s.words).toBe(3);
    expect(s.durationMs).toBe(30_000);
    expect(Math.round(s.wpm)).toBe(6);
  });

  it('empty segments → zeros (no divide-by-zero)', () => {
    expect(computeSessionStats([])).toEqual({ words: 0, durationMs: 0, wpm: 0 });
  });

  it('sums words across multiple segments', () => {
    const s = computeSessionStats([
      { t0: 0, t1: 1000, text: 'a b' },
      { t0: 1000, t1: 2000, text: 'c' },
    ]);
    expect(s.words).toBe(3);
    expect(s.durationMs).toBe(2000);
  });
});

describe('appendSessionStat (C-10a)', () => {
  function makeKv() {
    const store = new Map<string, string>();
    return {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
      store,
    };
  }

  it('appends a timestamped record to voice.stats', () => {
    const kv = makeKv();
    appendSessionStat(kv, { words: 5, durationMs: 10_000, wpm: 30 });
    const list = JSON.parse(kv.store.get('voice.stats')!) as { words: number; timestamp?: number }[];
    expect(list).toHaveLength(1);
    expect(list[0].words).toBe(5);
    expect(typeof list[0].timestamp).toBe('number');
  });

  it('caps the list at 200 most-recent entries', () => {
    const kv = makeKv();
    for (let i = 0; i < 205; i++) appendSessionStat(kv, { words: i, durationMs: 1, wpm: 1 });
    const list = JSON.parse(kv.store.get('voice.stats')!) as { words: number }[];
    expect(list).toHaveLength(200);
    expect(list[list.length - 1].words).toBe(204);
  });

  it('starts fresh on malformed existing JSON (never throws)', () => {
    const kv = makeKv();
    kv.store.set('voice.stats', '{not json}');
    expect(() => appendSessionStat(kv, { words: 1, durationMs: 1, wpm: 1 })).not.toThrow();
    expect(JSON.parse(kv.store.get('voice.stats')!)).toHaveLength(1);
  });
});
