// Renderer echo hook — pushes the five "what is the human looking at" facts
// from the Redux store into the main-side ViewportShadow on every change.
// Called once inside AppStateProvider alongside useLiveEvents. Best-effort:
// the rpc.control.reportViewport call is fire-and-forget and never throws.

import { useEffect } from 'react';
import { rpc } from '../../lib/rpc';
import { useAppStateSelector } from '@/renderer/app/state.hook';

export function useViewportShadow(): void {
  const activeWorkspaceId = useAppStateSelector((s) => s.activeWorkspaceId);
  const activeSessionId = useAppStateSelector((s) => s.activeSessionId);
  const focusedPaneId = useAppStateSelector((s) => s.focusedPaneId);
  const room = useAppStateSelector((s) => s.room);
  const activeSwarmId = useAppStateSelector((s) => s.activeSwarmId);

  useEffect(() => {
    void (async () => {
      try {
        await rpc.control.reportViewport({
          activeWorkspaceId,
          activeSessionId,
          focusedPaneId,
          room,
          activeSwarmId,
        });
      } catch {
        // best-effort — never surface errors to the user
      }
    })();
  }, [activeWorkspaceId, activeSessionId, focusedPaneId, room, activeSwarmId]);
}
