// Pure type definitions, initial state constant, and derived selectors for the
// global renderer AppState. Extracted from `state.tsx` so non-component
// exports live outside a TSX file (react-refresh rule) and stay React-free.
//
// No React, no DOM, no IPC. Safe to import from anywhere — including tests.

import type {
  AgentSession,
  BrowserState,
  Memory,
  MemoryGraph,
  Notification,
  ReviewState,
  RufloEntry,
  Skill,
  SkillProviderState,
  Swarm,
  SwarmMessage,
  Task,
  Workspace,
} from '../../shared/types';

export type RoomId =
  | 'workspaces'
  | 'command'
  | 'swarm'
  // P3-S2 — Operator Console room. Surfaces the constellation graph, activity
  // feed, and TopBar that already lived under features/operator-console but
  // were previously unreachable. Requires an active workspace; the room
  // itself renders a friendly empty-state when no swarm is active.
  | 'operator'
  | 'review'
  | 'tasks'
  | 'memory'
  | 'browser'
  | 'skills'
  // C-12 SigmaBench — multi-agent conflict benchmark room. Dispatches one
  // task to N providers in isolated worktrees and ranks them by how little
  // their changed-file sets overlap (most-isolated = best).
  | 'sigmabench'
  // V3-W13-012 — Jorvis Assistant standalone room. Available as a fallback
  // when the right-rail is gated off; otherwise the Jorvis tab inside the
  // rail hosts the same surface.
  | 'jorvis'
  | 'settings'
  // BSP-G2 — repo-level Git panel (Changes, History, Branches).
  | 'git'
  // BSP-O3 — Automations dashboard (Telegram remote + nightly digest).
  // Global room: reachable without an active workspace.
  | 'automations'
  // P1a Task 6 — Jorvis Persistent Operator mission board. NOT a global room:
  // missions are viewable per the normal room switch like tasks/review/git,
  // even though a mission itself may be workspace-scoped or global
  // (workspace_id null) at the data layer.
  | 'missions';

/**
 * Rooms that are NOT workspace-scoped. These must never be persisted into
 * `roomByWorkspace` (or serialized as a workspace's room in the session
 * snapshot) because they are global surfaces.
 * v1.4.2 — added 'settings' to fix the "click workspace after visiting
 * Settings stays on Settings" bug.
 * BSP-O3 — 'automations' is a global surface (Telegram + digest are
 * workspace-independent), so it must NOT be remembered per-workspace.
 * 2026-06-10 audit — exported (with `isGlobalRoom`) as the SINGLE source of
 * truth for all four guard sites: SET_ROOM, SET_ROOM_FOR_WORKSPACE,
 * WORKSPACE_OPEN (state.reducer.ts) and the snapshot `fallbackRoom`
 * (use-session-restore.ts). Add new global rooms HERE only —
 * state.reducer.global-rooms.test.ts + use-session-restore.snapshot.test.ts
 * enumerate this list at every site.
 */
export const GLOBAL_ROOMS: readonly RoomId[] = ['workspaces', 'settings', 'automations'] as const;

export function isGlobalRoom(room: RoomId): boolean {
  return (GLOBAL_ROOMS as readonly string[]).includes(room);
}

export interface AppState {
  ready: boolean;
  room: RoomId;
  /**
   * Per-workspace last-active room. v1.1.10 — fixes the session-restore bug
   * where the global `room` was serialized for ALL open workspaces, forcing
   * them into the same room after restore. SET_ROOM writes through to this
   * map keyed by the currently active workspace so each workspace remembers
   * the room the user was viewing when they last left it.
   */
  roomByWorkspace: Record<string, RoomId>;
  /** All persisted workspaces from the DB. */
  workspaces: Workspace[];
  /** Runtime-open workspaces. Ordered most-recently-active first. */
  openWorkspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Derived compatibility selector for existing consumers. */
  activeWorkspace: Workspace | null;
  sessions: AgentSession[];
  sessionsByWorkspace: Record<string, AgentSession[]>;
  activeSessionId: string | null;
  /**
   * Agent-attention (spec 2026-06-14). Maps keyed by id → the attention
   * timestamp. Presence drives the glow; cleared on focus/visit. A workspace
   * glows if it is a key here; a pane glows if its sessionId is a key.
   */
  attentionWorkspaces: Record<string, number>;
  attentionSessions: Record<string, number>;
  // Swarm Room (Phase 2)
  swarms: Swarm[];
  swarmsByWorkspace: Record<string, Swarm[]>;
  activeSwarmId: string | null;
  swarmMessages: Record<string, SwarmMessage[]>;
  // v1.13.2 — true while the canonical `use-live-events` swarm loader has an
  // `rpc.swarms.list` in flight for the active workspace. Single source of
  // truth: CommandRoom reads this slice instead of running its own parallel
  // fetch (the v1.13.1 dual-loader race overwrote the swarms slice). The
  // AddPaneButton "+Pane" gate consumes it so the button never enables on a
  // stale/empty slice mid-hydration.
  swarmsLoading: boolean;
  // Browser room (Phase 3): per-workspace state slice keyed by workspaceId.
  browser: Record<string, BrowserState>;
  // Skills room (Phase 4)
  skills: Skill[];
  skillProviderStates: SkillProviderState[];
  skillsBusy: Record<string, boolean>; // skillId|skillId:provider → in-flight
  // Memory (Phase 5)
  memories: Record<string, Memory[]>; // workspaceId -> list
  memoryGraph: Record<string, MemoryGraph>; // workspaceId -> graph cache
  activeMemoryName: Record<string, string | null>; // workspaceId -> selected note name
  // MEM-9/global-⌘O — a Ruflo agent-memory entry chosen in the global Memory
  // quick-switcher from OUTSIDE the Memory room. The room consumes + clears it
  // on mount to open the read-only virtual note (the room is the only place
  // that can render a Ruflo view). `null` when nothing is pending.
  pendingRufloView: RufloEntry | null;
  // BSP-O5 — a one-shot signal to open the Memory room directly on the graph
  // tab. Set by the Breadcrumb "Open memory graph" button and the command
  // palette "memory:graph" item; consumed + cleared by MemoryRoom on mount.
  // `true` when pending, `undefined` (absent) otherwise — mirrors the
  // `pendingSettingsTab` nonce pattern.
  pendingMemoryGraphView?: true;
  // ONB-1 — a Settings tab requested from OUTSIDE the Settings room (e.g. the
  // Feature Spotlight "Voice" deep-link). SettingsRoom reads this on mount and
  // selects the tab, then clears it. Mirrors the `pendingRufloView` pattern.
  // `undefined` when nothing is pending.
  pendingSettingsTab?: string;
  // Review (Phase 6) — keyed by workspaceId
  review: Record<string, ReviewState>;
  activeReviewSessionId: string | null;
  // Tasks (Phase 6) — keyed by workspaceId
  tasks: Record<string, Task[]>;
  // UI polish (Phase 7) — non-persisted view flags. The persisted values
  // (theme, onboarded, sidebarCollapsed) are loaded from kv on boot via the
  // `BOOT_UI` action and then mirrored here for synchronous reads. Writes
  // round-trip back to kv at the call site (see ThemeProvider, Sidebar).
  uiBoot: boolean;
  onboarded: boolean;
  commandPaletteOpen: boolean;
  sidebarCollapsed: boolean;
  // v1.4.2 packet-12 — id of the pane currently displayed in fullscreen mode,
  // or `null` when the regular grid is showing. Per-session only — NEVER
  // persisted into `roomByWorkspace` or the on-disk snapshot. Resets to
  // `null` on workspace close and active-workspace switch so the user always
  // lands back on the regular grid.
  focusedPaneId: string | null;
  // v1.4.9 #07 — Notifications. Newest-first id-keyed list; the reducer
  // upserts on every NOTIFICATIONS_DELTA. `unreadCount` is the source of
  // truth from the main process (the reducer does NOT derive it locally,
  // because evictions over the hard cap may DELETE rows without surfacing
  // a markRead — the main process owns the count).
  notifications: Notification[];
  notificationsUnreadCount: number;
}

export type Action =
  | { type: 'READY'; workspaces: Workspace[] }
  | { type: 'SET_ROOM'; room: RoomId }
  /**
   * v1.1.10 — seed a workspace's last-active room WITHOUT touching the
   * current `state.room`. Used by the session-restore drain to repopulate
   * `roomByWorkspace` for every workspace in the snapshot so the next
   * snapshot is lossless even if the user never visits the workspace.
   */
  | { type: 'SET_ROOM_FOR_WORKSPACE'; workspaceId: string; room: RoomId }
  | { type: 'SET_WORKSPACES'; workspaces: Workspace[] }
  /** DEV-W2 — optimistic rename: updates the name in both workspaces + openWorkspaces lists. */
  | { type: 'RENAME_WORKSPACE'; id: string; name: string }
  | { type: 'WORKSPACE_OPEN'; workspace: Workspace }
  | { type: 'WORKSPACE_CLOSE'; workspaceId: string }
  | { type: 'SET_ACTIVE_WORKSPACE_ID'; workspaceId: string | null }
  | { type: 'SYNC_OPEN_WORKSPACES'; workspaceIds: string[]; workspaces: Workspace[] }
  /**
   * Reorder the open-workspaces rail to match `orderedIds` (drag-to-reorder).
   * Existing Workspace object identities are reused; any open workspace not
   * named in `orderedIds` is preserved at the end. The renderer↔main mirror
   * (use-workspace-mirror) persists the new order automatically.
   */
  | { type: 'REORDER_OPEN_WORKSPACES'; orderedIds: string[] }
  /** Compatibility shim for pre-v1.1.3 call sites. Prefer WORKSPACE_OPEN + SET_ACTIVE_WORKSPACE_ID. */
  | { type: 'SET_ACTIVE_WORKSPACE'; workspace: Workspace | null }
  | { type: 'ADD_SESSIONS'; sessions: AgentSession[] }
  | { type: 'SET_ACTIVE_SESSION'; id: string | null }
  | { type: 'SET_ATTENTION'; sessionId: string; ts: number }
  // Clear a session's attention on focus/engage — dispatched UNCONDITIONALLY by
  // the pane-focus paths (the SET_ACTIVE_SESSION clear only fires when the active
  // session actually changes, so an already-active glowing pane would never clear).
  | { type: 'CLEAR_SESSION_ATTENTION'; sessionId: string }
  | { type: 'MARK_SESSION_EXITED'; id: string; exitCode: number }
  // v1.13.2 — runtime crash (or fast-crash) exit. Distinct from
  // MARK_SESSION_EXITED: sets `status: 'error'` so the pane stays VISIBLE
  // (the exited-session GC only auto-removes `status: 'exited'`) and so
  // PaneShell can render the crash banner + Relaunch affordance. Dispatched
  // from the `pty:error` subscriber in use-live-events.
  | { type: 'MARK_SESSION_ERROR'; id: string; exitCode: number | null; signal?: string | null }
  | { type: 'REMOVE_SESSION'; id: string }
  | { type: 'SET_SWARMS'; swarms: Swarm[] }
  // v1.13.2 — toggle the canonical swarm-loader in-flight flag (see
  // AppState.swarmsLoading). Dispatched by use-live-events around its
  // rpc.swarms.list call for the active workspace.
  | { type: 'SET_SWARMS_LOADING'; loading: boolean }
  | { type: 'UPSERT_SWARM'; swarm: Swarm }
  | { type: 'SET_ACTIVE_SWARM'; id: string | null }
  | { type: 'SET_SWARM_MESSAGES'; swarmId: string; messages: SwarmMessage[] }
  | { type: 'APPEND_SWARM_MESSAGE'; message: SwarmMessage }
  | { type: 'MARK_SWARM_ENDED'; id: string }
  | { type: 'SET_BROWSER_STATE'; state: BrowserState }
  | {
      type: 'SET_SKILLS';
      skills: Skill[];
      states: SkillProviderState[];
    }
  | { type: 'SKILLS_BUSY'; key: string; busy: boolean }
  | { type: 'SET_MEMORIES'; workspaceId: string; memories: Memory[] }
  | { type: 'UPSERT_MEMORY'; workspaceId: string; memory: Memory }
  | { type: 'REMOVE_MEMORY'; workspaceId: string; memoryId: string }
  | { type: 'SET_MEMORY_GRAPH'; workspaceId: string; graph: MemoryGraph }
  | { type: 'SET_ACTIVE_MEMORY'; workspaceId: string; name: string | null }
  // global-⌘O — stage (or clear) a Ruflo agent-memory entry for the Memory
  // room to open as a read-only virtual note. `entry: null` clears it.
  | { type: 'SET_PENDING_RUFLO_VIEW'; entry: RufloEntry | null }
  // BSP-O5 — stage (or clear) the one-shot graph-tab signal for MemoryRoom.
  // `pending: true` sets it; `pending: undefined` clears it after consume.
  | { type: 'SET_PENDING_MEMORY_GRAPH_VIEW'; pending: true | undefined }
  // ONB-1 — stage (or clear) a Settings tab to open. `tab: undefined` clears
  // it; SettingsRoom consumes it on mount and clears it after selecting.
  | { type: 'SET_SETTINGS_TAB'; tab: string | undefined }
  | { type: 'SET_REVIEW'; state: ReviewState }
  | { type: 'SET_ACTIVE_REVIEW_SESSION'; id: string | null }
  | { type: 'SET_TASKS'; workspaceId: string; tasks: Task[] }
  | { type: 'UPSERT_TASK'; task: Task }
  | { type: 'REMOVE_TASK'; workspaceId: string; taskId: string }
  | { type: 'BOOT_UI'; onboarded: boolean; sidebarCollapsed: boolean }
  | { type: 'SET_ONBOARDED'; value: boolean }
  | { type: 'SET_COMMAND_PALETTE'; open: boolean }
  | { type: 'SET_SIDEBAR_COLLAPSED'; collapsed: boolean }
  // v1.4.2 packet-12 — pane fullscreen toggle (per-session, not persisted).
  | { type: 'FOCUS_PANE'; paneId: string }
  | { type: 'UNFOCUS_PANE' }
  // v1.4.3 #06 — Pane Split + Minimise. SPLIT_PANE inserts the new sub-pane
  // AND mutates the parent's split fields so the renderer can group them
  // into one cell. MINIMISE_PANE toggles the collapsed-header rendering on a
  // single pane.
  | {
      type: 'SPLIT_PANE';
      parentId: string;
      newSession: AgentSession;
      groupId: string;
      direction: 'horizontal' | 'vertical';
    }
  | { type: 'MINIMISE_PANE'; paneId: string; minimised: boolean }
  // v1.4.9 #07 — Notifications reducer actions.
  // SET_NOTIFICATIONS: full replace (initial mount; paginated list response).
  // NOTIFICATIONS_DELTA: merge `added` + `updated` + remove `removed` + set
  // unreadCount (`updated` = read-state reconcile rows — upsert, never alert).
  // MARK_NOTIFICATION_READ / DISMISS_NOTIFICATION: optimistic local edits;
  // the main process echoes back via NOTIFICATIONS_DELTA which reconciles.
  | { type: 'SET_NOTIFICATIONS'; notifications: Notification[]; unreadCount: number }
  | {
      type: 'NOTIFICATIONS_DELTA';
      added: Notification[];
      removed: string[];
      updated?: Notification[];
      unreadCount: number;
    }
  | { type: 'MARK_NOTIFICATION_READ'; id: string; readAt: number }
  | { type: 'DISMISS_NOTIFICATION'; id: string };

export const initialAppState: AppState = {
  ready: false,
  room: 'workspaces',
  roomByWorkspace: {},
  workspaces: [],
  openWorkspaces: [],
  activeWorkspaceId: null,
  activeWorkspace: null,
  sessions: [],
  sessionsByWorkspace: {},
  activeSessionId: null,
  attentionWorkspaces: {},
  attentionSessions: {},
  swarms: [],
  swarmsByWorkspace: {},
  activeSwarmId: null,
  swarmMessages: {},
  swarmsLoading: false,
  browser: {},
  skills: [],
  skillProviderStates: [],
  skillsBusy: {},
  memories: {},
  memoryGraph: {},
  activeMemoryName: {},
  pendingRufloView: null,
  pendingMemoryGraphView: undefined,
  pendingSettingsTab: undefined,
  review: {},
  activeReviewSessionId: null,
  tasks: {},
  uiBoot: false,
  onboarded: true, // optimistic — corrected by BOOT_UI before the modal evaluates.
  commandPaletteOpen: false,
  sidebarCollapsed: false,
  focusedPaneId: null,
  notifications: [],
  notificationsUnreadCount: 0,
};

export function selectActiveWorkspace(
  state: Pick<AppState, 'openWorkspaces' | 'activeWorkspaceId'>,
): Workspace | null {
  if (!state.activeWorkspaceId) return null;
  return state.openWorkspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;
}
