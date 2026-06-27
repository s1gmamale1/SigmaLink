// DOM terminal presenter P1b — the per-mount host for a DOM-rendered pane
// (the engine-path twin of Terminal.tsx's xterm host). Owns the per-mount
// concerns: RefitController-driven sizing (cols from a measured probe span —
// ONE pty.resize per settle, none during drag: CSS reflows the text live for
// free, exactly the property this redesign exists for), the hidden-textarea
// input host (P1a encoder), focus routing, and select-to-copy parity.
//
// Deliberately ABSENT vs the xterm host: window:restored reveal (no GPU
// compositor state to repaint), dragFit (CSS wrap handles live drag), WebGL
// addon, link addon (FlowView anchors land in P2).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { getOrCreateEngine, type EngineCacheEntry } from '@/renderer/lib/engine-cache';
import { encodeKeyEvent, encodePaste, isNativePasteCombo, shiftEnterNewline } from './input-encoder';
import { feedFirstMessageKey, feedFirstMessagePaste } from '@/renderer/lib/pane-first-message';
import { encodeSgrMouse, shouldReportMouse } from './mouse-encoder';
import { getPlatform } from '@/renderer/lib/platform';
import { useAppStateSelector } from '@/renderer/app/state';
import { useRightRail } from '@/renderer/features/right-rail/RightRailContext.data';
import { routeLinkClick } from './route-link-click';
import { FlowView, MAX_RENDER_LINES } from './FlowView';
import { GridView } from './GridView';
import { PaneSearch } from './PaneSearch';
import { RefitController } from './refit-controller';
import { measureCellW, measureLineH, proposeGrid, PROBE_LEN } from './pane-metrics';

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

/** Flat list of search matches across the RENDERED (visible) logical lines —
 *  `line` is the index into the visible slice (FlowView's activeMatch.line
 *  contract), `index` is which match within that line. Case-insensitive,
 *  string ops only (no regex → no control-char-in-regex lint risk). */
function computeMatches(
  visibleTexts: string[],
  term: string,
): { line: number; index: number }[] {
  if (!term) return [];
  const needle = term.toLowerCase();
  const out: { line: number; index: number }[] = [];
  visibleTexts.forEach((text, line) => {
    const hay = text.toLowerCase();
    let from = 0;
    let index = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      out.push({ line, index });
      index += 1;
      from = at + needle.length;
    }
  });
  return out;
}

export function DomTerminalView({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // The cache OWNS the entry. getOrCreateEngine is idempotent (a Map hit after
  // the first call), so resolving it directly in render is cheap and pure for
  // the read paths (engine for FlowView, ptyExited/modes for the handlers). We
  // never MUTATE it here — the lifecycle mutations (mounted/lastAccessed)
  // happen inside the effect against its own in-effect resolve, satisfying the
  // React immutability lint (parity with Terminal.tsx's in-effect handling).
  const entry: EngineCacheEntry = getOrCreateEngine(sessionId);

  // Re-render the host on engine changes so the Flow↔Grid switch reacts to
  // alt-screen enter/exit (1049h/l). Cheap: the host renders a few divs.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => entry.engine.onBufferChanged(bump), [entry]);

  // FlowView link context — mirror the xterm host (Terminal.tsx): a clicked
  // PTY-pane link routes through the active workspace's built-in browser via
  // the shared routeLinkClick. The workspace id is read from a mutable ref so
  // the callback identity stays stable (FlowView memoizes rows on it).
  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspace?.id);
  const wsIdRef = useRef<string | undefined>(activeWorkspaceId);
  const providerId = useAppStateSelector((s) =>
    s.sessions.find((sess) => sess.id === sessionId)?.providerId,
  );
  useEffect(() => {
    wsIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);
  const { setActiveTab } = useRightRail();
  const onLinkClick = useCallback(
    (url: string) => routeLinkClick(url, wsIdRef.current, () => setActiveTab('browser')),
    [setActiveTab],
  );

  // Find-in-pane state. Matches are recomputed each render from the engine's
  // current visible lines (pane content is capped at MAX_RENDER_LINES, the
  // same window FlowView renders + highlights — alt-screen apps own their own
  // search so the overlay shows 0/0 there).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  let matches: { line: number; index: number }[] = [];
  if (searchOpen && searchTerm && entry.engine.bufferType !== 'alternate') {
    const lines = entry.engine.logicalLines();
    const visible = lines.slice(Math.max(0, lines.length - MAX_RENDER_LINES));
    matches = computeMatches(
      visible.map((l) => l.text),
      searchTerm,
    );
  }
  const activeMatch =
    matches.length > 0 ? matches[((activeIdx % matches.length) + matches.length) % matches.length]! : null;

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchTerm('');
    setActiveIdx(0);
    inputRef.current?.focus();
  };
  const onSearchTermChange = (term: string) => {
    setSearchTerm(term);
    setActiveIdx(0);
  };
  const onSearchNavigate = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (((i + direction) % matches.length) + matches.length) % matches.length);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const entry = getOrCreateEngine(sessionId);
    entry.mounted = true;
    entry.lastAccessed = Date.now();

    let lastCols = -1;
    let lastRows = -1;
    const runFit = () => {
      if (entry.ptyExited) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      const probe = probeRef.current;
      const { cols, rows } = proposeGrid(w, h, measureCellW(probe), measureLineH(probe));
      entry.engine.resize(cols, rows);
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        void rpc.pty.resize(sessionId, cols, rows).catch(() => undefined);
      }
    };
    // No dragFit: during a divider drag CSS re-wraps the text continuously;
    // the engine/PTY learn the final size once, on release/settle.
    const controller = new RefitController({ fit: runFit, reveal: runFit });

    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      controller.onContentRect(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(container);

    const onResizeStart = () => controller.onDragStart();
    const onResizeEnd = () => controller.onDragEnd();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);

    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      inputRef.current?.focus({ preventScroll: true });
      try {
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* jsdom / unmounted */
      }
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);

    // Shared cell-hit math: client coords → 1-based (col,row) in the terminal
    // grid, clamped to the engine's current dimensions. Falls back to the
    // 7.2px / 17px estimates when the probe span hasn't measured yet (jsdom).
    const cellAt = (clientX: number, clientY: number): { col: number; row: number } => {
      const rect = container.getBoundingClientRect();
      const probe = probeRef.current;
      const cellW = measureCellW(probe);
      const lineH = measureLineH(probe);
      return {
        col: Math.max(
          1,
          Math.min(entry.engine.term.cols, Math.floor((clientX - rect.left) / cellW) + 1),
        ),
        row: Math.max(
          1,
          Math.min(entry.engine.term.rows, Math.floor((clientY - rect.top) / lineH) + 1),
        ),
      };
    };

    // Wheel routing, in priority order (parity with xterm.js's viewport):
    //   1. App requested wheel-capable mouse tracking with SGR encoding
    //      (claude fullscreen does: 1049+1000+1006) → SGR wheel REPORTS at
    //      the pointer cell. Arrows here would hit the composer's prompt
    //      history instead of scrolling the transcript (operator-reported).
    //   2. Alt screen WITHOUT mouse tracking (less, vim without mouse=a) →
    //      arrow-key fallback, the classic terminal convention.
    //   3. Normal buffer → untouched: native DOM scroll + stick-to-bottom.
    // Native NON-passive listener: React root-level wheel handlers are
    // passive, so ev.preventDefault() would be ignored there.
    const onWheel = (ev: WheelEvent) => {
      if (entry.ptyExited || ev.deltaY === 0) return;
      const LINE_PX = 17; // FlowView row height estimate — only a wheel ratio
      const lines =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? Math.abs(ev.deltaY)
          : Math.abs(ev.deltaY) / LINE_PX;
      const n = Math.max(1, Math.min(10, Math.round(lines)));

      const mt = entry.engine.mouseTracking;
      if (mt.mode !== 'none' && mt.mode !== 'x10' && mt.sgr) {
        ev.preventDefault();
        const { col, row } = cellAt(ev.clientX, ev.clientY);
        const button = ev.deltaY < 0 ? 64 : 65; // SGR wheel up / down
        const report = encodeSgrMouse('press', button, col, row, {
          shift: ev.shiftKey,
          alt: ev.altKey,
          ctrl: ev.ctrlKey,
        });
        void rpc.pty.write(sessionId, report.repeat(n)).catch(() => undefined);
        return;
      }

      if (entry.engine.bufferType !== 'alternate') return;
      ev.preventDefault();
      const bytes = encodeKeyEvent(
        {
          key: ev.deltaY < 0 ? 'ArrowUp' : 'ArrowDown',
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
        },
        entry.engine.modes,
      );
      if (bytes) void rpc.pty.write(sessionId, bytes.repeat(n)).catch(() => undefined);
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    // P2 — pointer reporting. Shift is the universal "let me select text"
    // bypass (xterm/iTerm convention): shifted events never report and never
    // preventDefault, so native selection + the select-to-copy mouseup keep
    // working even under tracking. Reports require SGR encoding (1006) —
    // legacy encodings are not emitted.
    let heldButton: number | null = null;
    let lastMotionCell: string | null = null;
    const report = (kind: 'press' | 'release' | 'motion', button: number, ev: MouseEvent) => {
      const { col, row } = cellAt(ev.clientX, ev.clientY);
      const bytes = encodeSgrMouse(kind, button, col, row, {
        shift: ev.shiftKey,
        alt: ev.altKey,
        ctrl: ev.ctrlKey,
      });
      void rpc.pty.write(sessionId, bytes).catch(() => undefined);
      return `${col};${row}`;
    };
    const trackingActive = () => {
      const mt = entry.engine.mouseTracking;
      return !entry.ptyExited && mt.mode !== 'none' && mt.sgr;
    };
    const onMouseDownNative = (ev: MouseEvent) => {
      if (!trackingActive() || ev.shiftKey) return;
      if (!shouldReportMouse(entry.engine.mouseTracking.mode, 'press', false)) return;
      ev.preventDefault(); // suppress native selection start under tracking
      inputRef.current?.focus({ preventScroll: true });
      heldButton = ev.button;
      // Seed the motion-dedup with the press cell so the first same-cell move
      // is coalesced away (one report per cell, not press + redundant motion).
      lastMotionCell = report('press', ev.button, ev);
    };
    const onMouseUpNative = (ev: MouseEvent) => {
      if (heldButton === null) return;
      const btn = heldButton;
      heldButton = null;
      if (!trackingActive() || ev.shiftKey) return;
      if (!shouldReportMouse(entry.engine.mouseTracking.mode, 'release', false)) return;
      report('release', btn, ev);
    };
    const onMouseMoveNative = (ev: MouseEvent) => {
      if (!trackingActive() || ev.shiftKey) return;
      const mode = entry.engine.mouseTracking.mode;
      if (!shouldReportMouse(mode, 'motion', heldButton !== null)) return;
      const { col, row } = cellAt(ev.clientX, ev.clientY);
      const cellKey = `${col};${row}`;
      if (cellKey === lastMotionCell) return; // one report per cell, not per pixel
      lastMotionCell = cellKey;
      // motion carries the held button, or 3 (release/no-button) in any-mode
      const button = heldButton ?? 3;
      void rpc.pty
        .write(
          sessionId,
          encodeSgrMouse('motion', button, col, row, {
            shift: ev.shiftKey,
            alt: ev.altKey,
            ctrl: ev.ctrlKey,
          }),
        )
        .catch(() => undefined);
    };
    container.addEventListener('mousedown', onMouseDownNative);
    // window-level so a release outside the pane still ends the drag
    window.addEventListener('mouseup', onMouseUpNative);
    container.addEventListener('mousemove', onMouseMoveNative);

    return () => {
      entry.mounted = false;
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('mousedown', onMouseDownNative);
      window.removeEventListener('mouseup', onMouseUpNative);
      container.removeEventListener('mousemove', onMouseMoveNative);
      controller.dispose();
      try {
        ro.disconnect();
      } catch {
        /* already disconnected */
      }
      window.removeEventListener('sigma:pane-resize-start', onResizeStart);
      window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      // Engine is cache-owned: NOT disposed here (parity with detachFromHost).
    };
  }, [sessionId]);

  const writeBytes = (bytes: string) => {
    void rpc.pty.write(sessionId, bytes).catch(() => undefined);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (entry.ptyExited) return;
    // Find-in-pane open: mac ⌘F, win/linux Ctrl+Shift+F (plain Ctrl+F stays
    // readline forward-char). Handled before the encoder so the keystroke
    // never reaches the PTY.
    const isMac = getPlatform() === 'darwin';
    if (
      (isMac && ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === 'f') ||
      (!isMac && ev.ctrlKey && ev.shiftKey && ev.key.toLowerCase() === 'f')
    ) {
      ev.preventDefault();
      setSearchOpen(true);
      return;
    }
    const keyEvent = {
      key: ev.key,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      metaKey: ev.metaKey,
      shiftKey: ev.shiftKey,
    };
    // win32/linux paste keybindings (Ctrl+V / Ctrl+Shift+V / Shift+Insert)
    // must reach the browser un-prevented so the native `paste` event fires
    // and onPaste does the bracketed-paste encoding. Encoding them instead
    // (`\x16` / CSI 2;2~) would leave DOM panes with no keyboard paste on
    // Windows. mac keeps Ctrl+V as readline quoted-insert (paste is Cmd+V).
    if (isNativePasteCombo(keyEvent, getPlatform() === 'darwin')) return;
    // Capture the operator's first typed line as a pane-label fallback (no-op
    // once captured; SIGMA::LABEL supersedes it via PaneHeader precedence).
    feedFirstMessageKey(sessionId, keyEvent);
    const bytes = encodeKeyEvent(keyEvent, entry.engine.modes, {
      shiftEnterNewline: shiftEnterNewline(providerId),
    });
    if (bytes === null) return; // cmd-shortcuts / bare modifiers stay with the app
    ev.preventDefault();
    writeBytes(bytes);
  };

  const onPaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    ev.preventDefault();
    if (entry.ptyExited) return;
    const text = ev.clipboardData.getData('text');
    if (!text) return;
    feedFirstMessagePaste(sessionId, text);
    writeBytes(encodePaste(text, entry.engine.modes));
  };

  // Click focuses the input host. Copy-on-select runs first (parity with the
  // xterm path's onSelectionChange→clipboard pipe), THEN focus is set
  // UNCONDITIONALLY — gating focus behind "selection collapsed" let a stray
  // micro-selection (the tiny range an ordinary click leaves) swallow the
  // click's focus, which is the "pane needs 3-4 clicks to focus" bug. Under
  // SGR mouse-tracking the native press handler already focused, so stand down.
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString();
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    }
    const mt = entry.engine.mouseTracking;
    if (mt.mode !== 'none' && mt.sgr) return; // tracking focused on mousedown
    // `preventScroll` stops the browser scroll-jumping to reveal the
    // bottom-pinned 1×1 hidden textarea — that scroll-jump was the
    // "flicker on click".
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={containerRef}
      className={className}
      onMouseUp={onMouseUp}
      data-testid="dom-terminal-view"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
      <span
        ref={probeRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          fontFamily: MONO_FONT,
          fontSize: 12,
          lineHeight: 1.4,
          whiteSpace: 'pre',
        }}
      >
        {'W'.repeat(PROBE_LEN)}
      </span>
      {searchOpen && (
        <PaneSearch
          term={searchTerm}
          matchCount={matches.length}
          activeIndex={matches.length > 0 ? ((activeIdx % matches.length) + matches.length) % matches.length : 0}
          onTermChange={onSearchTermChange}
          onNavigate={onSearchNavigate}
          onClose={closeSearch}
        />
      )}
      {entry.engine.bufferType === 'alternate' ? (
        <GridView engine={entry.engine} />
      ) : (
        <FlowView
          engine={entry.engine}
          onLinkClick={onLinkClick}
          searchTerm={searchOpen ? searchTerm : undefined}
          activeMatch={activeMatch}
        />
      )}
      <textarea
        ref={inputRef}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="terminal input"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: 1,
          height: 1,
          opacity: 0,
          border: 'none',
          padding: 0,
          resize: 'none',
        }}
      />
    </div>
  );
}
