// DOM terminal presenter P1a (spec 2026-06-12) — golden table for the
// keyboard/paste → VT byte-sequence encoder. This is the job the ATTACHED
// xterm's UI layer did invisibly; in DOM-presenter panes we own it, and a
// wrong byte here is "vim arrow keys type letters" class breakage — hence
// exhaustive goldens over the set claude/codex (and shells later) consume.

import { describe, expect, it } from 'vitest';
import { encodeKeyEvent, encodePaste, isNativePasteCombo, shiftEnterNewline, type EncoderModes } from './input-encoder';

const M = (over: Partial<EncoderModes> = {}): EncoderModes => ({
  applicationCursorKeys: false,
  bracketedPaste: false,
  ...over,
});

function k(
  key: string,
  mods: Partial<{ ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }> = {},
) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
  };
}

describe('encodeKeyEvent — printables', () => {
  it('passes plain printables through', () => {
    expect(encodeKeyEvent(k('a'), M())).toBe('a');
    expect(encodeKeyEvent(k('Z'), M())).toBe('Z');
    expect(encodeKeyEvent(k('/'), M())).toBe('/');
    expect(encodeKeyEvent(k(' '), M())).toBe(' ');
  });

  it('shift+printable is just the (already shifted) char', () => {
    expect(encodeKeyEvent(k('A', { shift: true }), M())).toBe('A');
    expect(encodeKeyEvent(k('?', { shift: true }), M())).toBe('?');
  });

  it('alt acts as meta-sends-escape for printables', () => {
    expect(encodeKeyEvent(k('b', { alt: true }), M())).toBe('\x1bb');
    expect(encodeKeyEvent(k('.', { alt: true }), M())).toBe('\x1b.');
  });

  it('meta (cmd) combos are left to the host app — null', () => {
    expect(encodeKeyEvent(k('c', { meta: true }), M())).toBeNull();
    expect(encodeKeyEvent(k('v', { meta: true }), M())).toBeNull();
  });
});

describe('encodeKeyEvent — control characters', () => {
  it('Ctrl+a..z → \\x01..\\x1a (case-insensitive)', () => {
    expect(encodeKeyEvent(k('a', { ctrl: true }), M())).toBe('\x01');
    expect(encodeKeyEvent(k('c', { ctrl: true }), M())).toBe('\x03');
    expect(encodeKeyEvent(k('z', { ctrl: true }), M())).toBe('\x1a');
    expect(encodeKeyEvent(k('C', { ctrl: true, shift: true }), M())).toBe('\x03');
  });

  it('Ctrl punctuation block', () => {
    expect(encodeKeyEvent(k(' ', { ctrl: true }), M())).toBe('\x00');
    expect(encodeKeyEvent(k('[', { ctrl: true }), M())).toBe('\x1b');
    expect(encodeKeyEvent(k('\\', { ctrl: true }), M())).toBe('\x1c');
    expect(encodeKeyEvent(k(']', { ctrl: true }), M())).toBe('\x1d');
    expect(encodeKeyEvent(k('^', { ctrl: true, shift: true }), M())).toBe('\x1e');
    expect(encodeKeyEvent(k('_', { ctrl: true, shift: true }), M())).toBe('\x1f');
  });

  it('unmapped ctrl+printable → null (no surprise bytes)', () => {
    expect(encodeKeyEvent(k('1', { ctrl: true }), M())).toBeNull();
  });
});

describe('encodeKeyEvent — editing keys', () => {
  it('Enter / shift+Enter / alt+Enter (shift uses provider-resolved newline)', () => {
    expect(encodeKeyEvent(k('Enter'), M())).toBe('\r'); // plain Enter still submits
    expect(encodeKeyEvent(k('Enter', { shift: true }), M())).toBe('\n'); // default newline = LF
    expect(encodeKeyEvent(k('Enter', { shift: true }), M(), { shiftEnterNewline: '\x1b\r' })).toBe('\x1b\r');
    expect(encodeKeyEvent(k('Enter', { alt: true }), M())).toBe('\x1b\r'); // meta-enter unchanged
    expect(encodeKeyEvent(k('Enter', { alt: true, shift: true }), M())).toBe('\x1b\r'); // alt wins
  });

  it('Backspace family (DEL; ctrl→BS; alt→ESC DEL)', () => {
    expect(encodeKeyEvent(k('Backspace'), M())).toBe('\x7f');
    expect(encodeKeyEvent(k('Backspace', { ctrl: true }), M())).toBe('\x08');
    expect(encodeKeyEvent(k('Backspace', { alt: true }), M())).toBe('\x1b\x7f');
  });

  it('Tab / Shift+Tab (CSI Z — the claude mode-cycle key)', () => {
    expect(encodeKeyEvent(k('Tab'), M())).toBe('\t');
    expect(encodeKeyEvent(k('Tab', { shift: true }), M())).toBe('\x1b[Z');
  });

  it('Escape', () => {
    expect(encodeKeyEvent(k('Escape'), M())).toBe('\x1b');
  });
});

describe('shiftEnterNewline — provider-aware newline bytes', () => {
  it('claude uses meta-Enter (ESC CR)', () => {
    expect(shiftEnterNewline('claude')).toBe('\x1b\r');
  });
  it('codex and other providers use LF', () => {
    expect(shiftEnterNewline('codex')).toBe('\n');
    expect(shiftEnterNewline('gemini')).toBe('\n');
    expect(shiftEnterNewline('shell')).toBe('\n');
  });
  it('unknown / undefined provider falls back to LF', () => {
    expect(shiftEnterNewline(undefined)).toBe('\n');
    expect(shiftEnterNewline(null)).toBe('\n');
  });
});

describe('encodeKeyEvent — cursor keys (DECCKM-sensitive)', () => {
  it('normal mode: CSI A-D', () => {
    expect(encodeKeyEvent(k('ArrowUp'), M())).toBe('\x1b[A');
    expect(encodeKeyEvent(k('ArrowDown'), M())).toBe('\x1b[B');
    expect(encodeKeyEvent(k('ArrowRight'), M())).toBe('\x1b[C');
    expect(encodeKeyEvent(k('ArrowLeft'), M())).toBe('\x1b[D');
  });

  it('application cursor mode: SS3 A-D', () => {
    const m = M({ applicationCursorKeys: true });
    expect(encodeKeyEvent(k('ArrowUp'), m)).toBe('\x1bOA');
    expect(encodeKeyEvent(k('ArrowLeft'), m)).toBe('\x1bOD');
  });

  it('modifiers force the CSI 1;N form regardless of DECCKM (N = 1+s·1+a·2+c·4)', () => {
    expect(encodeKeyEvent(k('ArrowUp', { shift: true }), M())).toBe('\x1b[1;2A');
    expect(encodeKeyEvent(k('ArrowRight', { alt: true }), M({ applicationCursorKeys: true }))).toBe(
      '\x1b[1;3C',
    );
    expect(encodeKeyEvent(k('ArrowDown', { ctrl: true }), M())).toBe('\x1b[1;5B');
    expect(encodeKeyEvent(k('ArrowLeft', { ctrl: true, shift: true }), M())).toBe('\x1b[1;6D');
  });

  it('Home/End follow the same pattern (H/F)', () => {
    expect(encodeKeyEvent(k('Home'), M())).toBe('\x1b[H');
    expect(encodeKeyEvent(k('End'), M())).toBe('\x1b[F');
    expect(encodeKeyEvent(k('Home'), M({ applicationCursorKeys: true }))).toBe('\x1bOH');
    expect(encodeKeyEvent(k('End', { ctrl: true }), M())).toBe('\x1b[1;5F');
  });
});

describe('encodeKeyEvent — tilde keys and function keys', () => {
  it('Insert/Delete/PgUp/PgDn', () => {
    expect(encodeKeyEvent(k('Insert'), M())).toBe('\x1b[2~');
    expect(encodeKeyEvent(k('Delete'), M())).toBe('\x1b[3~');
    expect(encodeKeyEvent(k('PageUp'), M())).toBe('\x1b[5~');
    expect(encodeKeyEvent(k('PageDown'), M())).toBe('\x1b[6~');
  });

  it('modified tilde keys insert ;N', () => {
    expect(encodeKeyEvent(k('Delete', { shift: true }), M())).toBe('\x1b[3;2~');
    expect(encodeKeyEvent(k('PageUp', { ctrl: true }), M())).toBe('\x1b[5;5~');
  });

  it('F1–F4 are SS3 P/Q/R/S; modified → CSI 1;N form', () => {
    expect(encodeKeyEvent(k('F1'), M())).toBe('\x1bOP');
    expect(encodeKeyEvent(k('F4'), M())).toBe('\x1bOS');
    expect(encodeKeyEvent(k('F2', { shift: true }), M())).toBe('\x1b[1;2Q');
  });

  it('F5–F12 tilde codes (with the historical 16/22 gaps)', () => {
    expect(encodeKeyEvent(k('F5'), M())).toBe('\x1b[15~');
    expect(encodeKeyEvent(k('F6'), M())).toBe('\x1b[17~');
    expect(encodeKeyEvent(k('F7'), M())).toBe('\x1b[18~');
    expect(encodeKeyEvent(k('F8'), M())).toBe('\x1b[19~');
    expect(encodeKeyEvent(k('F9'), M())).toBe('\x1b[20~');
    expect(encodeKeyEvent(k('F10'), M())).toBe('\x1b[21~');
    expect(encodeKeyEvent(k('F11'), M())).toBe('\x1b[23~');
    expect(encodeKeyEvent(k('F12'), M())).toBe('\x1b[24~');
    expect(encodeKeyEvent(k('F5', { ctrl: true }), M())).toBe('\x1b[15;5~');
  });
});

describe('encodeKeyEvent — non-input keys', () => {
  it('bare modifiers and IME deadkeys → null', () => {
    expect(encodeKeyEvent(k('Shift', { shift: true }), M())).toBeNull();
    expect(encodeKeyEvent(k('Control', { ctrl: true }), M())).toBeNull();
    expect(encodeKeyEvent(k('Meta', { meta: true }), M())).toBeNull();
    expect(encodeKeyEvent(k('CapsLock'), M())).toBeNull();
    expect(encodeKeyEvent(k('Dead'), M())).toBeNull();
  });
});

describe('encodePaste', () => {
  it('normalizes newlines to \\r (terminal paste semantics)', () => {
    expect(encodePaste('a\r\nb\nc', M())).toBe('a\rb\rc');
  });

  it('wraps in bracketed-paste guards only when the mode is on', () => {
    expect(encodePaste('hi', M({ bracketedPaste: true }))).toBe('\x1b[200~hi\x1b[201~');
    expect(encodePaste('hi', M())).toBe('hi');
  });

  it('bracketed wrap composes with newline normalization', () => {
    expect(encodePaste('x\ny', M({ bracketedPaste: true }))).toBe('\x1b[200~x\ry\x1b[201~');
  });
});

describe('isNativePasteCombo — win32/linux paste keybindings pass through', () => {
  it('mac: never (Cmd+V already passes via metaKey; Ctrl+V stays quoted-insert)', () => {
    expect(isNativePasteCombo(k('v', { ctrl: true }), true)).toBe(false);
    expect(isNativePasteCombo(k('V', { ctrl: true, shift: true }), true)).toBe(false);
    expect(isNativePasteCombo(k('Insert', { shift: true }), true)).toBe(false);
  });

  it('non-mac: Ctrl+V and Ctrl+Shift+V are native paste', () => {
    expect(isNativePasteCombo(k('v', { ctrl: true }), false)).toBe(true);
    expect(isNativePasteCombo(k('V', { ctrl: true, shift: true }), false)).toBe(true);
  });

  it('non-mac: Shift+Insert is native paste; Ctrl+Insert / plain Insert are not', () => {
    expect(isNativePasteCombo(k('Insert', { shift: true }), false)).toBe(true);
    expect(isNativePasteCombo(k('Insert', { ctrl: true }), false)).toBe(false);
    expect(isNativePasteCombo(k('Insert'), false)).toBe(false);
  });

  it('non-mac: alt/meta variants and other ctrl letters stay with the terminal', () => {
    expect(isNativePasteCombo(k('v', { ctrl: true, alt: true }), false)).toBe(false);
    expect(isNativePasteCombo(k('v', { meta: true }), false)).toBe(false);
    expect(isNativePasteCombo(k('c', { ctrl: true }), false)).toBe(false); // SIGINT, not copy
  });
});
