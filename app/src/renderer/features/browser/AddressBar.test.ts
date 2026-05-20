// Unit tests for normalizeUrl() in AddressBar.tsx.
//
// v1.5.1-A: normalizeUrl is now exported from AddressBar.tsx; this test file
// imports the real function directly instead of maintaining a duplicate
// inline copy.
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './normalizeUrl';

describe('normalizeUrl — about: handling (v1.4.8 sub-task B)', () => {
  it('passes about:blank through unchanged', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('passes ABOUT:BLANK (case-insensitive) through unchanged', () => {
    expect(normalizeUrl('ABOUT:BLANK')).toBe('about:blank');
  });

  it('routes bare about: through the Google search fallback', () => {
    const result = normalizeUrl('about:');
    expect(result).toContain('google.com/search?q=');
    expect(result).toContain(encodeURIComponent('about:'));
  });

  it('routes about:about through the Google search fallback', () => {
    const result = normalizeUrl('about:about');
    expect(result).toContain('google.com/search?q=');
    expect(result).toContain(encodeURIComponent('about:about'));
  });

  it('routes about:newtab through the Google search fallback', () => {
    const result = normalizeUrl('about:newtab');
    expect(result).toContain('google.com/search?q=');
  });
});

describe('normalizeUrl — normal URL cases (regression)', () => {
  it('returns about:blank for an empty string', () => {
    expect(normalizeUrl('')).toBe('about:blank');
  });

  it('passes https:// URLs through unchanged', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('passes http:// URLs through unchanged', () => {
    expect(normalizeUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('prepends https:// to bare domain names', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('falls back to Google search for plain text queries', () => {
    const result = normalizeUrl('hello world');
    expect(result).toBe('https://www.google.com/search?q=' + encodeURIComponent('hello world'));
  });

  it('passes chrome: URLs through unchanged', () => {
    expect(normalizeUrl('chrome://settings')).toBe('chrome://settings');
  });

  it('passes file: URLs through unchanged', () => {
    expect(normalizeUrl('file:///tmp/foo.html')).toBe('file:///tmp/foo.html');
  });
});
