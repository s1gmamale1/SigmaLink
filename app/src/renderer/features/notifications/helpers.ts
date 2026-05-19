// v1.4.9 #07 — Pure helpers shared by the notification bell, dropdown, and
// item components. Extracted into a standalone module so each .tsx file
// satisfies `react-refresh/only-export-components` (only the component is
// exported from the .tsx file; helpers live here).
//
// All functions here are PURE — no React, no DOM, no RPC. The tests in
// `NotificationBell.test.tsx`, `NotificationDropdown.test.tsx`, and
// `NotificationItem.test.tsx` import them directly.

import type { Notification, NotificationSeverity } from '@/shared/types';

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
      return 'text-red-500 sl-bell-pulse';
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
