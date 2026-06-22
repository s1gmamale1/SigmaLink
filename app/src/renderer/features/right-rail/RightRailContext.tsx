// SigmaLink v1.1.4 Step 3 — lifts the right-rail's active-tab state out of
// `RightRail.tsx` and into a React context so the top-bar segmented control
// (`RightRailSwitcher`) and the rail itself can share one source of truth.
//
// Persistence is kv-backed under the same `rightRail.tab` key the legacy
// rail used (see `RightRail.tsx`, KV_TAB), so users do not lose their last
// active tab when the v1.1.4 chrome lands.
//
// DEV-W4 — adds `railOpen` + `setRailOpen` + `toggleRail` with window-scope-aware
// persistence via chrome-ui-kv (global in the main window, per-scope when detached;
// mirrors how RightRail.tsx persists `rightRail.width`).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { readChromeUi, writeChromeUi } from '@/renderer/lib/chrome-ui-kv';
import {
  DEFAULT_TAB,
  KV_OPEN,
  KV_TAB,
  normalizeTabId,
  RightRailCtx,
  VALID_TABS,
  type RightRailContextValue,
  type RightRailTabId,
} from './RightRailContext.data';

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTabState] = useState<RightRailTabId>(DEFAULT_TAB);
  // DEV-W4 — rail open/closed state. Default open so existing users see no change.
  const [railOpen, setRailOpenState] = useState<boolean>(true);

  // Hydrate the active tab. Window-scope-aware: main window → global key;
  // detached/scoped window → its own per-scope key (no clobber, #177).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await readChromeUi(KV_TAB, KV_TAB);
        if (!alive) return;
        const normalized = typeof raw === 'string' ? normalizeTabId(raw) : raw;
        if (typeof normalized === 'string' && VALID_TABS.has(normalized as RightRailTabId)) {
          setActiveTabState(normalized as RightRailTabId);
        }
      } catch {
        // kv unavailable — leave at DEFAULT_TAB.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Hydrate rail open/closed (same window-scope-aware keying as the tab).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await readChromeUi(KV_OPEN, KV_OPEN);
        if (!alive) return;
        setRailOpenState(raw === 'false' ? false : true);
      } catch {
        // kv unavailable — leave at default (open).
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setActiveTab = useCallback((tab: RightRailTabId) => {
    setActiveTabState(tab);
    void writeChromeUi(KV_TAB, KV_TAB, tab);
  }, []);

  const setRailOpen = useCallback((open: boolean) => {
    setRailOpenState(open);
    void writeChromeUi(KV_OPEN, KV_OPEN, String(open));
  }, []);

  const toggleRail = useCallback(() => {
    // 2026-06-10 — the KV write used to live INSIDE the setRailOpenState
    // updater. Updaters must be pure: React may invoke them twice (StrictMode
    // dev / render replay), double-firing the write. Compute the next value
    // from the rendered state and delegate to setRailOpen, which owns the
    // single state-set + KV-write path (DRY).
    setRailOpen(!railOpen);
  }, [railOpen, setRailOpen]);

  const value = useMemo<RightRailContextValue>(
    () => ({ activeTab, setActiveTab, railOpen, setRailOpen, toggleRail }),
    [activeTab, setActiveTab, railOpen, setRailOpen, toggleRail],
  );
  return <RightRailCtx.Provider value={value}>{children}</RightRailCtx.Provider>;
}
