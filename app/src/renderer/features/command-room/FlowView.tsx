// DOM terminal presenter P1b — the flowing-output presenter (spec §FlowView).
// Logical lines (isWrapped continuations pre-joined by the engine) render as
// one div per line with attribute-run spans; CSS does the wrapping, so a pane
// resize is a pure reflow — no buffer rewrap, no renderer clear, no repaint
// choreography. Native DOM selection/scroll come free (spec G1/G2).
//
// Virtualization: `content-visibility: auto` skips offscreen rendering work
// without JS measurement (logical lines have variable wrapped height, which
// breaks classic fixed-height windowing). The DOM itself is capped at the
// most recent MAX_RENDER_LINES logical lines; the engine retains the full
// 8000-line scrollback for read_pane/copy.
//
// Dirty-tracking: a row re-renders when its TEXT changes; rows inside the
// live tail (where TUIs repaint/recolor) always re-render. A style-only
// change deep in scrollback not re-rendering is a documented P1b limitation.

import { memo, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { DEFAULT_BG, DEFAULT_FG } from './ansi-palette';
import { CURSOR_STYLE, runStyle } from './run-style';

export const MAX_RENDER_LINES = 1500;
/** Rows from the bottom that re-render on every buffer change. */
export const LIVE_TAIL_LINES = 64;
/** Estimated single-row height for content-visibility (12px × 1.4 ≈ 17). */
const LINE_HEIGHT_PX = 17;
/** Within this many px of the bottom counts as "stuck" (auto-follow). */
const STICK_SLOP_PX = 8;

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

interface LineRowProps {
  engine: TerminalEngine;
  startRow: number;
  text: string;
  /** Live-tail rows re-render every change (spinners, recolors, cursor). */
  live: boolean;
  /** Character offset of the cursor within this logical line, or null. */
  cursorOffset: number | null;
}

const LineRow = memo(
  function LineRow({ engine, startRow, cursorOffset }: LineRowProps) {
    const runs = engine.styledLine(startRow);
    const children: React.ReactNode[] = [];
    let consumed = 0;
    let cursorPlaced = false;
    runs.forEach((run, i) => {
      if (cursorOffset !== null && !cursorPlaced && cursorOffset < consumed + run.text.length) {
        const at = cursorOffset - consumed;
        const before = run.text.slice(0, at);
        const cursorChar = run.text.slice(at, at + 1) || ' ';
        const after = run.text.slice(at + 1);
        const style = runStyle(run, false);
        if (before) children.push(<span key={`${i}b`} style={style}>{before}</span>);
        children.push(
          <span key={`${i}c`} data-cursor style={{ ...style, ...CURSOR_STYLE }}>
            {cursorChar}
          </span>,
        );
        if (after) children.push(<span key={`${i}a`} style={style}>{after}</span>);
        cursorPlaced = true;
      } else {
        children.push(<span key={i} style={runStyle(run, false)}>{run.text}</span>);
      }
      consumed += run.text.length;
    });
    if (cursorOffset !== null && !cursorPlaced) {
      // The buffer cursor can sit BEYOND the trimmed runs (styledLine drops
      // trailing default-styled whitespace): typing spaces advances cursor.col
      // without changing the trimmed text. Pad the gap so the block visually
      // tracks every typed space instead of pinning after the last glyph.
      const pad = cursorOffset - consumed;
      if (pad > 0) children.push(<span key="cpad">{' '.repeat(pad)}</span>);
      children.push(
        <span key="ce" data-cursor style={CURSOR_STYLE}>
          {' '}
        </span>,
      );
    }
    return (
      <div
        data-row={startRow}
        style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${LINE_HEIGHT_PX}px` }}
      >
        {children.length > 0 ? children : ' '}
      </div>
    );
  },
  (prev, next) =>
    !next.live &&
    prev.text === next.text &&
    prev.startRow === next.startRow &&
    prev.cursorOffset === next.cursorOffset,
);

export function FlowView({ engine, className }: { engine: TerminalEngine; className?: string }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => engine.onBufferChanged(bump), [engine]);

  // Stick-to-bottom: follow output while the user is at the bottom; stop the
  // moment they scroll up; resume when they return to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX;
  };

  const lines = engine.logicalLines();
  const visible = lines.slice(Math.max(0, lines.length - MAX_RENDER_LINES));
  const liveFromRow =
    visible.length > 0 ? visible[Math.max(0, visible.length - LIVE_TAIL_LINES)]!.startRow : 0;
  const cursor = engine.cursor;
  // Which logical line holds the cursor, and at what character offset?
  // offset = (cursor.row − line.startRow) · cols + cursor.col, because the
  // engine's wrapped rows are exactly cols wide.
  let cursorLine = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]!.startRow <= cursor.row) {
      cursorLine = i;
      break;
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className}
      data-testid="flow-view"
      style={{
        height: '100%',
        overflowY: 'auto',
        background: DEFAULT_BG,
        color: DEFAULT_FG,
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.4,
        // Flowing output keeps CSS wrap (the redesign's whole point); the
        // alternate buffer is now owned by GridView (P1c), so FlowView never
        // needs the no-wrap alt branch.
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        overflowX: 'hidden',
        userSelect: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {visible.map((l, i) => (
        <LineRow
          key={l.startRow}
          engine={engine}
          startRow={l.startRow}
          text={l.text}
          live={l.startRow >= liveFromRow}
          cursorOffset={
            i === cursorLine ? (cursor.row - l.startRow) * engine.term.cols + cursor.col : null
          }
        />
      ))}
    </div>
  );
}
