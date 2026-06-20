// v1.4.9 #07 — Single notification row in the dropdown.
//
// Renders:
//   - Severity icon (UX-9: Info / TriangleAlert / OctagonAlert per severity)
//     alongside the colour dot so urgency is visible to colour-blind users and
//     is announced by VoiceOver via a visually-hidden severity label.
//   - Title + body + relative timestamp.
//   - Duplicate-count badge `(×N)` when N > 1.
//   - Hover controls (right side): `×` dismiss + `Mark unread` (only when
//     the row is already read).
//
// Read styling: the row dims when `readAt !== null` so the operator can
// see what's been triaged at a glance.

import { Info, TriangleAlert, OctagonAlert, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Notification, NotificationSeverity } from '@/shared/types';
import { relativeTime, severityClass } from './helpers';

interface ItemProps {
  notification: Notification;
  onClick: () => void;
  onDismiss: () => void;
  onMarkUnread: () => void;
}

// UX-9 — per-severity icon: non-colour shape cue for colour-blind users.
// Returns a rendered element (not a component reference) so callers don't
// "create a component during render" (react-hooks/static-components).
function severityIcon(severity: NotificationSeverity, className?: string) {
  switch (severity) {
    case 'info':
      return <Info className={className} />;
    case 'warn':
      return <TriangleAlert className={className} />;
    case 'error':
    case 'critical':
      return <OctagonAlert className={className} />;
  }
}

// UX-9 — human-readable severity label surfaced in the button's accessible
// name and as visually-hidden text.
function severityLabel(severity: NotificationSeverity): string {
  switch (severity) {
    case 'info':
      return 'Info';
    case 'warn':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'critical':
      return 'Critical';
  }
}

export function NotificationItem({
  notification,
  onClick,
  onDismiss,
  onMarkUnread,
}: ItemProps) {
  const isRead = notification.readAt !== null;
  const sevLabel = severityLabel(notification.severity);
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
        // UX-9 — severity word prepended to the accessible name so VoiceOver
        // announces e.g. "Critical: Process exited, Open".
        aria-label={`${sevLabel}: ${notification.title}`}
      >
        {/* UX-9 — severity glyph: visible shape cue independent of colour.
            aria-hidden because the severity word is already in the button's
            aria-label above. The visually-hidden <span> below provides the
            same text for consumers that read children rather than aria-label. */}
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center',
            severityClass(notification.severity),
          )}
        >
          {severityIcon(notification.severity, 'h-3 w-3')}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            {/* UX-9 — visually-hidden severity prefix so the label survives
                CSS resets that strip aria-label from text extraction. */}
            <span className="sr-only">{sevLabel}:</span>
            <span
              className="truncate font-medium text-foreground"
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
