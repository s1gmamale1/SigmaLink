// app/src/main/core/pty/bell-scanner.test.ts
import { describe, expect, it } from 'vitest';
import { BellScanner } from './bell-scanner';

describe('BellScanner', () => {
  it('counts a lone BEL', () => {
    expect(new BellScanner().feed('\x07')).toBe(1);
  });

  it('counts a BEL embedded in text', () => {
    expect(new BellScanner().feed('done\x07next')).toBe(1);
  });

  it('ignores a BEL that terminates an OSC title sequence', () => {
    // ESC ] 0 ; title BEL  → the BEL is a String Terminator, not a bell
    expect(new BellScanner().feed('\x1b]0;my title\x07')).toBe(0);
  });

  it('counts a real BEL after an OSC sequence ends', () => {
    expect(new BellScanner().feed('\x1b]0;title\x07hey\x07')).toBe(1);
  });

  it('ignores an OSC terminator split across chunks', () => {
    const s = new BellScanner();
    expect(s.feed('\x1b]0;ti')).toBe(0);
    expect(s.feed('tle\x07')).toBe(0);
  });

  it('counts a real BEL that arrives in a later chunk after the OSC closed', () => {
    const s = new BellScanner();
    expect(s.feed('\x1b]0;t')).toBe(0);
    expect(s.feed('\x07\x07')).toBe(1); // first BEL closes OSC, second is real
  });

  it('handles OSC-8 hyperlink terminated by ST (ESC backslash) then a real BEL', () => {
    expect(new BellScanner().feed('\x1b]8;;http://x\x1b\\link\x07')).toBe(1);
  });

  it('returns 0 for plain text', () => {
    expect(new BellScanner().feed('no bells here')).toBe(0);
  });
});
