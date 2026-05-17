// Pure reducer for the global renderer AppState. Extracted from `state.tsx`
// so the dispatch logic is unit-testable without React and the TSX file can
// satisfy the react-refresh "only export components" rule.
//
// No React, no DOM, no IPC. The helpers below are intentionally module-local
// (not exported) — they are reducer implementation detail and aren't part of
// the public API.

import type { AgentSession, Swarm, Workspace } from '../../shared/types';
import { selectActiveWorkspace, type Action, type AppState, type RoomId } from './state.types';

/**
 * Rooms that are NOT workspace-scoped. These must never be persisted into
 * `roomByWorkspace` because they are global surfaces (launcher, settings).
 * v1.4.2 — added 'settings' to fix the "click workspace after visiting
 * Settings stays on Settings" bug.
 */
const GLOBAL_ROOMS: readonly RoomId[] = ['workspaces', 'settings'] as const;

function isGlobalRoom(room: RoomId): boolean {
  return (GLOBAL_ROOMS as readonly string[]).includes(room);
}

function deriveActiveWorkspace(state: AppState): AppState {
  const activeWorkspace = selectActiveWorkspace(state);
  return state.activeWorkspace === activeWorkspace ? state : { ...state, activeWorkspace };
}

function upsertOpenWorkspace(openWorkspaces: Workspace[], workspace: Workspace): Workspace[] {
  const filtered = openWorkspaces.filter((w) => w.id !== workspace.id);
  return [workspace, ...filtered];
}

function reconcileOpenWorkspaces(
  openWorkspaces: Workspace[],
  persistedWorkspaces: Workspace[],
): Workspace[] {
  const persisted = new Map(persistedWorkspaces.map((w) => [w.id, w]));
  return openWorkspaces
    .filter((w) => persisted.has(w.id))
    .map((w) => persisted.get(w.id) ?? w);
}

function workspaceIdsEqual(a: Workspace[], ids: string[]): boolean {
  return a.length === ids.length && a.every((w, index) => w.id === ids[index]);
}

function groupSessionsByWorkspace(sessions: AgentSession[]): Record<string, AgentSession[]> {
  const grouped: Record<string, AgentSession[]> = {};
  for (const session of sessions) {
    (grouped[session.workspaceId] ??= []).push(session);
  }
  return grouped;
}

function groupSwarmsByWorkspace(swarms: Swarm[]): Record<string, Swarm[]> {
  const grouped: Record<string, Swarm[]> = {};
  for (const swarm of swarms) {
    (grouped[swarm.workspaceId] ??= []).push(swarm);
  }
  return grouped;
}

/**
 * Drop entries from the per-workspace room map whose workspace is no longer
 * open. Keeps `roomByWorkspace` from growing unboundedly across long-running
 * sessions and prevents stale rooms leaking back when a closed workspace is
 * reopened later (it should land on its DB-persisted room, not a stale
 * runtime guess).
 */
function pruneRoomByWorkspace(
  roomByWorkspace: Record<string, RoomId>,
  openWorkspaces: Workspace[],
): Record<string, RoomId> {
  const liveIds = new Set(openWorkspaces.map((w) => w.id));
  let changed = false;
  const next: Record<string, RoomId> = {};
  for (const [id, room] of Object.entries(roomByWorkspace)) {
    if (liveIds.has(id)) next[id] = room;
    else changed = true;
  }
  return changed ? next : roomByWorkspace;
}


export function appStateReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'READY': {
      const openWorkspaces = reconcileOpenWorkspaces(state.openWorkspaces, action.workspaces);
      const activeWorkspaceId =
        state.activeWorkspaceId && openWorkspaces.some((w) => w.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : openWorkspaces[0]?.id ?? null;
      return deriveActiveWorkspace({
        ...state,
        ready: true,
        workspaces: action.workspaces,
        openWorkspaces,
        activeWorkspaceId,
        roomByWorkspace: pruneRoomByWorkspace(state.roomByWorkspace, openWorkspaces),
      });
    }
    case 'SET_ROOM': {
      // v1.1.10 — remember the room per active workspace so the snapshot
      // writer can serialise each open workspace's last room correctly. We
      // only persist non-'workspaces' rooms because the picker is not a
      // workspace-scoped surface; landing back on the picker is handled by
      // not having an entry (snapshot writer falls back to 'command').
      const wsId = state.activeWorkspaceId;
      const roomByWorkspace =
        wsId && !isGlobalRoom(action.room)
          ? { ...state.roomByWorkspace, [wsId]: action.room }
          : state.roomByWorkspace;
      return { ...state, room: action.room, roomByWorkspace };
    }
    case 'SET_ROOM_FOR_WORKSPACE': {
      // v1.1.10 — used by session-restore to seed the per-workspace map
      // without altering the user-visible `state.room`. No-op if the room
      // is a global surface (we drop those at SET_ROOM time too) or the entry is
      // already correct.
      if (isGlobalRoom(action.room)) return state;
      if (state.roomByWorkspace[action.workspaceId] === action.room) return state;
      return {
        ...state,
        roomByWorkspace: {
          ...state.roomByWorkspace,
          [action.workspaceId]: action.room,
        },
      };
    }
    case 'SET_WORKSPACES': {
      const openWorkspaces = reconcileOpenWorkspaces(state.openWorkspaces, action.workspaces);
      const activeWorkspaceId =
        state.activeWorkspaceId && openWorkspaces.some((w) => w.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : openWorkspaces[0]?.id ?? null;
      return deriveActiveWorkspace({
        ...state,
        workspaces: action.workspaces,
        openWorkspaces,
        activeWorkspaceId,
        roomByWorkspace: pruneRoomByWorkspace(state.roomByWorkspace, openWorkspaces),
      });
    }
    case 'WORKSPACE_OPEN': {
      const openWorkspaces = upsertOpenWorkspace(state.openWorkspaces, action.workspace);
      // Seed the per-workspace room entry if we don't have one yet — keeps
      // the snapshot writer accurate for workspaces opened mid-session, and
      // makes restore round-trips lossless for the active workspace.
      const wsId = action.workspace.id;
      const roomByWorkspace =
        state.roomByWorkspace[wsId] || state.room === 'workspaces'
          ? state.roomByWorkspace
          : { ...state.roomByWorkspace, [wsId]: state.room };
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces,
        activeWorkspaceId: wsId,
        roomByWorkspace,
      });
    }
    case 'WORKSPACE_CLOSE': {
      const openWorkspaces = state.openWorkspaces.filter((w) => w.id !== action.workspaceId);
      const activeWorkspaceId =
        state.activeWorkspaceId === action.workspaceId
          ? openWorkspaces[0]?.id ?? null
          : state.activeWorkspaceId;
      // Drop the closed workspace's room entry so the next open lands on its
      // DB-persisted room rather than a stale runtime guess.
      const { [action.workspaceId]: _dropped, ...rest } = state.roomByWorkspace;
      void _dropped;
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces,
        activeWorkspaceId,
        room: activeWorkspaceId ? state.room : 'workspaces',
        roomByWorkspace: rest,
        // v1.4.2 packet-12 — closing a workspace must clear any fullscreen
        // pane so the user lands on the regular grid in the next workspace
        // (the focused paneId would belong to the just-closed workspace).
        focusedPaneId: null,
      });
    }
    case 'SET_ACTIVE_WORKSPACE_ID': {
      if (!action.workspaceId) {
        return deriveActiveWorkspace({
          ...state,
          activeWorkspaceId: null,
          room: 'workspaces',
          // v1.4.2 packet-12 — clear fullscreen on workspace switch.
          focusedPaneId: null,
        });
      }
      const workspace = state.openWorkspaces.find((w) => w.id === action.workspaceId);
      if (!workspace) {
        // v1.1.10 — surface invalid dispatches instead of silently dropping
        // them. Caller can keep the soft fallback (returning unchanged state)
        // because every code path that should activate an open workspace
        // already opens it first; reaching this branch is always a bug.
        console.warn(
          '[appStateReducer] SET_ACTIVE_WORKSPACE_ID called with id not in openWorkspaces:',
          action.workspaceId,
        );
        return state;
      }
      // v1.3.3 — restore the per-workspace room if one exists. Default to
      // 'command' when no saved room is present so the user doesn't land on
      // the Launcher ('workspaces') when clicking an already-open workspace.
      const savedRoom = state.roomByWorkspace[action.workspaceId];
      const room = savedRoom && !isGlobalRoom(savedRoom) ? savedRoom : 'command';
      // v1.4.2 packet-12 — switching workspaces clears any fullscreen pane.
      // Fullscreen is per-session and shouldn't survive a workspace jump even
      // when we're returning to a workspace that previously had a pane
      // focused — the focusedPaneId would refer to a stale session.
      const focusedPaneId =
        state.activeWorkspaceId === action.workspaceId ? state.focusedPaneId : null;
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces: upsertOpenWorkspace(state.openWorkspaces, workspace),
        activeWorkspaceId: action.workspaceId,
        room,
        focusedPaneId,
      });
    }
    case 'SYNC_OPEN_WORKSPACES': {
      if (workspaceIdsEqual(state.openWorkspaces, action.workspaceIds)) return state;
      const persisted = new Map(action.workspaces.map((w) => [w.id, w]));
      const openWorkspaces = action.workspaceIds
        .map((id) => persisted.get(id))
        .filter((w): w is Workspace => Boolean(w));
      const activeWorkspaceId =
        state.activeWorkspaceId && openWorkspaces.some((w) => w.id === state.activeWorkspaceId)
          ? state.activeWorkspaceId
          : openWorkspaces[0]?.id ?? null;
      return deriveActiveWorkspace({
        ...state,
        workspaces: action.workspaces,
        openWorkspaces,
        activeWorkspaceId,
        room: activeWorkspaceId ? state.room : 'workspaces',
        roomByWorkspace: pruneRoomByWorkspace(state.roomByWorkspace, openWorkspaces),
      });
    }
    case 'SET_ACTIVE_WORKSPACE':
      // BUG-W7-001: activating a workspace no longer auto-switches rooms.
      // Some entry points (Launcher pickFolder, command palette "Open recent")
      // want the user to stay where they are; others (Launcher.launch()) still
      // dispatch SET_ROOM 'command' explicitly. Clearing the active workspace
      // does fall back to Workspaces — there is no other coherent room.
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces: action.workspace
          ? upsertOpenWorkspace(state.openWorkspaces, action.workspace)
          : state.openWorkspaces,
        activeWorkspaceId: action.workspace?.id ?? null,
        room: action.workspace ? state.room : 'workspaces',
      });
    case 'ADD_SESSIONS': {
      const map = new Map(state.sessions.map((s) => [s.id, s]));
      for (const s of action.sessions) map.set(s.id, s);
      const sessions = Array.from(map.values());
      const firstLive = action.sessions.find((s) => s.status !== 'error');
      return {
        ...state,
        sessions,
        sessionsByWorkspace: groupSessionsByWorkspace(sessions),
        activeSessionId: state.activeSessionId ?? firstLive?.id ?? action.sessions[0]?.id ?? null,
      };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.id };
    case 'MARK_SESSION_EXITED': {
      const sessions: AgentSession[] = state.sessions.map((s) =>
        s.id === action.id
          ? { ...s, status: 'exited', exitCode: action.exitCode, exitedAt: Date.now() }
          : s,
      );
      return {
        ...state,
        sessions,
        sessionsByWorkspace: groupSessionsByWorkspace(sessions),
      };
    }
    case 'REMOVE_SESSION': {
      const sessions = state.sessions.filter((s) => s.id !== action.id);
      // v1.1.10 — when the active session is removed, prefer a live (running)
      // replacement so the UI doesn't jump to an exited/error session as the
      // new "active". Fall through to any remaining session if no live ones
      // exist, then to null when the list is empty.
      const liveFallback = sessions.find((s) => s.status === 'running');
      const activeSessionId =
        state.activeSessionId === action.id
          ? liveFallback?.id ?? sessions[0]?.id ?? null
          : state.activeSessionId;
      // v1.4.2 packet-12 — closing the fullscreen pane must drop us back to
      // the grid so we don't render a fullscreen container with no contents.
      const focusedPaneId =
        state.focusedPaneId === action.id ? null : state.focusedPaneId;
      return {
        ...state,
        sessions,
        sessionsByWorkspace: groupSessionsByWorkspace(sessions),
        activeSessionId,
        focusedPaneId,
      };
    }
    case 'SET_SWARMS':
      return {
        ...state,
        swarms: action.swarms,
        swarmsByWorkspace: groupSwarmsByWorkspace(action.swarms),
        activeSwarmId:
          state.activeSwarmId && action.swarms.find((s) => s.id === state.activeSwarmId)
            ? state.activeSwarmId
            : action.swarms[0]?.id ?? null,
      };
    case 'UPSERT_SWARM': {
      const without = state.swarms.filter((s) => s.id !== action.swarm.id);
      const swarms = [action.swarm, ...without];
      // v1.1.10 — auto-activate only when this is the FIRST swarm to land in
      // the workspace (no other swarms exist there). Previously we auto-set
      // whenever `activeSwarmId` was null, which overrode an intentional user
      // deselection: a swarm `STATUS` message would yank the user back to
      // the swarm room. Restricting auto-activation to the "first swarm
      // arrives" case preserves both the original UX (no manual selection
      // needed when there's only one) and user agency (a cleared selection
      // stays cleared as long as there's something else to choose).
      const existingForWorkspace = state.swarms.some(
        (s) => s.workspaceId === action.swarm.workspaceId && s.id !== action.swarm.id,
      );
      const activeSwarmId =
        state.activeSwarmId ?? (existingForWorkspace ? null : action.swarm.id);
      return {
        ...state,
        swarms,
        swarmsByWorkspace: groupSwarmsByWorkspace(swarms),
        activeSwarmId,
      };
    }
    case 'SET_ACTIVE_SWARM':
      return { ...state, activeSwarmId: action.id };
    case 'SET_SWARM_MESSAGES':
      return {
        ...state,
        swarmMessages: { ...state.swarmMessages, [action.swarmId]: action.messages },
      };
    case 'APPEND_SWARM_MESSAGE': {
      const existing = state.swarmMessages[action.message.swarmId] ?? [];
      // Avoid duplicates if the renderer received the message twice (event +
      // tail refresh). Identity by `id`.
      if (existing.some((m) => m.id === action.message.id)) return state;
      const next = [...existing, action.message];
      return {
        ...state,
        swarmMessages: { ...state.swarmMessages, [action.message.swarmId]: next },
      };
    }
    case 'MARK_SWARM_ENDED': {
      const swarms: Swarm[] = state.swarms.map((s) =>
        s.id === action.id ? { ...s, status: 'completed', endedAt: Date.now() } : s,
      );
      return {
        ...state,
        swarms,
        swarmsByWorkspace: groupSwarmsByWorkspace(swarms),
      };
    }
    case 'SET_BROWSER_STATE':
      return {
        ...state,
        browser: { ...state.browser, [action.state.workspaceId]: action.state },
      };
    case 'SET_SKILLS':
      return {
        ...state,
        skills: action.skills,
        skillProviderStates: action.states,
      };
    case 'SKILLS_BUSY': {
      const next = { ...state.skillsBusy };
      if (action.busy) next[action.key] = true;
      else delete next[action.key];
      return { ...state, skillsBusy: next };
    }
    case 'SET_MEMORIES':
      return {
        ...state,
        memories: { ...state.memories, [action.workspaceId]: action.memories },
      };
    case 'UPSERT_MEMORY': {
      const list = state.memories[action.workspaceId] ?? [];
      const filtered = list.filter((m) => m.id !== action.memory.id);
      return {
        ...state,
        memories: {
          ...state.memories,
          [action.workspaceId]: [action.memory, ...filtered].sort(
            (a, b) => b.updatedAt - a.updatedAt,
          ),
        },
      };
    }
    case 'REMOVE_MEMORY': {
      const list = state.memories[action.workspaceId] ?? [];
      return {
        ...state,
        memories: {
          ...state.memories,
          [action.workspaceId]: list.filter((m) => m.id !== action.memoryId),
        },
      };
    }
    case 'SET_MEMORY_GRAPH':
      return {
        ...state,
        memoryGraph: { ...state.memoryGraph, [action.workspaceId]: action.graph },
      };
    case 'SET_ACTIVE_MEMORY':
      return {
        ...state,
        activeMemoryName: {
          ...state.activeMemoryName,
          [action.workspaceId]: action.name,
        },
      };
    case 'SET_REVIEW':
      return {
        ...state,
        review: { ...state.review, [action.state.workspaceId]: action.state },
      };
    case 'SET_ACTIVE_REVIEW_SESSION':
      return { ...state, activeReviewSessionId: action.id };
    case 'SET_TASKS':
      return {
        ...state,
        tasks: { ...state.tasks, [action.workspaceId]: action.tasks },
      };
    case 'UPSERT_TASK': {
      const list = state.tasks[action.task.workspaceId] ?? [];
      const filtered = list.filter((t) => t.id !== action.task.id);
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.task.workspaceId]: [action.task, ...filtered].sort(
            (a, b) => b.updatedAt - a.updatedAt,
          ),
        },
      };
    }
    case 'REMOVE_TASK': {
      const list = state.tasks[action.workspaceId] ?? [];
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [action.workspaceId]: list.filter((t) => t.id !== action.taskId),
        },
      };
    }
    case 'BOOT_UI':
      return {
        ...state,
        uiBoot: true,
        onboarded: action.onboarded,
        sidebarCollapsed: action.sidebarCollapsed,
      };
    case 'SET_ONBOARDED':
      return { ...state, onboarded: action.value };
    case 'SET_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: action.open };
    case 'SET_SIDEBAR_COLLAPSED':
      return { ...state, sidebarCollapsed: action.collapsed };
    case 'FOCUS_PANE':
      // v1.4.2 packet-12 — toggle pane fullscreen. Returns the same state
      // object if the requested paneId is already focused so consumers can
      // safely no-op rerenders via shallow equality.
      if (state.focusedPaneId === action.paneId) return state;
      return { ...state, focusedPaneId: action.paneId };
    case 'UNFOCUS_PANE':
      if (state.focusedPaneId === null) return state;
      return { ...state, focusedPaneId: null };
    default:
      return state;
  }
}
