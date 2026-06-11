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
// Per-pane chrome (status · branch · model · uncommitted count) is owned by
// PaneHeader / PaneFooter, which wrap this component in CommandRoom. This
// file is intentionally a bare xterm host; chrome lives outside it.

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
import { useRightRail } from '@/renderer/features/right-rail/RightRailContext.data';
import { RefitController } from './refit-controller';

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
function routeLinkClick(
  url: string,
  workspaceId: string | undefined,
  surfaceBrowser?: () => void,
): void {
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
      // C-8: surface the browser tab in the right rail after navigation.
      surfaceBrowser?.();
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

  // C-8: surface the browser tab when a terminal link is clicked.
  const { setActiveTab } = useRightRail();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ctx: TerminalCacheContext = {
      wsIdRef,
      routeLinkClick,
      surfaceBrowser: () => setActiveTab('browser'),
    };
    const entry = getOrCreateTerminal(sessionId, ctx);
    attachToHost(entry, container);
    const { terminal: term, fitAddon: fit } = entry;

    // PTY-IPC dedup: only forward a resize to the PTY when the cell grid
    // actually changed. -1 sentinels guarantee the first fit propagates.
    let lastCols = -1;
    let lastRows = -1;
    // Refit via xterm's ATOMIC fit.fit(): it calls _renderService.clear()
    // BEFORE term.resize(), so the (WebGL) renderer drops the old-geometry
    // glyph cells instead of leaving them painted under the new frame. The
    // earlier proposeDimensions()+resize() split dropped that clear (commit
    // 0805a6b) and caused the resize "ghost / duplicated text" bug — worst
    // with full-screen TUIs like Claude Code that only repaint changed cells.
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
    // Forced repaint for restore-from-hidden / window-restore. fit.fit()
    // no-ops when cols/rows are unchanged — exactly the restore-at-same-size
    // case — so refresh the full viewport and drop the WebGL glyph atlas to
    // repaint the buffer that kept receiving PTY bytes while hidden.
    const runReveal = () => {
      if (entry.ptyExited) return;
      runFit();
      try {
        term.refresh(0, term.rows - 1);
        entry.webglAddon?.clearTextureAtlas();
      } catch {
        /* terminal may be mid-dispose */
      }
    };
    // WHEN to refit (hidden/first-fit/drag/debounce/reveal) lives in the
    // controller — see refit-controller.ts for the full rationale.
    const controller = new RefitController({ fit: runFit, reveal: runReveal });

    const ro = new ResizeObserver((entries) => {
      if (entry.ptyExited) return;
      const e = entries[0];
      if (!e) return;
      controller.onContentRect(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(container);

    // PaneGrid fires `sigma:pane-resize-start` on divider grab and
    // `sigma:pane-resize-end` on release (or keyboard nudge / mid-drag
    // unmount). Between them the controller suppresses per-frame refits and
    // refits exactly ONCE on release — one clean SIGWINCH at the final size.
    const onResizeStart = () => controller.onDragStart();
    const onResizeEnd = () => controller.onDragEnd();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);

    // Pane-refit spec 2026-06-11 — app-window un-minimize / re-show never
    // fires the ResizeObserver (layout unchanged) while Chromium occlusion
    // throttling may have stalled WebGL frames; main emits this so every
    // visible terminal force-repaints.
    const offWindowRestored = window.sigma.eventOn('window:restored', () =>
      controller.onWindowRestored(),
    );

    // V3-W13-015 — listen for cross-workspace jump-to-pane events the
    // JorvisRoom dispatches when a Jorvis-spawned pane finishes. Only the
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
      controller.dispose();
      try {
        ro.disconnect();
      } catch {
        /* observer may already be disconnected — ignore */
      }
      window.removeEventListener('sigma:pane-resize-start', onResizeStart);
      window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
      offWindowRestored();
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      // V1.4.2 packet-03 (Layer 2) — DO NOT dispose the cached terminal.
      // Park its DOM in the cache's offscreen container so the next mount
      // (room switch, workspace switch, or grid reshuffle) finds an intact
      // terminal with full scrollback and an uninterrupted live data
      // stream. Permanent disposal happens via `destroy(sessionId)` when
      // the user explicitly removes the pane (REMOVE_SESSION dispatch).
      detachFromHost(entry);
    };
  }, [sessionId, setActiveTab]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
