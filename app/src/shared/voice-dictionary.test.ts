import { describe, it, expect } from 'vitest';
import { applyDictionary, type DictionaryEntry } from './voice-dictionary';

const entries: DictionaryEntry[] = [
  { pattern: 'at coordinator', replacement: '@coordinator', type: 'phrase' },
  { pattern: 'new line', replacement: '\n', type: 'macro' },
];

describe('applyDictionary', () => {
  it('replaces phrases case-insensitively, whole-word', () => {
    expect(applyDictionary('tell at coordinator hi', entries)).toBe('tell @coordinator hi');
  });
  it('expands macros', () => {
    expect(applyDictionary('line one new line line two', entries)).toBe('line one \n line two');
  });
  it('no entries → unchanged', () => {
    expect(applyDictionary('hello', [])).toBe('hello');
  });
});
