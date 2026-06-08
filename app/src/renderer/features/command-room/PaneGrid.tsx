// Command Room uniform fill-grid (BridgeSpace-style).
//
// A flat CSS grid: every pane is a direct child keyed by sessionId, placed by
// `gridShape` (rows ≈ √n, last/short rows widen to fill — no dead space). Flat
// siblings keyed by sessionId means a reflow (add/remove pane) only changes a
// cell's grid placement, never its parent, so the cached xterm terminals never
// remount. Square corners; 1px hairlines via `gap-px` on a `bg-border` ground;
// accent ring on the active pane. Fullscreen overlays the focused pane above all
// chrome (z-50 > the z-20 PaneHeader). There is no per-pane resize — the grid is
// a pure function of the session list (no layout state, no persistence).

import { gridShape } from '@/shared/pane-grid-shape';

export interface PaneGridProps {
  sessionIds: string[];
  activeSessionId: string | null;
  focusedPaneId: string | null;
  onActivate: (sessionId: string) => void;
  renderLeaf: (sessionId: string) => React.ReactNode;
}

export function PaneGrid({
  sessionIds,
  activeSessionId,
  focusedPaneId,
  onActivate,
  renderLeaf,
}: PaneGridProps) {
  const shape = gridShape(sessionIds);

  if (shape.cells.length === 0) {
    return <div className="h-full w-full" data-testid="pane-grid-empty" />;
  }

  return (
    <div
      data-testid="pane-grid"
      data-cols={shape.cols}
      data-rows={shape.rows}
      className="relative grid h-full w-full gap-px bg-border"
      style={{
        gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${shape.rows}, minmax(0, 1fr))`,
      }}
    >
      {shape.cells.map((cell) => {
        const isFocused = focusedPaneId === cell.sessionId;
        const isHidden = focusedPaneId !== null && !isFocused;
        const isActive = activeSessionId === cell.sessionId && focusedPaneId === null;
        return (
          <div
            key={cell.sessionId}
            data-testid="pane-cell"
            data-session-id={cell.sessionId}
            data-active={isActive ? 'true' : undefined}
            data-bsp-hidden={isHidden ? 'true' : undefined}
            onMouseDownCapture={() => onActivate(cell.sessionId)}
            className={[
              'relative min-h-0 min-w-0 overflow-hidden bg-card',
              isActive ? 'sl-pane-active z-[1] ring-1 ring-inset ring-[hsl(var(--ring))]' : '',
            ].join(' ')}
            // Fullscreen: focused cell overlays the whole grid above all chrome;
            // the rest stay mounted (display:none) so terminals are preserved.
            style={
              isFocused
                ? { position: 'absolute', inset: 0, zIndex: 50 }
                : isHidden
                  ? { display: 'none' }
                  : { gridColumn: `span ${cell.colSpan}` }
            }
          >
            {renderLeaf(cell.sessionId)}
          </div>
        );
      })}
    </div>
  );
}
