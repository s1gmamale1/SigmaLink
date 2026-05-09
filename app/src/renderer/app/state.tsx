// Global renderer state: current workspace, active room, live agent sessions.
// Plain useReducer + Context. No external store dependency.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { AgentSession, Workspace } from '@/shared/types';

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
}

type Action =
  | { type: 'READY'; workspaces: Workspace[] }
  | { type: 'SET_ROOM'; room: RoomId }
  | { type: 'SET_WORKSPACES'; workspaces: Workspace[] }
  | { type: 'SET_ACTIVE_WORKSPACE'; workspace: Workspace | null }
  | { type: 'ADD_SESSIONS'; sessions: AgentSession[] }
  | { type: 'SET_ACTIVE_SESSION'; id: string | null }
  | { type: 'MARK_SESSION_EXITED'; id: string; exitCode: number }
  | { type: 'REMOVE_SESSION'; id: string };

const initial: AppState = {
  ready: false,
  room: 'workspaces',
  workspaces: [],
  activeWorkspace: null,
  sessions: [],
  activeSessionId: null,
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
