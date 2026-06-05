import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/renderer/lib/motion';

// chars revealed per frame; capped so a huge block still feels like typing, not a dump.
const MIN_PER_FRAME = 2;
const CATCHUP_FRACTION = 0.18; // reveal ~18% of the remaining gap each frame → eases as it catches up

export interface StreamReveal { revealed: string; caret: boolean; }

export function useJorvisStreamReveal(fullText: string, active: boolean): StreamReveal {
  const reduced = prefersReducedMotion();
  const [count, setCount] = useState(reduced || !active ? fullText.length : 0);
  const rafRef = useRef<number | null>(null);
  // Track count on a ref so the rAF tick can read current value synchronously
  const countRef = useRef(count);
  countRef.current = count;

  useEffect(() => {
    if (reduced || !active) {
      setCount(fullText.length);
      return;
    }
    // Reset count when text changes while active (new delta arrived)
    // Only reset downward if new text is shorter (shouldn't happen) or advance forward
    const tick = () => {
      const current = countRef.current;
      if (current >= fullText.length) {
        rafRef.current = null;
        return;
      }
      const gap = fullText.length - current;
      const step = Math.max(MIN_PER_FRAME, Math.ceil(gap * CATCHUP_FRACTION));
      const next = Math.min(fullText.length, current + step);
      countRef.current = next;
      setCount(next);
      if (next < fullText.length) {
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
