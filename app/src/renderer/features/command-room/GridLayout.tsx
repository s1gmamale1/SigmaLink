// V3-W13-004: Multi-pane terminal grid layout.
//
// Generic CSS-grid layout supporting 1, 2, 4, 6, 8, 10, 12, 14, 16, 18,
// and 20 panes. Mirrors
// the launcher's GridPreset (V3-W12-007) so the room renders the user's
// chosen layout one-for-one. Counts that don't map to a preset
// fall back to the next-larger grid with empty trailing cells.
//
// Features:
//   - Active-pane focus ring using the theme `--ring` token.
//   - Cmd+Alt+<N> to focus pane N (1..9). 10/11/12 reachable via 0/-/=.
//   - Inter-cell drag handles to resize columns and rows. Fractional sizes
//     persist in component memory only; cross-room persistence is out of
//     scope for this ticket.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

interface GridShape {
  cols: number;
  rows: number;
}

function shapeFor(count: number): GridShape {
  // 1 → 1×1, 2 → 2×1, 4 → 2×2, 6 → 3×2, 8 → 4×2, 9 → 3×3,
  // 10/11/12 → 4×3, 14/16 → 4×4, 18/20 → 5×4.
  // Odd counts fall back to the next-larger preset, except 9 which gets
  // its own square 3×3 grid (v1.1.4 Step 4: V3 SigmaMind parity, no
  // trailing empty cell that 4×3 would leave).
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 8) return { cols: 4, rows: 2 };
  if (count === 9) return { cols: 3, rows: 3 };
  if (count <= 12) return { cols: 4, rows: 3 };
  if (count <= 16) return { cols: 4, rows: 4 };
  return { cols: 5, rows: 4 };
}

interface Props<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  renderCell: (item: T, ctx: { index: number; isActive: boolean; activate: () => void }) => ReactNode;
  activeIndex: number;
  onActiveChange: (index: number) => void;
  /**
   * v1.4.2 packet-12 — when non-null, the matching item renders fullscreen
   * filling the container. All other items stay mounted (their cells stay
   * in the DOM with `display: none`) so the #03 terminal cache keeps the
   * xterm subtree alive across the transition with full scrollback. The
   * key must match what `getKey()` would return for the focused item; an
   * id that doesn't match any item is treated as if no item is focused.
   */
  focusedKey?: string | null;
}

const MIN_FRAC = 0.15;

export function GridLayout<T>({
  items,
  getKey,
  renderCell,
  activeIndex,
  onActiveChange,
  focusedKey = null,
}: Props<T>) {
  const { cols, rows } = useMemo(() => shapeFor(items.length), [items.length]);
  const [colFracs, setColFracs] = useState<number[]>(() => Array(cols).fill(1));
  const [rowFracs, setRowFracs] = useState<number[]>(() => Array(rows).fill(1));
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset fracs synchronously when the grid shape changes. Comparing during
  // render and calling setState avoids the react-hooks/set-state-in-effect
  // anti-pattern; React will discard the just-set state and rerun render.
  if (colFracs.length !== cols) setColFracs(Array(cols).fill(1));
  if (rowFracs.length !== rows) setRowFracs(Array(rows).fill(1));

  // v1.4.2 packet-12 — derive the fullscreen state. We only "go fullscreen"
  // when the requested key matches one of the visible items; otherwise we
  // fall through to the regular grid so a stale id never strands the user
  // looking at a black screen. The keys here mirror the cell keys produced
  // by `getKey(item, index)` below.
  const focusedCellIdx = useMemo(() => {
    if (!focusedKey) return -1;
    for (let i = 0; i < items.length; i += 1) {
      const itm = items[i] as T;
      if (getKey(itm, i) === focusedKey) return i;
    }
    return -1;
  }, [focusedKey, items, getKey]);
  const isFullscreen = focusedCellIdx >= 0;

  // Cmd+Alt+<N> to focus pane N.
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (!ev.metaKey || !ev.altKey) return;
      let idx = -1;
      if (ev.key >= '1' && ev.key <= '9') idx = parseInt(ev.key, 10) - 1;
      else if (ev.key === '0') idx = 9;
      else if (ev.key === '-') idx = 10;
      else if (ev.key === '=') idx = 11;
      if (idx === -1 || idx >= items.length) return;
      ev.preventDefault();
      onActiveChange(idx);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items.length, onActiveChange]);

  // Generic divider drag — works for both rows and columns. `axis` is the
  // pixel-delta axis; `setFracs` updates the matching state slice; `idx` is
  // the index of the divider (i.e. the boundary between pane idx and idx+1).
  //
  // v1.4.2 packet-07 — pointermove state updates are coalesced through a
  // single requestAnimationFrame per drag so a 20-pane grid receives at most
  // one React render per frame even when the OS fires 120+ pointermoves/sec.
  // Without this, every move synchronously rebuilt the React tree AND fanned
  // out to 20 ResizeObserver callbacks; the trace showed sustained tasks
  // >16ms during sustained drag. The rAF coalesce is paired with a
  // `document.body.dataset.dragging` flag that Terminal.tsx reads to relax
  // its fit() debounce from 25ms → 100ms while a drag is in progress.
  const startDrag = useCallback(
    (
      idx: number,
      fracs: number[],
      setFracs: (next: number[]) => void,
      axis: 'x' | 'y',
    ) => (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = axis === 'x' ? rect.width : rect.height;
      const start = axis === 'x' ? ev.clientX : ev.clientY;
      const initial = [...fracs];
      const totalFrac = initial.reduce((a, b) => a + b, 0);
      const before = initial[idx];
      const after = initial[idx + 1] ?? 1;
      const pairSum = before + after;

      // v1.4.2 packet-07 — drag-coalesce primitives, scoped to this drag.
      let pendingRaf: number | null = null;
      let latest: number[] | null = null;
      const flush = () => {
        if (latest) setFracs(latest);
        latest = null;
        pendingRaf = null;
      };
      // Signal Terminal.tsx to relax its ResizeObserver debounce while the
      // user is actively dragging. Cleared on pointerup below.
      document.body.dataset.dragging = 'true';

      const move = (e: PointerEvent) => {
        const delta = (axis === 'x' ? e.clientX : e.clientY) - start;
        const dFrac = (delta / total) * totalFrac;
        const next = [...initial];
        const a = Math.max(MIN_FRAC, before + dFrac);
        const b = Math.max(MIN_FRAC, after - dFrac);
        if (a + b > pairSum + 0.001) {
          next[idx] = pairSum - MIN_FRAC;
          next[idx + 1] = MIN_FRAC;
        } else {
          next[idx] = a;
          next[idx + 1] = b;
        }
        latest = next;
        if (pendingRaf === null) {
          pendingRaf = requestAnimationFrame(flush);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // R-07-2: if pointerup arrives between the last move and the rAF
        // tick, flush synchronously so the final state isn't stale.
        if (pendingRaf !== null) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = null;
          if (latest) setFracs(latest);
          latest = null;
        }
        delete document.body.dataset.dragging;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [],
  );

  const totalCells = cols * rows;
  // v1.4.2 packet-12 — when a pane is fullscreen we still render the full
  // grid markup so child mounts (and therefore the #03 terminal cache hosts)
  // stay alive; non-focused cells are visually hidden via `display:none`.
  // The CSS-grid template is replaced with a single 1fr × 1fr cell that
  // gives the focused cell the entire viewport — `grid-column: 1 / -1` on
  // every cell would do the same but the simpler single-cell template keeps
  // browser layout cheaper.
  const gridStyle: CSSProperties = isFullscreen
    ? {
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
      }
    : {
        gridTemplateColumns: colFracs.map((f) => `${f}fr`).join(' '),
        gridTemplateRows: rowFracs.map((f) => `${f}fr`).join(' '),
      };
  const colTotal = colFracs.reduce((a, b) => a + b, 0);
  const rowTotal = rowFracs.reduce((a, b) => a + b, 0);

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full gap-1.5 p-2"
      style={gridStyle}
      data-fullscreen={isFullscreen ? 'true' : undefined}
    >
      {Array.from({ length: totalCells }, (_, cellIdx) => {
        const item = items[cellIdx];
        if (!item) {
          return (
            <div
              key={`empty-${cellIdx}`}
              className={cn(
                'rounded-lg border border-dashed border-border/40 bg-muted/10',
                // v1.4.2 packet-12 — hide empty trailing cells when a pane
                // is fullscreen so they don't steal grid space.
                isFullscreen && 'hidden',
              )}
            />
          );
        }
        const isActive = cellIdx === activeIndex;
        const isFocused = cellIdx === focusedCellIdx;
        // v1.4.2 packet-12 — non-focused panes stay mounted but hidden so
        // the #03 terminal cache (idempotent `attachToHost` keyed by
        // sessionId, DOM-parent-agnostic) keeps the xterm subtree alive
        // with full scrollback. Unmounting would force a remount + snapshot
        // replay flash on exit fullscreen.
        const cellStyle: CSSProperties | undefined =
          isFullscreen && !isFocused ? { display: 'none' } : undefined;
        return (
          <div
            key={getKey(item, cellIdx)}
            className={cn(
              'relative min-h-0 min-w-0 overflow-hidden rounded-lg border bg-card transition-shadow',
              // The focus ring is meaningful in grid mode; in fullscreen it's
              // a visual no-op (the pane fills the viewport) so we drop it
              // to keep the chrome quiet.
              isActive && !isFullscreen
                ? 'border-[hsl(var(--ring))] shadow-[0_0_0_1px_hsl(var(--ring))]'
                : 'border-border',
              isFocused && 'sl-pane-fullscreen',
            )}
            style={cellStyle}
            onMouseDown={() => onActiveChange(cellIdx)}
            data-pane-index={cellIdx}
            data-pane-focused={isFocused ? 'true' : undefined}
          >
            {renderCell(item, { index: cellIdx, isActive, activate: () => onActiveChange(cellIdx) })}
          </div>
        );
      })}
      {/* v1.4.2 packet-12 — dividers are pointless (and visually wrong)
          while a single pane fills the viewport. Suppress them in fullscreen
          mode; they re-render automatically when the user exits fullscreen. */}
      {!isFullscreen &&
        Array.from({ length: cols - 1 }, (_, i) => {
          const leftPct = (colFracs.slice(0, i + 1).reduce((a, b) => a + b, 0) / colTotal) * 100;
          return (
            <div
              key={`col-handle-${i}`}
              onPointerDown={startDrag(i, colFracs, setColFracs, 'x')}
              className="absolute top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-[hsl(var(--ring)/0.4)]"
              style={{ left: `${leftPct}%` }}
              aria-label={`Resize column ${i + 1}`}
              role="separator"
            />
          );
        })}
      {!isFullscreen &&
        Array.from({ length: rows - 1 }, (_, i) => {
          const topPct = (rowFracs.slice(0, i + 1).reduce((a, b) => a + b, 0) / rowTotal) * 100;
          return (
            <div
              key={`row-handle-${i}`}
              onPointerDown={startDrag(i, rowFracs, setRowFracs, 'y')}
              className="absolute left-0 z-20 h-1.5 w-full -translate-y-1/2 cursor-row-resize hover:bg-[hsl(var(--ring)/0.4)]"
              style={{ top: `${topPct}%` }}
              aria-label={`Resize row ${i + 1}`}
              role="separator"
            />
          );
        })}
    </div>
  );
}
