// Global renderer state: current workspace, active room, live agent sessions.
// Plain useReducer + Context. No external store dependency.

import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
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
  | { type: 'MARK_SESSION_EXITED'; id: string; exitCode: number };

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
      return {
        ...state,
        sessions,
        activeSessionId: state.activeSessionId ?? action.sessions[0]?.id ?? null,
      };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.id };
    case 'MARK_SESSION_EXITED':
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.id ? { ...s, status: 'exited', exitCode: action.exitCode } : s,
        ),
      };
    default:
      return state;
  }
}

const StateCtx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

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
      const p = raw as { sessionId: string; exitCode: number };
      dispatch({ type: 'MARK_SESSION_EXITED', id: p.sessionId, exitCode: p.exitCode });
    });
    return off;
  }, []);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StateCtx.Provider value={value}>{children}</StateCtx.Provider>;
}

export function useAppState() {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
