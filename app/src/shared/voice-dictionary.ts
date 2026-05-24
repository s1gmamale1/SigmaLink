// voice-dictionary.ts — Phrase substitution + verbal command macros for
// SigmaVoice transcripts (C-10a).
//
// Pure module: no runtime deps; importable by both main process and renderer.
// Patterns are applied longest-first to avoid partial overlaps.
//
// Implementation note: substitution uses a case-insensitive split/join
// approach rather than dynamic RegExp construction. This avoids any ReDoS
// risk from user-supplied pattern strings — split() with a string delimiter
// performs a plain literal search with no backtracking engine involved.

export interface DictionaryEntry {
  pattern: string;
  replacement: string;
  type: 'phrase' | 'macro';
}

/** Maximum allowed length for a single dictionary pattern (characters). */
const MAX_PATTERN_LENGTH = 200;

/**
 * Replace all case-insensitive occurrences of the literal string `pattern`
 * in `text` with `replacement` using a split/join strategy.
 *
 * String.prototype.split(string) performs a literal substring search with
 * no regex engine involved, so there is no ReDoS exposure regardless of
 * what characters `pattern` contains.
 */
function replaceLiteral(text: string, pattern: string, replacement: string): string {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  let idx = lowerText.indexOf(lowerPattern, cursor);
  while (idx !== -1) {
    parts.push(text.slice(cursor, idx));
    parts.push(replacement);
    cursor = idx + pattern.length;
    idx = lowerText.indexOf(lowerPattern, cursor);
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Apply a dictionary of phrase/macro entries to `text`.
 *
 * - Entries are applied longest-pattern-first to prevent shorter patterns
 *   from clobbering longer matches that share a prefix.
 * - Matching is case-insensitive and global (all occurrences replaced).
 * - An empty entry list returns the original text unchanged.
 * - Patterns longer than MAX_PATTERN_LENGTH are skipped (safety guard).
 *
 * @param text     The transcript text to transform.
 * @param entries  The dictionary/macro entries to apply.
 * @returns        The transformed text.
 */
export function applyDictionary(text: string, entries: DictionaryEntry[]): string {
  if (entries.length === 0) return text;

  // Sort by pattern length descending so longer patterns take priority.
  const sorted = [...entries].sort((a, b) => b.pattern.length - a.pattern.length);

  let result = text;
  for (const entry of sorted) {
    if (!entry.pattern || entry.pattern.length > MAX_PATTERN_LENGTH) continue;
    result = replaceLiteral(result, entry.pattern, entry.replacement);
  }
  return result;
}
