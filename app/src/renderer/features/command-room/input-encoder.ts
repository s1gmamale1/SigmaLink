// DOM terminal presenter P1a (spec 2026-06-12) — keyboard/paste → VT byte
// sequences. The ATTACHED xterm's UI layer encodes keys invisibly; in
// DOM-presenter panes the engine is headless, so we own the mapping. Pure
// module: no DOM, no xterm imports — golden-tested in input-encoder.test.ts.
//
// Scope (P1): the set claude/codex and ordinary line editing consume —
// printables, alt-as-meta, the ctrl block, editing keys, DECCKM-sensitive
// cursor keys with xterm's `1;N` modifier encoding, tilde keys, F1–F12,
// bracketed paste. Mouse reporting and the kitty keyboard protocol are
// explicitly P2 (spec Non-goals).

/** Terminal modes the encoder must respect. Produced by TerminalEngine.modes
 *  (DECCKM `\x1b[?1h` flips applicationCursorKeys; `\x1b[?2004h` flips
 *  bracketedPaste). */
export interface EncoderModes {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
}

/** The subset of KeyboardEvent the encoder reads — keeps tests DOM-free. */
export interface EncoderKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const ESC = '\x1b';

/** xterm modifier parameter: 1 + shift·1 + alt·2 + ctrl·4 (only >1 is emitted). */
function modParam(ev: EncoderKeyEvent): number {
  return 1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0);
}

/** Cursor-style keys: plain → CSI (or SS3 under DECCKM); modified → CSI 1;N. */
function cursorKey(letter: string, ev: EncoderKeyEvent, modes: EncoderModes): string {
  const n = modParam(ev);
  if (n > 1) return `${ESC}[1;${n}${letter}`;
  return modes.applicationCursorKeys ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

/** Tilde keys: plain → CSI <code>~; modified → CSI <code>;N~. */
function tildeKey(code: number, ev: EncoderKeyEvent): string {
  const n = modParam(ev);
  return n > 1 ? `${ESC}[${code};${n}~` : `${ESC}[${code}~`;
}

/** F1–F4: plain → SS3 P/Q/R/S; modified → CSI 1;N P/Q/R/S. */
function ss3FnKey(letter: string, ev: EncoderKeyEvent): string {
  const n = modParam(ev);
  return n > 1 ? `${ESC}[1;${n}${letter}` : `${ESC}O${letter}`;
}

const CTRL_PUNCT: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '`': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
};

const TILDE_CODES: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

const SS3_FN: Record<string, string> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };

const CURSOR_LETTERS: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
};

/**
 * Encode one key event to the bytes a terminal would send, or `null` when the
 * event is not terminal input (bare modifiers, IME dead keys, cmd-shortcuts —
 * those stay with the host app).
 */
export function encodeKeyEvent(ev: EncoderKeyEvent, modes: EncoderModes): string | null {
  // cmd (meta) combos belong to the host app (copy/paste/zoom shortcuts).
  if (ev.metaKey) return null;

  const { key } = ev;

  // Named keys first — their `key` values are multi-char.
  switch (key) {
    case 'Enter':
      return ev.altKey ? `${ESC}\r` : '\r';
    case 'Backspace':
      if (ev.ctrlKey) return '\x08';
      return ev.altKey ? `${ESC}\x7f` : '\x7f';
    case 'Tab':
      return ev.shiftKey ? `${ESC}[Z` : '\t';
    case 'Escape':
      return ESC;
    default:
      break;
  }

  const cursor = CURSOR_LETTERS[key];
  if (cursor) return cursorKey(cursor, ev, modes);

  const ss3 = SS3_FN[key];
  if (ss3) return ss3FnKey(ss3, ev);

  const tilde = TILDE_CODES[key];
  if (tilde !== undefined) return tildeKey(tilde, ev);

  // Printables (KeyboardEvent.key is the produced character, length 1).
  if (key.length === 1) {
    if (ev.ctrlKey) {
      const lower = key.toLowerCase();
      if (lower >= 'a' && lower <= 'z') {
        return String.fromCharCode(lower.charCodeAt(0) - 96);
      }
      const punct = CTRL_PUNCT[key];
      if (punct !== undefined) return punct;
      return null; // no surprise bytes for unmapped ctrl combos
    }
    if (ev.altKey) return ESC + key; // meta-sends-escape
    return key;
  }

  // Bare modifiers, CapsLock, Dead (IME), media keys, …
  return null;
}

/**
 * Encode pasted text: newlines become `\r` (what a terminal Enter sends), and
 * the whole payload is wrapped in bracketed-paste guards when the app has
 * enabled the mode (`\x1b[?2004h`) — that's how shells/TUIs distinguish a
 * paste from typed keys.
 */
export function encodePaste(text: string, modes: EncoderModes): string {
  const normalized = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  return modes.bracketedPaste ? `${ESC}[200~${normalized}${ESC}[201~` : normalized;
}
