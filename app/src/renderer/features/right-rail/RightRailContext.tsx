// SigmaLink v1.1.4 Step 3 — lifts the right-rail's active-tab state out of
// `RightRail.tsx` and into a React context so the top-bar segmented control
// (`RightRailSwitcher`) and the rail itself can share one source of truth.
//
// Persistence is kv-backed under the same `rightRail.tab` key the legacy
// rail used (see `RightRail.tsx`, KV_TAB), so users do not lose their last
// active tab when the v1.1.4 chrome lands.
//
// DEV-W4 — adds `railOpen` + `setRailOpen` + `toggleRail` with per-workspace
// persistence (mirrors how RightRail.tsx persists `rightRail.width`).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { rpc, rpcSilent } from '@/renderer/lib/rpc';
import { useAppStateSelector } from '@/renderer/app/state';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
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

  // DEV-W4 — per-workspace keying mirrors RightRail.tsx's width pattern.
  const wsId = useAppStateSelector((s) => s.activeWorkspace?.id ?? null);

  // Hydrate the persisted tab once on mount. Mirrors the read pattern that
  // used to live in `RightRail.tsx` so users keep their last selection.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = await rpcSilent.kv.get(KV_TAB);
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

  // DEV-W4 — hydrate persisted railOpen from the per-workspace key
  // (`ui.<wsId>.rightRail.open`) with no legacy global fallback (new feature).
  // Re-runs when wsId changes so switching workspaces restores their own state.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const raw = wsId
          ? await readWorkspaceUi(wsId, KV_OPEN)
          : await rpcSilent.kv.get(KV_OPEN);
        if (!alive) return;
        if (raw === 'false') {
          setRailOpenState(false);
        } else {
          // 'true', null (never persisted), or any other value → default open.
          setRailOpenState(true);
        }
      } catch {
        // kv unavailable — leave at default (open).
      }
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  const setActiveTab = useCallback((tab: RightRailTabId) => {
    setActiveTabState(tab);
    void rpc.kv.set(KV_TAB, tab).catch(() => undefined);
  }, []);

  const setRailOpen = useCallback(
    (open: boolean) => {
      setRailOpenState(open);
      const str = String(open);
      if (wsId) {
        void writeWorkspaceUi(wsId, KV_OPEN, str);
      } else {
        void rpc.kv.set(KV_OPEN, str).catch(() => undefined);
      }
    },
    [wsId],
  );

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
