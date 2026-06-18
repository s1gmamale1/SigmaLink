// DOM terminal presenter — robust stick-to-bottom for FlowView. The pure
// `computeStick` decision is jsdom-testable; the hook layers the DOM concerns
// the inline version lacked: the consumer sets overflow-anchor:none, the
// "keep prior intent unless scrolled up" rule means a content-growth distance
// jump can't disengage follow, and a rAF bottom re-assert means
// content-visibility re-measurement can't leave us short of the true bottom.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Within this many px of the bottom counts as "at bottom" (auto-follow). A
 *  generous slop tolerates content-visibility height-estimation jitter that
 *  the old 8px threshold did not. */
export const STICK_SLOP_PX = 24;

/** Pure decision: should the view follow the bottom after this scroll metric?
 *  - within slop of bottom -> follow
 *  - user scrolled UP away from bottom -> detach
 *  - otherwise (e.g. content grew, distance jumped, but no upward scroll) keep
 *    the prior intent — this is what stops the "follows then stops" bug. */
export function computeStick(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastTop: number;
  wasSticking: boolean;
  slop?: number;
}): boolean {
  const slop = opts.slop ?? STICK_SLOP_PX;
  const distance = opts.scrollHeight - opts.scrollTop - opts.clientHeight;
  if (distance <= slop) return true;
  const scrolledUp = opts.scrollTop < opts.lastTop - 1;
  if (scrolledUp) return false;
  return opts.wasSticking;
}

export function useStickToBottom(): {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onScroll: () => void;
  scrollToBottom: () => void;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = el.scrollTop;
  }, []);

  // Re-pin on every render while following; rAF re-assert after
  // content-visibility settles so we never land short of the true bottom.
  // When not following, do nothing — never yank a reading user back down.
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    pin();
    const id = requestAnimationFrame(() => {
      if (stickRef.current) pin();
    });
    return () => cancelAnimationFrame(id);
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = computeStick({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      lastTop: lastTopRef.current,
      wasSticking: stickRef.current,
    });
    lastTopRef.current = el.scrollTop;
    stickRef.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  const scrollToBottom = useCallback(() => {
    stickRef.current = true;
    pin();
    setAtBottom(true);
  }, [pin]);

  return { scrollRef, atBottom, onScroll, scrollToBottom };
}
