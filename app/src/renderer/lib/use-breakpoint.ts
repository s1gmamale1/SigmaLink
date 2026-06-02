// RSP-1 — one SSR-safe responsive-breakpoint hook, replacing the scattered
// `window.innerWidth` / `matchMedia` magic numbers (Sidebar's 1100, Memory's 900).
//
// `useSyncExternalStore` over a shared `resize` listener: getSnapshot returns a
// boolean, so React bails (Object.is) unless the viewport actually crosses the
// threshold — cheap even though `resize` fires often.

import { useSyncExternalStore } from 'react';

/** Width thresholds (px). `narrow` collapses multi-column rooms; `compact`
 *  collapses the sidebar to its icon rail. */
export const BREAKPOINTS = {
  narrow: 900,
  compact: 1100,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** True when the viewport width is BELOW the named breakpoint. SSR/test-safe
 *  (returns false when there is no `window`). */
export function useBelowBreakpoint(name: BreakpointName): boolean {
  const px = BREAKPOINTS[name];
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' ? window.innerWidth < px : false),
    () => false,
  );
}
