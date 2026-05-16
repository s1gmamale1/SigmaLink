import { useEffect } from 'react';
import { toast } from 'sonner';
import { rpcSilent, onEvent } from '@/renderer/lib/rpc';
import { playDing } from '@/renderer/lib/notifications';
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

export interface UseSigmaDispatchEchoArgs {
  workspaces: AppState['workspaces'];
  activeWorkspaceId: string | undefined;
  dispatch: React.Dispatch<Action>;
}

/** BUG-V1.1-04-IPC — dispatch-echo handler. When a Sigma tool dispatches a
 *  pane, auto-shift focus to the spawned pane. Cross-workspace jump: swap
 *  workspace (if needed), hop to the Command Room, set the global active
 *  session, and emit `sigma:pty-focus`. */
export function useSigmaDispatchEcho({
  workspaces,
  activeWorkspaceId,
  dispatch,
}: UseSigmaDispatchEchoArgs): void {
  useEffect(() => {
    const off = onEvent<DispatchEchoEvent>('assistant:dispatch-echo', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const echo = raw as DispatchEchoEvent;
      if (!echo.ok) {
        toast.error('Sigma dispatch failed', {
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
        let autoFocus = true;
        try {
          const raw = await rpcSilent.kv.get(KV_AUTO_FOCUS_ON_DISPATCH);
          autoFocus = raw === null || raw === undefined ? true : raw !== '0';
        } catch {
          /* default ON when kv unreachable */
        }
        if (autoFocus) jumpToPane();
        toast.success(`Sigma dispatched a ${echo.providerId} pane`, {
          description: `${wsLabel} · session ${echo.sessionId.slice(0, 8)}`,
          action: {
            label: 'Jump to pane',
            onClick: jumpToPane,
          },
        });
        void playDing();
      })();
    });
    return off;
  }, [workspaces, activeWorkspaceId, dispatch]);
}
