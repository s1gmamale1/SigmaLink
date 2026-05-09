// Vertical drag-handle for the right-rail dock.
//
// Lives between the main body slot and the rail column. Pointer-down captures
// the pointer, then `pointermove` reports x-deltas which the parent maps to a
// new rail width. The actual width is owned by `RightRail.tsx` and persisted
// to `kv['rightRail.width']`; this component is a controlled callback emitter.

import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  /** Current rail width (px). Used as the drag baseline. */
  width: number;
  /** Called continuously during drag with the proposed new width. */
  onResize: (next: number) => void;
  /** Called once the user releases the pointer. Persists the width. */
  onCommit: (final: number) => void;
  /** Min/max clamps applied during drag. */
  minWidth?: number;
  maxWidth?: number;
}

const DEFAULT_MIN = 320;
const DEFAULT_MAX = 900;

export function Splitter({
  width,
  onResize,
  onCommit,
  minWidth = DEFAULT_MIN,
  maxWidth = DEFAULT_MAX,
}: Props) {
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastWidthRef = useRef(width);
  // Mirror prop into ref so the global pointermove handler reads fresh values
  // without re-binding listeners every render.
  useEffect(() => {
    lastWidthRef.current = width;
  }, [width]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = { startX: e.clientX, startWidth: lastWidthRef.current };
      // Capture so we keep getting move events even if the cursor leaves.
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (!drag) return;
      // The rail is on the RIGHT, so dragging left expands the rail.
      const delta = drag.startX - e.clientX;
      const next = Math.max(minWidth, Math.min(maxWidth, drag.startWidth + delta));
      lastWidthRef.current = next;
      onResize(next);
    },
    [maxWidth, minWidth, onResize],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore — pointer may have been released already */
      }
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onCommit(lastWidthRef.current);
    },
    [onCommit],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize right rail"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        'group relative w-1 shrink-0 cursor-col-resize bg-border/40',
        'hover:bg-primary/40 active:bg-primary/60',
      )}
    >
      {/* Wider invisible hit target so the user does not need pixel precision. */}
      <div className="absolute inset-y-0 -left-1.5 w-3.5" />
    </div>
  );
}
