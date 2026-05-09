// Global renderer state: current workspace, active room, live agent sessions.
// Plain useReducer + Context. No external store dependency.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type {
  AgentSession,
  BrowserState,
  Swarm,
  SwarmMessage,
  Workspace,
} from '@/shared/types';

export type RoomId =
  | 'workspaces'
  | 'command'
  | 'swarm'
  | 'review'
  | 'memory'
  | 'browser'
  | 'skills'
  | 'settings';

export interface AppState {
  ready: boolean;
  room: RoomId;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: AgentSession[];
  activeSessionId: string | null;
  // Swarm Room (Phase 2)
  swarms: Swarm[];
  activeSwarmId: string | null;
  swarmMessages: Record<string, SwarmMessage[]>;
  // Browser room (Phase 3): per-workspace state slice keyed by workspaceId.
  browser: Record<string, BrowserState>;
}

type Action =
  | { type: 'READY'; workspaces: Workspace[] }
  | { type: 'SET_ROOM'; room: RoomId }
  | { type: 'SET_WORKSPACES'; workspaces: Workspace[] }
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
  | { type: 'SET_BROWSER_STATE'; state: BrowserState };

const initial: AppState = {
  ready: false,
  room: 'workspaces',
  workspaces: [],
  activeWorkspace: null,
  sessions: [],
  activeSessionId: null,
  swarms: [],
  activeSwarmId: null,
  swarmMessages: {},
  browser: {},
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'READY':
      return { ...state, ready: true, workspaces: action.workspaces };
    case 'SET_ROOM':
      return { ...state, room: action.room };
    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces };
    case 'SET_ACTIVE_WORKSPACE':
      return {
        ...state,
        activeWorkspace: action.workspace,
        room: action.workspace ? 'command' : 'workspaces',
      };
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
    default:
      return state;
  }
}

const StateCtx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

/**
 * Time after which an exited session is auto-removed from the live sessions
 * list. The user can also remove it manually from the Command Room.
 */
const EXITED_AUTO_REMOVE_MS = 5_000;

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = await rpc.workspaces.list();
        if (!alive) return;
        dispatch({ type: 'READY', workspaces: ws });
      } catch (err) {
        console.error('Failed to load workspaces:', err);
        dispatch({ type: 'READY', workspaces: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Listen for PTY exit so the UI can mark sessions accordingly.
  useEffect(() => {
    const off = window.sigma.eventOn('pty:exit', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; exitCode?: unknown };
      if (typeof p.sessionId !== 'string') return;
      const exitCode = typeof p.exitCode === 'number' ? p.exitCode : -1;
      dispatch({ type: 'MARK_SESSION_EXITED', id: p.sessionId, exitCode });
    });
    return off;
  }, []);

  // Listen for swarm:message so the side-chat updates live across rooms.
  useEffect(() => {
    const off = window.sigma.eventOn('swarm:message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as Record<string, unknown>;
      const swarmId = typeof p.swarmId === 'string' ? p.swarmId : '';
      const id = typeof p.id === 'string' ? p.id : '';
      const from = typeof p.from === 'string' ? p.from : 'operator';
      const to = typeof p.to === 'string' ? p.to : '*';
      const body = typeof p.body === 'string' ? p.body : '';
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      const kind = (typeof p.kind === 'string' ? p.kind : 'OPERATOR') as SwarmMessage['kind'];
      const payload =
        p.payload && typeof p.payload === 'object'
          ? (p.payload as Record<string, unknown>)
          : undefined;
      if (!swarmId || !id) return;
      dispatch({
        type: 'APPEND_SWARM_MESSAGE',
        message: {
          id,
          swarmId,
          fromAgent: from,
          toAgent: to,
          kind,
          body,
          payload,
          ts,
        },
      });
    });
    return off;
  }, []);

  // Listen for browser:state so the Browser room hydrates live across rooms.
  useEffect(() => {
    const off = window.sigma.eventOn('browser:state', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as Record<string, unknown>;
      const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
      if (!workspaceId) return;
      const tabsRaw = Array.isArray(p.tabs) ? (p.tabs as unknown[]) : [];
      const tabs = tabsRaw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          id: String(t.id ?? ''),
          workspaceId: String(t.workspaceId ?? workspaceId),
          url: String(t.url ?? ''),
          title: String(t.title ?? ''),
          active: Boolean(t.active),
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
          lastVisitedAt:
            typeof t.lastVisitedAt === 'number' ? t.lastVisitedAt : Date.now(),
        }));
      const activeTabId = typeof p.activeTabId === 'string' ? p.activeTabId : null;
      const lockOwnerRaw = p.lockOwner;
      const lockOwner =
        lockOwnerRaw && typeof lockOwnerRaw === 'object'
          ? {
              agentKey: String(
                (lockOwnerRaw as Record<string, unknown>).agentKey ?? '',
              ),
              claimedAt:
                typeof (lockOwnerRaw as Record<string, unknown>).claimedAt === 'number'
                  ? ((lockOwnerRaw as Record<string, unknown>).claimedAt as number)
                  : Date.now(),
              label:
                typeof (lockOwnerRaw as Record<string, unknown>).label === 'string'
                  ? ((lockOwnerRaw as Record<string, unknown>).label as string)
                  : undefined,
            }
          : null;
      const mcpUrl = typeof p.mcpUrl === 'string' ? p.mcpUrl : null;
      dispatch({
        type: 'SET_BROWSER_STATE',
        state: { workspaceId, tabs, activeTabId, lockOwner, mcpUrl },
      });
    });
    return off;
  }, []);

  // When the active workspace changes, refresh swarms for that workspace so
  // the Swarm Room can pick up persisted swarms across app restarts.
  useEffect(() => {
    let alive = true;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) {
      dispatch({ type: 'SET_SWARMS', swarms: [] });
      return;
    }
    void (async () => {
      try {
        const list = await rpc.swarms.list(wsId);
        if (!alive) return;
        dispatch({ type: 'SET_SWARMS', swarms: list });
      } catch (err) {
        console.error('Failed to load swarms:', err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.activeWorkspace?.id]);

  // Auto-remove exited sessions after a short grace period so the user can see
  // the final exit code, then the pane disappears.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = timersRef.current;
    for (const session of state.sessions) {
      if (session.status === 'exited' && !timers.has(session.id)) {
        const t = setTimeout(() => {
          dispatch({ type: 'REMOVE_SESSION', id: session.id });
          timers.delete(session.id);
        }, EXITED_AUTO_REMOVE_MS);
        timers.set(session.id, t);
      }
    }
    // Cancel timers for sessions that are no longer present.
    for (const [id, t] of timers) {
      if (!state.sessions.find((s) => s.id === id)) {
        clearTimeout(t);
        timers.delete(id);
      }
    }
  }, [state.sessions]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StateCtx.Provider value={value}>{children}</StateCtx.Provider>;
}

export function useAppState() {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
