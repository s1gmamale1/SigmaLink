// v1.5.1-A — SplitGroupCell extracted from CommandRoom.tsx.
//
// Renders the two halves of a split group in a single grid cell, separated by
// a sub-divider. Each sub-pane is its own <SessionTerminal> (and its own
// terminal-cache entry) so the cache handles their lifecycles transparently —
// no special-casing needed there.
//
// The sub-divider resizes the two halves with a simple ratio state; the outer
// GridLayout's divider math is unaffected because the split group occupies one
// outer grid cell.

// v1.4.3 #06

import { useCallback, useRef, useState } from 'react';
import { PaneShell } from './PaneShell';
import type { AgentSession } from '@/shared/types';

export function SplitGroupCell({
  panes,
  paneIndex,
  providers,
  focusedPaneId,
  workspaceRootPath,
  onActivate,
  onRemove,
  onStop,
  onToggleMinimise,
  onToggleFullscreen,
}: {
  panes: AgentSession[];
  paneIndex: number;
  providers: { id: string; name: string }[];
  focusedPaneId: string | null;
  /** v1.4.8 — forwarded to PaneShell for Finder-drop path normalisation. */
  workspaceRootPath: string;
  onActivate: (id: string) => void;
  onRemove: (s: AgentSession) => void;
  onStop: (s: AgentSession) => void;
  onToggleMinimise: (s: AgentSession) => void;
  onToggleFullscreen: (id: string) => void;
}) {
  const direction = panes[0]?.splitDirection ?? 'horizontal';
  const groupId = panes[0]?.splitGroupId ?? `split-${paneIndex}`;
  // Sub-grid divider state — fractional split between the two halves.
  // Defaults to 0.5 each. Min 0.15 to mirror GridLayout's MIN_FRAC.
  const [ratio, setRatio] = useState(0.5);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const startSubDrag = useCallback(
    (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = direction === 'vertical' ? rect.width : rect.height;
      const start = direction === 'vertical' ? ev.clientX : ev.clientY;
      const initial = ratio;
      let pendingRaf: number | null = null;
      let latest: number | null = null;
      const flush = () => {
        if (latest !== null) setRatio(latest);
        latest = null;
        pendingRaf = null;
      };
      document.body.dataset.dragging = 'true';
      const move = (e: PointerEvent) => {
        const delta = (direction === 'vertical' ? e.clientX : e.clientY) - start;
        const dFrac = delta / total;
        latest = Math.min(0.85, Math.max(0.15, initial + dFrac));
        if (pendingRaf === null) {
          pendingRaf = requestAnimationFrame(flush);
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (pendingRaf !== null) {
          cancelAnimationFrame(pendingRaf);
          pendingRaf = null;
          if (latest !== null) setRatio(latest);
          latest = null;
        }
        delete document.body.dataset.dragging;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, ratio],
  );

  // CSS grid template — 2 cols for vertical split (side-by-side) or 2 rows
  // for horizontal split (top/bottom). The brief uses "horizontal" to mean
  // "split the pane horizontally → two rows" — matches typical terminal
  // multiplexer semantics.
  const gridStyle =
    direction === 'vertical'
      ? { gridTemplateColumns: `${ratio}fr ${1 - ratio}fr` }
      : { gridTemplateRows: `${ratio}fr ${1 - ratio}fr` };

  return (
    <div
      ref={containerRef}
      className="relative grid h-full min-h-0 w-full min-w-0 gap-1"
      style={gridStyle}
      data-split-group={groupId}
      data-split-direction={direction}
    >
      {panes.map((p, idx) => (
        <div
          key={p.id}
          className="relative min-h-0 min-w-0 overflow-hidden rounded-md border border-border bg-card"
          onMouseDown={() => onActivate(p.id)}
        >
          <PaneShell
            session={p}
            paneIndex={paneIndex}
            providers={providers}
            workspaceRootPath={workspaceRootPath}
            onFocus={() => onActivate(p.id)}
            onRemove={() => onRemove(p)}
            onStop={() => onStop(p)}
            onSplit={() => undefined /* disabled in split sub-panes */}
            onToggleMinimise={() => onToggleMinimise(p)}
            isFullscreen={focusedPaneId === p.id}
            onToggleFullscreen={() => onToggleFullscreen(p.id)}
            inSplitGroup
          />
          {idx === 0 ? (
            // Sub-divider sits at the boundary between the two halves.
            // Positioned absolutely so it doesn't disturb the sub-grid math.
            <div
              onPointerDown={startSubDrag}
              className={
                direction === 'vertical'
                  ? 'absolute right-0 top-0 z-30 h-full w-1.5 translate-x-1/2 cursor-col-resize hover:bg-[hsl(var(--ring)/0.4)]'
                  : 'absolute bottom-0 left-0 z-30 h-1.5 w-full translate-y-1/2 cursor-row-resize hover:bg-[hsl(var(--ring)/0.4)]'
              }
              role="separator"
              aria-label={`Resize split ${direction === 'vertical' ? 'column' : 'row'}`}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
