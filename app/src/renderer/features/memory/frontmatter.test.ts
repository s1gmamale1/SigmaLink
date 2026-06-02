// MEM-9 — renderer frontmatter parse/serialize/round-trip.

import { describe, expect, it } from 'vitest';
import {
  applyFrontmatter,
  isFrontmatterFlat,
  parseFrontmatter,
  recordToRows,
  rowsToRecord,
  serializeFrontmatter,
  textToValue,
  valueToText,
} from './frontmatter';

describe('parseFrontmatter', () => {
  it('returns null + bodyStart 0 when there is no block', () => {
    expect(parseFrontmatter('# Just a heading\n')).toEqual({
      frontmatter: null,
      bodyStart: 0,
    });
  });

  it('parses a flat block and reports where the rest begins', () => {
    const body = '---\ntitle: Hello\ncount: 3\ndone: true\n---\nBody text\n';
    const { frontmatter, bodyStart } = parseFrontmatter(body);
    expect(frontmatter).toEqual({ title: 'Hello', count: 3, done: true });
    expect(body.slice(bodyStart)).toBe('Body text\n');
  });

  it('coerces inline lists', () => {
    const { frontmatter } = parseFrontmatter('---\naliases: [Foo, Bar]\n---\n');
    expect(frontmatter).toEqual({ aliases: ['Foo', 'Bar'] });
  });

  it('requires the opening fence on the very first line', () => {
    expect(parseFrontmatter('\n---\ntitle: x\n---\n').frontmatter).toBeNull();
  });

  it('returns null when the closing fence is missing', () => {
    expect(parseFrontmatter('---\ntitle: x\n').frontmatter).toBeNull();
  });

  it('handles CRLF bodies', () => {
    const body = '---\r\ntitle: Hi\r\n---\r\nrest';
    const { frontmatter, bodyStart } = parseFrontmatter(body);
    expect(frontmatter).toEqual({ title: 'Hi' });
    expect(body.slice(bodyStart)).toBe('rest');
  });
});

describe('serializeFrontmatter', () => {
  it('emits a fenced block ending in a newline', () => {
    expect(serializeFrontmatter({ title: 'Hi', n: 2 })).toBe('---\ntitle: Hi\nn: 2\n---\n');
  });

  it('quotes ambiguous scalars so they round-trip', () => {
    expect(serializeFrontmatter({ a: 'true', b: '3', c: 'x: y' })).toBe(
      '---\na: "true"\nb: "3"\nc: "x: y"\n---\n',
    );
  });

  it('serializes lists inline', () => {
    expect(serializeFrontmatter({ tags: ['a', 'b'] })).toBe('---\ntags: [a, b]\n---\n');
  });

  it('returns empty for null / empty', () => {
    expect(serializeFrontmatter(null)).toBe('');
    expect(serializeFrontmatter({})).toBe('');
  });
});

describe('applyFrontmatter', () => {
  it('replaces an existing block, preserving the body', () => {
    const body = '---\ntitle: Old\n---\nThe body\n';
    const out = applyFrontmatter(body, { title: 'New', extra: 1 });
    expect(out).toBe('---\ntitle: New\nextra: 1\n---\nThe body\n');
  });

  it('prepends when there is no existing block', () => {
    const out = applyFrontmatter('Just body', { title: 'T' });
    expect(out).toBe('---\ntitle: T\n---\nJust body');
  });

  it('removes the block when frontmatter is null/empty', () => {
    const body = '---\ntitle: x\n---\nbody';
    expect(applyFrontmatter(body, null)).toBe('body');
  });

  it('round-trips parse → apply with no semantic change', () => {
    const body = '---\ntitle: Hello\ntags: [a, b]\ncount: 5\n---\nText\n';
    const { frontmatter } = parseFrontmatter(body);
    expect(applyFrontmatter(body, frontmatter)).toBe(body);
  });
});

describe('grid helpers', () => {
  it('valueToText flattens lists to comma text', () => {
    expect(valueToText(['a', 'b'])).toBe('a, b');
    expect(valueToText(3)).toBe('3');
    expect(valueToText(null)).toBe('null');
  });

  it('textToValue makes comma text a list', () => {
    expect(textToValue('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(textToValue('hello')).toBe('hello');
    expect(textToValue('42')).toBe(42);
  });

  it('rows ⇄ record round-trips and drops blank keys', () => {
    const rec = { title: 'Hi', tags: ['a', 'b'] };
    const rows = recordToRows(rec);
    expect(rows).toEqual([
      { key: 'title', value: 'Hi' },
      { key: 'tags', value: 'a, b' },
    ]);
    expect(rowsToRecord([...rows, { key: '   ', value: 'ignored' }])).toEqual(rec);
  });

  it('rowsToRecord returns null when nothing usable', () => {
    expect(rowsToRecord([{ key: '', value: 'x' }])).toBeNull();
  });

  // H1 (review) — the grid must only edit faithfully-flat frontmatter; rich
  // YAML (lists, block scalars, nested maps) is gated read-only to prevent loss.
  describe('isFrontmatterFlat (H1 data-loss guard)', () => {
    it('true for no frontmatter / flat key:value blocks', () => {
      expect(isFrontmatterFlat('just a body, no frontmatter')).toBe(true);
      expect(isFrontmatterFlat('---\ntitle: Hi\ntags: [a, b]\n---\nbody')).toBe(true);
      expect(isFrontmatterFlat('---\n# a comment\nkey: val\n---\n')).toBe(true);
    });
    it('false for block scalars, list items, and nested maps', () => {
      expect(isFrontmatterFlat('---\ndesc: |\n  multi\n  line\n---\n')).toBe(false);
      expect(isFrontmatterFlat('---\nauthors:\n  - alice\n  - bob\n---\n')).toBe(false);
      expect(isFrontmatterFlat('---\nnested:\n  key: val\n---\n')).toBe(false);
      expect(isFrontmatterFlat('---\n- top-level-item\n---\n')).toBe(false);
    });
  });
});
