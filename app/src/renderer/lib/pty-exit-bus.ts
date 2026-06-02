// PERF-9 — renderer-side fan-out for `pty:exit`.
//
// Before: every cached terminal (`terminal-cache.ts`) registered its own
// `window.sigma.eventOn('pty:exit', …)` listener and dropped all but its own
// session after a runtime `payload.sessionId === ours` check. With the cache
// capped at TERMINAL_CACHE_LIMIT=32 that's up to 32 raw listeners, each fired
// on every PTY exit and 31/32 of those firings discarded.
//
// After: a single process-wide listener routes each payload to the set of
// subscribers registered for its sessionId — mirroring `pty-data-bus.ts`. The
// IPC channel and the main-process emitter are untouched.
//
// This module is renderer-only. It assumes `window.sigma.eventOn` exists — the
// preload bridge mounts it before React boots; if it doesn't, `pty:exit` would
// never have worked in the previous implementation either.
//
// `use-live-events.ts` (the single app-root listener) and ProviderInstallModal
// keep their own raw `eventOn('pty:exit')` registrations — they are each
// installed once, not per-session, so the per-session fan-out does not apply.

interface PtyExitPayload {
  sessionId: string;
  exitCode: number;
}

type Listener = (payload: PtyExitPayload) => void;

const listeners = new Map<string, Set<Listener>>();
let installed = false;
let off: (() => void) | null = null;

function isPtyExitPayload(p: unknown): p is PtyExitPayload {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string'
  );
}

function installOnce(): void {
  if (installed) return;
  // Like the data bus, the exit bus deliberately leaves the global `eventOn`
  // registered for the app lifetime — re-installing on every subscribe cycle
  // would defeat the single-listener fan-out. The preload `removeListener`
  // cost is paid once on page unload.
  off = window.sigma.eventOn('pty:exit', (raw: unknown) => {
    if (!isPtyExitPayload(raw)) return;
    const set = listeners.get(raw.sessionId);
    if (!set) return;
    // exitCode is forwarded verbatim; non-number values become -1 so callers
    // never have to re-validate (matches the prior terminal-cache behavior).
    const payload: PtyExitPayload = {
      sessionId: raw.sessionId,
      exitCode:
        typeof (raw as { exitCode?: unknown }).exitCode === 'number'
          ? (raw as { exitCode: number }).exitCode
          : -1,
    };
    // Snapshot before dispatch so a subscriber that synchronously
    // unsubscribes itself doesn't mutate the set we're iterating.
    for (const fn of Array.from(set)) fn(payload);
  });
  installed = true;
}

/**
 * Subscribe to PTY exit events for a specific session. Returns an unsubscribe
 * function that the caller MUST invoke when the session is no longer cached.
 *
 * Multiple subscribers per sessionId are supported, though in practice the
 * terminal cache holds exactly one entry (hence one subscriber) per session.
 */
export function subscribeExit(sessionId: string, fn: Listener): () => void {
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
 * Test-only helper. Resets the module-level singleton state between tests so
 * each `describe` block starts from a clean slate. Not exported through any
 * production code path.
 */
export function __resetPtyExitBus(): void {
  listeners.clear();
  off?.();
  off = null;
  installed = false;
}
