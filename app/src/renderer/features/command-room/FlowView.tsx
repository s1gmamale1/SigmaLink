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

import type { CSSProperties } from 'react';
import { memo, useEffect, useReducer } from 'react';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { DEFAULT_BG, DEFAULT_FG } from './ansi-palette';
import { CURSOR_STYLE, runStyle } from './run-style';
import { findUrls } from './linkify';
import { segmentRuns, type Decoration, type LineSegment } from './line-segments';
import { deriveBlocks } from './command-blocks';
import { useStickToBottom } from './use-stick-to-bottom';

/** Search highlight backgrounds (normal match / the active/current match). */
const SEARCH_BG_NORMAL = '#7c5e10';
const SEARCH_BG_ACTIVE = '#b8860b';

/** Case-insensitive match offsets of `term` within `text` (string ops only —
 *  no regex, so no control-char-in-regex lint risk and no escaping). */
function findMatches(text: string, term: string): { start: number; end: number }[] {
  if (!term) return [];
  const out: { start: number; end: number }[] = [];
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    out.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return out;
}

export const MAX_RENDER_LINES = 1500;
/** Rows from the bottom that re-render on every buffer change. */
export const LIVE_TAIL_LINES = 64;
/** Estimated single-row height for content-visibility (12px × 1.4 ≈ 17). */
const LINE_HEIGHT_PX = 17;
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
  /** Active find-in-pane term (undefined when search is closed). */
  searchTerm: string | undefined;
  /** Index of the active match WITHIN THIS ROW, or null if this row holds none. */
  activeMatchIndex: number | null;
  onLinkClick: ((url: string) => void) | undefined;
  /** This row is the first line of an OSC-133 command block (A mark). */
  blockStart: boolean;
  /** This row is inside a command block whose exit code was nonzero. */
  blockFailed: boolean;
}

/** Style + per-segment decoration → a span's CSSProperties (link underline,
 *  search background). The decoration styling layers ON TOP of the run style. */
function segStyle(seg: LineSegment): CSSProperties {
  const style = runStyle(seg, false);
  if (seg.search) {
    style.backgroundColor = seg.search === 'active' ? SEARCH_BG_ACTIVE : SEARCH_BG_NORMAL;
  }
  if (seg.link) {
    style.textDecoration = 'underline';
    style.cursor = 'pointer';
  }
  return style;
}

const LineRow = memo(
  function LineRow({
    engine,
    startRow,
    text,
    cursorOffset,
    searchTerm,
    activeMatchIndex,
    onLinkClick,
    blockStart,
    blockFailed,
  }: LineRowProps) {
    const runs = engine.styledLine(startRow);
    // Decorations: link anchors (plain-URL) + search highlights. The match at
    // `activeMatchIndex` (if this row is the active line) is the 'active' one.
    const decorations: Decoration[] = [];
    for (const u of findUrls(text)) decorations.push({ start: u.start, end: u.end, link: u.url });
    if (searchTerm) {
      const matches = findMatches(text, searchTerm);
      matches.forEach((m, mi) => {
        decorations.push({
          start: m.start,
          end: m.end,
          search: mi === activeMatchIndex ? 'active' : 'normal',
        });
      });
    }
    const segments = segmentRuns(runs, decorations);
    const children: React.ReactNode[] = [];
    let consumed = 0;
    let cursorPlaced = false;
    segments.forEach((seg, i) => {
      const style = segStyle(seg);
      const extra: React.HTMLAttributes<HTMLSpanElement> & { 'data-link'?: string; 'data-search-active'?: string } = {};
      if (seg.link) {
        extra['data-link'] = seg.link;
        const url = seg.link;
        extra.onClick = () => onLinkClick?.(url);
      }
      if (seg.search === 'active') extra['data-search-active'] = '';
      if (cursorOffset !== null && !cursorPlaced && cursorOffset < consumed + seg.text.length) {
        const at = cursorOffset - consumed;
        const before = seg.text.slice(0, at);
        const cursorChar = seg.text.slice(at, at + 1) || ' ';
        const after = seg.text.slice(at + 1);
        if (before) children.push(<span key={`${i}b`} style={style} {...extra}>{before}</span>);
        children.push(
          <span key={`${i}c`} data-cursor style={{ ...style, ...CURSOR_STYLE }}>
            {cursorChar}
          </span>,
        );
        if (after) children.push(<span key={`${i}a`} style={style} {...extra}>{after}</span>);
        cursorPlaced = true;
      } else {
        children.push(<span key={i} style={style} {...extra}>{seg.text}</span>);
      }
      consumed += seg.text.length;
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
    const rowStyle: CSSProperties = {
      contentVisibility: 'auto',
      containIntrinsicSize: `auto ${LINE_HEIGHT_PX}px`,
    };
    // OSC-133 command-block gutters: a red left rule flags a failed block; a
    // faint top rule marks the start of a new command block (the prompt line).
    if (blockFailed) {
      rowStyle.borderLeft = '2px solid #ef4444';
      rowStyle.paddingLeft = 4;
    }
    if (blockStart) {
      rowStyle.borderTop = '1px solid rgba(82,90,115,0.35)';
      rowStyle.marginTop = 2;
    }
    return (
      <div data-row={startRow} style={rowStyle}>
        {children.length > 0 ? children : ' '}
      </div>
    );
  },
  (prev, next) =>
    !next.live &&
    prev.text === next.text &&
    prev.startRow === next.startRow &&
    prev.cursorOffset === next.cursorOffset &&
    prev.searchTerm === next.searchTerm &&
    prev.activeMatchIndex === next.activeMatchIndex &&
    prev.onLinkClick === next.onLinkClick &&
    prev.blockStart === next.blockStart &&
    prev.blockFailed === next.blockFailed,
);

// Flicker fix (intermittent): memo so a sibling pane's focus switch
// (SET_ACTIVE_SESSION → unmemoized CommandRoom/PaneGrid/PaneShell cascade) does
// NOT re-render this FlowView. A spurious re-render re-fired useStickToBottom's
// pin (scrollTop=scrollHeight + rAF re-pin) and re-reconciled the 64 live-tail
// rows under content-visibility → a one-frame scroll/reflow jolt = the "sometimes"
// flash. Props are referentially stable on a focus cascade (engine is cache-owned;
// onLinkClick is useCallback'd on the stable setActiveTab; searchTerm=undefined and
// activeMatch=null while search is closed). Live output is UNAFFECTED — FlowView
// self-subscribes to engine.onBufferChanged via its own `bump`, and memo only
// blocks PARENT-driven re-renders, never internal-state ones.
export const FlowView = memo(function FlowView({
  engine,
  className,
  onLinkClick,
  searchTerm,
  activeMatch,
}: {
  engine: TerminalEngine;
  className?: string;
  onLinkClick?: (url: string) => void;
  searchTerm?: string;
  /** `line` = logical-line array index (in the rendered `visible` slice);
   *  `index` = which match within that line is the current/active one. */
  activeMatch?: { line: number; index: number } | null;
}) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const { scrollRef, atBottom, onScroll, scrollToBottom } = useStickToBottom();

  useEffect(() => engine.onBufferChanged(bump), [engine]);

  // Scroll the active match into view when it changes.
  useEffect(() => {
    try {
      scrollRef.current
        ?.querySelector('[data-search-active]')
        ?.scrollIntoView({ block: 'nearest' });
    } catch {
      /* jsdom / detached */
    }
  }, [activeMatch?.line, activeMatch?.index, searchTerm, scrollRef]);

  const lines = engine.logicalLines();
  const visible = lines.slice(Math.max(0, lines.length - MAX_RENDER_LINES));
  // OSC-133 command blocks (marks array is small — derive per render).
  const blocks = deriveBlocks(engine.promptMarks);
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
    <div className={className} style={{ position: 'relative', height: '100%' }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="flow-view"
        style={{
          height: '100%',
          overflowY: 'auto',
          overflowAnchor: 'none', // stop Chromium scroll-anchoring fighting auto-follow
          // Reserve the (layout-taking, styled) scrollbar gutter ALWAYS so the
          // text box width is constant whether or not the scrollbar is showing —
          // no reflow when it toggles, and DomTerminalView's matching SCROLLBAR_W
          // cols reserve stays exact. Without this the gutter only appears once
          // the transcript overflows, narrowing the box mid-session and stranding
          // the last word of full lines (the "inline break" bug).
          scrollbarGutter: 'stable',
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
            searchTerm={searchTerm}
            activeMatchIndex={activeMatch && activeMatch.line === i ? activeMatch.index : null}
            onLinkClick={onLinkClick}
            blockStart={blocks.some((b) => b.startRow === l.startRow)}
            blockFailed={blocks.some(
              (b) =>
                typeof b.exitCode === 'number' &&
                b.exitCode !== 0 &&
                l.startRow >= b.startRow &&
                l.startRow <= b.endRow,
            )}
          />
        ))}
      </div>
      {!atBottom && (
        <button
          type="button"
          data-testid="jump-to-bottom"
          onClick={scrollToBottom}
          aria-label="Jump to latest output"
          title="Jump to latest output"
          style={{
            position: 'absolute',
            right: 14,
            bottom: 12,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '9999px',
            border: '1px solid rgba(130,140,165,0.4)',
            background: 'rgba(28,32,44,0.9)',
            color: DEFAULT_FG,
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            padding: 0,
          }}
        >
          ↓
        </button>
      )}
    </div>
  );
});
