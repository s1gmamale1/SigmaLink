// One resizable splitter between the two children of a split node.
// Drag (or arrow keys) reports the new ratio for child `a`. The owning branch
// passes the container size accessor so this component stays presentation-only.

import { useRef } from 'react';

interface Props {
  dir: 'h' | 'v';
  ratio: number;
  /** Pixel size of the parent split container along the split axis. */
  getContainerSize: () => number;
  /** Commit a new ratio (already in 0..1; BspLayout clamps via setRatio). */
  onRatio: (ratio: number) => void;
}

const NUDGE = 0.02;

export function BspDivider({ dir, ratio, getContainerSize, onRatio }: Props) {
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  function flush() {
    rafRef.current = null;
    if (pendingRef.current !== null) {
      onRatio(pendingRef.current);
      pendingRef.current = null;
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.dataset.dragging = 'true';
    const size = getContainerSize();
    const startPos = dir === 'v' ? e.clientX : e.clientY;
    const startRatio = ratio;

    const move = (ev: PointerEvent) => {
      const pos = dir === 'v' ? ev.clientX : ev.clientY;
      if (size <= 0) return;
      const next = startRatio + (pos - startPos) / size;
      pendingRef.current = next;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      flush();
      delete document.body.dataset.dragging;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dec = dir === 'v' ? 'ArrowLeft' : 'ArrowUp';
    const inc = dir === 'v' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) { e.preventDefault(); onRatio(ratio - NUDGE); }
    else if (e.key === inc) { e.preventDefault(); onRatio(ratio + NUDGE); }
  }

  return (
    <div
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      data-testid="bsp-divider"
      data-dir={dir}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={[
        'relative z-10 shrink-0 bg-border',
        dir === 'v'
          ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-[3px] before:-right-[3px] before:content-[""]'
          : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-[3px] before:-bottom-[3px] before:content-[""]',
        'outline-none focus-visible:bg-[hsl(var(--ring))]',
      ].join(' ')}
    />
  );
}
