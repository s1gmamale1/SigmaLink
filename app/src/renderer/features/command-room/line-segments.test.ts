import { describe, expect, it } from 'vitest';
import { segmentRuns, type Decoration } from './line-segments';
import type { StyledRun } from '@/renderer/lib/terminal-engine';

const plain = (text: string): StyledRun => ({
  text,
  fg: { mode: 'default', value: 0 },
  bg: { mode: 'default', value: 0 },
  bold: false, dim: false, italic: false, underline: false, inverse: false, strikethrough: false,
});

describe('segmentRuns', () => {
  it('no decorations → one segment per run, text preserved', () => {
    const segs = segmentRuns([plain('hello '), { ...plain('world'), bold: true } as StyledRun], []);
    expect(segs.map((s) => s.text).join('')).toBe('hello world');
    expect(segs.length).toBe(2);
  });
  it('splits runs at decoration boundaries and tags them', () => {
    const decos: Decoration[] = [{ start: 6, end: 11, link: 'https://w' }];
    const segs = segmentRuns([plain('hello world!')], decos);
    expect(segs.map((s) => s.text)).toEqual(['hello ', 'world', '!']);
    expect(segs[1]!.link).toBe('https://w');
    expect(segs[0]!.link).toBeUndefined();
  });
  it('overlapping search + link decorations both apply', () => {
    const segs = segmentRuns([plain('x https://a.dev y')], [
      { start: 2, end: 15, link: 'https://a.dev' },
      { start: 10, end: 13, search: 'normal' },
    ]);
    const hit = segs.find((s) => s.search)!;
    expect(hit.link).toBe('https://a.dev');
  });
});
