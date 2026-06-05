// 0033 — Add closed_at soft-delete column to browser_tabs.
//
// Root cause (DEV-2): closeTab hard-deleted rows, so Recents only showed
// open tabs. With this migration, closed_at (epoch-ms) marks a tab as closed
// while keeping the row for the Recents list. NULL = open.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue its own
// BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0033_browser_tabs_closed_at';

export function up(db: Database.Database): void {
  // Nullable INTEGER: NULL = open; epoch-ms = closed (DEV-2).
  db.exec(`ALTER TABLE browser_tabs ADD COLUMN closed_at INTEGER`);
  // Composite index for the listRecents query:
  //   WHERE workspace_id = ? AND closed_at IS NOT NULL
  //   ORDER BY last_visited_at DESC
  db.exec(
    `CREATE INDEX IF NOT EXISTS browser_tabs_recents_idx` +
      ` ON browser_tabs (workspace_id, closed_at, last_visited_at)`,
  );
}
