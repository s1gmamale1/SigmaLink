export const PANE_ORDER_VERSION = 1 as const;

export interface PersistedPaneOrderV1 {
  version: typeof PANE_ORDER_VERSION;
  sessionIds: string[];
}

export function parsePaneOrder(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || parsed.version !== PANE_ORDER_VERSION
    || !Array.isArray(parsed.sessionIds)
  ) {
    return [];
  }

  const ids = new Set<string>();
  for (const id of parsed.sessionIds) {
    if (typeof id === 'string' && id !== '') {
      ids.add(id);
    }
  }

  return [...ids];
}

export function serializePaneOrder(sessionIds: readonly string[]): string {
  return JSON.stringify({ version: PANE_ORDER_VERSION, sessionIds });
}

export function reconcilePaneOrder(
  preferredIds: readonly string[],
  liveIds: readonly string[],
): string[] {
  const liveIdSet = new Set(liveIds);
  const order: string[] = [];
  const includedIds = new Set<string>();

  for (const id of preferredIds) {
    if (liveIdSet.has(id) && !includedIds.has(id)) {
      order.push(id);
      includedIds.add(id);
    }
  }

  for (const id of liveIds) {
    if (!includedIds.has(id)) {
      order.push(id);
      includedIds.add(id);
    }
  }

  return order;
}

export function swapPaneIds(
  order: string[],
  sourceId: string,
  targetId: string,
): string[] {
  if (sourceId === targetId) {
    return order;
  }

  const sourceIndex = order.indexOf(sourceId);
  const targetIndex = order.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return order;
  }

  const nextOrder = [...order];
  nextOrder[sourceIndex] = targetId;
  nextOrder[targetIndex] = sourceId;
  return nextOrder;
}

export function replacePaneOrderId(
  order: string[],
  oldId: string,
  newId: string,
): string[] {
  const oldIndex = order.indexOf(oldId);
  if (oldIndex === -1 || oldId === newId || newId === '' || order.includes(newId)) {
    return order;
  }

  const nextOrder = [...order];
  nextOrder[oldIndex] = newId;
  return nextOrder;
}
