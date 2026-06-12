import { describe, expect, it } from 'vitest';
import { findUrls } from './linkify';

describe('findUrls', () => {
  it('finds http(s) URLs with offsets', () => {
    // Offsets hand-derived from the literal string (end is EXCLUSIVE):
    //   "see " = 4 chars → first URL at index 4; "https://a.dev/x" = 15 chars
    //   → end 19. " and " spans 19..23 → "http://b.io" (11 chars) at 24..34
    //   → end 35.
    expect(findUrls('see https://a.dev/x and http://b.io')).toEqual([
      { start: 4, end: 19, url: 'https://a.dev/x' },
      { start: 24, end: 35, url: 'http://b.io' },
    ]);
  });
  it('trims trailing punctuation but keeps path punctuation', () => {
    expect(findUrls('go to https://a.dev/p?q=1).')[0]!.url).toBe('https://a.dev/p?q=1');
    expect(findUrls('(https://a.dev/x(y)z)')[0]!.url).toBe('https://a.dev/x(y)z');
  });
  it('no URLs → empty', () => {
    expect(findUrls('plain shell output')).toEqual([]);
  });
});
