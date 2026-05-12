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
  ReviewState,
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
  // V3-W13-012 — Bridge Assistant standalone room. Available as a fallback
  // when the right-rail is gated off; otherwise the Bridge tab inside the
  // rail hosts the same surface.
  | 'bridge'
  | 'settings';

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
  // Swarm Room (Phase 2)
  swarms: Swarm[];
  swarmsByWorkspace: Record<string, Swarm[]>;
  activeSwarmId: string | null;
  swarmMessages: Record<string, SwarmMessage[]>;
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
  | { type: 'WORKSPACE_OPEN'; workspace: Workspace }
  | { type: 'WORKSPACE_CLOSE'; workspaceId: string }
  | { type: 'SET_ACTIVE_WORKSPACE_ID'; workspaceId: string | null }
  | { type: 'SYNC_OPEN_WORKSPACES'; workspaceIds: string[]; workspaces: Workspace[] }
  /** Compatibility shim for pre-v1.1.3 call sites. Prefer WORKSPACE_OPEN + SET_ACTIVE_WORKSPACE_ID. */
  | { type: 'SET_ACTIVE_WORKSPACE'; workspace: Workspace | null }
  | { type: 'ADD_SESSIONS'; sessions: AgentSession[] }
  | { type: 'SET_ACTIVE_SESSION'; id: string | null }
  | { type: 'MARK_SESSION_EXITED'; id: string; exitCode: number }
  | { type: 'REMOVE_SESSION'; id: string }
  | { type: 'SET_SWARMS'; swarms: Swarm[] }
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
  | { type: 'SET_REVIEW'; state: ReviewState }
  | { type: 'SET_ACTIVE_REVIEW_SESSION'; id: string | null }
  | { type: 'SET_TASKS'; workspaceId: string; tasks: Task[] }
  | { type: 'UPSERT_TASK'; task: Task }
  | { type: 'REMOVE_TASK'; workspaceId: string; taskId: string }
  | { type: 'BOOT_UI'; onboarded: boolean; sidebarCollapsed: boolean }
  | { type: 'SET_ONBOARDED'; value: boolean }
  | { type: 'SET_COMMAND_PALETTE'; open: boolean }
  | { type: 'SET_SIDEBAR_COLLAPSED'; collapsed: boolean };

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
  swarms: [],
  swarmsByWorkspace: {},
  activeSwarmId: null,
  swarmMessages: {},
  browser: {},
  skills: [],
  skillProviderStates: [],
  skillsBusy: {},
  memories: {},
  memoryGraph: {},
  activeMemoryName: {},
  review: {},
  activeReviewSessionId: null,
  tasks: {},
  uiBoot: false,
  onboarded: true, // optimistic — corrected by BOOT_UI before the modal evaluates.
  commandPaletteOpen: false,
  sidebarCollapsed: false,
};

export function selectActiveWorkspace(
  state: Pick<AppState, 'openWorkspaces' | 'activeWorkspaceId'>,
): Workspace | null {
  if (!state.activeWorkspaceId) return null;
  return state.openWorkspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;
}
