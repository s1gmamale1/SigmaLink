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
import { WebglAddon } from '@xterm/addon-webgl';
import { rpc } from '@/renderer/lib/rpc';
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';
import { subscribeExit } from '@/renderer/lib/pty-exit-bus';

/** Maximum number of cached xterm instances before LRU eviction. */
export const TERMINAL_CACHE_LIMIT = 32;

/**
 * SF-3 (v1.29.0) — Device-Attributes RESPONSE matcher for the onData→pty.write
 * keystroke pipe.
 *
 * Symptom: on OS window focus-switch, `1;2c` appeared typed into every pane's
 * shell prompt. `1;2c` is the printable tail of xterm's Primary Device
 * Attributes reply `\x1b[?1;2c`. The sequence reaches xterm as a DA *response*
 * to a DA *query* (`\x1b[c`) that a program in the PTY emits on focus regain;
 * xterm answers via `onData`, and our pipe forwarded that answer to `pty.write`
 * — so the shell saw it as stdin and echoed `1;2c`.
 *
 * A DA response is xterm-synthesised and can NEVER be a human keystroke, so it
 * is always safe to strip from the keystroke pipe. We match ONLY the two DA
 * reply shapes (verified against @xterm/xterm 6.0.0):
 *   Primary DA   →  CSI ? … c   e.g. `\x1b[?1;2c`
 *   Secondary DA →  CSI > … c   e.g. `\x1b[>0;276;0c`
 *
 * We deliberately do NOT touch Cursor-Position-Report (`\x1b[…R`) or
 * Device-Status-Report (`\x1b[…n`) replies — programs legitimately rely on
 * those, and their grammars do not collide with this matcher (different final
 * byte, and CPR/DSR have no `?`/`>` introducer).
 */
// eslint-disable-next-line no-control-regex -- ESC (\x1b) is intrinsic to the CSI grammar we match
const DEVICE_ATTRIBUTES_RESPONSE_RE = /\x1b\[[?>][0-9;]*c/g;

/**
 * Strip Device-Attributes responses from a chunk headed for the PTY stdin.
 * Returns the cleaned string (possibly empty). Exported for unit testing.
 */
export function stripDeviceAttributesResponses(data: string): string {
  if (data.indexOf('\x1b[') === -1) return data; // fast path: no CSI at all
  return data.replace(DEVICE_ATTRIBUTES_RESPONSE_RE, '');
}

export interface TerminalCacheContext {
  /** Mutable holder the React mount updates so the link-handler closure
   *  inside xterm always sees the latest active workspace id without
   *  needing to recreate the terminal. */
  wsIdRef: { current: string | undefined };
  /** Click-router function from `Terminal.tsx`. Identity is stable per
   *  module so we accept the latest reference on every getOrCreate call;
   *  the first call wires the addon. */
  routeLinkClick: (url: string, workspaceId: string | undefined, surfaceBrowser?: () => void) => void;
  /** C-8: called (when capture is ON) after the browser RPC resolves to
   *  surface the browser tab in the right rail. Supplied by the
   *  `SessionTerminal` component via `useRightRail().setActiveTab`. */
  surfaceBrowser?: () => void;
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
  /** Spec 2026-06-10 (C) — xterm `onSelectionChange` disposer for iTerm2-style
   *  select-to-copy. Created once on first miss; disposed alongside the others
   *  on evict/destroy. */
  onSelectionDispose: { dispose: () => void };
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
  /** 2026-06-10 finding 3 — WebGL addon held ONLY while attached to a real
   *  host, so live GPU contexts ≈ visible panes instead of ≈ cache size
   *  (Chromium caps ~16 WebGL contexts per process; the cache holds 32).
   *  Null while parked (the DOM-renderer-free buffer still parses bytes). */
  webglAddon: WebglAddon | null;
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
        ctx.routeLinkClick(text, ctx.wsIdRef.current, ctx.surfaceBrowser);
      },
    },
  };
}

/** Spec 2026-06-10 (C) — xterm 6 dropped the built-in copyOnSelect option,
 *  so we replicate iTerm2 select-to-copy: push any non-empty selection to
 *  the system clipboard whenever the selection changes. */
export function copySelectionToClipboard(
  term: Pick<XTerm, 'hasSelection' | 'getSelection'>,
): void {
  if (!term.hasSelection()) return;
  const sel = term.getSelection();
  if (sel) void navigator.clipboard?.writeText(sel).catch(() => undefined);
}

/**
 * 2026-06-10 finding 2 — an entry is "parked" when its xterm DOM root is in
 * the offscreen parking lot (or was never attached anywhere). Entries whose
 * root is parented by a REAL host are on-screen right now; destroying one
 * blanks a visible pane (Terminal.tsx's runFit try/catch then swallows every
 * subsequent fit). Only parked entries are eviction candidates.
 */
function isParked(entry: CacheEntry): boolean {
  const root = entry.terminal.element;
  if (!root || !root.parentNode) return true;
  return parkingLot !== null && root.parentNode === parkingLot;
}

function evictOldestIfFull(): void {
  if (cache.size < TERMINAL_CACHE_LIMIT) return;
  // Prefer evicting entries whose PTY has already exited (they're effectively
  // read-only scrollback at this point); only then fall back to plain LRU
  // among live sessions. 2026-06-10 finding 2: NEVER evict an entry attached
  // to a real host — if every entry is attached (pathological: >cap mounted
  // panes) we exceed the cap instead, which is bounded by mounted-pane count.
  let exitedVictim: CacheEntry | null = null;
  let liveVictim: CacheEntry | null = null;
  for (const entry of cache.values()) {
    if (!isParked(entry)) continue;
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
      ctx.routeLinkClick(uri, ctx.wsIdRef.current, ctx.surfaceBrowser);
    }),
  );

  // Park the xterm DOM in the offscreen container until React mounts give
  // it a real host. xterm.js requires `open()` to be called exactly once
  // with a real DOM parent; we satisfy that here.
  const parking = ensureParkingLot();
  term.open(parking);

  // 2026-06-10 finding 3 — the WebGL renderer is NO LONGER loaded at creation.
  // It is an ATTACHED-ONLY concern (loadWebglAddon in attachToHost / disposed
  // in detachFromHost), so live GPU contexts ≈ visible panes rather than ≈
  // cache size. A parked terminal only parses bytes into its buffer and needs
  // no renderer.

  // Wire keystrokes back to the PTY. This listener lives for the entry's
  // entire cache lifetime — only `destroy()` disposes it.
  //
  // SF-3 — strip Device-Attributes responses before forwarding. xterm answers
  // a program's DA query (`\x1b[c`) via this same onData channel; on OS window
  // focus-switch that reply (`\x1b[?1;2c`) was reaching the shell prompt and
  // being echoed as the literal `1;2c`. DA responses are synthesised by xterm
  // and are never real keystrokes, so dropping them here is safe; an all-DA
  // chunk collapses to '' and is not written at all.
  const onDataDispose = term.onData((data) => {
    const clean = stripDeviceAttributesResponses(data);
    if (clean === '') return;
    void rpc.pty.write(sessionId, clean).catch(() => undefined);
  });

  // Spec 2026-06-10 (C) — iTerm2-style select-to-copy. xterm 6 removed the
  // built-in copyOnSelect option, so we mirror it by copying any non-empty
  // selection to the system clipboard whenever the selection changes. The
  // disposable is owned by the cache entry and torn down like onDataDispose.
  const onSelectionDispose = term.onSelectionChange(() => copySelectionToClipboard(term));

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
  //
  // PERF-9 — subscribe via the shared exit bus instead of registering a raw
  // per-session `eventOn('pty:exit')`. The bus runs ONE global listener and
  // fans out by sessionId, so we no longer install up to 32 listeners that
  // each re-validate + filter every exit. The payload is already sessionId-
  // matched + exitCode-normalised by the bus; the `entry.ptyExited` double-
  // write guard and the scrollback write are preserved verbatim.
  const offExit = subscribeExit(sessionId, (payload) => {
    const entry = cache.get(sessionId);
    if (!entry) return;
    if (entry.ptyExited) return;
    entry.ptyExited = true;
    term.write(`\r\n\x1b[2;90m[session exited code=${payload.exitCode}]\x1b[0m\r\n`);
  });

  const entry: CacheEntry = {
    sessionId,
    terminal: term,
    fitAddon: fit,
    unsubscribePty,
    onDataDispose,
    onSelectionDispose,
    offExit,
    lastAccessed: Date.now(),
    ptyExited: false,
    snapshotReady: false,
    webglAddon: null,
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
 * 2026-06-10 finding 3 — WebGL renderer is an ATTACHED-ONLY concern. xterm 6's
 * default DOM renderer rebuilds per-row DOM on every resize repaint (the
 * pane-resize "glitch"), so visible panes want WebGL; parked terminals only
 * parse bytes into the buffer and need no renderer at all. Loading here (and
 * disposing in detachFromHost) keeps live GPU contexts ≈ visible panes,
 * under Chromium's ~16-context cap.
 *
 * Best-effort + self-healing (unchanged from the creation-time version): if
 * WebGL is unavailable (jsdom, GPU blocklist) the load throws and the DOM
 * renderer stays; if Chromium evicts the context, `onContextLoss` disposes
 * the addon and xterm reverts to the DOM renderer — never a blank pane. Must
 * run AFTER term.open(), which always happened at creation (parking-lot open).
 */
function loadWebglAddon(entry: CacheEntry): void {
  if (entry.webglAddon) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        /* already disposed — ignore */
      }
      if (entry.webglAddon === webgl) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webgl);
    entry.webglAddon = webgl;
  } catch {
    /* WebGL unavailable — xterm's default DOM renderer remains active */
  }
}

/**
 * Move the xterm DOM root from wherever it currently lives (parking lot
 * or previous host) into the provided container, and bring up the WebGL
 * renderer for the now-visible terminal. Idempotent — safe to call when
 * the terminal is already mounted in `host`.
 */
export function attachToHost(entry: CacheEntry, host: HTMLElement): void {
  const root = entry.terminal.element;
  if (!root) return;
  if (root.parentNode !== host) host.appendChild(root);
  entry.lastAccessed = Date.now();
  loadWebglAddon(entry);
}

/**
 * Park the xterm DOM root in the offscreen container without disposing
 * the terminal, and release the WebGL context (finding 3) — a parked
 * terminal only needs buffer parsing. Resize observers / focus listeners
 * that the host wired are NOT removed here — they belong to the host's
 * React mount and are torn down by the host's cleanup.
 */
export function detachFromHost(entry: CacheEntry): void {
  const root = entry.terminal.element;
  if (!root) return;
  const parking = ensureParkingLot();
  if (root.parentNode !== parking) parking.appendChild(root);
  if (entry.webglAddon) {
    try {
      entry.webglAddon.dispose();
    } catch {
      /* already disposed (e.g. context loss raced) — ignore */
    }
    entry.webglAddon = null;
  }
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
    entry.onSelectionDispose.dispose();
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

/** Spec 2026-06-10 (C) — read-only accessor for a cached entry (no create).
 *  Used by PaneShell's context-menu Copy/Paste to reach the live xterm
 *  instance for a pane/scratch-tab without constructing a cache context. */
export function getCached(sessionId: string): CacheEntry | undefined {
  return cache.get(sessionId);
}
