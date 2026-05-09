// V3-W12-016 + V3-W12-018 — first hand-rolled migration.
//
// Forward-only. Adds:
//   - swarm_messages.resolved_at INTEGER NULL — Operator Console counter
//     projection filters envelopes by `kind ∈ {…} AND resolved_at IS NULL`.
//   - swarm_agents.auto_approve INTEGER NOT NULL DEFAULT 0 — per-agent
//     auto-approve toggle exposed in RoleRoster (W12-018).
//
// SQLite `ALTER TABLE ... ADD COLUMN` is idempotent-friendly via the
// PRAGMA-based check below: we re-read the column list, so re-running the
// migration on a DB that already has the columns is a no-op. The migrations
// runner records success in `schema_migrations` regardless so future boots
// skip this step entirely.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

export const name = '0001_v3_mailbox';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'swarm_messages', 'resolved_at')) {
      db.exec('ALTER TABLE swarm_messages ADD COLUMN resolved_at INTEGER');
    }
    if (!hasColumn(db, 'swarm_agents', 'auto_approve')) {
      db.exec(
        "ALTER TABLE swarm_agents ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0",
      );
    }
    // Backfill: existing rows already get NULL / 0 from the ALTER defaults
    // above. We still issue an explicit UPDATE so the migration is observable
    // in EXPLAIN QUERY PLAN output during diagnostic runs.
    db.exec('UPDATE swarm_messages SET resolved_at = NULL WHERE resolved_at IS NULL');
    db.exec('UPDATE swarm_agents SET auto_approve = 0 WHERE auto_approve IS NULL');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
