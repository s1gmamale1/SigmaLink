// wake-word.test.ts — "Hey Jorvis" wake-word matcher tests (C-11 / K3).
//
// The listening loop runs a tiny-model transcribe over the rolling buffer and
// passes the text here. A match escalates to the full capture+dispatch path.
// Matching must be tolerant of casing, surrounding words, and punctuation
// (whisper emits "Hey, Jorvis." etc.) but not fire on unrelated phrases.

import { describe, it, expect } from 'vitest';
import { matchesWakeWord, normalizeForWake } from './wake-word';

describe('matchesWakeWord', () => {
  it('matches the bare phrase', () => {
    expect(matchesWakeWord('hey jorvis')).toBe(true);
  });

  it('matches when embedded in a sentence', () => {
    expect(matchesWakeWord('ok hey jorvis do x')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesWakeWord('HEY JORVIS')).toBe(true);
    expect(matchesWakeWord('Hey Jorvis, open the browser')).toBe(true);
  });

  it('tolerates punctuation between/around the words', () => {
    expect(matchesWakeWord('Hey, Jorvis.')).toBe(true);
    expect(matchesWakeWord('...hey   jorvis!!!')).toBe(true);
    expect(matchesWakeWord('"hey jorvis"')).toBe(true);
  });

  it('tolerates extra interior whitespace and newlines', () => {
    expect(matchesWakeWord('hey \n jorvis')).toBe(true);
    expect(matchesWakeWord('  hey\tjorvis  ')).toBe(true);
  });

  it('does NOT match "hey there"', () => {
    expect(matchesWakeWord('hey there')).toBe(false);
  });

  it('does NOT match "jorvis" alone', () => {
    expect(matchesWakeWord('jorvis')).toBe(false);
  });

  it('does NOT match "hey" alone', () => {
    expect(matchesWakeWord('hey')).toBe(false);
  });

  it('respects word boundaries — "heyjorvis" / "hey jorvistron" do not match', () => {
    expect(matchesWakeWord('heyjorvis')).toBe(false);
    expect(matchesWakeWord('hey jorvistron go')).toBe(false);
  });

  it('does NOT match the reversed order "jorvis hey"', () => {
    expect(matchesWakeWord('jorvis hey')).toBe(false);
  });

  it('returns false for empty / whitespace / non-string-ish input', () => {
    expect(matchesWakeWord('')).toBe(false);
    expect(matchesWakeWord('   ')).toBe(false);
  });
});

describe('normalizeForWake', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForWake('  Hey,\n  JORVIS!! ')).toBe('hey jorvis');
  });

  it('keeps interior word spacing to a single space', () => {
    expect(normalizeForWake('hey      jorvis')).toBe('hey jorvis');
  });
});
