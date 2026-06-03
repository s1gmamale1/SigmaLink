// Browser room — the main page rendered when the user clicks the Browser
// nav item. Composes:
//   • TabStrip
//   • AddressBar
//   • BrowserViewMount (the placeholder div the main-process view tracks)
//   • AgentDrivingIndicator (overlay when an agent has the driver lock)

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Globe, Plus } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import { EmptyState } from '@/renderer/components/EmptyState';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import { TabStrip } from './TabStrip';
import { AddressBar } from './AddressBar';
import { BrowserViewMount } from './BrowserViewMount';
import { AgentDrivingIndicator } from './AgentDrivingIndicator';
import { BrowserRecents } from './BrowserRecents';
import { DesignOverlayBanner } from './DesignOverlay';
import { DesignDock } from './DesignDock';

const HOME_URL = 'about:blank';

// N2 — the Browser room is a horizontal resizable [sidebar | viewport] pair,
// mirroring MemoryRoom's RSP-1 tri-column. Stable panel ids key the persisted
// layout; the order [sidebar, viewport] is the array stored under `browser.cols`
// (per-workspace). The viewport panel hosts the native WebContentsView mount,
// so its width must drive the bounds the main process applies via `setBounds`.
const BROWSER_COLS_PANEL = 'browser.cols';
const PANEL_SIDEBAR = 'browser-sidebar';
const PANEL_VIEWPORT = 'browser-viewport';
/** Default percentages [sidebar, viewport]; the page viewport dominates. */
const DEFAULT_BROWSER_COLS: [number, number] = [18, 82];
const PERSIST_DEBOUNCE_MS = 400;

/** Parse a stored `JSON.stringify([number, number])` of exactly 2 positive
 *  finite sizes; else fall back to the defaults so a corrupt/legacy value never
 *  breaks layout. */
function parseBrowserCols(raw: string | null): [number, number] {
  if (!raw) return DEFAULT_BROWSER_COLS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    ) {
      return [parsed[0], parsed[1]] as [number, number];
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_BROWSER_COLS;
}

interface BrowserRoomProps {
  /**
   * When the BrowserRoom is hosted inside the right-rail dock, the parent
   * tab container toggles `display:none` on its inactive tabs. The
   * `BrowserViewMount` needs to know the room is hidden so it can park the
   * underlying WebContentsView (otherwise it floats at zero size at the wrong
   * coordinates). Default `true` preserves the standalone-room behaviour.
   */
  visible?: boolean;
  /**
   * V3-W14-006 — when the room is hosted as a Sigma Canvas surface, the
   * launcher passes the canvas id so DesignDock can persist `lastProviders`
   * + record dispatch history.
   */
  canvasId?: string;
}

export function BrowserRoom({ visible = true, canvasId }: BrowserRoomProps = {}) {
  const { state, dispatch } = useAppState();
  const ws = state.activeWorkspace;
  const slice = ws ? state.browser[ws.id] : null;
  // BUG-DF-01 — `slice` is a fresh object on every `browser:state` broadcast
  // (the reducer always spreads), so this useMemo intentionally still runs
  // each render. The downstream short-circuit lives in TabStrip/BrowserRecents
  // (`React.memo` with content-aware comparators) — that's where we actually
  // skip work when the visible tab data didn't change.
  const tabs = useMemo(() => slice?.tabs ?? [], [slice]);
  const activeTabId = slice?.activeTabId ?? null;
  const lockOwner = slice?.lockOwner ?? null;
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const initLoadedRef = useRef<string | null>(null);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  // V3-W14-001 — design picker state, surfaced from the AddressBar toggle.
  const [designActive, setDesignActive] = useState(false);

  // N2 — per-workspace resizable column sizes [sidebar, viewport]. `null` until
  // hydrated; we render a neutral full-bleed placeholder (NOT the real viewport)
  // until then so the WebContentsView mount happens EXACTLY ONCE inside the
  // resizable group — mounting it in a default tree first and then remounting
  // when hydration swaps in the group would reload the native page on every
  // open. Mirrors MemoryRoom's RSP-1 hydration guard.
  const [cols, setCols] = useState<[number, number] | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // N2 — bumped on drag-END to force ONE authoritative bounds recompute in
  // BrowserViewMount (the continuous re-sync during drag is owned by its own
  // ResizeObserver; this just guarantees the settled rect is pushed).
  const [boundsNonce, setBoundsNonce] = useState(0);

  const wsId = ws?.id ?? null;

  // Re-hydrate the column layout whenever the workspace changes. The reset to
  // `null` (unhydrated) is deferred via queueMicrotask out of the effect body so
  // switching workspace B never flashes A's layout — the resizable group
  // remounts with B's persisted sizes. Mirrors MemoryRoom.
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) setCols(null);
    });
    void (async () => {
      const raw = await readWorkspaceUi(wsId, BROWSER_COLS_PANEL);
      if (alive) setCols(parseBrowserCols(raw));
    })();
    return () => {
      alive = false;
    };
  }, [wsId]);

  // Debounced persist of a layout change (best-effort, per workspace).
  const persistCols = useCallback(
    (next: [number, number]) => {
      if (!wsId) return;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void writeWorkspaceUi(wsId, BROWSER_COLS_PANEL, JSON.stringify(next));
      }, PERSIST_DEBOUNCE_MS);
    },
    [wsId],
  );

  // Clear any pending debounce on unmount.
  useEffect(
    () => () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    },
    [],
  );

  // First-time hydration for this workspace: load persisted tabs.
  useEffect(() => {
    if (!ws) return;
    if (initLoadedRef.current === ws.id) return;
    initLoadedRef.current = ws.id;
    void (async () => {
      try {
        const initial = await rpc.browser.getState(ws.id);
        dispatch({ type: 'SET_BROWSER_STATE', state: initial });
        if (initial.activeTabId) {
          // Re-activate the persisted active tab so its WebContentsView attaches.
          await rpc.browser.setActiveTab({ workspaceId: ws.id, tabId: initial.activeTabId });
        }
      } catch (err) {
        console.error('Failed to hydrate browser state:', err);
        setHydrationError(err instanceof Error ? err.message : String(err));
        // Reset so a manual retry can re-attempt hydration.
        initLoadedRef.current = null;
      }
    })();
  }, [ws, dispatch]);

  const handleNavigate = useCallback(
    (url: string) => {
      if (!ws || !activeTabId) return;
      void rpc.browser.navigate({ workspaceId: ws.id, tabId: activeTabId, url });
    },
    [ws, activeTabId],
  );

  const handleNewTab = useCallback(() => {
    if (!ws) return;
    void (async () => {
      try {
        await rpc.browser.openTab({ workspaceId: ws.id, url: HOME_URL });
      } catch (err) {
        console.error('openTab failed', err);
      }
    })();
  }, [ws]);

  const handleSelect = useCallback(
    (tabId: string) => {
      if (!ws) return;
      void rpc.browser.setActiveTab({ workspaceId: ws.id, tabId });
    },
    [ws],
  );

  const handleClose = useCallback(
    (tabId: string) => {
      if (!ws) return;
      void rpc.browser.closeTab({ workspaceId: ws.id, tabId });
    },
    [ws],
  );

  const handleBack = useCallback(() => {
    if (!ws || !activeTabId) return;
    void rpc.browser.back({ workspaceId: ws.id, tabId: activeTabId });
  }, [ws, activeTabId]);

  const handleForward = useCallback(() => {
    if (!ws || !activeTabId) return;
    void rpc.browser.forward({ workspaceId: ws.id, tabId: activeTabId });
  }, [ws, activeTabId]);

  const handleReload = useCallback(() => {
    if (!ws || !activeTabId) return;
    void rpc.browser.reload({ workspaceId: ws.id, tabId: activeTabId });
  }, [ws, activeTabId]);

  const handleStop = useCallback(() => {
    if (!ws || !activeTabId) return;
    void rpc.browser.stop({ workspaceId: ws.id, tabId: activeTabId });
  }, [ws, activeTabId]);

  const handleHome = useCallback(() => handleNavigate(HOME_URL), [handleNavigate]);

  const handleTakeOver = useCallback(() => {
    if (!ws) return;
    void rpc.browser.releaseDriver({ workspaceId: ws.id });
  }, [ws]);

  if (!ws) {
    return (
      <EmptyState
        icon={Globe}
        title="Open a workspace to use the in-app browser"
        description="Tabs, navigation history, and the agent driver lock are scoped per workspace."
      />
    );
  }

  // N2 — sidebar + viewport extracted once so the resizable layout and the
  // unhydrated placeholder share IDENTICAL children (the viewport — and thus
  // BrowserViewMount — therefore mounts exactly once).
  const sidebarRegion = designActive ? (
    <DesignDock workspaceId={ws.id} canvasId={canvasId} compact />
  ) : (
    <BrowserRecents
      workspaceId={ws.id}
      tabs={tabs}
      activeTabId={activeTabId}
      disabled={!visible}
      compact
    />
  );

  const viewportRegion = (
    <div className="relative flex min-h-0 w-full flex-1">
      {/* v1.5.1-A caveat 6: keep BrowserViewMount mounted; hide via visible
          prop instead of unmounting on zero tabs to avoid WebContentsView
          lifecycle churn. N2 — `boundsNonce` forces one authoritative
          recompute after a sidebar-resize drag ends. */}
      <BrowserViewMount
        workspaceId={ws.id}
        visible={visible && tabs.length > 0}
        boundsNonce={boundsNonce}
      />
      {tabs.length === 0 ? (
        <EmptyState
          title="No tabs open"
          description="Open a new tab to start browsing"
          action={
            <Button size="sm" onClick={handleNewTab}>
              <Plus className="h-3.5 w-3.5" /> New tab
            </Button>
          }
        />
      ) : (
        <>
          <AgentDrivingIndicator lockOwner={lockOwner} onTakeOver={handleTakeOver} />
          <DesignOverlayBanner active={designActive} />
        </>
      )}
    </div>
  );

  // N2 — body row. Until `cols` hydrates we render a neutral full-bleed
  // placeholder (NOT the viewport) so the WebContentsView mount is deferred
  // until the persisted layout is known and then mounts EXACTLY ONCE inside the
  // resizable group — preventing a mount→remount that would reload the native
  // page on every open. Mirrors MemoryRoom's RSP-1 hydration guard.
  let bodyRow: ReactNode;
  if (cols === null) {
    bodyRow = <div className="relative min-h-0 flex-1" aria-hidden />;
  } else {
    bodyRow = (
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={(layout) => {
          const sidebar = layout[PANEL_SIDEBAR];
          const viewport = layout[PANEL_VIEWPORT];
          if (Number.isFinite(sidebar) && Number.isFinite(viewport)) {
            persistCols([sidebar, viewport]);
          }
          // Drag-END authoritative bounds recompute. The continuous re-sync
          // during the drag is owned by BrowserViewMount's own ResizeObserver
          // (the viewport flex cell physically resizes); this guarantees the
          // settled rect is pushed even if the final observer tick coalesced.
          setBoundsNonce((n) => n + 1);
        }}
      >
        <ResizablePanel
          id={PANEL_SIDEBAR}
          defaultSize={cols[0]}
          minSize={10}
          collapsible
          collapsedSize={0}
          className="flex min-h-0 flex-col"
        >
          {sidebarRegion}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id={PANEL_VIEWPORT}
          defaultSize={cols[1]}
          minSize={40}
          className="flex min-h-0 flex-col"
        >
          {viewportRegion}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hydrationError ? (
        <ErrorBanner
          message={`Failed to load browser state: ${hydrationError}`}
          onDismiss={() => setHydrationError(null)}
        />
      ) : null}
      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={handleSelect}
        onClose={handleClose}
        onNewTab={handleNewTab}
      />
      <AddressBar
        url={activeTab?.url ?? ''}
        disabled={!activeTab}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onStop={handleStop}
        onHome={handleHome}
        workspaceId={ws.id}
        activeTabId={activeTabId}
        onDesignActiveChange={setDesignActive}
      />
      {bodyRow}
      {slice ? (
        <div className="border-t border-border bg-sidebar px-3 py-1 text-[11px] text-muted-foreground">
          MCP: {slice.mcpUrl ?? '— not started —'}{' '}
          {lockOwner ? (
            <span className="ml-2 text-amber-300/80">
              · driver: {lockOwner.label || lockOwner.agentKey}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

