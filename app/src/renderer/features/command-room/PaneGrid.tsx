// Command Room fill-grid with row-local resize (BridgeSpace-style).
//
// Sessions tile into rows (rows ≈ √n, short rows widen to fill — no dead space).
// Each row is an independent CSS grid, so dragging a vertical divider resizes
// ONLY the two adjacent panes in that row. Horizontal dividers between rows
// resize the two adjacent rows. Panes are keyed by sessionId; resizing never
// reparents a pane (no remount). Adding/removing a pane reflows the rows — a
// pane may move rows and remount, but the terminal cache preserves its
// scrollback, and resize fractions reset to even for the new shape.
//
// WHY CSS GRID + CSS VARIABLES (not per-cell flex):
//   The previous flex model put the size on each cell as a React-controlled
//   inline style (`style={{ flex }}`). Running terminals dispatch
//   `sigma:pty-focus` → SET_ACTIVE_SESSION at cursor-move frequency, which
//   re-renders CommandRoom → this (non-memoized) grid; React then reconciled
//   the cell's `style.flex` back to the STALE committed value mid-drag,
//   stomping the live imperative drag → oscillation ("glitchy resize").
//
//   The fix: the live track sizes live in CSS custom properties — `--pg-rows`
//   on the grid container and `--pg-cols` on each row. JSX only ever emits the
//   CONSTANT strings `var(--pg-rows)` / `var(--pg-cols)`, which React rewrites
//   to the same value on every render (a no-op) — so reconciliation can NEVER
//   stomp the live size. The vars are the single mutable source, written
//   imperatively by the drag handler (one setProperty per rAF, no setState) and
//   by a useLayoutEffect on commit. `minmax(0, fr)` tracks distribute space
//   deterministically (no sub-pixel flex jitter) and allow panes to shrink past
//   xterm's intrinsic content width.
//
// Square corners; 1px hairlines are the divider tracks (bg-border); accent ring
// on the active pane; fullscreen overlays the focused pane above all chrome
// (z-50).

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** A CSS grid track list for `fractions`, with 1px divider tracks between them.
 *  `minmax(0, Nfr)` lets a track shrink past its content's intrinsic size
 *  (e.g. xterm's stamped pixel width) and distributes space deterministically. */
function trackTemplate(fractions: number[]): string {
  return fractions.map((f) => `minmax(0,${f}fr)`).join(' 1px ');
}

/** Parse + VALIDATE persisted fractions against the current shape. Rejects a
 *  blob whose signature, row/col counts, or entry types don't match — a stale
 *  or hand-edited value would otherwise yield `undefined` track sizes. */
function parseFracs(raw: string | null, sig: string, rows: string[][]): Fracs | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as Fracs;
    if (
      f &&
      f.sig === sig &&
      Array.isArray(f.rows) &&
      f.rows.length === rows.length &&
      f.rows.every((x) => typeof x === 'number') &&
      Array.isArray(f.cols) &&
      f.cols.length === rows.length &&
      f.cols.every(
        (c, i) => Array.isArray(c) && c.length === rows[i]!.length && c.every((x) => typeof x === 'number'),
      )
    ) {
      return f;
    }
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
  // the shape signature doesn't match (a pane was added/removed). A re-render
  // when `stored` changes is what runs the layout-effect that writes the CSS
  // vars; during a drag we DON'T setState (the var is mutated imperatively).
  const [stored, setStored] = useState<Fracs | null>(null);
  const fracs = stored && stored.sig === sig ? stored : evenFracs(rows);
  const fracsKey = JSON.stringify(fracs);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());
  // Authoritative base for begin/endDrag, synced at every mutation point (never
  // during render). Reading `stored` in a handler that closed over an old
  // render (e.g. a window pointerup listener from drag-start) could be stale —
  // and an async KV load that resolves mid-drag would corrupt other rows'
  // persisted fractions. The ref is always current, so the drag math is too.
  const storedRef = useRef<Fracs | null>(null);
  // Active drag: which axis/track + the captured starting fractions + the
  // element whose CSS var we mutate. During the drag we write ONLY that var
  // imperatively (no setState → the heavy PaneShell/terminal tree never
  // re-renders per frame); state is committed once on release.
  const dragRef = useRef<{
    kind: 'row' | 'col';
    row: number;
    index: number;
    snap: number[];
    el: HTMLElement | null;
    prop: '--pg-rows' | '--pg-cols';
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
          f = parseFracs(await rpcSilent.kv.get(kvKey(workspaceId)), sig, rows);
        } catch {
          f = null;
        }
      }
      if (!alive) return;
      loadedForRef.current = workspaceId;
      lastSavedRef.current = f ? JSON.stringify(f) : '';
      storedRef.current = f; // keep the drag base authoritative immediately
      setStored(f);
    })();
    return () => {
      alive = false;
    };
    // Re-load on workspace change only; sig/rows are captured for the validity
    // check (a shape change without a workspace change just fails validation →
    // even fractions, which is correct).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Write the CSS vars from the COMMITTED fractions. Keyed on the fraction
  // VALUE (fracsKey) so incidental re-renders (SET_ACTIVE_SESSION etc.) do NOT
  // re-run it and overwrite a live drag. The drag guard is belt-and-suspenders.
  useLayoutEffect(() => {
    if (dragRef.current) return;
    const container = containerRef.current;
    if (container) container.style.setProperty('--pg-rows', trackTemplate(fracs.rows));
    fracs.cols.forEach((cols, r) => {
      const rowEl = rowRefs.current.get(r);
      if (rowEl) rowEl.style.setProperty('--pg-cols', trackTemplate(cols));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fracsKey]);

  // Plain closures (not useCallback): they read mutable refs + rebuild the
  // fracs, which the React compiler can't memoize; they're handed to a
  // non-memoized divider, so memoization buys nothing.
  const persist = (next: Fracs) => {
    if (!workspaceId || loadedForRef.current !== workspaceId) return;
    const serialized = JSON.stringify(next);
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;
    rpcSilent.kv.set(kvKey(workspaceId), serialized).catch(() => {});
  };

  const beginDrag = (kind: 'row' | 'col', row: number, index: number) => {
    const base = storedRef.current && storedRef.current.sig === sig ? storedRef.current : evenFracs(rows);
    const snap = kind === 'row' ? [...base.rows] : [...base.cols[row]!];
    const el = kind === 'row' ? containerRef.current : rowRefs.current.get(row) ?? null;
    const prop: '--pg-rows' | '--pg-cols' = kind === 'row' ? '--pg-rows' : '--pg-cols';
    dragRef.current = { kind, row, index, snap, el, prop, last: snap };
    // Tell terminals a divider drag started so they suppress their per-frame RO
    // refit until `sigma:pane-resize-end` (one clean refit on release, no SIGWINCH
    // storm). Paired with the dispatch in endDrag below.
    window.dispatchEvent(new CustomEvent('sigma:pane-resize-start'));
  };

  // Per-frame: mutate ONLY the dragged container's CSS var — no React render,
  // so the drag stays smooth regardless of how heavy the panes are, and no
  // re-render can stomp it (React never owns this var).
  const applyDrag = (delta: number) => {
    const d = dragRef.current;
    if (!d || !d.el) return;
    const next = shiftPair(d.snap, d.index, delta);
    d.last = next;
    d.el.style.setProperty(d.prop, trackTemplate(next));
  };

  // On release: commit the final fractions to React state once, persist, and
  // tell the terminals to refit NOW (instead of after the RO debounce, which
  // would snap content ~60ms after release).
  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const base = storedRef.current && storedRef.current.sig === sig ? storedRef.current : evenFracs(rows);
    const next: Fracs =
      d.kind === 'row'
        ? { ...base, sig, rows: d.last }
        : { ...base, sig, cols: base.cols.map((c, r) => (r === d.row ? d.last : c)) };
    storedRef.current = next;
    setStored(next);
    persist(next);
    window.dispatchEvent(new CustomEvent('sigma:pane-resize-end'));
  };

  if (rows.length === 0) return <div className="h-full w-full" data-testid="pane-grid-empty" />;

  return (
    <div
      ref={containerRef}
      data-testid="pane-grid"
      className="relative grid h-full w-full bg-background"
      // CONSTANT string — the live row sizes live in `--pg-rows`, written
      // imperatively, so React reconciliation never rewrites them.
      style={{ gridTemplateRows: 'var(--pg-rows)' }}
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
            data-testid="pane-row"
            className="grid min-h-0 min-w-0 overflow-hidden"
            style={{ gridTemplateColumns: 'var(--pg-cols)' }}
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
                    data-testid="pane-cell"
                    data-session-id={sid}
                    data-active={isActive ? 'true' : undefined}
                    data-bsp-hidden={isHidden ? 'true' : undefined}
                    onMouseDownCapture={() => onActivate(sid)}
                    className={[
                      'relative min-h-0 min-w-0 overflow-hidden bg-card',
                      isActive ? 'sl-pane-active z-[1] ring-1 ring-inset ring-[hsl(var(--ring))]' : '',
                    ].join(' ')}
                    // Cells carry NO size style — the grid track sizes them. Only
                    // the fullscreen overlay / hidden-sibling branches set style,
                    // and those change only on focus (rare), never per drag-frame.
                    style={
                      isFocused
                        ? { position: 'absolute', inset: 0, zIndex: 50 }
                        : isHidden
                          ? { display: 'none' }
                          : undefined
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
