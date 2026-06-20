// 0038 — Seed notifications.osEnabled = '1' (OS notifications default ON).
//
// os-notify.ts isEnabled() returns readKv('notifications.osEnabled') === '1'.
// Without this seed the key is absent on a fresh install → isEnabled() returns
// false → OS notifications are silently disabled even though the user never
// opted out. INSERT OR IGNORE is safe to re-run (idempotent): it skips the
// row if the key already exists (e.g. user explicitly set it to '0').
//
// H-7: the runner owns the transaction; this migration MUST NOT issue BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0038_os_notify_default_on';

export function up(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO kv (key, value, updated_at)
     VALUES ('notifications.osEnabled', '1', (unixepoch() * 1000))`,
  ).run();
}
