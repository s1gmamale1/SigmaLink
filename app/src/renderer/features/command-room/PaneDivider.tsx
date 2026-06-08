// A 1px hairline splitter between two panes (vertical) or two rows (horizontal).
// Reports the cumulative drag as a FRACTION of the container along the axis, so
// the parent (PaneGrid) can shift the two adjacent flex fractions by that amount.
// rAF-coalesced; sets `document.body.dataset.dragging` so Terminal.tsx relaxes
// its refit debounce during the drag.

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
    el.setPointerCapture(e.pointerId);
    document.body.dataset.dragging = 'true';
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
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flush();
      delete document.body.dataset.dragging;
      onResizeEnd();
      // Terminals suppress refit during the drag; tell them to fit once now.
      window.dispatchEvent(new CustomEvent('sigma:pane-resized'));
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
