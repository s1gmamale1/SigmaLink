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
import type { IBuffer, IBufferCell } from '@xterm/headless';
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

/** Color of one run: default (inherit theme), palette index 0–255, or 0xRRGGBB. */
export interface RunColor {
  mode: 'default' | 'palette' | 'rgb';
  value: number;
}

/** OSC-133 (FinalTerm shell-integration) prompt mark. */
export interface PromptMark {
  kind: 'A' | 'B' | 'C' | 'D';
  /** Absolute buffer row (baseY + cursorY) at mark time. Drifts once the
   *  scrollback trims past it — accepted: trimmed rows are out of the render
   *  window anyway. */
  row: number;
  /** Only on 'D' marks that carried one (`133;D;<code>`). */
  exitCode?: number;
}

const MAX_PROMPT_MARKS = 2048;

/** One attribute-contiguous span of a logical line. */
export interface StyledRun {
  text: string;
  fg: RunColor;
  bg: RunColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

type Disposer = { dispose(): void };

function cellColor(_mode: number, value: number, isPalette: boolean, isRgb: boolean): RunColor {
  if (isRgb) return { mode: 'rgb', value };
  if (isPalette) return { mode: 'palette', value };
  return { mode: 'default', value: 0 };
}

function sameColor(a: RunColor, b: RunColor): boolean {
  return a.mode === b.mode && a.value === b.value;
}

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
  private sgrMouseMode = false;
  private readonly marks: PromptMark[] = [];

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
    // DECSET/DECRST 1006 watcher — xterm's public modes API exposes
    // mouseTrackingMode but NOT the report ENCODING; the presenter needs it
    // to emit well-formed SGR wheel reports (claude fullscreen consumes the
    // wheel via mouse reporting, not arrow keys). Returning false lets
    // xterm's own handler still process the sequence.
    const watch1006 = (set: boolean) => (params: (number | number[])[]): boolean => {
      if (params.includes(1006)) this.sgrMouseMode = set;
      return false;
    };
    this.disposers.push(
      this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, watch1006(true)),
    );
    this.disposers.push(
      this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, watch1006(false)),
    );
    // OSC 133 (FinalTerm shell integration): A=prompt B=command-start
    // C=output-start D=command-end[;exit]. Recording rows here gives the
    // FlowView its command-block gutters. Return true: the mark is consumed
    // (xterm has no default handler for 133 anyway).
    this.disposers.push(
      this.term.parser.registerOscHandler(133, (data) => {
        const kind = data[0];
        if (kind === 'A' || kind === 'B' || kind === 'C' || kind === 'D') {
          const buf = this.term.buffer.active;
          const mark: PromptMark = { kind, row: buf.baseY + buf.cursorY };
          if (kind === 'D' && data.length > 2) {
            const code = Number(data.slice(2).split(';')[0]);
            if (Number.isFinite(code)) mark.exitCode = code;
          }
          this.marks.push(mark);
          if (this.marks.length > MAX_PROMPT_MARKS) this.marks.shift();
        }
        return true;
      }),
    );
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

  /** Granular mouse-tracking state. `mode` mirrors xterm verbatim ('x10' is
   *  press-only legacy and reports no wheel/motion); `sgr` tracks DECSET 1006
   *  via the parser hook (the public modes API hides the report encoding). */
  get mouseTracking(): { mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'; sgr: boolean } {
    return { mode: this.term.modes.mouseTrackingMode, sgr: this.sgrMouseMode };
  }

  /** OSC-133 shell-integration marks (FinalTerm protocol), oldest first. */
  get promptMarks(): readonly PromptMark[] {
    return this.marks;
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

  /** Rows currently in the active buffer (screen + scrollback). Lets a consumer
   *  bound a recent-rows scan without materializing the whole buffer. */
  get bufferLength(): number {
    return this.term.buffer.active.length;
  }

  /** Absolute cursor position in the active buffer (row = baseY + cursorY). */
  get cursor(): { row: number; col: number } {
    const buf = this.term.buffer.active;
    return { row: buf.baseY + buf.cursorY, col: buf.cursorX };
  }

  /** Walk one buffer line's cells, appending attribute-contiguous runs to
   *  `runs` (continuing `cur` across calls so wrapped rows can merge). */
  private appendRowRuns(
    line: NonNullable<ReturnType<IBuffer['getLine']>>,
    runs: StyledRun[],
    cur: StyledRun | null,
    work: IBufferCell,
  ): StyledRun | null {
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x, work);
      if (!cell || cell.getWidth() === 0) continue; // wide-char continuation
      const chars = cell.getChars() || ' ';
      const fg = cellColor(cell.getFgColorMode(), cell.getFgColor(), cell.isFgPalette(), cell.isFgRGB());
      const bg = cellColor(cell.getBgColorMode(), cell.getBgColor(), cell.isBgPalette(), cell.isBgRGB());
      const bold = !!cell.isBold();
      const dim = !!cell.isDim();
      const italic = !!cell.isItalic();
      const underline = !!cell.isUnderline();
      const inverse = !!cell.isInverse();
      const strikethrough = !!cell.isStrikethrough();
      if (
        cur &&
        sameColor(cur.fg, fg) && sameColor(cur.bg, bg) &&
        cur.bold === bold && cur.dim === dim && cur.italic === italic &&
        cur.underline === underline && cur.inverse === inverse &&
        cur.strikethrough === strikethrough
      ) {
        cur.text += chars;
      } else {
        cur = { text: chars, fg, bg, bold, dim, italic, underline, inverse, strikethrough };
        runs.push(cur);
      }
    }
    return cur;
  }

  /** Trim trailing DEFAULT-styled whitespace in place (parity with
   *  translateToString(true)); painted trailing cells are kept. */
  private trimTrailingDefaultWhitespace(runs: StyledRun[]): void {
    while (runs.length > 0) {
      const last = runs[runs.length - 1]!;
      if (last.fg.mode === 'default' && last.bg.mode === 'default' && !last.inverse && !last.underline && !last.strikethrough) {
        last.text = last.text.replace(/[ ]+$/, '');
        if (last.text === '') {
          runs.pop();
          continue;
        }
      }
      break;
    }
  }

  /**
   * Extract the logical line starting at (or containing) `startRow` as
   * attribute-contiguous runs — the FlowView's span contract. Trailing
   * default-styled whitespace is trimmed (parity with translateToString(true)).
   */
  styledLine(startRow: number): StyledRun[] {
    const buf = this.term.buffer.active;
    if (buf.length === 0) return [];
    let row = Math.min(Math.max(0, startRow), buf.length - 1);
    while (row > 0 && buf.getLine(row)?.isWrapped) row--;
    const runs: StyledRun[] = [];
    const work = buf.getNullCell();
    let cur: StyledRun | null = null;
    let r = row;
    for (;;) {
      const line = buf.getLine(r);
      if (!line) break;
      cur = this.appendRowRuns(line, runs, cur, work);
      r++;
      if (r >= buf.length || !buf.getLine(r)?.isWrapped) break;
    }
    this.trimTrailingDefaultWhitespace(runs);
    return runs;
  }

  /**
   * GridView contract — ONE buffer row as attribute runs: no wrapped-run
   * snapping, no continuation joining (a grid row is a grid row even if the
   * app's output autowrapped). Trailing default whitespace trimmed; painted
   * trailing cells (TUI theme fills) kept.
   */
  styledRow(row: number): StyledRun[] {
    const buf = this.term.buffer.active;
    if (row < 0 || row >= buf.length) return [];
    const line = buf.getLine(row);
    if (!line) return [];
    const runs: StyledRun[] = [];
    this.appendRowRuns(line, runs, null, buf.getNullCell());
    this.trimTrailingDefaultWhitespace(runs);
    return runs;
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
