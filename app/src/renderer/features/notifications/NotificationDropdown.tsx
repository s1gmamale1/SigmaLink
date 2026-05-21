// v1.4.9 #07 — Notification dropdown panel.
// v1.5.1-C — D5 deep-link navigation implemented (caveat 6).
//
// Owns the filter-chip strip [All | This workspace | Errors only] and the
// scrollable list of items. Mark-all-read and Clear-read controls live in
// the header. Per D4, opening the dropdown does NOT auto-mark-read — the
// operator must click items or hit "Mark all read".
//
// D5 navigation routes:
//   pty-exit  → 'command' room; scroll session-history to sessionId
//   swarm-*   → 'swarm' room; scroll mailbox to messageId (via swarmId)
//   tool-error → 'sigma' room; scroll conversation to messageId
//   fallback  → current filtered notifications view (source gone)

import { CheckCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppState } from '@/renderer/app/state';
import { rpc } from '@/renderer/lib/rpc';
import type { Notification } from '@/shared/types';
import { NotificationItem } from './NotificationItem';
import { applyFilter, type FilterChip } from './helpers';

interface DropdownProps {
  onClose: () => void;
}

export function NotificationDropdown({ onClose }: DropdownProps) {
  const { state, dispatch } = useAppState();
  const [chip, setChip] = useState<FilterChip>('all');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeWorkspaceId = state.activeWorkspace?.id ?? null;

  // Close-on-outside-click. We deliberately do NOT mark-all-read on close
  // — that's an anti-pattern per D4.
  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      const el = containerRef.current;
      if (!el) return;
      if (event.target instanceof Node && !el.contains(event.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const filtered = useMemo(
    () => applyFilter(state.notifications, chip, activeWorkspaceId),
    [state.notifications, chip, activeWorkspaceId],
  );

  const handleMarkAllRead = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (rpc as any).notifications.markAllRead();
    } catch {
      /* swallow — toast already shown by rpc client */
    }
  };

  const handleClearRead = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (rpc as any).notifications.clearRead();
    } catch {
      /* swallow */
    }
  };

  /**
   * D5 deep-link navigation. Reads the notification kind + payload and
   * dispatches the appropriate SET_ROOM action. On any deep-link, also
   * marks-read. Falls back to the filtered notifications view if the source
   * pane / swarm / conversation is gone.
   */
  const handleItemClick = useCallback(
    async (notification: Notification) => {
      // Optimistic local update; the main process delta echo reconciles.
      // `Date.now()` here is inside an event-handler callback, NOT during
      // render — wrapping in useCallback satisfies the react-hooks/purity
      // lint rule which flags any impure call reachable from a render path.
      const readAt = Date.now();
      dispatch({ type: 'MARK_NOTIFICATION_READ', id: notification.id, readAt });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (rpc as any).notifications.markRead(notification.id);
      } catch {
        /* swallow */
      }

      // D5 — deep-link to the source context.
      const payload = notification.payload ?? {};
      const kind = notification.kind;

      if (kind === 'pty-exit') {
        // Navigate to command room and scroll to the session in session history.
        dispatch({ type: 'SET_ROOM', room: 'command' });
        const sessionId = payload.sessionId as string | undefined;
        if (sessionId) {
          // Emit a custom event so the CommandRoom's session-history list can
          // scroll to the target session. The event is best-effort — if the
          // CommandRoom is not mounted yet it will be ignored.
          window.dispatchEvent(
            new CustomEvent('sigma:scroll-to-session', { detail: { sessionId } }),
          );
        }
      } else if (kind === 'swarm-broadcast' || kind.startsWith('swarm')) {
        // Navigate to swarm room and scroll the mailbox to the target message.
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
        // Navigate to sigma assistant room and scroll to the target message.
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
      // For unknown kinds, fall back: keep the dropdown open on the
      // current filtered view (no navigation); the mark-read above is
      // the only side effect. This covers 'tool-error-summary', '*-summary',
      // and any future kinds not yet in the registry.

      // We do NOT close the dropdown on click — operator may want to triage
      // multiple items in sequence.
    },
    [dispatch],
  );

  const handleDismiss = async (notification: Notification) => {
    dispatch({ type: 'DISMISS_NOTIFICATION', id: notification.id });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (rpc as any).notifications.dismiss(notification.id);
    } catch {
      /* swallow */
    }
  };

  const handleMarkUnread = async (notification: Notification) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (rpc as any).notifications.markUnread(notification.id);
    } catch {
      /* swallow */
    }
  };

  return (
    <div
      ref={containerRef}
      role="menu"
      aria-label="Notifications"
      data-testid="notification-dropdown"
      className="absolute right-0 top-full z-50 mt-1 w-96 rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold tracking-tight">Notifications</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            data-testid="notification-mark-all-read"
            title="Mark all read"
          >
            <CheckCheck className="h-3 w-3" aria-hidden />
            Mark all read
          </button>
          <button
            type="button"
            onClick={handleClearRead}
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            data-testid="notification-clear-read"
            title="Clear read"
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            Clear read
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notifications"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      </header>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {(['all', 'workspace', 'errors'] as const).map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`notification-filter-${id}`}
            onClick={() => setChip(id)}
            className={cn(
              'rounded px-2 py-0.5 text-xs',
              chip === id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
          >
            {id === 'all' ? 'All' : id === 'workspace' ? 'This workspace' : 'Errors only'}
          </button>
        ))}
      </div>
      <div
        className="max-h-96 overflow-y-auto"
        data-testid="notification-list"
      >
        {filtered.length === 0 ? (
          <p
            className="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="notification-empty"
          >
            No notifications.
          </p>
        ) : (
          <ul role="list">
            {filtered.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  notification={n}
                  onClick={() => handleItemClick(n)}
                  onDismiss={() => handleDismiss(n)}
                  onMarkUnread={() => handleMarkUnread(n)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
