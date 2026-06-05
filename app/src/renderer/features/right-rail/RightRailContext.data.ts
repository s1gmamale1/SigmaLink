// Pure context + type + KV key constants for the right-rail tab state. Split
// out of `RightRailContext.tsx` so the component file exports only a
// component — keeps the `react-refresh/only-export-components` rule happy
// without forcing external callers to chase the type into a new path.

import { createContext, useContext } from 'react';

export type RightRailTabId = 'browser' | 'editor' | 'jorvis' | 'skills' | 'swarm';

export const KV_TAB = 'rightRail.tab';
// Per-workspace panel id for the open/closed state.
export const KV_OPEN = 'rightRail.open';
export const DEFAULT_TAB: RightRailTabId = 'browser';
export const VALID_TABS: ReadonlySet<RightRailTabId> = new Set([
  'browser',
  'editor',
  'jorvis',
  'skills',
  'swarm',
]);

/**
 * Backward-compat: persisted KV may hold `'sigma'` from before the v1.8.x
 * Jorvis rename. Map it to the current tab id so the rail opens correctly.
 */
export function normalizeTabId(value: string): string {
  if (value === 'sigma') return 'jorvis';
  return value;
}

export interface RightRailContextValue {
  activeTab: RightRailTabId;
  setActiveTab: (tab: RightRailTabId) => void;
  /** Whether the right-rail panel is currently open. Defaults to true. */
  railOpen: boolean;
  /** Explicitly set the rail open/closed state. Persists per-workspace. */
  setRailOpen: (open: boolean) => void;
  /** Toggle rail open↔closed. Persists per-workspace. */
  toggleRail: () => void;
}

export const RightRailCtx = createContext<RightRailContextValue | null>(null);

export function useRightRail(): RightRailContextValue {
  const ctx = useContext(RightRailCtx);
  if (!ctx) {
    throw new Error('useRightRail must be used within a RightRailProvider');
  }
  return ctx;
}
