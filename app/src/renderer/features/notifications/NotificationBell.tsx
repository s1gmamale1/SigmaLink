// v1.4.9 #07 — Top-right notification bell.
// UX-2 — rebuilt on the Radix Popover primitive (src/components/ui/popover).
//
// Renders a Bell icon button with the D4 badge (`unreadCount`) and pulses
// when any unread row is `critical` (D1). The bell is now the PopoverTrigger;
// the dropdown is its PopoverContent so it gets focus-trap, Escape-to-close,
// return-focus, portal, and the MOT-1 spring enter/exit for free. The
// dropdown itself is owned by `<NotificationDropdown />`.

import { Bell } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { useAppStateSelector } from '@/renderer/app/state';
import { NotificationDropdown } from './NotificationDropdown';
import { deriveBadgeState } from './helpers';

export function NotificationBell() {
  // PERF-3 — granular selectors: re-render only when the notifications list or
  // the unread count changes (not on every unrelated dispatch). Both selectors
  // return referentially-stable slices straight off the store, so the
  // useSyncExternalStore Object.is bail-out holds.
  const notifications = useAppStateSelector((s) => s.notifications);
  const notificationsUnreadCount = useAppStateSelector((s) => s.notificationsUnreadCount);
  const [open, setOpen] = useState(false);

  const { hasError, hasCritical, hasWarn } = useMemo(() => {
    let hasError = false;
    let hasCritical = false;
    let hasWarn = false;
    for (const n of notifications) {
      if (n.readAt !== null) continue;
      if (n.severity === 'critical') hasCritical = true;
      else if (n.severity === 'error') hasError = true;
      else if (n.severity === 'warn') hasWarn = true;
    }
    return { hasError, hasCritical, hasWarn };
  }, [notifications]);

  const badge = deriveBadgeState(
    notificationsUnreadCount,
    hasError,
    hasCritical,
    hasWarn,
  );

  return (
    <div className="relative" style={noDragStyle()} data-testid="notification-bell-wrapper">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={badge.label ? `Notifications (${badge.label} unread)` : 'Notifications'}
            data-testid="notification-bell"
            // D1 — critical pulses the bell button. We keep both the animated
            // `sl-bell-pulse` and a static accent companion so reduced-motion
            // operators still get an unmistakable critical signal.
            className={cn(
              'relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
              hasCritical && 'sl-bell-pulse sl-bell-critical-static',
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
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={6}
          className="w-96 border-0 bg-transparent p-0 shadow-none"
        >
          <NotificationDropdown onClose={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
