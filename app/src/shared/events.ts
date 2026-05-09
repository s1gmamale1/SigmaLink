// Typed pub/sub events that flow main -> renderer.
// One ipcMain.send / ipcRenderer.on per topic; in-process fan-out via Set<callback>.

export type EventMap = {
  'pty:data': { sessionId: string; data: string };
  'pty:exit': { sessionId: string; exitCode: number; signal?: number };
  /**
   * V3-W13-002 — emitted whenever the PTY data stream contains a navigable
   * URL. The renderer subscribes from `Terminal.tsx` and routes the click
   * into the in-app Browser (right-rail) tab, falling back to
   * `shell.openExternal` only when `kv['browser.captureLinks']` is `'0'`.
   */
  'pty:link-detected': { sessionId: string; url: string; text?: string };
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
  /** Review state row for one session was created/updated. */
  'review:changed': { sessionId: string };
  /**
   * Streamed stdout/stderr from a Review-Room test runner. Renderer appends
   * these to the per-session output buffer. `done: true` signals end-of-run.
   */
  'review:run-output': {
    sessionId: string;
    runId: string;
    stream: 'stdout' | 'stderr' | 'system';
    data: string;
    exitCode?: number | null;
    done?: boolean;
  };
  /**
   * A task row was created, updated, deleted, or had a comment thread
   * change. The renderer reloads the workspace's task list on this event.
   */
  'tasks:changed': { taskId: string | null };
  /**
   * V3-W14-001 — element-picker capture. Emitted from the main process when
   * the user clicks an element in a Design-mode browser tab. Renderer
   * subscribes from the DesignDock to populate the captured-source pill,
   * outerHTML preview, and screenshot thumbnail.
   */
  'design:capture': {
    pickerToken: string;
    workspaceId: string;
    tabId: string;
    selector: string;
    outerHTML: string;
    computedStyles: Record<string, string>;
    screenshotPng: string; // data: URL
    pageUrl: string;
  };
  /** V3-W14-001 — picker on/off transitions, surfaces in the address bar. */
  'design:picker-state': {
    workspaceId: string;
    tabId: string;
    active: boolean;
  };
  /** V3-W14-005 — HMR / file-watch nudge. */
  'design:patch-applied': {
    workspaceId: string;
    tabId: string;
    file: string;
    range?: { startLine: number; endLine: number };
  };
};

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];
export type Listener<E extends EventName> = (payload: EventPayload<E>) => void;
