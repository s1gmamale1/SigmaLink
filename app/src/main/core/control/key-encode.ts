// src/main/core/control/key-encode.ts
//
// Maps human-friendly key names to terminal byte sequences for the send_keys
// tool. Unknown tokens pass through literally (so plain text can be sent too).
// Pure — no imports, vitest-clean.

const KEY_MAP: Record<string, string> = {
  Enter: '\r', Return: '\r', Tab: '\t', Escape: '\x1b', Esc: '\x1b',
  Backspace: '\x7f', Delete: '\x1b[3~', Space: ' ',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
};

export function encodeKey(token: string): string {
  if (Object.prototype.hasOwnProperty.call(KEY_MAP, token)) return KEY_MAP[token];
  // Generic Ctrl-<letter> → control char (C-a=0x01 .. C-z=0x1a).
  const m = /^C-([A-Za-z])$/.exec(token);
  if (m) {
    const code = m[1].toLowerCase().charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) return String.fromCharCode(code);
  }
  return token; // literal passthrough
}

export function encodeKeys(keys: string[]): string {
  return keys.map(encodeKey).join('');
}
