import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { readWorkspaceUi, writeWorkspaceUi } from '@/renderer/lib/workspace-ui-kv';
import {
  parsePaneOrder,
  reconcilePaneOrder,
  replacePaneOrderId,
  serializePaneOrder,
  swapPaneIds,
} from '@/shared/pane-order';

export const COMMAND_ROOM_PANE_ORDER_PANEL = 'commandRoom.paneOrder';

export interface UsePaneOrderArgs {
  workspaceId: string | null;
  canonicalSessionIds: string[];
}

export interface UsePaneOrderResult {
  orderedSessionIds: string[];
  reorderReady: boolean;
  swapPanes: (sourceId: string, targetId: string) => boolean;
  replaceSessionId: (oldId: string, newId: string) => boolean;
}

interface PendingReplacement {
  oldId: string;
  newId: string;
}

interface LoadedPaneOrder {
  workspaceId: string | null;
  preferredIds: string[];
  ready: boolean;
  pendingReplacements: PendingReplacement[];
}

function persistPaneOrder(workspaceId: string, sessionIds: string[]): void {
  void writeWorkspaceUi(
    workspaceId,
    COMMAND_ROOM_PANE_ORDER_PANEL,
    serializePaneOrder(sessionIds),
  ).catch(() => undefined);
}

export function usePaneOrder({
  workspaceId,
  canonicalSessionIds,
}: UsePaneOrderArgs): UsePaneOrderResult {
  const [loadedOrder, setLoadedOrder] = useState<LoadedPaneOrder>(() => ({
    workspaceId,
    preferredIds: [...canonicalSessionIds],
    ready: false,
    pendingReplacements: [],
  }));
  const loadedOrderRef = useRef(loadedOrder);
  const pendingOrdersByWorkspaceRef = useRef(new Map<string, LoadedPaneOrder>());

  const orderForWorkspace = loadedOrder.workspaceId === workspaceId
    ? loadedOrder
    : {
        workspaceId,
        preferredIds: canonicalSessionIds,
        ready: false,
        pendingReplacements: [],
      };
  const orderedSessionIds = reconcilePaneOrder(
    orderForWorkspace.preferredIds,
    canonicalSessionIds,
  );
  const reorderReady = workspaceId !== null && orderForWorkspace.ready;

  const latestWorkspaceIdRef = useRef(workspaceId);
  const latestOrderedSessionIdsRef = useRef(orderedSessionIds);
  const latestReorderReadyRef = useRef(reorderReady);
  useLayoutEffect(() => {
    latestWorkspaceIdRef.current = workspaceId;
    latestOrderedSessionIdsRef.current = orderedSessionIds;
    latestReorderReadyRef.current = reorderReady;
  }, [orderedSessionIds, reorderReady, workspaceId]);

  const commitLoadedOrder = useCallback((nextOrder: LoadedPaneOrder): void => {
    loadedOrderRef.current = nextOrder;
    setLoadedOrder(nextOrder);
  }, []);

  useEffect(() => {
    if (workspaceId === null) {
      const emptyWorkspaceOrder: LoadedPaneOrder = {
        workspaceId: null,
        preferredIds: [...latestOrderedSessionIdsRef.current],
        ready: false,
        pendingReplacements: [],
      };
      commitLoadedOrder(emptyWorkspaceOrder);
      return;
    }

    const requestedWorkspaceId = workspaceId;
    let cancelled = false;

    if (loadedOrderRef.current.workspaceId !== requestedWorkspaceId) {
      const pendingOrder = pendingOrdersByWorkspaceRef.current.get(requestedWorkspaceId);
      commitLoadedOrder(pendingOrder ?? {
        workspaceId: requestedWorkspaceId,
        preferredIds: [...latestOrderedSessionIdsRef.current],
        ready: false,
        pendingReplacements: [],
      });
    }

    void (async () => {
      let rawOrder: string | null;
      try {
        rawOrder = await readWorkspaceUi(
          requestedWorkspaceId,
          COMMAND_ROOM_PANE_ORDER_PANEL,
        );
      } catch {
        rawOrder = null;
      }

      if (
        cancelled
        || latestWorkspaceIdRef.current !== requestedWorkspaceId
        || loadedOrderRef.current.workspaceId !== requestedWorkspaceId
      ) {
        return;
      }

      const pendingReplacements = pendingOrdersByWorkspaceRef.current
        .get(requestedWorkspaceId)?.pendingReplacements
        ?? loadedOrderRef.current.pendingReplacements;
      let preferredIds = parsePaneOrder(rawOrder);
      let replacementApplied = false;
      for (const replacement of pendingReplacements) {
        const nextIds = replacePaneOrderId(
          preferredIds,
          replacement.oldId,
          replacement.newId,
        );
        replacementApplied ||= nextIds !== preferredIds;
        preferredIds = nextIds;
      }

      pendingOrdersByWorkspaceRef.current.delete(requestedWorkspaceId);
      commitLoadedOrder({
        workspaceId: requestedWorkspaceId,
        preferredIds,
        ready: true,
        pendingReplacements: [],
      });

      if (replacementApplied) {
        persistPaneOrder(requestedWorkspaceId, preferredIds);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [commitLoadedOrder, workspaceId]);

  const swapPanes = useCallback((sourceId: string, targetId: string): boolean => {
    const currentWorkspaceId = latestWorkspaceIdRef.current;
    if (currentWorkspaceId === null || !latestReorderReadyRef.current) {
      return false;
    }

    const currentOrder = latestOrderedSessionIdsRef.current;
    const nextOrder = swapPaneIds(currentOrder, sourceId, targetId);
    if (nextOrder === currentOrder) {
      return false;
    }

    commitLoadedOrder({
      workspaceId: currentWorkspaceId,
      preferredIds: nextOrder,
      ready: true,
      pendingReplacements: [],
    });
    persistPaneOrder(currentWorkspaceId, nextOrder);
    return true;
  }, [commitLoadedOrder]);

  const replaceSessionId = useCallback((oldId: string, newId: string): boolean => {
    const currentWorkspaceId = latestWorkspaceIdRef.current;
    if (currentWorkspaceId === null) {
      return false;
    }

    const currentOrder = latestOrderedSessionIdsRef.current;
    const nextOrder = replacePaneOrderId(currentOrder, oldId, newId);
    if (nextOrder === currentOrder) {
      return false;
    }

    const currentLoadedOrder = loadedOrderRef.current;
    const ready = latestReorderReadyRef.current;
    const nextLoadedOrder: LoadedPaneOrder = {
      workspaceId: currentWorkspaceId,
      preferredIds: nextOrder,
      ready,
      pendingReplacements: ready
        ? []
        : [
            ...(currentLoadedOrder.workspaceId === currentWorkspaceId
              ? currentLoadedOrder.pendingReplacements
              : []),
            { oldId, newId },
          ],
    };
    if (!ready) {
      pendingOrdersByWorkspaceRef.current.set(currentWorkspaceId, nextLoadedOrder);
    }
    commitLoadedOrder(nextLoadedOrder);

    if (ready) {
      persistPaneOrder(currentWorkspaceId, nextOrder);
    }
    return true;
  }, [commitLoadedOrder]);

  return {
    orderedSessionIds,
    reorderReady,
    swapPanes,
    replaceSessionId,
  };
}
