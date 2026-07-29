// Single source of truth for terminal retention limits.
//
// Before this module the scrollback default lived in BOTH terminal-engine.ts
// (the DOM presenter's headless engine) and terminal-cache.ts (the attached
// xterm), and the LRU cap lived in BOTH terminal-cache.ts and engine-cache.ts.
// Four constants that must agree, declared in four places.

/** Rows retained by an ATTACHED (visible) pane. Unchanged from the shipped
 *  value — the focused pane keeps full history. */
export const DEFAULT_SCROLLBACK_ROWS = 8000;

/** Rows retained by a PARKED (offscreen) pane after trim-on-park.
 *  A pane spawns at 120x32 (main/core/providers/launcher.ts), so this is
 *  ~60 screenfuls — deep enough that re-attaching feels lossless, shallow
 *  enough to bound the cache. */
export const PARKED_SCROLLBACK_ROWS = 2000;

/** Upper bound the Settings input clamps to. A pane row costs memory in both
 *  the xterm buffer and the DOM presenter's engine, so an unbounded value is a
 *  self-inflicted OOM; 100k rows is ~12x the default and far past any real
 *  scrollback need. */
export const MAX_SCROLLBACK_ROWS = 100_000;

/** LRU cap per cache. The stated design target is 16 panes x N workspaces;
 *  32 per cache across two caches was 4x that target. */
export const TERMINAL_CACHE_LIMIT = 20;
export const ENGINE_CACHE_LIMIT = 20;

/** Parse a `pty.scrollbackRows` KV value. Any absent, malformed, or
 *  non-positive value falls back to the default rather than producing a
 *  zero-scrollback terminal. */
export function resolveScrollbackRows(raw: string | null): number {
  if (raw == null || raw === '') return DEFAULT_SCROLLBACK_ROWS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SCROLLBACK_ROWS;
  return parsed;
}
