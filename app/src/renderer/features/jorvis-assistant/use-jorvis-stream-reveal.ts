import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/renderer/lib/motion';

// chars revealed per frame; capped so a huge block still feels like typing, not a dump.
const MIN_PER_FRAME = 2;
const CATCHUP_FRACTION = 0.18; // reveal ~18% of the remaining gap each frame → eases as it catches up

export interface StreamReveal { revealed: string; caret: boolean; }

export function useJorvisStreamReveal(fullText: string, active: boolean): StreamReveal {
  const reduced = prefersReducedMotion();
  // For reduced-motion or inactive rows, start fully revealed — no rAF needed.
  const [count, setCount] = useState(() => (reduced || !active ? fullText.length : 0));
  const rafRef = useRef<number | null>(null);
  // countRef / targetRef: only written inside effects/callbacks — never during render.
  const countRef = useRef(reduced || !active ? fullText.length : 0);
  const targetRef = useRef(fullText.length);

  useEffect(() => {
    // Keep targetRef in sync with the latest fullText inside the effect (not render).
    targetRef.current = fullText.length;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // Reduced-motion or inactive: no rAF needed — initial state already has
    // fullText.length. If fullText changed, schedule a quick sync via setTimeout
    // so setState never fires synchronously in the effect body.
    if (reduced || !active) {
      const id = window.setTimeout(() => {
        countRef.current = targetRef.current;
        setCount(targetRef.current);
      }, 0);
      return () => {
        window.clearTimeout(id);
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };
    }

    const tick = () => {
      const current = countRef.current;
      const target = targetRef.current;
      if (current >= target) {
        rafRef.current = null;
        return;
      }
      const gap = target - current;
      const step = Math.max(MIN_PER_FRAME, Math.ceil(gap * CATCHUP_FRACTION));
      const next = Math.min(target, current + step);
      countRef.current = next;
      setCount(next);
      if (next < target) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [fullText, active, reduced]);

  const revealed = reduced || !active ? fullText : fullText.slice(0, count);
  // Caret shows whenever the turn is active and motion is allowed — even when
  // the reveal has caught up to the current fullText (more deltas may arrive).
  const caret = active && !reduced;
  return { revealed, caret };
}
