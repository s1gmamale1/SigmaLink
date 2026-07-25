// v1.4.9 #07 — Top-right notification bell.
// UX-2 — rebuilt on the Radix Popover primitive (src/components/ui/popover).
//
// Renders a Bell icon button with the D4 badge and pulses when authoritative
// counts report any unread `critical` row (D1), including off-page rows. The
// bell is now the PopoverTrigger;
// the dropdown is its PopoverContent so it gets focus-trap, Escape-to-close,
// return-focus, portal, and the MOT-1 spring enter/exit for free. The
// dropdown itself is owned by `<NotificationDropdown />`.

import { Bell } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { noDragStyle } from '@/renderer/lib/drag-region';
import { useAppStateSelector } from '@/renderer/app/state';
import { NotificationDropdown } from './NotificationDropdown';
import { deriveBadgeState } from './helpers';

export function NotificationBell() {
  // Counts cover every retained row, including critical notifications outside
  // the currently loaded page. Deriving urgency from rendered rows made the
  // bell silently downgrade as soon as a critical row moved off-page.
  const notificationCounts = useAppStateSelector((s) => s.notificationCounts);
  const [open, setOpen] = useState(false);

  const hasCritical = notificationCounts.unreadBySeverity.critical > 0;
  const hasError = notificationCounts.unreadBySeverity.error > 0;
  const hasWarn = notificationCounts.unreadBySeverity.warn > 0;

  const badge = deriveBadgeState(
    notificationCounts.unread,
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
