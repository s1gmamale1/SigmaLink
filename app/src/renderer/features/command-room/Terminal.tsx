// Single xterm.js terminal bound to a PTY session via the RPC bridge.
// Subscribe order is: register live data listener FIRST, then call subscribe()
// to fetch the historical buffer — eliminates the replay/live race.
//
// TODO(V3-W13-003): per-pane chrome (top-bar status dot + branch + close, plus
// the `<model> <effort> <speed> · <cwd>` mid-strip from V3-W12-002) ships with
// the right-rail dock work. This file deliberately stays a bare xterm host
// until then; pane chrome is owned by the new PaneHeader / PaneFooter
// components (see V3_PARITY_BACKLOG.md §V3-W13-003).

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';

interface Props {
  sessionId: string;
  className?: string;
}

/**
 * V3-W13-002 — when the user clicks a link inside a PTY pane, prefer routing
 * through the active workspace's built-in browser. Falls back to
 * `window.open` (which Electron forwards to the OS) if anything goes wrong
 * or the gate kv is `'0'`.
 */
async function routeLinkClick(url: string, workspaceId: string | undefined): Promise<void> {
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

function isPtyDataPayload(p: unknown): p is { sessionId: string; data: string } {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string' &&
    'data' in p &&
    typeof (p as { data: unknown }).data === 'string'
  );
}

function isPtyExitPayload(p: unknown): p is { sessionId: string; exitCode: number } {
  return (
    !!p &&
    typeof p === 'object' &&
    'sessionId' in p &&
    typeof (p as { sessionId: unknown }).sessionId === 'string'
  );
}

export function SessionTerminal({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const { state } = useAppState();
  // Capture the current workspace id in a ref so the WebLinksAddon callback
  // (created once per terminal mount) always reads the latest value without
  // needing to re-mount xterm on workspace switches.
  const wsIdRef = useRef<string | undefined>(state.activeWorkspace?.id);
  useEffect(() => {
    wsIdRef.current = state.activeWorkspace?.id;
  }, [state.activeWorkspace?.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const term = new Terminal({
      fontFamily:
        'JetBrains Mono, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: false,
      scrollback: 8000,
      theme: THEME,
      convertEol: true,
      // V3-W13-002 — handle OSC8 hyperlink activation. Plain URLs are
      // covered by the WebLinksAddon below; this handles the `\x1b]8;;…`
      // sequences emitted by modern CLIs (claude, gh, ripgrep --hyperlink).
      linkHandler: {
        activate: (_event, text) => {
          void routeLinkClick(text, wsIdRef.current);
        },
        // Default `allowNonHttpProtocols = false` is what we want — file://
        // links from the in-app browser only flow when the gate is on AND
        // the user explicitly clicked them in the address bar, not from PTY.
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // V3-W13-002 — intercept the WebLinksAddon click so plain-text URLs that
    // xterm renders into a clickable region route into the in-app browser.
    // OSC8 hyperlinks are handled by `pty:link-detected` (see below) when
    // the user clicks them via the same xterm hover-region.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void routeLinkClick(uri, wsIdRef.current);
      }),
    );
    term.open(container);
    termRef.current = term;
    // Initial fit is handled by the ResizeObserver below — it fires once
    // immediately on observe() and we gate fit() on non-zero dimensions, so
    // we no longer need the requestAnimationFrame workaround that caused
    // misaligned text when GridLayout was still flex-shrinking on mount.

    // 1) Subscribe to live PTY data BEFORE pulling the snapshot.
    const offData = window.sigma.eventOn('pty:data', (raw: unknown) => {
      if (!isPtyDataPayload(raw)) return;
      if (raw.sessionId === sessionId) term.write(raw.data);
    });
    const offExit = window.sigma.eventOn('pty:exit', (raw: unknown) => {
      if (!isPtyExitPayload(raw)) return;
      if (raw.sessionId === sessionId) {
        const code = typeof raw.exitCode === 'number' ? raw.exitCode : -1;
        term.write(`\r\n\x1b[2;90m[session exited code=${code}]\x1b[0m\r\n`);
      }
    });

    // 2) Pull historical buffer atomically. Any data emitted during this await
    //    will reach us via the live listener attached above, so ordering is
    //    only "history then live" if the snapshot was non-empty.
    void rpc.pty.subscribe(sessionId).then((res) => {
      if (disposed) return;
      if (res.history) term.write(res.history);
    });

    // Wire local input -> PTY.
    const onDataDisp = term.onData((data) => {
      void rpc.pty.write(sessionId, data).catch(() => undefined);
    });

    // Resize observer: keep PTY in sync with the visible cell grid.
    // Gate fit() on non-zero dimensions so we don't run while GridLayout is
    // still flex-shrinking on first mount (the previous rAF workaround
    // could fire mid-resize and produced misaligned cells). Debounce to
    // 25ms so a window-edge drag doesn't fire dozens of IPC calls per
    // second; first fit at non-zero size runs synchronously.
    let lastCols = term.cols;
    let lastRows = term.rows;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let didFirstFit = false;
    const runFit = () => {
      if (disposed) return;
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
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      if (!didFirstFit) {
        didFirstFit = true;
        runFit();
        return;
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(runFit, 25);
    });
    ro.observe(container);

    // V3-W13-015 — listen for cross-workspace jump-to-pane events the
    // BridgeRoom dispatches when a Bridge-spawned pane finishes. Only the
    // matching session focuses; other Terminals ignore the event silently.
    const onFocusReq = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      try {
        term.focus();
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* DOM may have unmounted */
      }
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      onDataDisp.dispose();
      offData();
      offExit();
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
