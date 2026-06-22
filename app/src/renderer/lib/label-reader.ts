// Per-pane SIGMA::LABEL reader — replaces the byte-regex label-watcher.ts.
//
// Interactive Claude Code is a TUI that PAINTS via cursor-control escapes, so
// the sentinel never appears as a clean newline-delimited line in the raw PTY
// byte stream (what the old watcher tried). Captured live, "SIGMA::LABEL say
// hello" arrives as `\x1b[2C\x1b[9ASIGMA::LABEL\x1b[16Gsay\x1b[20Ghello` — words
// placed by absolute-column jumps, preceded by cursor moves. So we read the
// label from the PARSED buffer instead: the per-pane TerminalEngine (DOM mode,
// default) or the cached xterm Terminal (xterm mode), where @xterm has already
// resolved cursor-jumps into real, correctly-spaced text.
//
// Lifecycle: attached by engine-cache / terminal-cache at create time (which
// enforce engine↔xterm mutual exclusion, so the two paths never run together
// for one session) and detached at destroy. Feeds the existing pane-labels
// store (sanitize + last-good + no-notify-on-unchanged live there).

import { setAgentLabel } from '@/renderer/lib/pane-labels';
import { extractLabel } from '@/renderer/lib/pane-label-scan';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';

// Recent buffer rows to scan on each change — covers the visible screen plus a
// little history so a just-painted label is in range, without re-scanning an
// 8000-row scrollback on every coalesced repaint.
const SCAN_ROWS = 160;

/** The minimal @xterm/xterm surface the reader needs (the real Terminal
 *  satisfies it; tests pass a lightweight fake). */
export interface XtermLike {
  onWriteParsed(cb: () => void): { dispose(): void };
  buffer: {
    active: {
      length: number;
      getLine(
        i: number,
      ): { translateToString(trim?: boolean): string; isWrapped: boolean } | undefined;
    };
  };
}

/** Read the current label from a parsed engine buffer (recent rows only). */
export function readEngineLabel(
  engine: Pick<TerminalEngine, 'logicalLines' | 'bufferLength'>,
): string | null {
  const len = engine.bufferLength;
  const lines = engine.logicalLines(Math.max(0, len - SCAN_ROWS), len).map((l) => l.text);
  return extractLabel(lines);
}

/** Read the current label from a parsed xterm buffer (recent rows, wrap-joined). */
export function readXtermLabel(term: XtermLike): string | null {
  const buf = term.buffer.active;
  const end = buf.length;
  const lines: string[] = [];
  let i = Math.max(0, end - SCAN_ROWS);
  // Snap to a wrap head so the window never starts mid-logical-line.
  while (i > 0 && buf.getLine(i)?.isWrapped) i--;
  while (i < end) {
    const head = buf.getLine(i);
    if (!head) { i++; continue; }
    let text = head.translateToString(true);
    let next = i + 1;
    while (next < end && buf.getLine(next)?.isWrapped) {
      text += buf.getLine(next)!.translateToString(true);
      next++;
    }
    lines.push(text);
    i = next;
  }
  return extractLabel(lines);
}

const detachers = new Map<string, () => void>();

/** Attach a label reader to a DOM-mode engine (idempotent per session). */
export function attachEngineLabelReader(sessionId: string, engine: TerminalEngine): void {
  if (detachers.has(sessionId)) return;
  const off = engine.onBufferChanged(() => {
    const label = readEngineLabel(engine);
    if (label) setAgentLabel(sessionId, label);
  });
  detachers.set(sessionId, off);
}

/** Attach a label reader to an xterm-mode Terminal (idempotent per session). */
export function attachXtermLabelReader(sessionId: string, term: XtermLike): void {
  if (detachers.has(sessionId)) return;
  const sub = term.onWriteParsed(() => {
    const label = readXtermLabel(term);
    if (label) setAgentLabel(sessionId, label);
  });
  detachers.set(sessionId, () => sub.dispose());
}

/** Detach a session's reader. Idempotent; safe if never attached. */
export function detachLabelReader(sessionId: string): void {
  const off = detachers.get(sessionId);
  if (!off) return;
  try {
    off();
  } catch {
    /* raced teardown — ignore */
  }
  detachers.delete(sessionId);
}

/** Test-only: detach every reader. */
export function __resetLabelReaders(): void {
  for (const id of Array.from(detachers.keys())) detachLabelReader(id);
}
