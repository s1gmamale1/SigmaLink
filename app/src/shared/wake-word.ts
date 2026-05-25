// wake-word.ts — "Hey Jorvis" wake-word matcher (C-11 / K3).
//
// The always-on listening loop transcribes a rolling audio window with the tiny
// Whisper model and passes the resulting text here. A match escalates to the
// full capture+dispatch path. Matching is deliberately tolerant of casing,
// punctuation, and surrounding words (whisper emits "Hey, Jorvis." or
// "ok hey jorvis do x") but anchored on word boundaries so it does not fire on
// "heyjorvis", "hey jorvistron", or "jorvis" alone.
//
// Out of scope (per plan): a true wake-word ML model. This is the v1
// energy-gated tiny-Whisper phrase match.

/**
 * The wake phrase, anchored on word boundaries. Built once at module load.
 * `\bhey\s+jorvis\b` against a normalized (lowercased, punctuation-stripped,
 * whitespace-collapsed) string.
 */
const WAKE_PATTERN = /\bhey\s+jorvis\b/;

/**
 * Lowercase, replace any non-alphanumeric run with a single space, and trim.
 * This turns whisper output like `"Hey, Jorvis."` into `hey jorvis` so the
 * word-boundary regex matches reliably regardless of punctuation/whitespace.
 */
export function normalizeForWake(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when `text` contains the "hey jorvis" wake phrase (case/punctuation
 * tolerant, word-boundary anchored). Empty / non-string input never matches.
 */
export function matchesWakeWord(text: string): boolean {
  const normalized = normalizeForWake(text);
  if (!normalized) return false;
  return WAKE_PATTERN.test(normalized);
}
