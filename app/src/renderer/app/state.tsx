// Global renderer state: current workspace, active room, live agent sessions.
/* eslint-disable react-refresh/only-export-components */
// Plain useReducer + Context. No external store dependency.
//
// This file owns the React component (`AppStateProvider`) and the
// side-effectful IPC wiring (session restore, workspace lifecycle mirror,
// PTY/swarm/browser/skills/memory/review/tasks event listeners,
// exited-session GC timers). The pure pieces have been split into siblings:
//   - state.types.ts    — type union, AppState, Action, initialAppState, selectActiveWorkspace
//   - state.reducer.ts  — appStateReducer + its private helpers
//   - state.hook.ts     — AppStateContext + useAppState
// Public re-exports below keep every existing `@/renderer/app/state` import
// path working unchanged — see the rooms-menu-items.ts / workspaces-summary.ts
// pattern this mirrors.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { rpc } from '../lib/rpc';
import type { SwarmMessage, Workspace } from '../../shared/types';
import { initialAppState, type RoomId } from './state.types';
import { appStateReducer } from './state.reducer';
import { AppDispatchContext, AppStateContext, appStateStore } from './state.hook';

// Re-exports so external callers continue to use `@/renderer/app/state`
// without knowing about the split. DO NOT inline these consumers.
export type { Action, AppState, RoomId } from './state.types';
export { initialAppState, selectActiveWorkspace } from './state.types';
export { appStateReducer } from './state.reducer';
export { useAppDispatch, useAppState, useAppStateSelector } from './state.hook';

// BUG-V1.1.2-02 — Runtime mirror of the `RoomId` union so the session-restore
// handler can narrow an incoming string before dispatching SET_ROOM. Adding a
// room here is a one-line edit; failing to add one means the restore silently
// drops back to 'workspaces' for that pane — never a crash.
const VALID_ROOMS: ReadonlySet<RoomId> = new Set<RoomId>([
  'workspaces',
  'command',
  'swarm',
  'operator',
  'review',
  'tasks',
  'memory',
  'browser',
  'skills',
  'bridge',
  'settings',
]);

function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && VALID_ROOMS.has(value as RoomId);
}

/**
 * Time after which an exited session is auto-removed from the live sessions
 * list. The user can also remove it manually from the Command Room.
 */
const EXITED_AUTO_REMOVE_MS = 5_000;

function parseOpenWorkspacesChanged(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { workspaceIds?: unknown };
  if (!Array.isArray(p.workspaceIds)) return null;
  const ids = p.workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length === p.workspaceIds.length ? ids : null;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appStateReducer, initialAppState);
  const workspacesRef = useRef<Workspace[]>([]);

  useLayoutEffect(() => {
    appStateStore.setState(state);
  }, [state]);

  useEffect(() => {
    workspacesRef.current = state.workspaces;
  }, [state.workspaces]);

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

  // P3-S8 — Test-only hook. Playwright drives `workspaces.open` via IPC but
  // the renderer's own AppState is unaware until `workspaces.list` re-fires.
  // Rather than exposing a dispatch handle to window (which would leak
  // implementation details), we listen for a `sigma:test:activate-workspace`
  // CustomEvent and re-read the workspace list, then activate the matching
  // entry. No-op in production: the event is never dispatched outside tests.
  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<{ rootPath?: string; id?: string }>).detail ?? {};
      try {
        const list = await rpc.workspaces.list();
        dispatch({ type: 'SET_WORKSPACES', workspaces: list });
        const match = list.find(
          (w) => (detail.id && w.id === detail.id) || (detail.rootPath && w.rootPath === detail.rootPath),
        );
        if (match) dispatch({ type: 'WORKSPACE_OPEN', workspace: match });
      } catch {
        /* test harness: swallow */
      }
    };
    window.addEventListener('sigma:test:activate-workspace', handler as EventListener);
    return () => window.removeEventListener('sigma:test:activate-workspace', handler as EventListener);
  }, []);

  // v1.1.3 Step 2 — main-process workspace lifecycle mirror. `workspaces.open`
  // emits the event after it marks a workspace opened, and local close/open
  // state sends the current id list back so the main process can keep one
  // runtime list for Step 6 persistence.
  useEffect(() => {
    const off = window.sigma.eventOn('app:open-workspaces-changed', (raw: unknown) => {
      const workspaceIds = parseOpenWorkspacesChanged(raw);
      if (!workspaceIds) return;
      void (async () => {
        let workspaces = workspacesRef.current;
        if (workspaceIds.some((id) => !workspaces.some((w) => w.id === id))) {
          try {
            workspaces = await rpc.workspaces.list();
            dispatch({ type: 'SET_WORKSPACES', workspaces });
          } catch {
            return;
          }
        }
        dispatch({ type: 'SYNC_OPEN_WORKSPACES', workspaceIds, workspaces });
      })();
    });
    return off;
  }, []);

  const lastOpenWorkspaceIdsRef = useRef<string>('');
  useEffect(() => {
    if (!state.ready) return;
    const workspaceIds = state.openWorkspaces.map((w) => w.id);
    const key = workspaceIds.join('\0');
    if (!key && !lastOpenWorkspaceIdsRef.current) return;
    if (key === lastOpenWorkspaceIdsRef.current) return;
    lastOpenWorkspaceIdsRef.current = key;
    try {
      window.sigma.eventSend('app:open-workspaces-changed', { workspaceIds });
    } catch {
      /* preload bridge gone — nothing actionable on the renderer side */
    }
  }, [state.ready, state.openWorkspaces]);

  // Hydrate persisted UI flags (onboarded, sidebar collapse) from the kv
  // table. Runs once on mount; the theme is loaded by ThemeProvider.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [onboardedRaw, sidebarRaw] = await Promise.all([
          rpc.kv.get('app.onboarded').catch(() => null),
          rpc.kv.get('app.sidebar.collapsed').catch(() => null),
        ]);
        if (!alive) return;
        dispatch({
          type: 'BOOT_UI',
          onboarded: onboardedRaw === '1',
          sidebarCollapsed: sidebarRaw === '1',
        });
      } catch {
        if (alive) dispatch({ type: 'BOOT_UI', onboarded: false, sidebarCollapsed: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // BUG-V1.1.2-02 — Session restore on boot. The main process emits
  // `app:session-restore` once `did-finish-load` fires; we wait until the
  // workspace list has hydrated (`state.ready === true`) before activating
  // the workspace so the WORKSPACE_OPEN dispatch can use a verified row
  // still exists. A missing row (deleted/moved workspace) falls back to the
  // picker — no crash, no toast. The room dispatch only fires if the
  // restored room is a known `RoomId`; an unknown room from a downgrade
  // path keeps the user on 'workspaces' (the default for a fresh boot).
  //
  // We hold the payload across a possibly-not-yet-ready render in a ref so
  // the listener can attach immediately (don't miss the event if main
  // pushes before our effect runs).
  const pendingRestoreRef = useRef<{
    activeWorkspaceId: string;
    openWorkspaces: Array<{ workspaceId: string; room: string }>;
  } | null>(null);
  useEffect(() => {
    const off = window.sigma.eventOn('app:session-restore', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as {
        activeWorkspaceId?: unknown;
        openWorkspaces?: unknown;
        workspaceId?: unknown;
        room?: unknown;
      };
      if (typeof p.activeWorkspaceId === 'string' && Array.isArray(p.openWorkspaces)) {
        const openWorkspaces = p.openWorkspaces
          .filter((entry): entry is { workspaceId: string; room: string } => {
            if (!entry || typeof entry !== 'object') return false;
            const e = entry as { workspaceId?: unknown; room?: unknown };
            return typeof e.workspaceId === 'string' && !!e.workspaceId && typeof e.room === 'string' && !!e.room;
          });
        if (openWorkspaces.length > 0) {
          pendingRestoreRef.current = {
            activeWorkspaceId: p.activeWorkspaceId,
            openWorkspaces,
          };
        }
        return;
      }
      if (typeof p.workspaceId !== 'string' || !p.workspaceId) return;
      if (typeof p.room !== 'string' || !p.room) return;
      pendingRestoreRef.current = {
        activeWorkspaceId: p.workspaceId,
        openWorkspaces: [{ workspaceId: p.workspaceId, room: p.room }],
      };
    });
    return off;
  }, []);

  // Drain the pending restore once the workspace list has loaded so we can
  // safely look up the workspace by id. Runs whenever `state.ready` flips
  // (cold boot) or whenever the workspace list re-syncs (a deleted workspace
  // shows up here as a no-op). Idempotent — clearing the ref guarantees a
  // single dispatch per snapshot.
  useEffect(() => {
    if (!state.ready) return;
    const pending = pendingRestoreRef.current;
    if (!pending) return;
    const workspaceById = new Map(state.workspaces.map((w) => [w.id, w]));
    const restored = pending.openWorkspaces
      .map((entry) => ({ entry, workspace: workspaceById.get(entry.workspaceId) }))
      .filter((item): item is { entry: { workspaceId: string; room: string }; workspace: Workspace } =>
        Boolean(item.workspace),
      );
    if (restored.length === 0) {
      // Workspaces were deleted/moved between sessions; fall back to picker.
      pendingRestoreRef.current = null;
      return;
    }
    for (const item of [...restored].reverse()) {
      dispatch({ type: 'WORKSPACE_OPEN', workspace: item.workspace });
    }
    const active =
      restored.find((item) => item.workspace.id === pending.activeWorkspaceId) ?? restored[0];
    dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: active.workspace.id });
    if (isRoomId(active.entry.room)) {
      dispatch({ type: 'SET_ROOM', room: active.entry.room });
    }
    for (const item of restored) {
      void rpc.panes.resume(item.workspace.id).catch(() => {
        /* pane resume failures are reported by main; restore should continue */
      });
    }
    pendingRestoreRef.current = null;
  }, [state.ready, state.workspaces]);

  // BUG-V1.1.2-02 — Persist on change. Every time the active workspace or
  // room actually changes, fire-and-forget `app:session-snapshot` so the
  // main process can flush it to kv on the next quit. Throttled to ≤ 1
  // event/sec so a rapid sequence of room toggles doesn't spam IPC; the
  // trailing-edge timer guarantees the final state still lands.
  //
  // We deliberately skip emission while the boot flow is still hydrating
  // (`state.ready === false`) so the persisted row doesn't get overwritten
  // by the initial 'workspaces' default before the restore effect runs.
  const lastSnapshotRef = useRef<string>('');
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.ready) return;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    const key = `${wsId}::${state.room}`;
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(() => {
      try {
        window.sigma.eventSend('app:session-snapshot', {
          activeWorkspaceId: wsId,
          openWorkspaces: state.openWorkspaces.map((workspace) => ({
            workspaceId: workspace.id,
            room: state.room,
          })),
        });
      } catch {
        /* preload bridge gone — nothing actionable on the renderer side */
      }
    }, 250);
    return () => {
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [state.ready, state.activeWorkspace?.id, state.openWorkspaces, state.room]);

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

  // Initial skills hydration + live refresh when the main process notifies us.
  // Defined inside the effect so the dep array stays empty (no stale closure
  // risk: `dispatch` from `useReducer` is referentially stable per React docs).
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void (async () => {
        try {
          const list = await rpc.skills.list();
          if (!alive) return;
          dispatch({ type: 'SET_SKILLS', skills: list.skills, states: list.states });
        } catch (err) {
          console.error('Failed to load skills:', err);
        }
      })();
    };
    refresh();
    const off = window.sigma.eventOn('skills:changed', refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Memory hydration: refresh whenever the active workspace changes AND on
  // every `memory:changed` event so the list / graph stay live.
  useEffect(() => {
    let alive = true;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    const refresh = () => {
      void (async () => {
        try {
          const list = await rpc.memory.list_memories({ workspaceId: wsId });
          if (!alive) return;
          dispatch({ type: 'SET_MEMORIES', workspaceId: wsId, memories: list });
        } catch (err) {
          console.error('Failed to load memories:', err);
        }
      })();
    };
    refresh();
    const off = window.sigma.eventOn('memory:changed', refresh);
    return () => {
      alive = false;
      off();
    };
  }, [state.activeWorkspace?.id]);

  // Review-room hydration: load on workspace switch + refresh on
  // `review:changed` events. Also re-runs whenever a session enters/leaves
  // (reuses the existing `sessions` length as the trigger).
  useEffect(() => {
    let alive = true;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    const refresh = () => {
      void (async () => {
        try {
          const r = await rpc.review.list(wsId);
          if (!alive) return;
          dispatch({ type: 'SET_REVIEW', state: r });
        } catch (err) {
          console.error('Failed to load review state:', err);
        }
      })();
    };
    refresh();
    const off = window.sigma.eventOn('review:changed', refresh);
    return () => {
      alive = false;
      off();
    };
  }, [state.activeWorkspace?.id, state.sessions.length]);

  // Tasks hydration mirroring the memory pattern.
  useEffect(() => {
    let alive = true;
    const wsId = state.activeWorkspace?.id;
    if (!wsId) return;
    const refresh = () => {
      void (async () => {
        try {
          const list = await rpc.tasks.list(wsId);
          if (!alive) return;
          dispatch({ type: 'SET_TASKS', workspaceId: wsId, tasks: list });
        } catch (err) {
          console.error('Failed to load tasks:', err);
        }
      })();
    };
    refresh();
    const off = window.sigma.eventOn('tasks:changed', refresh);
    return () => {
      alive = false;
      off();
    };
  }, [state.activeWorkspace?.id]);

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
  return (
    <AppDispatchContext.Provider value={dispatch}>
      <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
    </AppDispatchContext.Provider>
  );
}
