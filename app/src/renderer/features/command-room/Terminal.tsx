// Single xterm.js terminal bound to a PTY session via the RPC bridge.
// Mount order is: restore the registry ring-buffer snapshot, then subscribe
// to live data. This makes workspace switches visually lossless without
// keeping hidden xterm instances alive.
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
import { subscribePtyData } from '@/renderer/lib/pty-data-bus';
import { useAppStateSelector } from '@/renderer/app/state';

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
  // V1.1.10 perf — subscribe to only the workspace id slice instead of the
  // full AppState. Terminal previously re-rendered on every dispatch (chat
  // message, notification, etc.) because it consumed the whole context.
  const activeWorkspaceId = useAppStateSelector(
    (state) => state.activeWorkspace?.id,
  );
  // Capture the current workspace id in a ref so the WebLinksAddon callback
  // (created once per terminal mount) always reads the latest value without
  // needing to re-mount xterm on workspace switches.
  const wsIdRef = useRef<string | undefined>(activeWorkspaceId);
  useEffect(() => {
    wsIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    const term = new Terminal({
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

    // V1.2.7 — workspace switches unmount xterm, not PTYs. Rehydrate the
    // visible terminal from the process-wide registry's ring buffer, then
    // attach the shared live bus listener.
    let offData: (() => void) | null = null;
    void (async () => {
      try {
        const snap = await rpc.pty.snapshot(sessionId);
        if (!disposed && snap.buffer) term.write(snap.buffer);
      } catch {
        /* snapshot is best-effort; live subscription still attaches below */
      }
      if (disposed) return;
      offData = subscribePtyData(sessionId, (payload) => {
        term.write(payload.data);
      });
    })();

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
    // v1.2.5 — once the PTY has exited we disconnect the ResizeObserver so
    // it can't forward another `pty.resize` IPC into a closed file
    // descriptor. ptyExited is a belt-and-braces guard for any in-flight
    // observer callback that has already been scheduled when disconnect()
    // is called.
    let ptyExited = false;
    const runFit = () => {
      if (disposed || ptyExited) return;
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
      if (ptyExited) return;
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

    // v1.2.5 — subscribe to `pty:exit` for this session. When the underlying
    // PTY exits (e.g. Kimi spawn → ENOENT → exit within 200ms), disconnect
    // the ResizeObserver so any pending callback or container size change
    // does not forward a resize into a dead handle. The main process also
    // short-circuits via `registry.resize` + try/catch in `local-pty.ts`;
    // this is the renderer's contribution to defense-in-depth.
    const offExit = window.sigma.eventOn('pty:exit', (raw: unknown) => {
      if (!isPtyExitPayload(raw)) return;
      if (raw.sessionId === sessionId) {
        ptyExited = true;
        if (resizeTimer) {
          clearTimeout(resizeTimer);
          resizeTimer = null;
        }
        try {
          ro.disconnect();
        } catch {
          /* observer may already be disconnected — ignore */
        }
        const code = typeof raw.exitCode === 'number' ? raw.exitCode : -1;
        term.write(`\r\n\x1b[2;90m[session exited code=${code}]\x1b[0m\r\n`);
      }
    });

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
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      onDataDisp.dispose();
      offData?.();
      offExit();
      window.removeEventListener('sigma:pty-focus', onFocusReq);
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
