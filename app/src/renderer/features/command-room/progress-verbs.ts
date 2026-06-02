// ANIM-3 — Rotating progress gerunds for pane "aliveness" strip.
// Pure / DOM-free — safe to import from tests and non-browser contexts.

export const PROGRESS_VERBS: readonly string[] = [
  'Percolating',
  'Cogitating',
  'Spelunking',
  'Conjuring',
  'Synthesizing',
  'Untangling',
  'Marinating',
  'Noodling',
  'Tinkering',
  'Orchestrating',
  'Ruminating',
  'Whittling',
] as const;

/**
 * Returns the verb at position `index % PROGRESS_VERBS.length`.
 * Safe for any non-negative integer; the modulo keeps it in-bounds.
 */
export function pickVerb(index: number): string {
  return PROGRESS_VERBS[((index % PROGRESS_VERBS.length) + PROGRESS_VERBS.length) % PROGRESS_VERBS.length];
}
