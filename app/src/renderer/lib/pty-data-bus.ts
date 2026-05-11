// V1.1.8 perf-ptybus — renderer-side fan-out for `pty:data`.
//
// Before: every <SessionTerminal> + <PaneSplash> registered its own
// `window.sigma.eventOn('pty:data', …)` listener and dropped 99% of events
// after a runtime `payload.sessionId === ours.id` check. With 16 panes that's
// 32 listeners per chunk; for a CLI streaming at ~50 chunks/sec the fan-out
// cost dominates the renderer event loop.
//
// After: a single process-wide listener routes each payload to the set of
// subscribers registered for its sessionId. Callers no longer pay the
// per-pane type-check or the sibling-pane dispatch cost. The IPC channel and
// the main-process ring buffer in `src/main/rpc-router.ts` are untouched.
//
// This module is renderer-only. It assumes `window.sigma.eventOn` exists —
// the preload bridge mounts it before React boots; if it doesn't, `pty:data`
// would never have worked in the previous implementation either.

interface PtyDataPayload {
  sessionId: string;
  data: string;
}

type Listener = (payload: PtyDataPayload) => void;

const listeners = new Map<string, Set<Listener>>();
let installed = false;
let off: (() => void) | null = null;

function isPtyDataPayload(p: unknown): p is PtyDataPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string' &&
    'data' in p &&
    typeof (p as { data: unknown }).data === 'string'
  );
}

function installOnce(): void {
  if (installed) return;
  // The bus deliberately leaves the global `eventOn` registered for the app
  // lifetime — re-installing on every subscribe cycle (when listener count
  // drops to 0 then climbs again) would defeat the whole point of the
  // single-listener fan-out. The preload `removeListener` cost is paid once
  // on page unload.
  off = window.sigma.eventOn('pty:data', (raw: unknown) => {
    if (!isPtyDataPayload(raw)) return;
    const set = listeners.get(raw.sessionId);
    if (!set) return;
    // Snapshot before dispatch so a subscriber that synchronously
    // unsubscribes itself (legal — e.g. PaneSplash hiding on first byte)
    // doesn't mutate the set we're iterating.
    for (const fn of Array.from(set)) fn(raw);
  });
  installed = true;
}

/**
 * Subscribe to PTY data chunks for a specific session. Returns an
 * unsubscribe function that the caller MUST invoke on unmount.
 *
 * Multiple subscribers per sessionId are supported (e.g. Terminal +
 * PaneSplash share the same session while the boot splash is visible).
 */
export function subscribePtyData(sessionId: string, fn: Listener): () => void {
  installOnce();
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(sessionId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Test-only helper. Resets the module-level singleton state between tests
 * so each `describe` block starts from a clean slate. Not exported through
 * any production code path.
 */
export function __resetPtyDataBus(): void {
  listeners.clear();
  off?.();
  off = null;
  installed = false;
}
