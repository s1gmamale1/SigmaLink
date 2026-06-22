// Pure extractor for the pane auto-label. Given RENDERED logical lines (from a
// parsed terminal buffer, where cursor-paint has been resolved to real text),
// return the freshest SIGMA::LABEL value. The sentinel must sit at the
// EFFECTIVE line start — after only an optional bullet/indent that the TUI
// paints — so a mid-prose mention does not false-match. Internal whitespace is
// collapsed (the TUI spaces words via cursor-column jumps). Returns null when
// no line qualifies.

// Leading decoration the TUI may paint before the sentinel: whitespace, a
// quote/box-draw glyph, or a bullet. `│`=U+2502, `⏺`=U+23FA, `•`=U+2022.
const SENTINEL = /^[\s>│⏺•*\-]*SIGMA::LABEL\s+(.+?)\s*$/;

export function extractLabel(lines: string[]): string | null {
  let found: string | null = null;
  for (const line of lines) {
    const m = SENTINEL.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text !== '') found = text; // last qualifying line wins
  }
  return found;
}
