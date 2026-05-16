// V1.4.2 packet-03 (Layer 2 — Approach B): renderer-side terminal-instance
// cache. Closes the v1.2.7 follow-up "True xterm instance preservation"
// (`docs/08-bugs/BACKLOG.md` line 40) and the v1.4.1 dogfood "feels frozen
// after room switch" report. The user's stated mental model is a "normal
// terminal multiplexer" — output keeps flowing and scrollback survives no
// matter which room/workspace is focused.
//
// Why Approach B (cache) instead of Approach A (React 19 `<Activity>`):
//
//   • Approach A only fixes the room-switch case (Settings ↔ Command).
//     When the user switches workspaces (A → B → A), `<CommandRoom>` stays
//     mounted but the `<SessionTerminal>` children rerender with NEW
//     sessionIds — `<Activity>` cannot help because the React keys differ.
//   • Approach B is keyed by sessionId at the module-singleton level.
//     Terminals survive both room AND workspace switches without any change
//     to `App.tsx`'s lazy/Suspense composition. Packets 12 (Pane Focus) and
//     07 (rAF audit) compose on top without conflict.
//
// Lifecycle:
//
//   getOrCreateTerminal(sessionId, ctx)
//     → returns a cached `Terminal` instance (cache hit) or constructs one
//       (cache miss). On miss, also subscribes to the PTY data bus AND fires
//       the snapshot RPC (Layer 1 race-safe ordering). The subscription
//       persists across remounts — the cached terminal keeps receiving
//       output even while detached from the DOM.
//
//   attachToHost(entry, host)
//     → moves the xterm DOM root into `host` (call once per React mount).
//
//   detachFromHost(entry)
//     → parks the xterm DOM root in an offscreen "parking lot" div. Does
//       NOT dispose; the listener and scrollback survive.
//
//   destroy(sessionId)
//     → real dispose. Call when the underlying session is permanently gone
//       (REMOVE_SESSION dispatch in CommandRoom, or LRU eviction).
//
// LRU policy: cap at 32 cached instances. The upper-bound design target is
// 16 panes × N workspaces; eviction kicks in only when the user accumulates
// far more sessions than they're actively working with. Evicted entries are
// disposed (xterm + listeners + DOM), which is fine because the PTY itself
// keeps running in the main process — a future remount just rebuilds.

import { Terminal as XTerm, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { rpc } from '@/renderer/lib/rpc';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';

/** Maximum number of cached xterm instances before LRU eviction. */
export const TERMINAL_CACHE_LIMIT = 32;

export interface TerminalCacheContext {
  /** Mutable holder the React mount updates so the link-handler closure
   *  inside xterm always sees the latest active workspace id without
   *  needing to recreate the terminal. */
  wsIdRef: { current: string | undefined };
  /** Click-router function from `Terminal.tsx`. Identity is stable per
   *  module so we accept the latest reference on every getOrCreate call;
   *  the first call wires the addon. */
  routeLinkClick: (url: string, workspaceId: string | undefined) => void;
}

export interface CacheEntry {
  sessionId: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  /** Live PTY-data bus unsubscribe. Created once on first miss; persists
   *  across mounts so we never miss bytes between mount cycles. */
  unsubscribePty: () => void;
  /** xterm `onData` disposer — writes user keystrokes back to the PTY.
   *  Created once on first miss; never recreated on remount. */
  onDataDispose: { dispose: () => void };
  /** Global `pty:exit` listener disposer. Owned by the cache so the exit
   *  message gets written exactly once into the scrollback, regardless of
   *  whether the terminal happened to be mounted at exit time. */
  offExit: () => void;
  /** Last time this entry was mounted into a real DOM host. Used by LRU. */
  lastAccessed: number;
  /** True once the underlying PTY emitted `pty:exit`. Resize observers
   *  consult this to avoid forwarding into a dead handle. */
  ptyExited: boolean;
  /** True after the snapshot RPC has resolved and pending chunks drained
   *  (or after a remount, where snapshot is skipped entirely). */
  snapshotReady: boolean;
}

const cache = new Map<string, CacheEntry>();
let parkingLot: HTMLDivElement | null = null;

function ensureParkingLot(): HTMLDivElement {
  if (parkingLot && parkingLot.isConnected) return parkingLot;
  const div = document.createElement('div');
  div.setAttribute('data-sigmalink-terminal-parking', 'true');
  // Offscreen, hidden but with non-zero size so xterm's measurement DOM
  // continues to work when the terminal is detached. `aria-hidden` keeps
  // assistive tech from announcing the parked output twice.
  div.style.position = 'absolute';
  div.style.left = '-99999px';
  div.style.top = '0';
  div.style.width = '1024px';
  div.style.height = '768px';
  div.style.visibility = 'hidden';
  div.setAttribute('aria-hidden', 'true');
  document.body.appendChild(div);
  parkingLot = div;
  return div;
}

const THEME = {
  background: '#0a0c12',
  foreground: '#e6e8f0',
  cursor: '#a78bfa',
  cursorAccent: '#0a0c12',
  selectionBackground: 'rgba(167, 139, 250, 0.35)',
  black: '#0a0c12',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e6e8f0',
  brightBlack: '#525a73',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
} as const;

function buildTerminalOptions(ctx: TerminalCacheContext): ITerminalOptions {
  return {
    fontFamily:
      'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: false,
    scrollback: 8000,
    theme: THEME,
    convertEol: true,
    // V3-W13-002 — OSC8 hyperlink activation. Plain URLs go through the
    // WebLinksAddon below; this handles `\x1b]8;;…` sequences from CLIs
    // like claude / gh / ripgrep --hyperlink.
    linkHandler: {
      activate: (_event, text) => {
        ctx.routeLinkClick(text, ctx.wsIdRef.current);
      },
    },
  };
}

function isPtyExitPayload(p: unknown): p is { sessionId: string; exitCode: number } {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string'
  );
}

function evictOldestIfFull(): void {
  if (cache.size < TERMINAL_CACHE_LIMIT) return;
  // Prefer evicting entries whose PTY has already exited (they're effectively
  // read-only scrollback at this point); only then fall back to plain LRU
  // among live sessions.
  let exitedVictim: CacheEntry | null = null;
  let liveVictim: CacheEntry | null = null;
  for (const entry of cache.values()) {
    if (entry.ptyExited) {
      if (!exitedVictim || entry.lastAccessed < exitedVictim.lastAccessed) {
        exitedVictim = entry;
      }
    } else if (!liveVictim || entry.lastAccessed < liveVictim.lastAccessed) {
      liveVictim = entry;
    }
  }
  const victim = exitedVictim ?? liveVictim;
  if (victim) destroy(victim.sessionId);
}

/**
 * Get or create a cached terminal for the given sessionId. On cache miss
 * also wires the PTY data bus subscription, the keystroke pipe, and the
 * `pty:exit` listener — all of which then survive remount cycles for the
 * lifetime of the entry.
 */
export function getOrCreateTerminal(
  sessionId: string,
  ctx: TerminalCacheContext,
): CacheEntry {
  const existing = cache.get(sessionId);
  if (existing) {
    existing.lastAccessed = Date.now();
    return existing;
  }
  evictOldestIfFull();

  const term = new XTerm(buildTerminalOptions(ctx));
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      ctx.routeLinkClick(uri, ctx.wsIdRef.current);
    }),
  );

  // Park the xterm DOM in the offscreen container until React mounts give
  // it a real host. xterm.js requires `open()` to be called exactly once
  // with a real DOM parent; we satisfy that here.
  const parking = ensureParkingLot();
  term.open(parking);

  // Wire keystrokes back to the PTY. This listener lives for the entry's
  // entire cache lifetime — only `destroy()` disposes it.
  const onDataDispose = term.onData((data) => {
    void rpc.pty.write(sessionId, data).catch(() => undefined);
  });

  // V1.4.2 packet-03 (Layer 1) — race-safe snapshot + live ordering. The
  // subscription attaches synchronously; pending chunks buffer locally
  // until the snapshot resolves, then drain in arrival order.
  //
  // Caveat: `rpc.pty.snapshot` returns `{ buffer }`, NOT `{ history }`
  // (schema at `src/main/core/rpc/schemas.ts:81`).
  const pending: string[] = [];
  let snapshotDone = false;
  const entryRef: { current: CacheEntry | null } = { current: null };
  const unsubscribePty = subscribePtyData(sessionId, (payload) => {
    if (entryRef.current && !cache.has(sessionId)) return;
    if (snapshotDone) term.write(payload.data);
    else pending.push(payload.data);
  });

  // `pty:exit` handler lives at the cache layer so the exit message is
  // written into the scrollback exactly once, regardless of whether the
  // terminal is currently mounted. On exit we ALSO flag `ptyExited` so
  // mounted ResizeObservers stop forwarding `pty.resize` IPC.
  const offExit = window.sigma.eventOn('pty:exit', (raw: unknown) => {
    if (!isPtyExitPayload(raw)) return;
    if (raw.sessionId !== sessionId) return;
    const entry = cache.get(sessionId);
    if (!entry) return;
    if (entry.ptyExited) return;
    entry.ptyExited = true;
    const code = typeof raw.exitCode === 'number' ? raw.exitCode : -1;
    term.write(`\r\n\x1b[2;90m[session exited code=${code}]\x1b[0m\r\n`);
  });

  const entry: CacheEntry = {
    sessionId,
    terminal: term,
    fitAddon: fit,
    unsubscribePty,
    onDataDispose,
    offExit,
    lastAccessed: Date.now(),
    ptyExited: false,
    snapshotReady: false,
  };
  entryRef.current = entry;
  cache.set(sessionId, entry);

  // Kick off the snapshot in the background. Race-safe: any chunks that
  // arrived between bus-subscribe and snapshot-resolve are in `pending`
  // and drain here. On hot-remount we never hit this path again because
  // the cache entry already exists.
  void (async () => {
    try {
      const snap = await rpc.pty.snapshot(sessionId);
      if (!cache.has(sessionId)) return;
      if (snap.buffer) term.write(snap.buffer);
    } catch {
      /* snapshot is best-effort; the live subscription already captured
         everything since the bus listener attached. */
    }
    for (const chunk of pending) term.write(chunk);
    pending.length = 0;
    snapshotDone = true;
    entry.snapshotReady = true;
  })();

  return entry;
}

/**
 * Move the xterm DOM root from wherever it currently lives (parking lot
 * or previous host) into the provided container. Idempotent — safe to
 * call when the terminal is already mounted in `host`.
 */
export function attachToHost(entry: CacheEntry, host: HTMLElement): void {
  const root = entry.terminal.element;
  if (!root) return;
  if (root.parentNode === host) {
    entry.lastAccessed = Date.now();
    return;
  }
  host.appendChild(root);
  entry.lastAccessed = Date.now();
}

/**
 * Park the xterm DOM root in the offscreen container without disposing
 * the terminal. Resize observers / focus listeners that the host wired
 * are NOT removed here — they belong to the host's React mount and are
 * torn down by the host's cleanup.
 */
export function detachFromHost(entry: CacheEntry): void {
  const root = entry.terminal.element;
  if (!root) return;
  const parking = ensureParkingLot();
  if (root.parentNode !== parking) parking.appendChild(root);
}

/**
 * Permanently dispose the cached terminal. Call on REMOVE_SESSION (the
 * user explicitly closed the pane) or on LRU eviction. Idempotent.
 */
export function destroy(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return;
  cache.delete(sessionId);
  try {
    entry.unsubscribePty();
  } catch {
    /* listener may have raced through during a teardown — ignore */
  }
  try {
    entry.offExit();
  } catch {
    /* same */
  }
  try {
    entry.onDataDispose.dispose();
  } catch {
    /* same */
  }
  try {
    entry.terminal.dispose();
  } catch {
    /* same */
  }
}

/** Test-only helper: wipe every cached entry. */
export function __resetTerminalCache(): void {
  for (const id of Array.from(cache.keys())) destroy(id);
  if (parkingLot && parkingLot.parentNode) {
    parkingLot.parentNode.removeChild(parkingLot);
  }
  parkingLot = null;
}

/** Inspection helper. */
export function getCacheSize(): number {
  return cache.size;
}

/** Inspection helper — returns true if the cache currently holds an entry
 *  for `sessionId`. Mostly used in tests; production callers should prefer
 *  `getOrCreateTerminal`. */
export function hasCached(sessionId: string): boolean {
  return cache.has(sessionId);
}
