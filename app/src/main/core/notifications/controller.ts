// v1.4.9 #07 — notifications RPC controller. Maps `notifications.*` channels
// onto NotificationsManager. The manager owns the IPC delta broadcast — the
// controller only forwards CRUD calls; the renderer subscribes to the delta
// event independently via `useLiveEvents`.

import { defineController } from '../../../shared/rpc';
import type { Notification, NotificationSeverity } from '../../../shared/types';
import type { NotificationsManager } from './manager';

interface ListInput {
  limit?: number;
  offset?: number;
  workspaceId?: string | null;
  severities?: NotificationSeverity[];
}

export interface NotificationsControllerDeps {
  /** 2026-07-03 (review medium #4) — OS delivery self-check; returns whether
   *  the native show() call succeeded. Wired to OsNotifier.notifyTest. */
  osTest?: () => boolean;
}

export function buildNotificationsController(
  manager: NotificationsManager,
  deps: NotificationsControllerDeps = {},
) {
  return defineController({
    list: async (input?: ListInput): Promise<Notification[]> => {
      return manager.list(input ?? {});
    },
    unreadCount: async (): Promise<number> => {
      return manager.unreadCount();
    },
    markRead: async (id: string): Promise<void> => {
      if (typeof id !== 'string' || !id) {
        throw new Error('notifications.markRead: id required');
      }
      manager.markRead(id);
    },
    markAllRead: async (): Promise<void> => {
      manager.markAllRead();
    },
    markUnread: async (id: string): Promise<void> => {
      if (typeof id !== 'string' || !id) {
        throw new Error('notifications.markUnread: id required');
      }
      manager.markUnread(id);
    },
    dismiss: async (id: string): Promise<void> => {
      if (typeof id !== 'string' || !id) {
        throw new Error('notifications.dismiss: id required');
      }
      manager.dismiss(id);
    },
    clearRead: async (): Promise<{ removed: string[] }> => {
      const removed = manager.clearRead();
      return { removed };
    },
    osTest: async (): Promise<{ shown: boolean }> => {
      return { shown: deps.osTest ? deps.osTest() : false };
    },
  });
}
