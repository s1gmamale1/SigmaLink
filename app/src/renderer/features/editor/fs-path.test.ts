import { describe, expect, it } from 'vitest';
import { fsPath, isDescendant } from './fs-path';

describe('fsPath', () => {
  it('joins POSIX segments and trims separators', () => {
    expect(fsPath.join('/a/b', 'c.txt')).toBe('/a/b/c.txt');
    expect(fsPath.join('/a/b/', '/c/')).toBe('/a/b/c');
  });
  it('joins Windows segments with a backslash', () => {
    expect(fsPath.join('C:\\a\\b', 'c.txt')).toBe('C:\\a\\b\\c.txt');
  });
  it('basename returns the trailing segment', () => {
    expect(fsPath.basename('/a/b/c.txt')).toBe('c.txt');
    expect(fsPath.basename('/a/b/')).toBe('b');
  });
  it('dirname returns the parent path', () => {
    expect(fsPath.dirname('/a/b/c.txt')).toBe('/a/b');
    expect(fsPath.dirname('/a')).toBe('/a'); // at/above root: no parent
  });
});

describe('isDescendant', () => {
  it('is true for the path itself', () => {
    expect(isDescendant('/a/b', '/a/b')).toBe(true);
  });
  it('is true for a child path', () => {
    expect(isDescendant('/a/b/c', '/a/b')).toBe(true);
  });
  it('is false for a sibling sharing a name prefix', () => {
    expect(isDescendant('/a/bc', '/a/b')).toBe(false);
  });
  it('is false for an unrelated path', () => {
    expect(isDescendant('/x/y', '/a/b')).toBe(false);
  });
});
