// v1.4.9 #07 — Top-right notification bell.
//
// Renders a Bell icon button with the D4 badge (`unreadCount`) and pulses
// when any unread row is `critical` (D1). Clicking toggles the dropdown.
// The dropdown is owned by `<NotificationDropdown />`; this component is
// the trigger + visible state machine.

import { Bell } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { useAppState } from '@/renderer/app/state';
import { NotificationDropdown } from './NotificationDropdown';
import { deriveBadgeState } from './helpers';

export function NotificationBell() {
  const { state } = useAppState();
  const [open, setOpen] = useState(false);

  const { hasError, hasCritical, hasWarn } = useMemo(() => {
    let hasError = false;
    let hasCritical = false;
    let hasWarn = false;
    for (const n of state.notifications) {
      if (n.readAt !== null) continue;
      if (n.severity === 'critical') hasCritical = true;
      else if (n.severity === 'error') hasError = true;
      else if (n.severity === 'warn') hasWarn = true;
    }
    return { hasError, hasCritical, hasWarn };
  }, [state.notifications]);

  const badge = deriveBadgeState(
    state.notificationsUnreadCount,
    hasError,
    hasCritical,
    hasWarn,
  );

  return (
    <div className="relative" style={noDragStyle()} data-testid="notification-bell-wrapper">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={badge.label ? `Notifications (${badge.label} unread)` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="notification-bell"
        // D1 — critical pulses the bell button.
        className={cn(
          'relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
          hasCritical && 'sl-bell-pulse',
        )}
      >
        <Bell className="h-4 w-4" aria-hidden />
        {badge.label !== null ? (
          <span
            data-testid="notification-bell-badge"
            className={cn(
              'absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none',
              badge.colorClass,
            )}
          >
            {badge.label}
          </span>
        ) : null}
      </button>
      {open ? (
        <NotificationDropdown onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
