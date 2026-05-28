// W-6 Cluster B — Sigma→Jorvis rename: DB table + column + index.
//
// Renames:
//   sigma_pane_events        → jorvis_pane_events
//   sigma_monitor_conversation_id → jorvis_monitor_conversation_id  (on agent_sessions)
//   sigma_pane_events_conv_ts → jorvis_pane_events_conv_ts  (index recreated)
//
// better-sqlite3 / SQLite 3.25+ supports:
//   ALTER TABLE ... RENAME TO ...
//   ALTER TABLE ... RENAME COLUMN ... TO ...
//
// CROSS-SYNC CAVEAT: renaming a synced table changes the cross-machine wire
// format. A v1.10.x peer syncing 'sigma_pane_events' won't match a renamed
// peer syncing 'jorvis_pane_events'. This is an intentional coordinated
// rename acceptable for the internal-use ecosystem — no dual-table-name
// compat shim is provided.
//
// Idempotent: all operations are guarded with existence checks so running
// up() on an already-migrated DB is a no-op.

import type Database from 'better-sqlite3';

interface ColumnRow {
  name: string;
}

interface TableRow {
  name: string;
}

interface IndexRow {
  name: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).all(table) as TableRow[];
  return rows.length > 0;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
  return rows.some((r) => r.name === column);
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
  ).all(indexName) as IndexRow[];
  return rows.length > 0;
}

export const name = '0022_jorvis_pane_events_rename';

export function up(db: Database.Database): void {
  // 1. Rename table sigma_pane_events → jorvis_pane_events.
  if (tableExists(db, 'sigma_pane_events') && !tableExists(db, 'jorvis_pane_events')) {
    db.exec(`ALTER TABLE sigma_pane_events RENAME TO jorvis_pane_events`);
  }

  // 2. Drop old index (renamed table carries the old index name; recreate under new name).
  if (indexExists(db, 'sigma_pane_events_conv_ts')) {
    db.exec(`DROP INDEX sigma_pane_events_conv_ts`);
  }
  if (!indexExists(db, 'jorvis_pane_events_conv_ts')) {
    db.exec(
      `CREATE INDEX jorvis_pane_events_conv_ts ON jorvis_pane_events(conversation_id, ts DESC)`,
    );
  }

  // 3. Rename column sigma_monitor_conversation_id → jorvis_monitor_conversation_id
  //    on agent_sessions.
  if (
    tableExists(db, 'agent_sessions') &&
    columnExists(db, 'agent_sessions', 'sigma_monitor_conversation_id') &&
    !columnExists(db, 'agent_sessions', 'jorvis_monitor_conversation_id')
  ) {
    db.exec(
      `ALTER TABLE agent_sessions RENAME COLUMN sigma_monitor_conversation_id TO jorvis_monitor_conversation_id`,
    );
  }

  // 4. Remap any existing sync_state dirty rows from the old table name so
  //    they don't orphan — the CRDT engine would otherwise read from the
  //    now-renamed table and silently skip them. Guarded by sync_state
  //    existence (absent on installs that never enabled cross-machine sync).
  if (tableExists(db, 'sync_state')) {
    db.prepare(
      `UPDATE sync_state SET table_name = 'jorvis_pane_events' WHERE table_name = 'sigma_pane_events'`,
    ).run();
  }
}
