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

import { useEffect, useMemo, useRef } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { getOrCreateEngine } from '@/renderer/lib/engine-cache';
import { encodeKeyEvent, encodePaste } from './input-encoder';
import { FlowView } from './FlowView';
import { RefitController } from './refit-controller';

const PROBE_LEN = 10;
const PAD_X = 6; // FlowView horizontal padding — subtracted before cols math

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

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
  // Idempotent cache hit — safe under StrictMode double-render.
  const entry = useMemo(() => getOrCreateEngine(sessionId), [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
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
      const cellW = probe && probe.offsetWidth > 0 ? probe.offsetWidth / PROBE_LEN : 7.2;
      const lineH = probe && probe.offsetHeight > 0 ? probe.offsetHeight : 17;
      const cols = Math.max(2, Math.floor((w - PAD_X * 2) / cellW));
      const rows = Math.max(1, Math.floor(h / lineH));
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
      inputRef.current?.focus();
      try {
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* jsdom / unmounted */
      }
    };
    window.addEventListener('sigma:pty-focus', onFocusReq);

    return () => {
      entry.mounted = false;
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
  }, [sessionId, entry]);

  const writeBytes = (bytes: string) => {
    void rpc.pty.write(sessionId, bytes).catch(() => undefined);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (entry.ptyExited) return;
    const bytes = encodeKeyEvent(
      {
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        shiftKey: ev.shiftKey,
      },
      entry.engine.modes,
    );
    if (bytes === null) return; // cmd-shortcuts / bare modifiers stay with the app
    ev.preventDefault();
    writeBytes(bytes);
  };

  const onPaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    ev.preventDefault();
    if (entry.ptyExited) return;
    const text = ev.clipboardData.getData('text');
    if (!text) return;
    writeBytes(encodePaste(text, entry.engine.modes));
  };

  // Click focuses the input host — but never at the cost of an in-progress
  // text selection; select-to-copy parity with the xterm path's
  // onSelectionChange→clipboard pipe.
  const onMouseUp = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString();
      if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      return;
    }
    inputRef.current?.focus();
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
      <FlowView engine={entry.engine} />
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
