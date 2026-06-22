import { useEffect } from 'react';
import { toast } from 'sonner';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';
import type { AppState } from '@/renderer/app/state';
import type { Action } from '@/renderer/app/state.types';

const KV_AUTO_FOCUS_ON_DISPATCH = 'sigma.autoFocusOnDispatch';

interface DispatchEchoEvent {
  workspaceId: string;
  sessionId: string;
  providerId: string;
  ok: boolean;
  error: string | null;
  conversationId: string | null;
}

export interface UseJorvisDispatchEchoArgs {
  workspaces: AppState['workspaces'];
  activeWorkspaceId: string | undefined;
  dispatch: React.Dispatch<Action>;
}

/** BUG-V1.1-04-IPC — dispatch-echo handler. When a Sigma tool dispatches a
 *  pane, auto-shift focus to the spawned pane. Cross-workspace jump: swap
 *  workspace (if needed), hop to the Command Room, set the global active
 *  session, and emit `sigma:pty-focus`. */
export function useJorvisDispatchEcho({
  workspaces,
  activeWorkspaceId,
  dispatch,
}: UseJorvisDispatchEchoArgs): void {
  useEffect(() => {
    const off = onEvent<DispatchEchoEvent>('assistant:dispatch-echo', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const echo = raw as DispatchEchoEvent;
      if (!echo.ok) {
        toast.error('Jorvis dispatch failed', {
          description: echo.error ?? 'Unknown error',
        });
        return;
      }
      const targetWs = workspaces.find((w) => w.id === echo.workspaceId) ?? null;
      const wsLabel = targetWs?.name ?? 'workspace';

      const jumpToPane = (): void => {
        if (targetWs && activeWorkspaceId !== targetWs.id) {
          dispatch({ type: 'SET_ACTIVE_WORKSPACE', workspace: targetWs });
        }
        dispatch({ type: 'SET_ROOM', room: 'command' });
        dispatch({ type: 'SET_ACTIVE_SESSION', id: echo.sessionId });
        try {
          window.dispatchEvent(
            new CustomEvent('sigma:pty-focus', {
              detail: { sessionId: echo.sessionId },
            }),
          );
        } catch {
          /* ignore — DOM unmounted */
        }
      };

      void (async () => {
        // NOTE (grep-twin): the GLOBAL use-live-events `assistant:dispatch-echo`
        // subscriber performs this SAME panes+swarms hydration so external- and
        // Telegram-driven launches reflect in the grid in ANY room. Keep the two
        // in sync; ADD_SESSIONS / UPSERT_SWARM are idempotent upserts, so both
        // firing while the Jorvis room is active is harmless. This copy ALSO
        // drives the view-follow jump below — the Jorvis-chat-only UX that an
        // autonomous launch must not trigger.
        //
        // v1.5.3 hotfix for v1.5.2-and-earlier — refresh renderer's swarms +
        // sessions state from the source of truth before navigation. The echo
        // event tells us a pane was spawned, but the backend creates the swarm
        // agent row + AgentSession row asynchronously and doesn't push them
        // back through this event payload. Without these refreshes the
        // sidebar agent badge and Command Room grid don't include the new
        // pane (it exists on disk + in DB, just invisible in the UI until a
        // workspace reopen). Mirrors the v1.4.3 #02 panes.listForWorkspace
        // hydration pattern used in boot-restore + workspace open.
        try {
          const [sessions, swarms] = await Promise.all([
            rpcSilent.panes.listForWorkspace(echo.workspaceId),
            rpcSilent.swarms.list(echo.workspaceId),
          ]);
          if (sessions && sessions.length > 0) {
            dispatch({ type: 'ADD_SESSIONS', sessions });
          }
          if (swarms) {
            for (const swarm of swarms) {
              dispatch({ type: 'UPSERT_SWARM', swarm });
            }
          }
        } catch {
          /* best-effort — pane will populate on next workspace reopen */
        }
        let autoFocus = true;
        try {
          const raw = await rpcSilent.kv.get(KV_AUTO_FOCUS_ON_DISPATCH);
          autoFocus = raw === null || raw === undefined ? true : raw !== '0';
        } catch {
          /* default ON when kv unreachable */
        }
        if (autoFocus) jumpToPane();
        toast.success(`Jorvis dispatched a ${echo.providerId} pane`, {
          description: `${wsLabel} · session ${echo.sessionId.slice(0, 8)}`,
          action: {
            label: 'Jump to pane',
            onClick: jumpToPane,
          },
        });
      })();
    });
    return off;
  }, [workspaces, activeWorkspaceId, dispatch]);
}
