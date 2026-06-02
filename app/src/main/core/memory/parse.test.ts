// Tests for the BUG-10 dependency-free frontmatter parser + JSON round-trip
// helpers in parse.ts. (The wikilink extractor is exercised elsewhere.)

import { describe, expect, it } from 'vitest';
import {
  frontmatterFromJson,
  frontmatterToJson,
  parseFrontmatter,
} from './parse';

describe('parseFrontmatter', () => {
  it('returns null when there is no leading frontmatter block', () => {
    expect(parseFrontmatter('just a body, no fence').frontmatter).toBeNull();
    expect(parseFrontmatter('').frontmatter).toBeNull();
  });

  it('returns null when the block is not the very first line', () => {
    const body = 'intro line\n---\nkey: value\n---\n';
    expect(parseFrontmatter(body).frontmatter).toBeNull();
  });

  it('returns null when the opening fence is never closed', () => {
    const body = '---\nkey: value\nno close here';
    expect(parseFrontmatter(body).frontmatter).toBeNull();
  });

  it('parses flat string key: value pairs', () => {
    const body = '---\ntitle: Hello World\nauthor: Jane\n---\nbody text';
    expect(parseFrontmatter(body).frontmatter).toEqual({
      title: 'Hello World',
      author: 'Jane',
    });
  });

  it('coerces numbers (int and float, signed)', () => {
    const body = '---\ncount: 42\nratio: -3.14\nver: 1.2.3\n---\n';
    expect(parseFrontmatter(body).frontmatter).toEqual({
      count: 42,
      ratio: -3.14,
      ver: '1.2.3', // version-like string stays a string, not NaN
    });
  });

  it('coerces booleans and null', () => {
    const body = '---\npinned: true\ndraft: False\narchived: null\n---\n';
    expect(parseFrontmatter(body).frontmatter).toEqual({
      pinned: true,
      draft: false,
      archived: null,
    });
  });

  it('parses inline flow lists with mixed scalar types', () => {
    const body = '---\naliases: [Foo, bar, 3]\nempty: []\n---\n';
    expect(parseFrontmatter(body).frontmatter).toEqual({
      aliases: ['Foo', 'bar', 3],
      empty: [],
    });
  });

  it('strips matching quotes from quoted strings', () => {
    const body = `---\nq1: "a: b"\nq2: 'with spaces'\n---\n`;
    expect(parseFrontmatter(body).frontmatter).toEqual({
      q1: 'a: b',
      q2: 'with spaces',
    });
  });

  it('ignores comments, blanks, and non key:value lines (nested YAML out of scope)', () => {
    const body = [
      '---',
      '# a comment',
      '',
      'kept: yes-string',
      'nested:',
      '  - item', // block-list continuation — ignored
      '---',
      'body',
    ].join('\n');
    // `nested:` has an empty value -> '' ; the `- item` line has no colon -> ignored.
    expect(parseFrontmatter(body).frontmatter).toEqual({
      kept: 'yes-string',
      nested: '',
    });
  });

  it('returns null when the block has no usable key:value lines', () => {
    const body = '---\n# only a comment\n---\nbody';
    expect(parseFrontmatter(body).frontmatter).toBeNull();
  });

  it('tolerates a leading BOM before the fence', () => {
    const body = '\uFEFF---\nkey: value\n---\n';
    expect(parseFrontmatter(body).frontmatter).toEqual({ key: 'value' });
  });
});

describe('frontmatterToJson', () => {
  it('serializes a populated record', () => {
    expect(frontmatterToJson({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('returns null for null or empty records', () => {
    expect(frontmatterToJson(null)).toBeNull();
    expect(frontmatterToJson({})).toBeNull();
  });
});

describe('frontmatterFromJson', () => {
  it('parses a valid object back', () => {
    expect(frontmatterFromJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('collapses null / empty / malformed / non-object to null', () => {
    expect(frontmatterFromJson(null)).toBeNull();
    expect(frontmatterFromJson(undefined)).toBeNull();
    expect(frontmatterFromJson('')).toBeNull();
    expect(frontmatterFromJson('not json {')).toBeNull();
    expect(frontmatterFromJson('[1,2,3]')).toBeNull(); // array is not a record
    expect(frontmatterFromJson('42')).toBeNull();
  });

  it('round-trips through to/from', () => {
    const fm = { title: 'T', aliases: ['a', 'b'], pinned: true };
    const json = frontmatterToJson(fm);
    expect(frontmatterFromJson(json)).toEqual(fm);
  });
});
