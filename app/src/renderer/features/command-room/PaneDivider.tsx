// A 1px hairline splitter between two panes (vertical) or two rows (horizontal).
// Reports the cumulative drag as a FRACTION of the container along the axis, so
// the parent (PaneGrid) can shift the two adjacent flex fractions by that amount.
// rAF-coalesced. (Terminals refit on their own ResizeObserver, coalesced per
// animation frame — no global drag flag, so a missed pointerup can't freeze
// refits.)

import { useRef } from 'react';

interface Props {
  /** 'vertical' = a vertical line that resizes widths; 'horizontal' = resizes heights. */
  orientation: 'vertical' | 'horizontal';
  /** Pixel size of the container along the drag axis (row width / column height). */
  getSize: () => number;
  onResizeStart: () => void;
  /** Cumulative delta since drag start, as a fraction (-1..1) of the container. */
  onResize: (deltaFraction: number) => void;
  onResizeEnd: () => void;
}

const NUDGE = 0.02;

export function PaneDivider({ orientation, getSize, onResizeStart, onResize, onResizeEnd }: Props) {
  const vertical = orientation === 'vertical';
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  function flush() {
    rafRef.current = null;
    if (pendingRef.current !== null) {
      onResize(pendingRef.current);
      pendingRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; the window listeners below drive the drag */
    }
    const size = getSize();
    const startPos = vertical ? e.clientX : e.clientY;
    onResizeStart();

    const move = (ev: PointerEvent) => {
      if (size <= 0) return;
      const pos = vertical ? ev.clientX : ev.clientY;
      pendingRef.current = (pos - startPos) / size;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    };
    const up = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* may already be released / detached — ignore */
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flush();
      onResizeEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
    const inc = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    onResizeStart();
    onResize(e.key === inc ? NUDGE : -NUDGE);
    onResizeEnd();
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      tabIndex={0}
      data-testid="pane-divider"
      data-orientation={orientation}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={[
        'relative z-[2] shrink-0 bg-border',
        vertical
          ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-[3px] before:-right-[3px] before:content-[""]'
          : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-[3px] before:-bottom-[3px] before:content-[""]',
        'outline-none focus-visible:bg-[hsl(var(--ring))]',
      ].join(' ')}
    />
  );
}
