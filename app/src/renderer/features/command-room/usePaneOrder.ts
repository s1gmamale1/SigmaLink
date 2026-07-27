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
  replaceSessionId: (workspaceId: string, oldId: string, newId: string) => boolean;
}

interface PendingReplacement {
  oldId: string;
  newId: string;
  fallbackIds: string[];
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
  const ordersByWorkspaceRef = useRef(new Map<string, LoadedPaneOrder>(
    loadedOrder.workspaceId === null
      ? []
      : [[loadedOrder.workspaceId, loadedOrder]],
  ));

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
    if (
      workspaceId !== null
      && loadedOrderRef.current.workspaceId === workspaceId
    ) {
      ordersByWorkspaceRef.current.set(workspaceId, {
        ...loadedOrderRef.current,
        preferredIds: orderedSessionIds,
      });
    }
  }, [orderedSessionIds, reorderReady, workspaceId]);

  const commitLoadedOrder = useCallback((nextOrder: LoadedPaneOrder): void => {
    loadedOrderRef.current = nextOrder;
    if (nextOrder.workspaceId !== null) {
      ordersByWorkspaceRef.current.set(nextOrder.workspaceId, nextOrder);
    }
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

    const workspaceOrder = loadedOrderRef.current.workspaceId === requestedWorkspaceId
      ? loadedOrderRef.current
      : ordersByWorkspaceRef.current.get(requestedWorkspaceId) ?? {
        workspaceId: requestedWorkspaceId,
        preferredIds: [...latestOrderedSessionIdsRef.current],
        ready: false,
        pendingReplacements: [],
      };
    if (
      loadedOrderRef.current.workspaceId !== requestedWorkspaceId
      || workspaceOrder.ready
    ) {
      commitLoadedOrder({
        ...workspaceOrder,
        ready: false,
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

      const pendingReplacements = ordersByWorkspaceRef.current
        .get(requestedWorkspaceId)?.pendingReplacements
        ?? loadedOrderRef.current.pendingReplacements;
      let preferredIds = parsePaneOrder(rawOrder);
      for (const replacement of pendingReplacements) {
        let nextIds = replacePaneOrderId(
          preferredIds,
          replacement.oldId,
          replacement.newId,
        );
        if (nextIds === preferredIds) {
          const completeIds = reconcilePaneOrder(
            preferredIds,
            replacement.fallbackIds,
          );
          nextIds = replacePaneOrderId(
            completeIds,
            replacement.oldId,
            replacement.newId,
          );
        }
        preferredIds = nextIds;
      }

      commitLoadedOrder({
        workspaceId: requestedWorkspaceId,
        preferredIds,
        ready: true,
        pendingReplacements: [],
      });

      if (pendingReplacements.length > 0) {
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

  const replaceSessionId = useCallback((
    targetWorkspaceId: string,
    oldId: string,
    newId: string,
  ): boolean => {
    const isActiveWorkspace = latestWorkspaceIdRef.current === targetWorkspaceId;
    const loadedOrderMatchesTarget =
      loadedOrderRef.current.workspaceId === targetWorkspaceId;
    const canUseLiveLoadedOrder = isActiveWorkspace && loadedOrderMatchesTarget;
    const currentLoadedOrder = canUseLiveLoadedOrder
      ? loadedOrderRef.current
      : ordersByWorkspaceRef.current.get(targetWorkspaceId)
        ?? (loadedOrderMatchesTarget ? loadedOrderRef.current : undefined);
    if (!currentLoadedOrder || currentLoadedOrder.workspaceId !== targetWorkspaceId) {
      return false;
    }

    const currentOrder = canUseLiveLoadedOrder
      ? latestOrderedSessionIdsRef.current
      : currentLoadedOrder.preferredIds;
    const nextOrder = replacePaneOrderId(currentOrder, oldId, newId);
    if (nextOrder === currentOrder) {
      return false;
    }

    const ready = isActiveWorkspace
      ? latestReorderReadyRef.current
      : currentLoadedOrder.ready;
    const nextLoadedOrder: LoadedPaneOrder = {
      workspaceId: targetWorkspaceId,
      preferredIds: nextOrder,
      ready,
      pendingReplacements: ready
        ? []
        : [
          ...currentLoadedOrder.pendingReplacements,
          { oldId, newId, fallbackIds: [...currentOrder] },
        ],
    };
    if (isActiveWorkspace) {
      commitLoadedOrder(nextLoadedOrder);
    } else {
      ordersByWorkspaceRef.current.set(targetWorkspaceId, nextLoadedOrder);
    }

    if (ready) {
      persistPaneOrder(targetWorkspaceId, nextOrder);
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
