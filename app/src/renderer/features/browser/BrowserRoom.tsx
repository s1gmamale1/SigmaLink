// Browser room — the main page rendered when the user clicks the Browser
// nav item. Composes:
//   • TabStrip
//   • AddressBar
//   • BrowserViewMount (the placeholder div the main-process view tracks)
//   • AgentDrivingIndicator (overlay when an agent has the driver lock)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { rpc } from '@/renderer/lib/rpc';
import { useAppState } from '@/renderer/app/state';
import { EmptyState } from '@/renderer/components/EmptyState';
import { ErrorBanner } from '@/renderer/components/ErrorBanner';
import { TabStrip } from './TabStrip';
import { AddressBar } from './AddressBar';
import { BrowserViewMount } from './BrowserViewMount';
import { AgentDrivingIndicator } from './AgentDrivingIndicator';

const HOME_URL = 'about:blank';

export function BrowserRoom() {
  const { state, dispatch } = useAppState();
  const ws = state.activeWorkspace;
  const slice = ws ? state.browser[ws.id] : null;
  const tabs = useMemo(() => slice?.tabs ?? [], [slice]);
  const activeTabId = slice?.activeTabId ?? null;
  const lockOwner = slice?.lockOwner ?? null;
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const initLoadedRef = useRef<string | null>(null);
  const [hydrationError, setHydrationError] = useState<string | null>(null);

  // First-time hydration for this workspace: load persisted tabs.
  useEffect(() => {
    if (!ws) return;
    if (initLoadedRef.current === ws.id) return;
    initLoadedRef.current = ws.id;
    void (async () => {
      try {
        const initial = await rpc.browser.getState(ws.id);
        dispatch({ type: 'SET_BROWSER_STATE', state: initial });
        // If no tabs exist after hydration, create a default one.
        if (initial.tabs.length === 0) {
          const tab = await rpc.browser.openTab({ workspaceId: ws.id, url: HOME_URL });
          dispatch({
            type: 'SET_BROWSER_STATE',
            state: {
              workspaceId: ws.id,
              tabs: [tab],
              activeTabId: tab.id,
              lockOwner: null,
              mcpUrl: initial.mcpUrl,
            },
          });
        } else if (initial.activeTabId) {
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
      />
      <div className="relative flex min-h-0 flex-1">
        <BrowserViewMount workspaceId={ws.id} visible={true} />
        <AgentDrivingIndicator lockOwner={lockOwner} onTakeOver={handleTakeOver} />
      </div>
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

