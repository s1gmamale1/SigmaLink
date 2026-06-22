// v1.4.9 #07 — Pure helpers shared by the notification bell, dropdown, and
// item components. Extracted into a standalone module so each .tsx file
// satisfies `react-refresh/only-export-components` (only the component is
// exported from the .tsx file; helpers live here).
//
// Most functions here are PURE — no React, no DOM, no RPC (the tests in
// `NotificationBell.test.tsx`, `NotificationDropdown.test.tsx`, and
// `NotificationItem.test.tsx` import them directly). The lone exception is
// `navigateToNotification` (P3 / NTF-2): the D5 deep-link routing was lifted
// out of the dropdown so the toast↔bell handoff (`use-live-events.ts`) can
// reuse the exact same navigation. It dispatches reducer actions + best-effort
// `window` scroll events, so it is NOT pure — but it is only ever invoked from
// an event handler (click / toast action), never during render.

import type { Dispatch } from 'react';
import type { Action } from '@/renderer/app/state.types';
import type { Notification, NotificationSeverity } from '@/shared/types';
import {
  NOTIFICATION_SOURCES,
  notificationSource,
  type NotificationSource,
} from '@/shared/notification-prefs';

export type FilterChip = 'all' | 'workspace' | 'errors';

/** D4 — bell badge math. Returns the visible label (null = no badge) and
 *  the tailwind colour class for the bullet.
 *
 *  Colour rules:
 *    - Any unread `error` or `critical` → red.
 *    - Otherwise any unread `warn` → amber.
 *    - Otherwise (only info unread) → muted-foreground gray.
 */
export function deriveBadgeState(
  unreadCount: number,
  hasError: boolean,
  hasCritical: boolean,
  hasWarn: boolean,
): { label: string | null; colorClass: string } {
  if (unreadCount <= 0) return { label: null, colorClass: '' };
  const label = unreadCount >= 10 ? '9+' : String(unreadCount);
  if (hasError || hasCritical) {
    return { label, colorClass: 'bg-red-500 text-white' };
  }
  if (hasWarn) {
    return { label, colorClass: 'bg-amber-500 text-white' };
  }
  return { label, colorClass: 'bg-muted-foreground text-background' };
}

/** Filter the dropdown's row list per the active filter chip. */
export function applyFilter(
  notifications: Notification[],
  chip: FilterChip,
  workspaceId: string | null,
): Notification[] {
  switch (chip) {
    case 'all':
      return notifications;
    case 'workspace':
      if (!workspaceId) return notifications;
      // Include the active workspace's rows AND global (null workspace_id) rows.
      return notifications.filter(
        (n) => n.workspaceId === workspaceId || n.workspaceId === null,
      );
    case 'errors':
      // Per Open Q3 resolution — "Errors only" includes critical.
      return notifications.filter(
        (n) => n.severity === 'error' || n.severity === 'critical',
      );
  }
}

/** D1 — severity → tailwind colour class for the row's leading dot. */
export function severityClass(severity: NotificationSeverity): string {
  switch (severity) {
    case 'info':
      return 'text-muted-foreground';
    case 'warn':
      return 'text-amber-500';
    case 'error':
      return 'text-red-500';
    case 'critical':
      return 'text-red-500';
  }
}

/** Coarse-grained relative-time formatter for the row timestamp. The dropdown
 *  re-renders cheaply on every NOTIFICATIONS_DELTA so a wall-clock now() in
 *  here is fine; the result is interpolated into a string and never compared
 *  for equality. */
export function relativeTime(ts: number, nowFn: () => number = Date.now): string {
  const diff = nowFn() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** NTF-2 — a collapsible source section in the dropdown. */
export interface SourceGroup {
  source: NotificationSource;
  label: string;
  items: Notification[];
  /** Unread (readAt == null) rows in this section — drives the header count. */
  unreadCount: number;
}

/**
 * NTF-2 — bucket the (already-filtered, already created-desc-sorted) list by
 * coarse {@link notificationSource}. Sections come back in the canonical
 * {@link NOTIFICATION_SOURCES} order; empty sections are omitted. Within a
 * section the caller's incoming order is preserved (created-desc), so we do
 * NOT re-sort here.
 */
export function groupBySource(notifications: Notification[]): SourceGroup[] {
  const byId = new Map<NotificationSource, Notification[]>();
  for (const n of notifications) {
    const src = notificationSource(n.kind);
    const bucket = byId.get(src);
    if (bucket) bucket.push(n);
    else byId.set(src, [n]);
  }
  const groups: SourceGroup[] = [];
  for (const { id, label } of NOTIFICATION_SOURCES) {
    const items = byId.get(id);
    if (!items || items.length === 0) continue;
    groups.push({
      source: id,
      label,
      items,
      unreadCount: items.reduce((acc, n) => acc + (n.readAt == null ? 1 : 0), 0),
    });
  }
  return groups;
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

/**
 * P3 — highest severity across a (non-empty) set of rows. Returns `null` for an
 * empty input so callers can short-circuit (no rows → no tone / toast).
 */
export function maxSeverity(notifications: Notification[]): NotificationSeverity | null {
  let best: NotificationSeverity | null = null;
  for (const n of notifications) {
    if (best === null || SEVERITY_RANK[n.severity] > SEVERITY_RANK[best]) {
      best = n.severity;
    }
  }
  return best;
}

/**
 * D5 deep-link navigation, lifted out of `NotificationDropdown` (P3 / NTF-2) so
 * the toast "View" action reuses the identical routing. Marks-read is the
 * caller's concern (the dropdown does it optimistically; the toast leaves the
 * bell row unread until the operator opens it) — this only does the routing:
 *
 *   pty-exit  → 'command' room; scroll session-history to sessionId
 *   swarm-*   → 'swarm' room; scroll mailbox to messageId (via swarmId)
 *   tool-error → 'jorvis' room; scroll conversation to messageId
 *   fallback  → no navigation (source pane / swarm / conversation gone)
 *
 * Best-effort: the `window` scroll events are ignored if the target surface is
 * not mounted. Not pure (dispatch + DOM) — call only from event handlers.
 */
export function navigateToNotification(
  notification: Notification,
  dispatch: Dispatch<Action>,
): void {
  const payload = notification.payload ?? {};
  const kind = notification.kind;

  if (kind === 'pty-exit') {
    dispatch({ type: 'SET_ROOM', room: 'command' });
    const sessionId = payload.sessionId as string | undefined;
    if (sessionId) {
      window.dispatchEvent(
        new CustomEvent('sigma:scroll-to-session', { detail: { sessionId } }),
      );
    }
  } else if (kind === 'swarm-broadcast' || kind.startsWith('swarm')) {
    dispatch({ type: 'SET_ROOM', room: 'swarm' });
    const swarmId = payload.swarmId as string | undefined;
    const messageId = payload.messageId as string | undefined;
    if (swarmId) {
      dispatch({ type: 'SET_ACTIVE_SWARM', id: swarmId });
    }
    if (messageId) {
      window.dispatchEvent(
        new CustomEvent('sigma:scroll-to-swarm-message', { detail: { messageId, swarmId } }),
      );
    }
  } else if (kind === 'tool-error') {
    dispatch({ type: 'SET_ROOM', room: 'jorvis' });
    const conversationId = payload.conversationId as string | undefined;
    const messageId = payload.messageId as string | undefined;
    if (conversationId || messageId) {
      window.dispatchEvent(
        new CustomEvent('sigma:scroll-to-message', {
          detail: { conversationId, messageId },
        }),
      );
    }
  }
  // Unknown kinds (e.g. '*-summary') intentionally do not navigate.
}
