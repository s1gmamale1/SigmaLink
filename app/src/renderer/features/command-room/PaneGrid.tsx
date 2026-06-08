// Command Room fill-grid with row-local resize (BridgeSpace-style).
//
// Sessions tile into rows (rows ≈ √n, short rows widen to fill — no dead space).
// Each row is an independent flex row, so dragging a vertical divider resizes
// ONLY the two adjacent panes in that row (not the whole column). Horizontal
// dividers between rows resize the two adjacent rows. Panes are keyed by
// sessionId; resizing never reparents a pane (no remount). Adding/removing a
// pane reflows the rows — a pane may move rows and remount, but the terminal
// cache preserves its scrollback, and resize fractions reset to even for the
// new shape.
//
// Square corners; 1px hairlines are the dividers (bg-border); accent ring on the
// active pane; fullscreen overlays the focused pane above all chrome (z-50).

import { Fragment, useEffect, useRef, useState } from 'react';
import { rpcSilent } from '@/renderer/lib/rpc';
import { paneRows, shapeSignature } from '@/shared/pane-grid-shape';
import { PaneDivider } from './PaneDivider';

export interface PaneGridProps {
  sessionIds: string[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
  workspaceId: string | null;
  onActivate: (sessionId: string) => void;
  renderLeaf: (sessionId: string) => React.ReactNode;
}

interface Fracs {
  sig: string;
  rows: number[]; // per-row height fractions, sum 1
  cols: number[][]; // per-row column-width fractions, each sub-array sums to 1
}

const MIN_FRAC = 0.1;

function evenFracs(rows: string[][]): Fracs {
  return {
    sig: rows.map((r) => r.length).join('x'),
    rows: rows.map(() => 1 / rows.length),
    cols: rows.map((r) => r.map(() => 1 / r.length)),
  };
}

function kvKey(workspaceId: string): string {
  return `panegrid.${workspaceId}`;
}

function parseFracs(raw: string | null, sig: string): Fracs | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as Fracs;
    if (f && f.sig === sig && Array.isArray(f.rows) && Array.isArray(f.cols)) return f;
  } catch {
    /* ignore */
  }
  return null;
}

/** Shift two adjacent fractions by `delta`, keeping their pair-sum and both ≥ MIN. */
function shiftPair(snap: number[], i: number, delta: number): number[] {
  const pairSum = snap[i]! + snap[i + 1]!;
  const a = Math.min(pairSum - MIN_FRAC, Math.max(MIN_FRAC, snap[i]! + delta));
  const next = [...snap];
  next[i] = a;
  next[i + 1] = pairSum - a;
  return next;
}

export function PaneGrid({
  sessionIds,
  activeSessionId,
  focusedPaneId,
  workspaceId,
  onActivate,
  renderLeaf,
}: PaneGridProps) {
  const rows = paneRows(sessionIds);
  const sig = shapeSignature(sessionIds);

  // Resize fractions. `stored` is the user's overrides; falls back to even when
  // the shape signature doesn't match (a pane was added/removed).
  const [stored, setStored] = useState<Fracs | null>(null);
  const fracs = stored && stored.sig === sig ? stored : evenFracs(rows);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());
  const cellRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Active drag: the two neighbour elements + their starting fractions. During
  // the drag we mutate ONLY these two elements' flex imperatively (no setState,
  // so the heavy PaneShell/terminal tree never re-renders per frame); state is
  // committed once on release.
  const dragRef = useRef<{
    kind: 'row' | 'col';
    row: number;
    index: number;
    snap: number[];
    els: [HTMLElement | undefined, HTMLElement | undefined];
    last: number[];
  } | null>(null);
  const loadedForRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string>('');

  // Load persisted fractions for this workspace (setState only after await).
  useEffect(() => {
    let alive = true;
    void (async () => {
      let f: Fracs | null = null;
      if (workspaceId) {
        try {
          f = parseFracs(await rpcSilent.kv.get(kvKey(workspaceId)), sig);
        } catch {
          f = null;
        }
      }
      if (!alive) return;
      loadedForRef.current = workspaceId;
      lastSavedRef.current = f ? JSON.stringify(f) : '';
      setStored(f);
    })();
    return () => {
      alive = false;
    };
    // Re-load on workspace change only; sig is captured for the validity check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Plain closures (not useCallback): they read a mutable ref + rebuild the
  // fracs, which the React compiler can't memoize; they're handed to a
  // non-memoized divider, so memoization buys nothing. Defined fresh each render
  // with current state/props.
  const persist = (next: Fracs) => {
    if (!workspaceId || loadedForRef.current !== workspaceId) return;
    const serialized = JSON.stringify(next);
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;
    rpcSilent.kv.set(kvKey(workspaceId), serialized).catch(() => {});
  };

  const beginDrag = (kind: 'row' | 'col', row: number, index: number) => {
    const base = stored && stored.sig === sig ? stored : evenFracs(rows);
    const snap = kind === 'row' ? [...base.rows] : [...base.cols[row]!];
    const els: [HTMLElement | undefined, HTMLElement | undefined] =
      kind === 'row'
        ? [rowRefs.current.get(index), rowRefs.current.get(index + 1)]
        : [
            cellRefs.current.get(rows[row]![index]!),
            cellRefs.current.get(rows[row]![index + 1]!),
          ];
    dragRef.current = { kind, row, index, snap, els, last: snap };
  };

  // Per-frame: mutate ONLY the two neighbours' flex directly on the DOM — no
  // React render, so the drag stays smooth regardless of how heavy the panes are.
  const applyDrag = (delta: number) => {
    const d = dragRef.current;
    if (!d) return;
    const next = shiftPair(d.snap, d.index, delta);
    d.last = next;
    if (d.els[0]) d.els[0].style.flex = String(next[d.index]);
    if (d.els[1]) d.els[1].style.flex = String(next[d.index + 1]);
  };

  // On release: commit the final fractions to React state once, then persist.
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const base = stored && stored.sig === sig ? stored : evenFracs(rows);
    const next: Fracs =
      d.kind === 'row'
        ? { ...base, sig, rows: d.last }
        : { ...base, sig, cols: base.cols.map((c, r) => (r === d.row ? d.last : c)) };
    setStored(next);
    persist(next);
  };

  if (rows.length === 0) return <div className="h-full w-full" data-testid="pane-grid-empty" />;

  return (
    <div
      ref={containerRef}
      data-testid="pane-grid"
      className="relative flex h-full w-full flex-col bg-background"
    >
      {rows.map((rowIds, r) => (
        <Fragment key={r}>
          {r > 0 ? (
            <PaneDivider
              orientation="horizontal"
              getSize={() => containerRef.current?.getBoundingClientRect().height ?? 0}
              onResizeStart={() => beginDrag('row', r, r - 1)}
              onResize={applyDrag}
              onResizeEnd={endDrag}
            />
          ) : null}
          <div
            ref={(el) => {
              if (el) rowRefs.current.set(r, el);
              else rowRefs.current.delete(r);
            }}
            className="flex min-h-0 min-w-0 flex-row"
            style={{ flex: fracs.rows[r] ?? 1 }}
          >
            {rowIds.map((sid, i) => {
              const isFocused = focusedPaneId === sid;
              const isHidden = focusedPaneId !== null && !isFocused;
              const isActive = activeSessionId === sid && focusedPaneId === null;
              return (
                <Fragment key={sid}>
                  {i > 0 ? (
                    <PaneDivider
                      orientation="vertical"
                      getSize={() => rowRefs.current.get(r)?.getBoundingClientRect().width ?? 0}
                      onResizeStart={() => beginDrag('col', r, i - 1)}
                      onResize={applyDrag}
                      onResizeEnd={endDrag}
                    />
                  ) : null}
                  <div
                    ref={(el) => {
                      if (el) cellRefs.current.set(sid, el);
                      else cellRefs.current.delete(sid);
                    }}
                    data-testid="pane-cell"
                    data-session-id={sid}
                    data-active={isActive ? 'true' : undefined}
                    data-bsp-hidden={isHidden ? 'true' : undefined}
                    onMouseDownCapture={() => onActivate(sid)}
                    className={[
                      'relative min-h-0 min-w-0 overflow-hidden bg-card',
                      isActive ? 'sl-pane-active z-[1] ring-1 ring-inset ring-[hsl(var(--ring))]' : '',
                    ].join(' ')}
                    style={
                      isFocused
                        ? { position: 'absolute', inset: 0, zIndex: 50 }
                        : isHidden
                          ? { display: 'none' }
                          : { flex: fracs.cols[r]?.[i] ?? 1 }
                    }
                  >
                    {renderLeaf(sid)}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
