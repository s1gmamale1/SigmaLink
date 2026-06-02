// P4.2 PERF-14 — full-text search over memories via FTS5.
//
// better-sqlite3 ships with FTS5 compiled in (verified). This migration creates
// an EXTERNAL-CONTENT FTS5 index over `memories(name, body)` so search can rank
// hits with bm25() instead of the in-process JS inverted index. The
// external-content pattern means the FTS table stores only the index — the row
// data lives in `memories` (content='memories', content_rowid='rowid'). Triggers
// keep the index in sync on INSERT / DELETE / UPDATE; on delete/update we issue
// the special `INSERT INTO memories_fts(memories_fts, rowid, ...) VALUES('delete', ...)`
// command FTS5 requires to forget the old indexed terms for external content.
//
// We populate the index from the existing rows with the FTS5 'rebuild' command
// (`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`), which reindexes
// every row of the content table — correct even when the DB already holds notes.
//
// H-7: NO db.transaction(), BEGIN, COMMIT, or ROLLBACK here — the migration
// runner (migrate.ts) already wraps each migration's up() in ONE transaction;
// a nested BEGIN throws "cannot start a transaction within a transaction" and
// crashes fresh-DB startup. Each statement below is a plain db.exec. The static
// guard in __tests__/migrate.spec.ts enforces the no-self-BEGIN rule.
//
// Idempotent: CREATE VIRTUAL TABLE / CREATE TRIGGER both use IF NOT EXISTS, and
// 'rebuild' is safe to re-run. The `down` drops the triggers + virtual table.

import type Database from 'better-sqlite3';

export const name = '0031_memory_fts5';

// `db.exec` below is the better-sqlite3 SQL runner — NOT child_process.exec.
export function up(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);

  // External-content FTS5 index over the `name` + `body` columns of `memories`.
  run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name,
      body,
      content='memories',
      content_rowid='rowid'
    )
  `);

  // Keep the index synchronized with the content table. For external-content
  // tables the AFTER DELETE / the "old" half of AFTER UPDATE must use the
  // special 'delete' command so FTS5 removes the previously-indexed terms.
  run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, body)
        VALUES (new.rowid, new.name, new.body);
    END
  `);
  run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, body)
        VALUES ('delete', old.rowid, old.name, old.body);
    END
  `);
  run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, body)
        VALUES ('delete', old.rowid, old.name, old.body);
      INSERT INTO memories_fts(rowid, name, body)
        VALUES (new.rowid, new.name, new.body);
    END
  `);

  // Populate the index from existing rows (no-op on a fresh DB; reindexes the
  // whole content table when notes already exist).
  run(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
}

export function down(db: Database.Database): void {
  const run = (sql: string) => db.exec(sql);
  run(`DROP TRIGGER IF EXISTS memories_fts_au`);
  run(`DROP TRIGGER IF EXISTS memories_fts_ad`);
  run(`DROP TRIGGER IF EXISTS memories_fts_ai`);
  run(`DROP TABLE IF EXISTS memories_fts`);
}
