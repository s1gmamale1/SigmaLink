// DOM terminal presenter P1c — the cell-exact alt-screen presenter (spec
// §GridView). Alt-buffer TUIs (claude fullscreen, codex/opencode ratatui)
// paint a rows×cols viewport with cursor positioning; rendering them as
// flowing logical lines (FlowView) was legible but not cell-exact. GridView
// renders exactly term.rows fixed-height rows from the active buffer's
// viewport: white-space pre (rows NEVER wrap), inline-block run spans
// (backgrounds fill the row — v2.4.2 stripe lesson), block cursor at the
// cursor cell. Viewport-only by construction: the alt buffer has no
// scrollback, and wheel input is routed upstream by DomTerminalView (SGR
// reports / arrow fallback). No mouse-position reporting yet (P2).

import { useEffect, useReducer } from 'react';
import type { TerminalEngine } from '@/renderer/lib/terminal-engine';
import { defaultBg, defaultFg } from './ansi-palette';
import { cursorStyle, runStyle } from './run-style';

const MONO_FONT =
  'JetBrains Mono, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

export function GridView({ engine, className }: { engine: TerminalEngine; className?: string }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.onBufferChanged(bump), [engine]);

  const buf = engine.term.buffer.active;
  const rows = engine.term.rows;
  // Viewport top in absolute buffer rows. The alt buffer normally has
  // length === rows (no scrollback), making this 0; the clamp keeps us
  // correct if an implementation detail ever pads it.
  const top = Math.max(0, buf.length - rows);
  const cursor = engine.cursor;

  const rowNodes = [];
  for (let i = 0; i < rows; i++) {
    const absRow = top + i;
    const runs = engine.styledRow(absRow);
    const children: React.ReactNode[] = [];
    let cursorPlaced = false;
    const cursorCol = absRow === cursor.row ? cursor.col : null;
    let consumed = 0;
    runs.forEach((run, ri) => {
      if (cursorCol !== null && !cursorPlaced && cursorCol < consumed + run.text.length) {
        const at = cursorCol - consumed;
        const before = run.text.slice(0, at);
        const cursorChar = run.text.slice(at, at + 1) || ' ';
        const after = run.text.slice(at + 1);
        const style = runStyle(run, true);
        if (before) children.push(<span key={`${ri}b`} style={style}>{before}</span>);
        children.push(
          <span key={`${ri}c`} data-cursor style={{ ...style, ...cursorStyle() }}>
            {cursorChar}
          </span>,
        );
        if (after) children.push(<span key={`${ri}a`} style={style}>{after}</span>);
        cursorPlaced = true;
      } else {
        children.push(<span key={ri} style={runStyle(run, true)}>{run.text}</span>);
      }
      consumed += run.text.length;
    });
    if (cursorCol !== null && !cursorPlaced) {
      const pad = cursorCol - consumed;
      if (pad > 0) children.push(<span key="cpad" style={{ display: 'inline-block', verticalAlign: 'top' }}>{' '.repeat(pad)}</span>);
      children.push(
        <span key="ce" data-cursor style={{ display: 'inline-block', verticalAlign: 'top', ...cursorStyle() }}>
          {' '}
        </span>,
      );
    }
    rowNodes.push(
      <div
        key={i}
        data-grid-row={i}
        style={{ whiteSpace: 'pre', overflow: 'hidden', height: '1.4em', lineHeight: 1.4 }}
      >
        {children.length > 0 ? children : ' '}
      </div>,
    );
  }

  return (
    <div
      className={className}
      data-testid="grid-view"
      style={{
        height: '100%',
        overflow: 'hidden',
        background: defaultBg(),
        color: defaultFg(),
        fontFamily: MONO_FONT,
        fontSize: 12,
        lineHeight: 1.4,
        userSelect: 'text',
        padding: '4px 6px',
        boxSizing: 'border-box',
      }}
    >
      {rowNodes}
    </div>
  );
}
