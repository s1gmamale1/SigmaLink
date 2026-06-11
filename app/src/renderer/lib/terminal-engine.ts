// DOM terminal presenter P1a (spec 2026-06-12) — the headless VT engine.
//
// Wraps `@xterm/headless` (xterm's full escape-sequence parser + buffer
// state, no renderer): PTY bytes go in via write(), the buffer is read out
// as LOGICAL lines (isWrapped continuations joined) — the FlowView contract —
// and terminal-initiated replies (DA/DSR/CPR answers the hosted app
// requests) flow back to the PTY via the delegate, exactly like today's
// attached-xterm onData→pty.write pipe (SF-3).
//
// P1a lands this module standalone; terminal-cache integration happens with
// the first DOM-presenter mount (P1b) so the live attached-xterm path stays
// untouched until then.

import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { EncoderModes } from '../features/command-room/input-encoder';

export interface EngineDelegate {
  /** Bytes the TERMINAL emits toward the PTY (query answers; later, encoded
   *  keystrokes from the presenter's InputEncoder). */
  writeToPty(data: string): void;
}

export interface EngineOptions {
  cols?: number;
  rows?: number;
  /** Matches the attached path's scrollback (terminal-cache buildTerminalOptions). */
  scrollback?: number;
}

/** One logical (unwrapped) line of buffer content. */
export interface LogicalLine {
  /** Absolute index of the logical line's FIRST buffer row (stable identity
   *  for virtualized rendering until the scrollback trims past it). */
  startRow: number;
  text: string;
}

type Disposer = { dispose(): void };

const schedule: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 0);

export class TerminalEngine {
  readonly term: HeadlessTerminal;

  private readonly disposers: Disposer[] = [];
  private readonly changeSubs = new Set<() => void>();
  private notifyScheduled = false;
  private disposed = false;

  constructor(delegate: EngineDelegate, opts: EngineOptions = {}) {
    this.term = new HeadlessTerminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      scrollback: opts.scrollback ?? 8000,
      // Parity with the attached path (terminal-cache buildTerminalOptions):
      // PTY streams are \n-rich on some providers.
      convertEol: true,
      allowProposedApi: true,
    });
    // Terminal-initiated replies (Primary/Secondary DA, DSR, CPR…) — the
    // hosted app asks, the VT core answers via onData, we forward to the PTY.
    this.disposers.push(this.term.onData((d) => delegate.writeToPty(d)));
    // Coalesced change notify: bursts of writes collapse to one callback per
    // frame (rAF in the renderer; setTimeout(0) under node tests).
    this.disposers.push(this.term.onWriteParsed(() => this.scheduleNotify()));
  }

  write(data: string): void {
    if (this.disposed) return;
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    this.scheduleNotify();
  }

  /** Subscribe to coalesced buffer changes. Returns the unsubscribe. */
  onBufferChanged(cb: () => void): () => void {
    this.changeSubs.add(cb);
    return () => {
      this.changeSubs.delete(cb);
    };
  }

  get bufferType(): 'normal' | 'alternate' {
    return this.term.buffer.active.type;
  }

  /** Modes the presenter's InputEncoder must respect (DECCKM, bracketed paste). */
  get modes(): EncoderModes {
    const m = this.term.modes;
    return {
      applicationCursorKeys: m.applicationCursorKeysMode,
      bracketedPaste: m.bracketedPasteMode,
    };
  }

  /**
   * Extract LOGICAL lines from the active buffer: a buffer row whose
   * successor has `isWrapped` is joined with its continuations, so the
   * presenter can let CSS re-wrap at any width. `startRow`/`endRow` bound the
   * scan in absolute buffer rows (defaults: whole buffer) — virtualization
   * passes a window.
   */
  logicalLines(startRow = 0, endRow = this.term.buffer.active.length): LogicalLine[] {
    const buf = this.term.buffer.active;
    const out: LogicalLine[] = [];
    const last = Math.min(endRow, buf.length);
    let row = Math.max(0, startRow);
    // Snap backward to the head of a wrapped run so a window never starts
    // mid-logical-line.
    while (row > 0 && buf.getLine(row)?.isWrapped) row--;
    while (row < last) {
      const head = buf.getLine(row);
      if (!head) break;
      let text = head.translateToString(true);
      let next = row + 1;
      while (next < buf.length && buf.getLine(next)?.isWrapped) {
        // Continuation rows keep trailing-space trim only at the very end.
        text += buf.getLine(next)!.translateToString(true);
        next++;
      }
      out.push({ startRow: row, text });
      row = next;
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeSubs.clear();
    for (const d of this.disposers) d.dispose();
    this.term.dispose();
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled || this.disposed) return;
    this.notifyScheduled = true;
    schedule(() => {
      this.notifyScheduled = false;
      if (this.disposed) return;
      for (const cb of this.changeSubs) cb();
    });
  }
}
