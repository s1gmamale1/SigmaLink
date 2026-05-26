// v1.1.9 file-size split — extracted from `state.tsx`.
//
// Owns the broad live-event subscribers that keep the renderer state in sync
// with main-process notifications and per-workspace data sources. Each
// `useEffect` mirrors the original effect in `state.tsx` byte-for-byte
// (same deps array, same cleanup) so subscription ordering and lifetimes
// remain identical.
//
// Covered events / fetches:
//   - pty:exit              → MARK_SESSION_EXITED (clean exit)
//   - pty:error             → MARK_SESSION_ERROR  (runtime / fast crash)
//   - swarm:message         → APPEND_SWARM_MESSAGE
//   - browser:state         → SET_BROWSER_STATE
//   - skills:changed        → SET_SKILLS (initial + live)
//   - memory:changed        → SET_MEMORIES (initial + live)
//   - review:changed        → SET_REVIEW (initial + live)
//   - tasks:changed         → SET_TASKS (initial + live)
//   - workspace switch      → SET_SWARMS (rpc.swarms.list)

import { useEffect, type Dispatch } from 'react';
import { rpc, rpcSilent } from '../../lib/rpc';
import type { Action, AppState } from '../state.types';
import type { Notification } from '../../../shared/types';
import { parseBrowserState, parseSwarmMessage, runRefreshOnEvent } from './parsers';
import { playNotificationTone } from '../../lib/notifications';

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

  // v1.13.2 — Listen for PTY crash. The main process emits a DISTINCT
  // `pty:error` event for runtime / fast crashes (contract:
  // `{ sessionId: string; exitCode: number | null; signal?: string | null }`).
  // Unlike `pty:exit` (clean exit → MARK_SESSION_EXITED → GC'd after 5s) this
  // dispatches MARK_SESSION_ERROR so the pane stays visible in an error state
  // with its scrollback intact for a Relaunch. Subscribed alongside (not in
  // place of) the `pty:exit` listener.
  useEffect(() => {
    const off = window.sigma.eventOn('pty:error', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; exitCode?: unknown; signal?: unknown };
      if (typeof p.sessionId !== 'string') return;
      const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null;
      const signal = typeof p.signal === 'string' ? p.signal : null;
      dispatch({ type: 'MARK_SESSION_ERROR', id: p.sessionId, exitCode, signal });
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
  // `review:changed` events.
  //
  // v1.1.10 — dropped `state.sessions.length` from the dep array. Previously,
  // every session add/remove tore down the listener, re-subscribed, AND fired
  // an immediate RPC fetch (runRefreshOnEvent calls `refresh()` synchronously
  // on every setup). Under rapid session churn (e.g. multi-pane spawn /
  // teardown) this spammed `rpc.review.list` with N+1 calls for every
  // unrelated session event. The main process already emits `review:changed`
  // whenever review state actually changes — that channel is the correct
  // trigger here and matches every other room in this file.
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
  }, [state.activeWorkspace?.id, dispatch]);

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

  // v1.4.9 #07 — Notifications. Initial paginated mount + live delta merge.
  // The main process emits `notifications:changed` with a `{added, removed,
  // unreadCount}` delta (D2 IPC contract); the reducer reconciles via the
  // id-keyed upsert. The initial fetch is paginated (limit 100); the
  // dropdown can infinite-scroll for older rows.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = (await (rpcSilent as any).notifications.list({ limit: 100, offset: 0 })) as Notification[];
        if (!alive) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const counter = (await (rpcSilent as any).notifications.unreadCount()) as number;
        if (!alive) return;
        dispatch({
          type: 'SET_NOTIFICATIONS',
          notifications: list,
          unreadCount: typeof counter === 'number' ? counter : 0,
        });
      } catch {
        // Pre-migration boot or controller not yet registered — silent.
      }
    })();
    return () => {
      alive = false;
    };
  }, [dispatch]);

  useEffect(() => {
    const off = window.sigma.eventOn('notifications:changed', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as {
        added?: unknown;
        removed?: unknown;
        unreadCount?: unknown;
      };
      const added = Array.isArray(p.added)
        ? (p.added.filter((n) => n && typeof n === 'object') as Notification[])
        : [];
      const removed = Array.isArray(p.removed)
        ? (p.removed.filter((id) => typeof id === 'string') as string[])
        : [];
      const unreadCount = typeof p.unreadCount === 'number' ? p.unreadCount : 0;
      dispatch({ type: 'NOTIFICATIONS_DELTA', added, removed, unreadCount });
      // v1.13.1 — play a distinct tone once per delta when the delta contains
      // any new unread notification. v1.29.0 (SF-5): widened from warn/error/
      // critical to ALL severities incl. `info` per operator request — every new
      // notification is now audible. playNotificationTone() respects the
      // `notifications.sound` kv toggle (default ON). Fire-and-forget — non-critical.
      const hasUnread = added.some((n) => n.readAt == null);
      if (hasUnread) {
        void playNotificationTone();
      }
    });
    return off;
  }, [dispatch]);

  // When the active workspace changes, refresh swarms for that workspace so
  // the Swarm Room can pick up persisted swarms across app restarts.
  //
  // v1.13.2 — this is the CANONICAL swarm loader. CommandRoom previously ran
  // its own parallel `rpc.swarms.list` (a dual-loader race that could overwrite
  // the swarms slice); that fetch is now removed. The `swarmsLoading` slice is
  // driven from HERE so the AddPaneButton "+Pane" gate reflects this loader's
  // in-flight window and never enables on a stale/empty slice mid-hydration.
  useEffect(() => {
    let alive = true;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) {
      dispatch({ type: 'SET_SWARMS_LOADING', loading: false });
      dispatch({ type: 'SET_SWARMS', swarms: [] });
      return;
    }
    dispatch({ type: 'SET_SWARMS_LOADING', loading: true });
    void (async () => {
      try {
        const list = await rpc.swarms.list(wsId);
        if (!alive) return;
        dispatch({ type: 'SET_SWARMS', swarms: list });
      } catch (err) {
        console.error('Failed to load swarms:', err);
      } finally {
        if (alive) dispatch({ type: 'SET_SWARMS_LOADING', loading: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.activeWorkspace?.id, dispatch]);
}
