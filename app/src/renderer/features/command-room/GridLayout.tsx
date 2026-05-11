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
  // 1 → 1×1, 2 → 2×1, 4 → 2×2, 6 → 3×2, 8 → 4×2, 10 → 5×2,
  // 12 → 4×3, 14/16 → 4×4, 18/20 → 5×4.
  // Odd counts fall back to the next-larger preset.
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 8) return { cols: 4, rows: 2 };
  if (count <= 10) return { cols: 5, rows: 2 };
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
}

const MIN_FRAC = 0.15;

export function GridLayout<T>({ items, getKey, renderCell, activeIndex, onActiveChange }: Props<T>) {
  const { cols, rows } = useMemo(() => shapeFor(items.length), [items.length]);
  const [colFracs, setColFracs] = useState<number[]>(() => Array(cols).fill(1));
  const [rowFracs, setRowFracs] = useState<number[]>(() => Array(rows).fill(1));
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset fracs synchronously when the grid shape changes. Comparing during
  // render and calling setState avoids the react-hooks/set-state-in-effect
  // anti-pattern; React will discard the just-set state and rerun render.
  if (colFracs.length !== cols) setColFracs(Array(cols).fill(1));
  if (rowFracs.length !== rows) setRowFracs(Array(rows).fill(1));

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
        setFracs(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [],
  );

  const totalCells = cols * rows;
  const gridStyle: CSSProperties = {
    gridTemplateColumns: colFracs.map((f) => `${f}fr`).join(' '),
    gridTemplateRows: rowFracs.map((f) => `${f}fr`).join(' '),
  };
  const colTotal = colFracs.reduce((a, b) => a + b, 0);
  const rowTotal = rowFracs.reduce((a, b) => a + b, 0);

  return (
    <div ref={containerRef} className="relative grid h-full w-full gap-1.5 p-2" style={gridStyle}>
      {Array.from({ length: totalCells }, (_, cellIdx) => {
        const item = items[cellIdx];
        if (!item) {
          return (
            <div
              key={`empty-${cellIdx}`}
              className="rounded-lg border border-dashed border-border/40 bg-muted/10"
            />
          );
        }
        const isActive = cellIdx === activeIndex;
        return (
          <div
            key={getKey(item, cellIdx)}
            className={cn(
              'relative min-h-0 min-w-0 overflow-hidden rounded-lg border bg-card transition-shadow',
              isActive
                ? 'border-[hsl(var(--ring))] shadow-[0_0_0_1px_hsl(var(--ring))]'
                : 'border-border',
            )}
            onMouseDown={() => onActiveChange(cellIdx)}
            data-pane-index={cellIdx}
          >
            {renderCell(item, { index: cellIdx, isActive, activate: () => onActiveChange(cellIdx) })}
          </div>
        );
      })}
      {Array.from({ length: cols - 1 }, (_, i) => {
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
      {Array.from({ length: rows - 1 }, (_, i) => {
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
