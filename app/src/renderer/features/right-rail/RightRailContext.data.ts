// Pure context + type + KV key constants for the right-rail tab state. Split
// out of `RightRailContext.tsx` so the component file exports only a
// component — keeps the `react-refresh/only-export-components` rule happy
// without forcing external callers to chase the type into a new path.

import { createContext, useContext } from 'react';

export type RightRailTabId = 'browser' | 'editor' | 'bridge';

export const KV_TAB = 'rightRail.tab';
export const DEFAULT_TAB: RightRailTabId = 'browser';
export const VALID_TABS: ReadonlySet<RightRailTabId> = new Set([
  'browser',
  'editor',
  'bridge',
]);

export interface RightRailContextValue {
  activeTab: RightRailTabId;
  setActiveTab: (tab: RightRailTabId) => void;
}

export const RightRailCtx = createContext<RightRailContextValue | null>(null);

export function useRightRail(): RightRailContextValue {
  const ctx = useContext(RightRailCtx);
  if (!ctx) {
    throw new Error('useRightRail must be used within a RightRailProvider');
  }
  return ctx;
}
