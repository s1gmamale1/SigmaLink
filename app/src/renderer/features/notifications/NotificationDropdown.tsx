// v1.4.9 #07 — Notification dropdown panel.
// v1.5.1-C — D5 deep-link navigation implemented (caveat 6).
// UX-2 — rebuilt as the body of a Radix PopoverContent (owned by
//   NotificationBell). Dismissal — outside-click, Escape, return-focus — is
//   now handled by the Popover primitive, so the old manual mousedown-outside
//   listener is gone. This is no longer a self-positioned surface; it renders
//   the header / filter chips / scrollable list inside the portal'd content.
//   ARIA fixed: `role="dialog"` labelled "Notifications" with a `role="list"`
//   item list (the old `role="menu"` with non-menuitem children was a
//   mismatch). The `onClose` prop closes the controlling Popover.
//
// Owns the filter-chip strip [All | This workspace | Errors only] and the
// scrollable list of items. Mark-all-read and Clear-read controls live in
// the header. Per D4, opening the dropdown does NOT auto-mark-read — the
// operator must click items or hit "Mark all read".
//
// P3 / NTF-2 — the filtered list is now bucketed by source (`groupBySource`)
// into collapsible sections rendered in the canonical NOTIFICATION_SOURCES
// order. Each section header shows the source label + an unread count + a
// collapse chevron (collapsed state is local; default all expanded). Rows
// keep their created-desc order inside a section. Sections + rows fade in
// (reduced-motion-safe `sl-fade-in`) so new arrivals settle rather than pop.
//
// D5 navigation routes (extracted to the shared `navigateToNotification`
// helper so the toast "View" action in `use-live-events.ts` reuses it):
//   pty-exit  → 'command' room; scroll session-history to sessionId
//   swarm-*   → 'swarm' room; scroll mailbox to messageId (via swarmId)
//   tool-error → 'jorvis' room; scroll conversation to messageId
//   fallback  → current filtered notifications view (source gone)

import { CheckCheck, ChevronRight, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppState } from '@/renderer/app/state';
import { rpc } from '@/renderer/lib/rpc';
import type { NotificationSource } from '@/shared/notification-prefs';
import type { Notification } from '@/shared/types';
import { NotificationItem } from './NotificationItem';
import { applyFilter, groupBySource, navigateToNotification, type FilterChip } from './helpers';

interface DropdownProps {
  onClose: () => void;
}

export function NotificationDropdown({ onClose }: DropdownProps) {
  const { state, dispatch } = useAppState();
  const [chip, setChip] = useState<FilterChip>('all');
  // NTF-2 — sections collapsed by the operator. Default: empty = all expanded.
  const [collapsed, setCollapsed] = useState<Set<NotificationSource>>(new Set());
  const activeWorkspaceId = state.activeWorkspace?.id ?? null;

  const filtered = useMemo(
    () => applyFilter(state.notifications, chip, activeWorkspaceId),
    [state.notifications, chip, activeWorkspaceId],
  );

  // NTF-2 — bucket the filtered list by source into collapsible sections, in
  // the canonical NOTIFICATION_SOURCES order (empty sections omitted).
  const groups = useMemo(() => groupBySource(filtered), [filtered]);

  const toggleSection = useCallback((source: NotificationSource) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

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
   * D5 deep-link navigation. Marks-read (optimistic) then delegates the
   * room-routing to the shared {@link navigateToNotification} helper (DRY with
   * the toast "View" action in `use-live-events.ts`). Falls back to the current
   * filtered view if the source pane / swarm / conversation is gone (the helper
   * simply does not navigate for unknown kinds).
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

      // D5 — deep-link to the source context (shared with the toast handoff).
      navigateToNotification(notification, dispatch);

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
      role="dialog"
      aria-label="Notifications"
      data-testid="notification-dropdown"
      // The Popover (in NotificationBell) owns positioning, the portal,
      // focus-trap, Escape, and the MOT-1 spring; its PopoverContent is made
      // transparent/border-less so THIS panel is the single rendered surface
      // (avoids the double-glass + doubled blur on the glass theme). `sl-glass`
      // tints it on the glass theme (SF-4) + `relative` anchors the specular
      // ::before; `bg-popover` supplies the solid surface on non-glass themes.
      className="sl-glass relative overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
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
        {groups.length === 0 ? (
          <p
            className="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="notification-empty"
          >
            No notifications.
          </p>
        ) : (
          // NTF-2 — grouped collapsible sections in NOTIFICATION_SOURCES order.
          // Each section is a sl-fade-in (reduced-motion-safe) so a freshly
          // appearing source settles in rather than popping.
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.source);
            return (
              <section
                key={group.source}
                data-testid={`notification-section-${group.source}`}
                className="sl-fade-in border-b border-border last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => toggleSection(group.source)}
                  data-testid={`notification-section-toggle-${group.source}`}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-1.5 bg-muted/30 px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'h-3 w-3 shrink-0 transition-transform',
                      !isCollapsed && 'rotate-90',
                    )}
                  />
                  <span className="flex-1 truncate normal-case">{group.label}</span>
                  {group.unreadCount > 0 ? (
                    <span
                      className="rounded bg-muted px-1 text-[10px] tabular-nums text-foreground"
                      data-testid={`notification-section-count-${group.source}`}
                    >
                      {group.unreadCount}
                    </span>
                  ) : null}
                </button>
                {isCollapsed ? null : (
                  <ul role="list">
                    {group.items.map((n) => (
                      <li key={n.id} className="sl-fade-in">
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
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
