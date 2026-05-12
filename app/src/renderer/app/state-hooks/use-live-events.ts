// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the broad live-event subscribers that keep the renderer state in sync
// with main-process notifications and per-workspace data sources. Each
// `useEffect` mirrors the original effect in `state.tsx` byte-for-byte
// (same deps array, same cleanup) so subscription ordering and lifetimes
// remain identical.
//
// Covered events / fetches:
//   - pty:exit              → MARK_SESSION_EXITED
//   - swarm:message         → APPEND_SWARM_MESSAGE
//   - browser:state         → SET_BROWSER_STATE
//   - skills:changed        → SET_SKILLS (initial + live)
//   - memory:changed        → SET_MEMORIES (initial + live)
//   - review:changed        → SET_REVIEW (initial + live)
//   - tasks:changed         → SET_TASKS (initial + live)
//   - workspace switch      → SET_SWARMS (rpc.swarms.list)

import { useEffect, type Dispatch } from 'react';
import { rpc } from '../../lib/rpc';
import type { Action, AppState } from '../state.types';
import { parseBrowserState, parseSwarmMessage, runRefreshOnEvent } from './parsers';

export function useLiveEvents(state: AppState, dispatch: Dispatch<Action>): void {
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
  }, [dispatch]);

  // Listen for swarm:message so the side-chat updates live across rooms.
  useEffect(() => {
    const off = window.sigma.eventOn('swarm:message', (raw: unknown) => {
      const message = parseSwarmMessage(raw);
      if (message) dispatch({ type: 'APPEND_SWARM_MESSAGE', message });
    });
    return off;
  }, [dispatch]);

  // Listen for browser:state so the Browser room hydrates live across rooms.
  useEffect(() => {
    const off = window.sigma.eventOn('browser:state', (raw: unknown) => {
      const parsed = parseBrowserState(raw);
      if (parsed) dispatch({ type: 'SET_BROWSER_STATE', state: parsed });
    });
    return off;
  }, [dispatch]);

  // Initial skills hydration + live refresh when the main process notifies us.
  // `dispatch` from `useReducer` is referentially stable, so adding it to the
  // dep arrays here doesn't re-subscribe — it just satisfies the lint rule.
  useEffect(() => {
    return runRefreshOnEvent(
      async (isAlive) => {
        const list = await rpc.skills.list();
        if (!isAlive()) return;
        dispatch({ type: 'SET_SKILLS', skills: list.skills, states: list.states });
      },
      'skills:changed',
      'skills',
    );
  }, [dispatch]);

  // Memory hydration: refresh whenever the active workspace changes AND on
  // every `memory:changed` event so the list / graph stay live.
  useEffect(() => {
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    return runRefreshOnEvent(
      async (isAlive) => {
        const list = await rpc.memory.list_memories({ workspaceId: wsId });
        if (!isAlive()) return;
        dispatch({ type: 'SET_MEMORIES', workspaceId: wsId, memories: list });
      },
      'memory:changed',
      'memories',
    );
  }, [state.activeWorkspace?.id, dispatch]);

  // Review-room hydration: load on workspace switch + refresh on
  // `review:changed` events. Also re-runs whenever a session enters/leaves
  // (reuses the existing `sessions` length as the trigger).
  useEffect(() => {
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    return runRefreshOnEvent(
      async (isAlive) => {
        const r = await rpc.review.list(wsId);
        if (!isAlive()) return;
        dispatch({ type: 'SET_REVIEW', state: r });
      },
      'review:changed',
      'review state',
    );
  }, [state.activeWorkspace?.id, state.sessions.length, dispatch]);

  // Tasks hydration mirroring the memory pattern.
  useEffect(() => {
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    return runRefreshOnEvent(
      async (isAlive) => {
        const list = await rpc.tasks.list(wsId);
        if (!isAlive()) return;
        dispatch({ type: 'SET_TASKS', workspaceId: wsId, tasks: list });
      },
      'tasks:changed',
      'tasks',
    );
  }, [state.activeWorkspace?.id, dispatch]);

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
  }, [state.activeWorkspace?.id, dispatch]);
}
