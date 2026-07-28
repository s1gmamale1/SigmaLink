import type {
  Notification,
  NotificationChangeSet,
  NotificationCounts,
  NotificationPage,
  NotificationSnapshot,
} from '../../shared/types';

const NOTIFICATION_SEVERITIES = new Set<Notification['severity']>([
  'info',
  'warn',
  'error',
  'critical',
]);

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

function isNonNegativeSafeInteger(raw: unknown): raw is number {
  return Number.isSafeInteger(raw) && (raw as number) >= 0;
}

function parseNotification(raw: unknown): Notification | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== 'string' ||
    !(raw.workspaceId === null || typeof raw.workspaceId === 'string') ||
    typeof raw.kind !== 'string' ||
    !NOTIFICATION_SEVERITIES.has(raw.severity as Notification['severity']) ||
    typeof raw.title !== 'string' ||
    !(raw.body === null || typeof raw.body === 'string') ||
    !(raw.payload === null || isRecord(raw.payload)) ||
    !(raw.sourceEvent === null || typeof raw.sourceEvent === 'string') ||
    typeof raw.dedupKey !== 'string' ||
    !Number.isSafeInteger(raw.dupCount) ||
    (raw.dupCount as number) < 1 ||
    !isNonNegativeSafeInteger(raw.createdAt) ||
    !(raw.readAt === null || isNonNegativeSafeInteger(raw.readAt))
  ) {
    return null;
  }
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    kind: raw.kind,
    severity: raw.severity as Notification['severity'],
    title: raw.title,
    body: raw.body,
    payload: raw.payload,
    sourceEvent: raw.sourceEvent,
    dedupKey: raw.dedupKey,
    dupCount: raw.dupCount as number,
    createdAt: raw.createdAt,
    readAt: raw.readAt,
  };
}

function parseNotificationRows(raw: unknown): Notification[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: Notification[] = [];
  for (const candidate of raw) {
    const row = parseNotification(candidate);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function parseNotificationCounts(raw: unknown): NotificationCounts | null {
  if (!isRecord(raw)) return null;
  const value = raw as {
    unread?: unknown;
    unreadBySeverity?: unknown;
  };
  if (!Number.isSafeInteger(value.unread) || (value.unread as number) < 0) {
    return null;
  }
  if (!isRecord(value.unreadBySeverity)) {
    return null;
  }
  const severities = value.unreadBySeverity as Record<string, unknown>;
  let severityTotal = 0;
  for (const severity of ['info', 'warn', 'error', 'critical'] as const) {
    const count = severities[severity];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
    severityTotal += count as number;
  }
  if (severityTotal !== value.unread) return null;
  return value as NotificationCounts;
}

export function parseNotificationPage(raw: unknown): NotificationPage | null {
  if (!isRecord(raw)) return null;
  const items = parseNotificationRows(raw.items);
  if (!items || !(raw.nextCursor === null || typeof raw.nextCursor === 'string')) {
    return null;
  }
  return { items, nextCursor: raw.nextCursor };
}

export function parseNotificationChangeSet(raw: unknown): NotificationChangeSet | null {
  if (!isRecord(raw)) return null;
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) {
    return null;
  }
  const counts = parseNotificationCounts(raw.counts);
  const added = parseNotificationRows(raw.added);
  const updated = parseNotificationRows(raw.updated);
  if (
    !counts ||
    !added ||
    !updated ||
    !Array.isArray(raw.removed) ||
    raw.removed.some((id) => typeof id !== 'string') ||
    !isNonNegativeSafeInteger(raw.unreadCount) ||
    raw.unreadCount !== counts.unread
  ) {
    return null;
  }
  return {
    revision: raw.revision as number,
    added,
    updated,
    removed: raw.removed as string[],
    counts,
    unreadCount: counts.unread,
  };
}

export function parseNotificationSnapshot(raw: unknown): NotificationSnapshot | null {
  if (!isRecord(raw)) return null;
  const page = parseNotificationPage(raw);
  const counts = parseNotificationCounts(raw.counts);
  if (
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !counts ||
    !page
  ) {
    return null;
  }
  return {
    revision: raw.revision as number,
    counts,
    ...page,
  };
}
