// wake-word.ts — "Hey Sigma" wake-word matcher (C-11 / K3).
//
// The always-on listening loop transcribes a rolling audio window with the tiny
// Whisper model and passes the resulting text here. A match escalates to the
// full capture+dispatch path. Matching is deliberately tolerant of casing,
// punctuation, and surrounding words (whisper emits "Hey, Sigma." or
// "ok hey sigma do x") but anchored on word boundaries so it does not fire on
// "heysigma", "hey sigmatron", or "sigma" alone.
//
// Out of scope (per plan): a true wake-word ML model. This is the v1
// energy-gated tiny-Whisper phrase match.

/**
 * The wake phrase, anchored on word boundaries. Built once at module load.
 * `\bhey\s+sigma\b` against a normalized (lowercased, punctuation-stripped,
 * whitespace-collapsed) string.
 */
const WAKE_PATTERN = /\bhey\s+sigma\b/;

/**
 * Lowercase, replace any non-alphanumeric run with a single space, and trim.
 * This turns whisper output like `"Hey, Sigma."` into `hey sigma` so the
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
 * True when `text` contains the "hey sigma" wake phrase (case/punctuation
 * tolerant, word-boundary anchored). Empty / non-string input never matches.
 */
export function matchesWakeWord(text: string): boolean {
  const normalized = normalizeForWake(text);
  if (!normalized) return false;
  return WAKE_PATTERN.test(normalized);
}
