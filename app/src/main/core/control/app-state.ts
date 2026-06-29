// src/main/core/control/app-state.ts
//
// get_app_state snapshot assembler — the Unity/Blender-MCP "look at the screen"
// data model. Pure-ish: every source is injected via AppStateDeps so this loads
// under vitest with fakes (NO electron / better-sqlite3 import here). Each
// sub-source read is guarded — one failing source degrades only its section and
// never throws the whole snapshot (spec §9).
//
// The builder consumes its OWN narrow Raw* input types; rpc-router (Task 4) maps
// the real DB rows / registries onto them. This keeps the builder transport- and
// storage-agnostic and trivially testable.

import type { ViewportShadow } from './app-state-shadow';

export interface RawWorkspace {
  id: string;
  name: string;
  rootPath: string;
  repoRoot: string | null;
  repoMode: string;
  lastOpenedAt: number;
}

export interface RawSession {
  id: string;
  workspaceId: string;
  paneIndex: number | null;
  name: string | null;
  providerId: string;
  displayProviderId: string | null;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  status: 'starting' | 'running' | 'exited' | 'error';
  exitCode: number | null;
  startedAt: number;
  exitedAt: number | null;
  minimised: boolean;
  splitGroupId: string | null;
  splitDirection: 'horizontal' | 'vertical' | null;
  splitIndex: 0 | 1 | null;
  swarmId: string | null;
  agentKey: string | null;
  swarmRole: string | null;
}

export interface RawSwarmAgent {
  agentKey: string;
  role: string;
  roleIndex: number;
  status: string;
  sessionId: string | null;
  providerId: string;
}

export interface RawSwarm {
  id: string;
  name: string;
  mission: string;
  preset: string;
  status: string;
  createdAt: number;
  endedAt: number | null;
  agents: RawSwarmAgent[];
}

export interface RawBrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
  createdAt: number;
  lastVisitedAt: number;
}

export interface RawBrowser {
  activeTabId: string | null;
  lockOwner: { agentKey: string; claimedAt: number; label?: string } | null;
  detached: boolean;
  tabs: RawBrowserTab[];
}

export interface RawNotif {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  workspaceId: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface CapacitySnapshot {
  liveAgents: number;
  cap: number;
  workspaceLiveAgents: number;
  workspaceCap: number;
  /** Global headroom: cap - liveAgents. */
  headroom: number;
}

export interface AppStateDeps {
  listWorkspaces: () => RawWorkspace[];
  getOpenWorkspaceIds: () => string[];
  windowScopes: () => Array<{ windowId: number; isMain: boolean; workspaceIds: string[] }>;
  /** Sessions for a workspace, ordered by pane_index. */
  listSessions: (workspaceId: string) => RawSession[];
  ptyAlive: (sessionId: string) => { alive: boolean; pid: number | null };
  /** Main-side AttentionDetector query map: sessionId → last attention. */
  attention: () => ReadonlyMap<string, { ts: number; reason: string }>;
  listSwarms: (workspaceId: string) => RawSwarm[];
  /** Browser state for a workspace, or null when no manager exists. */
  browserState: (workspaceId: string) => RawBrowser | null;
  notifications: () => { unreadCount: number; recent: RawNotif[] };
  viewport: () => ViewportShadow;
  derivePaneName: (s: { id: string; name: string | null }) => string;
  shapeSignature: (orderedIds: string[]) => string;
  /**
   * RAM-brake capacity snapshot (control-plane Task 3). Optional: absent →
   * capacity is null in the snapshot (degrades gracefully). A failing read
   * is also swallowed by safe() and produces null — never throws the snapshot.
   */
  capacity?: (workspaceId: string | null) => CapacitySnapshot | null;
  /**
   * Task 4 — pending non-blocking escalations. Optional: absent → empty list.
   * Wrapped in safe() so a failing read never throws the whole snapshot.
   */
  pendingEscalations?: () => Array<{ id: string; toolName: string; summary: string; requestedAt: number }>;
  now?: () => number;
}

export interface AppStateSnapshotSession {
  sessionId: string;
  workspaceId: string;
  paneIndex: number | null;
  displayName: string;
  operatorName: string | null;
  providerId: string;
  displayProviderId: string | null;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  dbStatus: 'starting' | 'running' | 'exited' | 'error';
  ptyAlive: boolean;
  pid: number | null;
  exitCode: number | null;
  startedAt: number;
  exitedAt: number | null;
  minimised: boolean;
  splitGroupId: string | null;
  splitDirection: 'horizontal' | 'vertical' | null;
  splitIndex: 0 | 1 | null;
  attentionTs: number | null;
  swarmId: string | null;
  agentKey: string | null;
  swarmRole: string | null;
}

export interface AppStateSnapshot {
  capturedAt: number;
  viewportStale: boolean;
  workspaces: {
    all: RawWorkspace[];
    openIds: string[];
    activeId: string | null;
    detachedIds: string[];
    attention: Record<string, number>;
  };
  currentView: { room: string | null; activeSwarmId: string | null };
  panes: {
    activeSessionId: string | null;
    focusedPaneId: string | null;
    gridShape: string;
    orderedSessionIds: string[];
    sessions: AppStateSnapshotSession[];
  };
  swarms: Array<{
    swarmId: string;
    name: string;
    mission: string;
    preset: string;
    status: string;
    createdAt: number;
    endedAt: number | null;
    agentCount: number;
    agents: RawSwarmAgent[];
  }>;
  browser:
    | null
    | {
        available: boolean;
        activeTabId: string | null;
        lockOwner: { agentKey: string; claimedAt: number; label?: string } | null;
        detached: boolean;
        tabs: RawBrowserTab[];
      };
  notifications: { unreadCount: number; recent: RawNotif[] };
  windows: Array<{ windowId: number; isMain: boolean; workspaceIds: string[] }>;
  /** RAM-brake capacity (Task 3). Null when the dep is absent or its read fails. */
  capacity: CapacitySnapshot | null;
  /** Pending non-blocking escalations (Task 4). Empty when the dep is absent. */
  pendingEscalations: Array<{ id: string; toolName: string; summary: string; requestedAt: number }>;
}

const EMPTY_VIEWPORT: ViewportShadow = {
  activeWorkspaceId: null,
  activeSessionId: null,
  focusedPaneId: null,
  room: null,
  activeSwarmId: null,
  viewportStale: true,
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function buildAppState(
  deps: AppStateDeps,
  opts: { workspaceId?: string; allWorkspaces?: boolean },
): AppStateSnapshot {
  const now = deps.now ?? Date.now;

  const viewport = safe(() => deps.viewport(), EMPTY_VIEWPORT);
  const openIds = safe(() => deps.getOpenWorkspaceIds(), []);
  const workspacesAll = safe(() => deps.listWorkspaces(), []);
  const targetWs = opts.workspaceId ?? viewport.activeWorkspaceId ?? openIds[0] ?? null;
  const wsScope: string[] = opts.allWorkspaces
    ? workspacesAll.map((w) => w.id)
    : targetWs
      ? [targetWs]
      : [];

  const attn = safe(() => deps.attention(), new Map<string, { ts: number; reason: string }>());

  const rawSessions: RawSession[] = [];
  for (const wsId of wsScope) {
    for (const s of safe(() => deps.listSessions(wsId), [])) rawSessions.push(s);
  }

  const sessions: AppStateSnapshotSession[] = rawSessions.map((s) => {
    const live = safe(() => deps.ptyAlive(s.id), { alive: false, pid: null });
    const a = attn.get(s.id);
    return {
      sessionId: s.id,
      workspaceId: s.workspaceId,
      paneIndex: s.paneIndex,
      displayName: safe(() => deps.derivePaneName({ id: s.id, name: s.name }), s.id),
      operatorName: s.name,
      providerId: s.providerId,
      displayProviderId: s.displayProviderId,
      cwd: s.cwd,
      branch: s.branch,
      worktreePath: s.worktreePath,
      dbStatus: s.status,
      ptyAlive: live.alive,
      pid: live.pid,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      exitedAt: s.exitedAt,
      minimised: s.minimised,
      splitGroupId: s.splitGroupId,
      splitDirection: s.splitDirection,
      splitIndex: s.splitIndex,
      attentionTs: a ? a.ts : null,
      swarmId: s.swarmId,
      agentKey: s.agentKey,
      swarmRole: s.swarmRole,
    };
  });

  // Per-workspace attention derived from the sessions in scope.
  const wsAttention: Record<string, number> = {};
  for (const s of sessions) {
    if (s.attentionTs !== null) {
      wsAttention[s.workspaceId] = Math.max(wsAttention[s.workspaceId] ?? 0, s.attentionTs);
    }
  }

  const orderedSessionIds = sessions
    .filter((s) => s.workspaceId === targetWs)
    .map((s) => s.sessionId);
  const gridShape = safe(() => deps.shapeSignature(orderedSessionIds), '');

  const swarms = (targetWs ? safe(() => deps.listSwarms(targetWs), []) : []).map((sw) => ({
    swarmId: sw.id,
    name: sw.name,
    mission: sw.mission,
    preset: sw.preset,
    status: sw.status,
    createdAt: sw.createdAt,
    endedAt: sw.endedAt,
    agentCount: sw.agents.length,
    agents: sw.agents,
  }));

  const browserRaw = targetWs ? safe(() => deps.browserState(targetWs), null) : null;
  const browser = browserRaw
    ? {
        available: true,
        activeTabId: browserRaw.activeTabId,
        lockOwner: browserRaw.lockOwner,
        detached: browserRaw.detached,
        tabs: browserRaw.tabs,
      }
    : null;

  const notifications = safe(() => deps.notifications(), { unreadCount: 0, recent: [] });
  const windows = safe(() => deps.windowScopes(), []);
  const detachedIds = windows.filter((w) => !w.isMain).flatMap((w) => w.workspaceIds);

  // Task 3 — RAM-brake capacity block. Wrapped in safe() so a failing read
  // never throws the whole snapshot (spec §9 defensive degradation).
  const capacity = safe<CapacitySnapshot | null>(
    () => (deps.capacity ? deps.capacity(targetWs) : null),
    null,
  );

  // Task 4 — pending non-blocking escalations. Wrapped in safe() for resilience.
  const pendingEscalations = safe<Array<{ id: string; toolName: string; summary: string; requestedAt: number }>>(
    () => (deps.pendingEscalations ? deps.pendingEscalations() : []),
    [],
  );

  return {
    capturedAt: now(),
    viewportStale: viewport.viewportStale,
    workspaces: {
      all: workspacesAll,
      openIds,
      activeId: viewport.activeWorkspaceId,
      detachedIds,
      attention: wsAttention,
    },
    currentView: { room: viewport.room, activeSwarmId: viewport.activeSwarmId },
    panes: {
      activeSessionId: viewport.activeSessionId,
      focusedPaneId: viewport.focusedPaneId,
      gridShape,
      orderedSessionIds,
      sessions,
    },
    swarms,
    browser,
    notifications,
    windows,
    capacity,
    pendingEscalations,
  };
}
