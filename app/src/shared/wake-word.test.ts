// wake-word.test.ts — "Hey Sigma" wake-word matcher tests (C-11 / K3).
//
// The listening loop runs a tiny-model transcribe over the rolling buffer and
// passes the text here. A match escalates to the full capture+dispatch path.
// Matching must be tolerant of casing, surrounding words, and punctuation
// (whisper emits "Hey, Sigma." etc.) but not fire on unrelated phrases.

import { describe, it, expect } from 'vitest';
import { matchesWakeWord, normalizeForWake } from './wake-word';

describe('matchesWakeWord', () => {
  it('matches the bare phrase', () => {
    expect(matchesWakeWord('hey sigma')).toBe(true);
  });

  it('matches when embedded in a sentence', () => {
    expect(matchesWakeWord('ok hey sigma do x')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesWakeWord('HEY SIGMA')).toBe(true);
    expect(matchesWakeWord('Hey Sigma, open the browser')).toBe(true);
  });

  it('tolerates punctuation between/around the words', () => {
    expect(matchesWakeWord('Hey, Sigma.')).toBe(true);
    expect(matchesWakeWord('...hey   sigma!!!')).toBe(true);
    expect(matchesWakeWord('"hey sigma"')).toBe(true);
  });

  it('tolerates extra interior whitespace and newlines', () => {
    expect(matchesWakeWord('hey \n sigma')).toBe(true);
    expect(matchesWakeWord('  hey\tsigma  ')).toBe(true);
  });

  it('does NOT match "hey there"', () => {
    expect(matchesWakeWord('hey there')).toBe(false);
  });

  it('does NOT match "sigma" alone', () => {
    expect(matchesWakeWord('sigma')).toBe(false);
  });

  it('does NOT match "hey" alone', () => {
    expect(matchesWakeWord('hey')).toBe(false);
  });

  it('respects word boundaries — "heysigma" / "hey sigmatron" do not match', () => {
    expect(matchesWakeWord('heysigma')).toBe(false);
    expect(matchesWakeWord('hey sigmatron go')).toBe(false);
  });

  it('does NOT match the reversed order "sigma hey"', () => {
    expect(matchesWakeWord('sigma hey')).toBe(false);
  });

  it('returns false for empty / whitespace / non-string-ish input', () => {
    expect(matchesWakeWord('')).toBe(false);
    expect(matchesWakeWord('   ')).toBe(false);
  });
});

describe('normalizeForWake', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForWake('  Hey,\n  SIGMA!! ')).toBe('hey sigma');
  });

  it('keeps interior word spacing to a single space', () => {
    expect(normalizeForWake('hey      sigma')).toBe('hey sigma');
  });
});
