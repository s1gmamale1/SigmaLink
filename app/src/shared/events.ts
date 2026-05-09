// Typed pub/sub events that flow main -> renderer.
// One ipcMain.send / ipcRenderer.on per topic; in-process fan-out via Set<callback>.

export type EventMap = {
  'pty:data': { sessionId: string; data: string };
  'pty:exit': { sessionId: string; exitCode: number; signal?: number };
  'workspace:launched': { workspaceId: string };
  'swarm:message': {
    swarmId: string;
    from: string;
    to: string;
    body: string;
    ts: number;
    kind?: string;
    id?: string;
    payload?: Record<string, unknown>;
  };
  'memory:changed': { id: string; kind: 'create' | 'update' | 'delete' };
  /**
   * Broadcast on every browser-state change for the workspace: tab list
   * mutation, navigation start/finish, lock claim/release, supervisor
   * up/down. The renderer hydrates its `browser` slice from this event.
   *
   * The original Phase-1 placeholder shape (tabId/url/title/canGoBack)
   * is preserved as optional fields so any consumer that targeted only
   * the per-tab navigation update keeps compiling.
   */
  'browser:state': {
    workspaceId: string;
    tabs: Array<{
      id: string;
      workspaceId: string;
      url: string;
      title: string;
      active: boolean;
      createdAt: number;
      lastVisitedAt: number;
    }>;
    activeTabId: string | null;
    lockOwner: { agentKey: string; claimedAt: number; label?: string } | null;
    mcpUrl: string | null;
    // Per-tab navigation summary for the active tab — convenient for
    // address-bar UIs that only want the current URL/title.
    tabId?: string;
    url?: string;
    title?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
  };
};

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];
export type Listener<E extends EventName> = (payload: EventPayload<E>) => void;
