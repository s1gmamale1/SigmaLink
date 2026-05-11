// SigmaLink v1.1.4 Step 3 — lifts the right-rail's active-tab state out of
// `RightRail.tsx` and into a React context so the top-bar segmented control
// (`RightRailSwitcher`) and the rail itself can share one source of truth.
//
// Persistence is kv-backed under the same `rightRail.tab` key the legacy
// rail used (see `RightRail.tsx`, KV_TAB), so users do not lose their last
// active tab when the v1.1.4 chrome lands.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';

export type RightRailTabId = 'browser' | 'editor' | 'bridge';

interface RightRailContextValue {
  activeTab: RightRailTabId;
  setActiveTab: (tab: RightRailTabId) => void;
}

const KV_TAB = 'rightRail.tab';
const DEFAULT_TAB: RightRailTabId = 'browser';
const VALID_TABS: ReadonlySet<RightRailTabId> = new Set([
  'browser',
  'editor',
  'bridge',
]);

const RightRailCtx = createContext<RightRailContextValue | null>(null);

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTabState] = useState<RightRailTabId>(DEFAULT_TAB);

  // Hydrate the persisted tab once on mount. Mirrors the read pattern that
  // used to live in `RightRail.tsx` so users keep their last selection.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await rpcSilent.kv.get(KV_TAB);
        if (!alive) return;
        if (typeof raw === 'string' && VALID_TABS.has(raw as RightRailTabId)) {
          setActiveTabState(raw as RightRailTabId);
        }
      } catch {
        // kv unavailable — leave at DEFAULT_TAB.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setActiveTab = useCallback((tab: RightRailTabId) => {
    setActiveTabState(tab);
    void rpc.kv.set(KV_TAB, tab).catch(() => undefined);
  }, []);

  const value = useMemo<RightRailContextValue>(
    () => ({ activeTab, setActiveTab }),
    [activeTab, setActiveTab],
  );
  return <RightRailCtx.Provider value={value}>{children}</RightRailCtx.Provider>;
}

export function useRightRail(): RightRailContextValue {
  const ctx = useContext(RightRailCtx);
  if (!ctx) {
    throw new Error('useRightRail must be used within a RightRailProvider');
  }
  return ctx;
}
