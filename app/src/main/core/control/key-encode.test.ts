import { describe, it, expect } from 'vitest';
import { encodeKey, encodeKeys } from './key-encode';

describe('key-encode', () => {
  it('maps named keys', () => {
    expect(encodeKey('Enter')).toBe('\r');
    expect(encodeKey('Tab')).toBe('\t');
    expect(encodeKey('Up')).toBe('\x1b[A');
  });
  it('maps C-<letter> control chars', () => {
    expect(encodeKey('C-c')).toBe('\x03');
    expect(encodeKey('C-d')).toBe('\x04');
    expect(encodeKey('C-x')).toBe('\x18');
  });
  it('passes unknown tokens through literally', () => {
    expect(encodeKey('hello')).toBe('hello');
  });
  it('encodeKeys joins the sequence', () => {
    expect(encodeKeys(['l', 's', 'Enter'])).toBe('ls\r');
    expect(encodeKeys(['C-c'])).toBe('\x03');
  });
});
