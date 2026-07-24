import { describe, expect, it, vi } from 'vitest';
import type {
  NotificationPage,
  NotificationSnapshot,
} from '../../../shared/types';
import { buildNotificationsController } from './controller';
import type { NotificationsManager } from './manager';

describe('notifications RPC snapshot/page controller', () => {
  it('forwards snapshot options and returns the manager snapshot', async () => {
    const expected: NotificationSnapshot = {
      revision: 7,
      counts: {
        unread: 1,
        unreadBySeverity: { info: 0, warn: 0, error: 0, critical: 1 },
      },
      items: [],
      nextCursor: null,
    };
    const snapshot = vi.fn(() => expected);
    const controller = buildNotificationsController({
      snapshot,
    } as unknown as NotificationsManager);

    await expect(
      controller.snapshot({
        limit: 25,
        workspaceId: 'ws-1',
        severities: ['error', 'critical'],
      }),
    ).resolves.toBe(expected);
    expect(snapshot).toHaveBeenCalledWith({
      limit: 25,
      workspaceId: 'ws-1',
      severities: ['error', 'critical'],
    });
  });

  it('forwards page options and returns the manager page', async () => {
    const expected: NotificationPage = { items: [], nextCursor: null };
    const page = vi.fn(() => expected);
    const controller = buildNotificationsController({
      page,
    } as unknown as NotificationsManager);

    await expect(
      controller.page({ cursor: 'cursor-1', limit: 25 }),
    ).resolves.toBe(expected);
    expect(page).toHaveBeenCalledWith({ cursor: 'cursor-1', limit: 25 });
  });
});
