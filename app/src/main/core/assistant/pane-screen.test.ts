import { describe, expect, it } from 'vitest';
import { extractPaneScreen } from './pane-screen';

describe('extractPaneScreen', () => {
  it('strips ANSI CSI sequences (colors, cursor moves, clears)', () => {
    const raw = '\x1b[31mred\x1b[0m plain \x1b[2J\x1b[1;1H';
    expect(extractPaneScreen(raw, 1024)).toEqual({ text: 'red plain ', truncated: false });
  });

  it('strips OSC sequences (title, hyperlinks) with BEL and ST terminators', () => {
    const raw = '\x1b]0;my-title\x07before \x1b]8;;https://x\x1b\\after';
    expect(extractPaneScreen(raw, 1024).text).toBe('before after');
  });

  it('normalizes CRLF and lone CR to LF and drops other control chars', () => {
    const raw = 'a\r\nb\rc\x08d\x00';
    expect(extractPaneScreen(raw, 1024).text).toBe('a\nb\ncd');
  });

  it('keeps tabs and newlines', () => {
    expect(extractPaneScreen('a\tb\nc', 1024).text).toBe('a\tb\nc');
  });

  it('returns the TAIL when over maxBytes and flags truncation', () => {
    const raw = 'x'.repeat(100) + 'TAIL';
    const out = extractPaneScreen(raw, 8);
    expect(out.text).toBe('xxxxTAIL');
    expect(out.truncated).toBe(true);
  });

  it('handles empty input', () => {
    expect(extractPaneScreen('', 1024)).toEqual({ text: '', truncated: false });
  });
});
