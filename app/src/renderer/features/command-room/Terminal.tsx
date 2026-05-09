// Single xterm.js terminal bound to a PTY session via the RPC bridge.
// Subscribe order is: register live data listener FIRST, then call subscribe()
// to fetch the historical buffer — eliminates the replay/live race.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { rpc } from '@/renderer/lib/rpc';

interface Props {
  sessionId: string;
  className?: string;
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

export function SessionTerminal({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    try {
      fit.fit();
    } catch {
      /* ignore initial fit errors */
    }

    termRef.current = term;

    // 1) Subscribe to live PTY data BEFORE pulling the snapshot.
    const offData = window.sigma.eventOn('pty:data', (raw: unknown) => {
      const p = raw as { sessionId: string; data: string };
      if (p.sessionId === sessionId) term.write(p.data);
    });
    const offExit = window.sigma.eventOn('pty:exit', (raw: unknown) => {
      const p = raw as { sessionId: string; exitCode: number };
      if (p.sessionId === sessionId) {
        term.write(`\r\n\x1b[2;90m[session exited code=${p.exitCode}]\x1b[0m\r\n`);
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
      void rpc.pty.write(sessionId, data);
    });

    // Resize observer: keep PTY in sync with the visible cell grid.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = term;
      void rpc.pty.resize(sessionId, cols, rows).catch(() => undefined);
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      onDataDisp.dispose();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
