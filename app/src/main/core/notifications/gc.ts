// v1.4.9 #07 — Boot-time notifications GC. Runs once at app start (D2 TTL of
// 30 days on read rows). The lead default chose "always run on boot" — cheap
// (one indexed scan + DELETE) and self-documenting; we don't gate on
// `notifications.count > 0` because the gating check itself costs the same
// indexed scan it skips.
//
// Returns the count of rows dropped so the boot path can log a single
// summary line in dev. Production swallows the count.

import type { NotificationsManager } from './manager';

export function runBootNotificationsGc(manager: NotificationsManager): number {
  try {
    const removed = manager.gc();
    return removed.length;
  } catch {
    // GC is best-effort; never block the app boot on a stale DB scan.
    return 0;
  }
}
