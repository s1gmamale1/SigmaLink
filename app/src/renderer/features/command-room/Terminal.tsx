// Single xterm.js host bound to a PTY session via the RPC bridge.
//
// V1.4.2 packet-03 (Layer 2 — Approach B): xterm instances are NOT created
// or disposed here. The renderer-side cache in
// `src/renderer/lib/terminal-cache.ts` owns the long-lived `Terminal`
// instances (one per sessionId) and the PTY data-bus subscription that
// keeps writing into them across mount cycles. This file is now a thin
// React host: on mount it asks the cache for the terminal, attaches its
// DOM root to the local container, and wires per-mount concerns (resize
// observer, focus event, link-handler workspace context). On unmount it
// DETACHES (parks the xterm DOM in the cache's offscreen container) so the
// next mount finds an intact terminal with full scrollback — no replay
// flash, no snapshot RPC, no lost bytes.
//
// What "per-mount" means:
//   - The ResizeObserver belongs to the host (xterm needs to refit when
//     the container size changes — different on each remount).
//   - The `wsIdRef` belongs to the host (the active workspace id is React
//     state; the cache stores a mutable holder the host updates).
//   - The `sigma:pty-focus` listener belongs to the host (it manipulates
//     the live DOM; remounting re-binds it).
//
// What "cache-owned" means:
//   - The xterm `Terminal` instance.
//   - The PTY data-bus subscription (so bytes never go missing while the
//     React tree is between mounts).
//   - The `term.onData()` keystroke pipe.
//   - The `pty:exit` listener (so the exit message is written exactly
//     once into the scrollback).
//
// TODO(V3-W13-003): per-pane chrome (top-bar status dot + branch + close,
// plus the `<model> <effort> <speed> · <cwd>` mid-strip from V3-W12-002)
// ships with the right-rail dock work. This file deliberately stays a bare
// xterm host until then; pane chrome is owned by the new PaneHeader /
// PaneFooter components (see V3_PARITY_BACKLOG.md §V3-W13-003).

import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import {
  attachToHost,
  detachFromHost,
  getOrCreateTerminal,
  type TerminalCacheContext,
} from '@/renderer/lib/terminal-cache';
import { useAppStateSelector } from '@/renderer/app/state';

interface Props {
  sessionId: string;
  className?: string;
}

/**
 * V3-W13-002 — when the user clicks a link inside a PTY pane, prefer
 * routing through the active workspace's built-in browser. Falls back to
 * `window.open` (which Electron forwards to the OS) if anything goes wrong
 * or the gate kv is `'0'`.
 *
 * Note: lives at module scope so the function identity is stable. The
 * cache's link-handler closure captures it once at first cache miss; the
 * `workspaceId` argument is read from a mutable holder the host updates
 * on every workspace change.
 */
function routeLinkClick(url: string, workspaceId: string | undefined): void {
  void (async () => {
    let captureEnabled = true;
    try {
      const raw = await rpcSilent.kv.get('browser.captureLinks');
      captureEnabled = raw === null || raw === undefined ? true : raw === '1';
    } catch {
      /* default ON when kv unreachable */
    }
    if (!captureEnabled || !workspaceId) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      const state = await rpcSilent.browser.getState(workspaceId);
      if (state.activeTabId) {
        await rpc.browser.navigate({ workspaceId, tabId: state.activeTabId, url });
      } else {
        await rpc.browser.openTab({ workspaceId, url });
      }
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  })();
}

export function SessionTerminal({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // V1.1.10 perf — subscribe to only the workspace id slice instead of
  // the full AppState (the Terminal previously re-rendered on every chat
  // message dispatch because it consumed the whole context).
  const activeWorkspaceId = useAppStateSelector((state) => state.activeWorkspace?.id);
  // The cache's link-handler closure reads from this holder, so updating
  // the ref is enough — no terminal recreation needed.
  const wsIdRef = useRef<string | undefined>(activeWorkspaceId);
  useEffect(() => {
    wsIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ctx: TerminalCacheContext = {
      wsIdRef,
      routeLinkClick,
    };
    const entry = getOrCreateTerminal(sessionId, ctx);
    attachToHost(entry, container);
    const { terminal: term, fitAddon: fit } = entry;

    // Resize observer: keep PTY in sync with the visible cell grid.
    // Gate fit() on non-zero dimensions so we don't run while GridLayout
    // is still flex-shrinking on first mount (the previous rAF workaround
    // could fire mid-resize and produced misaligned cells). Debounce to
    // 25ms so a window-edge drag doesn't fire dozens of IPC calls per
    // second; first fit at non-zero size runs synchronously.
    let lastCols = term.cols;
    let lastRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let didFirstFit = false;
    const runFit = () => {
      if (entry.ptyExited) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        void rpc.pty.resize(sessionId, cols, rows).catch(() => undefined);
      }
    };
    const ro = new ResizeObserver((entries) => {
      if (entry.ptyExited) return;
      const e = entries[0];
      if (!e) return;
      const { width, height } = e.contentRect;
      if (width <= 0 || height <= 0) return;
      if (!didFirstFit) {
        didFirstFit = true;
        runFit();
        return;
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      // v1.4.2 packet-07 — while the user is dragging a divider, relax the
      // fit() debounce so 20 simultaneous ResizeObserver callbacks don't
      // each refit + IPC a pty.resize every 25ms. GridLayout.startDrag sets
      // `document.body.dataset.dragging` for the lifetime of the drag and
      // clears it on pointerup, at which point the final fit fires within
      // the standard 25ms window.
      const debounceMs = document.body.dataset.dragging === 'true' ? 100 : 25;
      resizeTimer = setTimeout(runFit, debounceMs);
    });
    ro.observe(container);

    // V3-W13-015 — listen for cross-workspace jump-to-pane events the
    // SigmaRoom dispatches when a Sigma-spawned pane finishes. Only the
    // matching session focuses; other Terminals ignore the event silently.
    // BUG-V1.1-04-IPC — guard against double-focus when the auto-focus
    // path fires immediately after the user already had this pane focused
    // (e.g. they were typing in it when the dispatch echo arrived).
    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      const xtermEl = container.querySelector<HTMLElement>('.xterm-helper-textarea');
      const alreadyFocused =
        document.activeElement === xtermEl ||
        (xtermEl ? xtermEl.contains(document.activeElement) : false);
      if (alreadyFocused) return;
      try {
        term.focus();
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* DOM may have unmounted */
      }
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      try {
        ro.disconnect();
      } catch {
        /* observer may already be disconnected — ignore */
      }
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      // V1.4.2 packet-03 (Layer 2) — DO NOT dispose the cached terminal.
      // Park its DOM in the cache's offscreen container so the next mount
      // (room switch, workspace switch, or grid reshuffle) finds an intact
      // terminal with full scrollback and an uninterrupted live data
      // stream. Permanent disposal happens via `destroy(sessionId)` when
      // the user explicitly removes the pane (REMOVE_SESSION dispatch).
      detachFromHost(entry);
    };
  }, [sessionId]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
