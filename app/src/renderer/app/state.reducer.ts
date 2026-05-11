// Pure reducer for the global renderer AppState. Extracted from `state.tsx`
// so the dispatch logic is unit-testable without React and the TSX file can
// satisfy the react-refresh "only export components" rule.
//
// No React, no DOM, no IPC. The helpers below are intentionally module-local
// (not exported) — they are reducer implementation detail and aren't part of
// the public API.

import type { Workspace } from '../../shared/types';
import { selectActiveWorkspace, type Action, type AppState } from './state.types';

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
      });
    }
    case 'SET_ROOM':
      return { ...state, room: action.room };
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
      });
    }
    case 'WORKSPACE_OPEN':
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces: upsertOpenWorkspace(state.openWorkspaces, action.workspace),
        activeWorkspaceId: action.workspace.id,
      });
    case 'WORKSPACE_CLOSE': {
      const openWorkspaces = state.openWorkspaces.filter((w) => w.id !== action.workspaceId);
      const activeWorkspaceId =
        state.activeWorkspaceId === action.workspaceId
          ? openWorkspaces[0]?.id ?? null
          : state.activeWorkspaceId;
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces,
        activeWorkspaceId,
        room: activeWorkspaceId ? state.room : 'workspaces',
      });
    }
    case 'SET_ACTIVE_WORKSPACE_ID': {
      if (!action.workspaceId) {
        return deriveActiveWorkspace({
          ...state,
          activeWorkspaceId: null,
          room: 'workspaces',
        });
      }
      const workspace = state.openWorkspaces.find((w) => w.id === action.workspaceId);
      if (!workspace) return state;
      return deriveActiveWorkspace({
        ...state,
        openWorkspaces: upsertOpenWorkspace(state.openWorkspaces, workspace),
        activeWorkspaceId: action.workspaceId,
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
        activeSessionId: state.activeSessionId ?? firstLive?.id ?? action.sessions[0]?.id ?? null,
      };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.id };
    case 'MARK_SESSION_EXITED':
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id
            ? { ...s, status: 'exited', exitCode: action.exitCode, exitedAt: Date.now() }
            : s,
        ),
      };
    case 'REMOVE_SESSION': {
      const sessions = state.sessions.filter((s) => s.id !== action.id);
      const activeSessionId =
        state.activeSessionId === action.id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      return { ...state, sessions, activeSessionId };
    }
    case 'SET_SWARMS':
      return {
        ...state,
        swarms: action.swarms,
        activeSwarmId:
          state.activeSwarmId && action.swarms.find((s) => s.id === state.activeSwarmId)
            ? state.activeSwarmId
            : action.swarms[0]?.id ?? null,
      };
    case 'UPSERT_SWARM': {
      const without = state.swarms.filter((s) => s.id !== action.swarm.id);
      const swarms = [action.swarm, ...without];
      return {
        ...state,
        swarms,
        activeSwarmId: state.activeSwarmId ?? action.swarm.id,
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
    case 'MARK_SWARM_ENDED':
      return {
        ...state,
        swarms: state.swarms.map((s) =>
          s.id === action.id ? { ...s, status: 'completed', endedAt: Date.now() } : s,
        ),
      };
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
    default:
      return state;
  }
}
