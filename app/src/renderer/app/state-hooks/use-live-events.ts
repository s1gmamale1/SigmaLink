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

import { useEffect, useRef, type Dispatch } from 'react';
import { toast } from 'sonner';
import { rpc, rpcSilent } from '../../lib/rpc';
import type { Action, AppState } from '../state.types';
import type { AgentSession, Notification } from '../../../shared/types';
import { parseBrowserState, parseSwarmMessage, runRefreshOnEvent } from './parsers';
import { playNotificationTone } from '../../lib/notifications';
import { playCue } from '../../lib/sounds';
import {
  KV_DND,
  KV_OS_PER_SOURCE,
  KV_QUIET_HOURS,
  isQuietActive,
  notificationSource,
  parseMutedSources,
  parseQuietHours,
  type NotificationPrefs,
} from '../../../shared/notification-prefs';
import { maxSeverity, navigateToNotification } from '../../features/notifications/helpers';

// Agent-attention sound throttle. Module scope so a 20-agent swarm finishing
// together plays ONE sound, and the throttle survives hook remounts.
const ATTENTION_SOUND_THROTTLE_MS = 2000;
let lastAttentionSoundAt = 0;

export function useLiveEvents(state: AppState, dispatch: Dispatch<Action>): void {
  // Current-state ref so event callbacks (which subscribe with stable deps) see
  // the LATEST state, not a stale closure. Used by the resume_swarm refresh to
  // read the active workspace at event time. Updated in an effect (never assign
  // a ref during render — react-hooks/refs).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

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

  // Agent-attention (spec 2026-06-14) — "agent is now waiting for you" (bell or
  // idle). Light up the workspace row + pane and play the throttled cue.
  useEffect(() => {
    const off = window.sigma.eventOn('agent:attention', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; ts?: unknown };
      if (typeof p.sessionId !== 'string') return;
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      dispatch({ type: 'SET_ATTENTION', sessionId: p.sessionId, ts });
      if (ts - lastAttentionSoundAt > ATTENTION_SOUND_THROTTLE_MS) {
        lastAttentionSoundAt = ts;
        void playCue('agent-attention');
      }
    });
    return off;
  }, [dispatch]);

  // Jorvis close_pane → drop the pane from the grid live (twin of the
  // assistant:dispatch-echo ADD path).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:pane-closed', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown };
      if (typeof p.sessionId !== 'string') return;
      dispatch({ type: 'REMOVE_SESSION', id: p.sessionId });
    });
    return off;
  }, [dispatch]);

  // Jorvis switch_workspace → activate a different workspace in the UI.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:switch-workspace', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { workspaceId?: unknown };
      if (typeof p.workspaceId !== 'string') return;
      dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: p.workspaceId });
    });
    return off;
  }, [dispatch]);

  // Jorvis / external open_workspace → open the workspace, add it to the rail,
  // AND activate it so the operator SEES the agent's work live. A human opening a
  // workspace switches to it; without the activate, an external agent's newly
  // opened workspace — and any panes it then launches there — render in the
  // background and never surface in the visible window. (Canonical pattern:
  // WORKSPACE_OPEN + SET_ACTIVE_WORKSPACE_ID — see state.types.ts.)
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:open-workspace', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { root?: unknown };
      if (typeof p.root !== 'string') return;
      void (async () => {
        try {
          const ws = await rpc.workspaces.open(p.root as string);
          dispatch({ type: 'WORKSPACE_OPEN', workspace: ws });
          dispatch({ type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: ws.id });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, [dispatch]);

  // launch_pane / create_swarm / add_agent emit `assistant:dispatch-echo` after
  // spawning a pane. The renderer has no server-push for a new pane, so without a
  // GLOBAL subscriber the pane exists in the DB but never appears in the grid
  // until a workspace reopen. (Previously the ONLY dispatch-echo subscriber lived
  // inside JorvisRoom, so an external- or Telegram-driven launch never reflected
  // unless the operator happened to be in the Jorvis room.) This refetches the
  // workspace's panes + swarms and upserts them so the pane surfaces in ANY room.
  // It deliberately does NOT change the active room/session — that view-follow UX
  // belongs to the Jorvis chat flow (useJorvisDispatchEcho, the grep-twin), which
  // an autonomous external/Telegram launch must not trigger. ADD_SESSIONS /
  // UPSERT_SWARM are idempotent upserts, so the two paths overlapping while the
  // Jorvis room is active is safe.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:dispatch-echo', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const echo = raw as { workspaceId?: unknown; ok?: unknown };
      if (echo.ok !== true || typeof echo.workspaceId !== 'string') return;
      const workspaceId = echo.workspaceId;
      void (async () => {
        try {
          const [sessions, swarms] = await Promise.all([
            rpcSilent.panes.listForWorkspace(workspaceId),
            rpcSilent.swarms.list(workspaceId),
          ]);
          if (sessions && sessions.length > 0) {
            dispatch({ type: 'ADD_SESSIONS', sessions });
          }
          if (swarms) {
            for (const swarm of swarms) dispatch({ type: 'UPSERT_SWARM', swarm });
          }
        } catch {
          /* best-effort — pane will populate on next workspace reopen */
        }
      })();
    });
    return off;
  }, [dispatch]);

  // Jorvis close_workspace → remove the workspace + drop it from the rail.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:close-workspace', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { workspaceId?: unknown };
      if (typeof p.workspaceId !== 'string') return;
      void (async () => {
        try {
          await rpc.workspaces.remove(p.workspaceId as string);
          dispatch({ type: 'WORKSPACE_CLOSE', workspaceId: p.workspaceId as string });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, [dispatch]);

  // Jorvis focus_pane → set active session and optionally fullscreen it.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:focus-pane', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; fullscreen?: unknown };
      if (typeof p.sessionId !== 'string') return;
      dispatch({ type: 'SET_ACTIVE_SESSION', id: p.sessionId });
      if (p.fullscreen === true) {
        dispatch({ type: 'FOCUS_PANE', paneId: p.sessionId });
      }
    });
    return off;
  }, [dispatch]);

  // Jorvis stop_pane → kill the PTY process but leave the pane in the grid.
  // Mirrors CommandRoom's handleStop: rpc.pty.kill(sessionId). The existing
  // pty:exit → MARK_SESSION_EXITED plumbing updates the UI automatically.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:stop-pane', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown };
      if (typeof p.sessionId !== 'string') return;
      void (async () => {
        try {
          await rpc.pty.kill(p.sessionId as string);
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, []);

  // Jorvis split_pane → split a pane and add the new session to the grid.
  // Mirrors CommandRoom's handleSplitPane: rpc.swarms.splitPane then SPLIT_PANE.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:split-pane', (raw: unknown) => {
      // The split_pane TOOL already ran rpc.swarms.splitPane in main and emitted
      // the new session — this subscriber ONLY dispatches the grid update (no
      // second rpc → no double-create; the tool surfaced any failure as ok:false).
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { parentId?: unknown; newSession?: unknown; groupId?: unknown; direction?: unknown };
      if (typeof p.parentId !== 'string') return;
      if (!p.newSession || typeof p.newSession !== 'object') return;
      const newSession = p.newSession as AgentSession;
      const groupId = typeof p.groupId === 'string' ? p.groupId : null;
      if (!groupId) {
        dispatch({ type: 'ADD_SESSIONS', sessions: [newSession] });
        return;
      }
      dispatch({
        type: 'SPLIT_PANE',
        parentId: p.parentId,
        newSession,
        groupId,
        direction: p.direction === 'vertical' ? 'vertical' : 'horizontal',
      });
    });
    return off;
  }, [dispatch]);

  // Jorvis set_pane_minimised → minimise or restore a pane.
  // Mirrors CommandRoom's handleToggleMinimise: dispatch MINIMISE_PANE then rpc.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:set-pane-minimised', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { paneId?: unknown; minimised?: unknown };
      if (typeof p.paneId !== 'string') return;
      if (typeof p.minimised !== 'boolean') return;
      dispatch({ type: 'MINIMISE_PANE', paneId: p.paneId, minimised: p.minimised });
      void (async () => {
        try {
          await rpc.swarms.minimisePane({ paneId: p.paneId as string, minimised: p.minimised as boolean });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, [dispatch]);

  // Jorvis set_pane_display_provider → cosmetic relabel of a pane's provider badge.
  // Mirrors PaneGearPopover's relabel: rpc.panes.setDisplayProvider. The main
  // process emits panes:display-provider-changed which the renderer can pick up
  // to refresh; the rpc call alone is sufficient for the initiating window.
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:set-display-provider', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { sessionId?: unknown; displayProviderId?: unknown };
      if (typeof p.sessionId !== 'string') return;
      if (typeof p.displayProviderId !== 'string') return;
      void (async () => {
        try {
          await rpc.panes.setDisplayProvider({
            sessionId: p.sessionId as string,
            displayProviderId: p.displayProviderId as string,
          });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, []);

  // Jorvis rename_workspace → rename a workspace optimistically then persist via RPC.
  // Mirrors Sidebar's onRename: dispatch RENAME_WORKSPACE first (optimistic), then
  // rpc.workspaces.rename({ id, name }). On failure, a full SET_WORKSPACES reload
  // is skipped here (best-effort path — the sidebar handler does it if desired).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:rename-workspace', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { workspaceId?: unknown; name?: unknown };
      if (typeof p.workspaceId !== 'string') return;
      if (typeof p.name !== 'string') return;
      dispatch({ type: 'RENAME_WORKSPACE', id: p.workspaceId, name: p.name });
      void (async () => {
        try {
          await rpc.workspaces.rename({ id: p.workspaceId as string, name: p.name as string });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, [dispatch]);

  // Jorvis detach_window → pop a workspace out into its own OS window.
  // Mirrors Sidebar's onDetach: rpc.windows.detachWorkspace({ workspaceId }).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:detach-window', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { workspaceId?: unknown };
      if (typeof p.workspaceId !== 'string') return;
      void (async () => {
        try {
          await rpc.windows.detachWorkspace({ workspaceId: p.workspaceId as string });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, []);

  // Jorvis redock_window → redock a detached workspace window back into main.
  // Mirrors rpc.windows.redockWorkspace({ workspaceId }).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:redock-window', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { workspaceId?: unknown };
      if (typeof p.workspaceId !== 'string') return;
      void (async () => {
        try {
          await rpc.windows.redockWorkspace({ workspaceId: p.workspaceId as string });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, []);

  // send_message_to_agent has NO subscriber: the tool calls swarmsCtl.sendMessage
  // DIRECTLY in main (mailbox-append + PTY-write), so the renderer sees the line
  // via the existing pty:data stream. A subscriber here would DOUBLE-SEND.

  // resume_swarm → the TOOL already healed the swarm (DB status flip) in main;
  // this subscriber only REFRESHES the renderer's swarm list so the new status
  // shows (no second rpc.swarms.resume).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:resume-swarm', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const wsId = stateRef.current.activeWorkspaceId;
      if (!wsId) return;
      void (async () => {
        try {
          const swarms = await rpc.swarms.list(wsId);
          dispatch({ type: 'SET_SWARMS', swarms });
        } catch { /* best-effort */ }
      })();
    });
    return off;
  }, [dispatch]);

  // kill_swarm → the TOOL already killed the swarm (PTYs reaped) in main; this
  // subscriber only marks it ended in the renderer (no second rpc.swarms.kill).
  useEffect(() => {
    const off = window.sigma.eventOn('assistant:kill-swarm', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const p = raw as { swarmId?: unknown };
      if (typeof p.swarmId !== 'string') return;
      dispatch({ type: 'MARK_SWARM_ENDED', id: p.swarmId });
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

      // Reducer upsert is the load-bearing path — do it SYNCHRONOUSLY, exactly
      // as before, so the bell badge / dropdown reconcile immediately and never
      // wait on the (async) sound + toast handoff below.
      dispatch({ type: 'NOTIFICATIONS_DELTA', added, removed, unreadCount });

      // P3 (NTF-2 / SND-1) — toast↔bell handoff. The new unread rows are
      // surfaced as a distinct per-severity tone + a themed sonner toast, BOTH
      // gated by the operator's notification prefs:
      //   - per-source mute (notifications.osPerSource) silences a source's
      //     tone AND toast — but the row still lands in the bell (recorded).
      //   - DND / quiet-hours (notifications.dnd / .quietHours) suppress the
      //     TOAST here (the bell badge still carries it visually). The tone is
      //     still DISPATCHED to playNotificationTone — the sounds engine owns
      //     the DND/quiet gate (isSoundSuppressedByPrefs) and drops it there, so
      //     we keep a single gate source of truth rather than duplicating it.
      // (Supersedes the v1.29.0 SF-5 "single tone, all severities, only the
      //  notifications.sound toggle" behavior — now per-severity + per-source/
      //  quiet aware.) Because the prefs live in KV (async reads), all of this
      //  runs in a fire-and-forget block AFTER the synchronous dispatch above;
      //  a few KV reads per delta is fine (deltas are user-paced).
      const newUnread = added.filter((n) => n.readAt == null);
      if (newUnread.length === 0) return;
      void (async () => {
        try {
          const [perSourceRaw, quietRaw, dndRaw] = await Promise.all([
            rpcSilent.kv.get(KV_OS_PER_SOURCE),
            rpcSilent.kv.get(KV_QUIET_HOURS),
            rpcSilent.kv.get(KV_DND),
          ]);
          const prefs: NotificationPrefs = {
            dnd: dndRaw === '1',
            quietHours: parseQuietHours(quietRaw),
            mutedSources: parseMutedSources(perSourceRaw),
          };

          // Drop rows whose source the operator muted — never audible, no toast.
          const audible = newUnread.filter(
            (n) => !prefs.mutedSources.includes(notificationSource(n.kind)),
          );
          if (audible.length === 0) return;

          // Distinct per-severity tone for the delta's MAX unread severity.
          // Fire-and-forget; the sounds engine owns master/quiet/mute gating.
          const sev = maxSeverity(audible);
          if (sev) void playNotificationTone(sev);

          // Suppress toasts entirely while DND / quiet-hours is active — the
          // bell badge already carries the rows. Otherwise surface one themed
          // toast per audible new unread row (typically 1 per delta).
          const now = new Date();
          const nowMinutes = now.getHours() * 60 + now.getMinutes();
          if (isQuietActive(prefs, nowMinutes)) return;

          for (const n of audible) {
            const body = n.body ?? undefined;
            if (n.severity === 'error' || n.severity === 'critical') {
              toast.error(n.title, {
                description: body,
                duration: Infinity,
                action: {
                  label: 'View',
                  onClick: () => navigateToNotification(n, dispatch),
                },
              });
            } else if (n.severity === 'warn') {
              toast.warning(n.title, { description: body, duration: 5000 });
            } else {
              toast(n.title, { description: body, duration: 3000 });
            }
          }
        } catch {
          // Prefs read / toast surface unavailable (early boot, no Toaster yet,
          // controller not registered) — sound + toast are non-critical.
        }
      })();
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
