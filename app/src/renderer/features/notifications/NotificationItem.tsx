// v1.4.9 #07 — Single notification row in the dropdown.
//
// Renders:
//   - Severity dot (D1 colour palette: gray info / amber warn / red error /
//     pulsing red critical).
//   - Title + body + relative timestamp.
//   - Duplicate-count badge `(×N)` when N > 1.
//   - Hover controls (right side): `×` dismiss + `Mark unread` (only when
//     the row is already read).
//
// Read styling: the row dims when `readAt !== null` so the operator can
// see what's been triaged at a glance.

import { CircleDot, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Notification } from '@/shared/types';
import { relativeTime, severityClass } from './helpers';

interface ItemProps {
  notification: Notification;
  onClick: () => void;
  onDismiss: () => void;
  onMarkUnread: () => void;
}

export function NotificationItem({
  notification,
  onClick,
  onDismiss,
  onMarkUnread,
}: ItemProps) {
  const isRead = notification.readAt !== null;
  const isCritical = notification.severity === 'critical';
  return (
    <div
      className={cn(
        'group relative flex items-start gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0',
        isRead ? 'opacity-60' : '',
      )}
      data-testid={`notification-item-${notification.id}`}
      data-severity={notification.severity}
      data-read={isRead ? '1' : '0'}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 items-start gap-2 text-left hover:opacity-80"
        aria-label={`Open ${notification.title}`}
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center',
            severityClass(notification.severity),
          )}
        >
          <CircleDot className="h-3 w-3" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                'truncate font-medium text-foreground',
                isCritical && 'sl-bell-pulse',
              )}
            >
              {notification.title}
            </span>
            {notification.dupCount > 1 ? (
              <span
                className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                data-testid={`notification-dup-${notification.id}`}
              >
                ×{notification.dupCount}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {relativeTime(notification.createdAt)}
            </span>
          </span>
          {notification.body ? (
            <span className="truncate text-muted-foreground">{notification.body}</span>
          ) : null}
        </span>
      </button>
      <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-hover:flex">
        {isRead ? (
          <button
            type="button"
            onClick={onMarkUnread}
            aria-label="Mark unread"
            data-testid={`notification-mark-unread-${notification.id}`}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            title="Mark unread"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid={`notification-dismiss-${notification.id}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
