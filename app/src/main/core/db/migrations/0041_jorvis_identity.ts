// 0041 — Jorvis persistent identity: jorvis_memory (+ FTS5) and jorvis_amendments.
//
// Phase 21 (P2) data layer. `jorvis_memory` is Jorvis's durable long-term
// memory (facts / playbooks / preferences / postmortems), searched via an
// external-content FTS5 index exactly like `memories` / `memories_fts`
// (migration 0031) — this is a clone of that trigger/rebuild idiom,
// substituting table `jorvis_memory` and the (title, body) columns for
// (name, body). `jorvis_amendments` holds self-proposed charter amendments
// that only take effect once an operator approves them (P2 design decision
// D6) — no CHECK constraints on `kind`/`status` here; those unions are
// validated at the app layer (zod tool schemas, P2 Task 3).
//
// LOCAL-ONLY, like the P1a mission tables (0039_missions) — deliberately NOT
// added to the sync engine's allowlist (`core/sync/dirty-tracker.ts`
// SYNCED_TABLES / `core/sync/engine.ts` COLUMN_ALLOWLIST). Operator-private
// memory (P2 design decision D5) stays per-machine. Grepping `mission_events`
// under `core/sync/` turns up nothing — the P1a mission tables were never
// registered there — and the same is true of `memories_fts` (the FTS5
// virtual table sibling of the already-synced `memories` table is also
// absent from both allowlists). Both absences are mirrored here exactly: no
// edits to dirty-tracker.ts / engine.ts for jorvis_memory, jorvis_memory_fts,
// or jorvis_amendments.
//
// H-7: the runner owns the transaction; this migration MUST NOT issue
// BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0041_jorvis_identity';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jorvis_memory (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      workspace_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS jorvis_memory_kind_idx ON jorvis_memory(kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS jorvis_memory_ws_idx ON jorvis_memory(workspace_id)`);

  // External-content FTS5 index over (title, body) — clone of 0031_memory_fts5
  // substituting table jorvis_memory for memories and (title, body) for (name, body).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS jorvis_memory_fts USING fts5(
      title,
      body,
      content='jorvis_memory',
      content_rowid='rowid'
    )
  `);

  // Keep the index synchronized with the content table. For external-content
  // tables the AFTER DELETE / the "old" half of AFTER UPDATE must use the
  // special 'delete' command so FTS5 removes the previously-indexed terms.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_ai AFTER INSERT ON jorvis_memory BEGIN
      INSERT INTO jorvis_memory_fts(rowid, title, body)
        VALUES (new.rowid, new.title, new.body);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_ad AFTER DELETE ON jorvis_memory BEGIN
      INSERT INTO jorvis_memory_fts(jorvis_memory_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS jorvis_memory_fts_au AFTER UPDATE ON jorvis_memory BEGIN
      INSERT INTO jorvis_memory_fts(jorvis_memory_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO jorvis_memory_fts(rowid, title, body)
        VALUES (new.rowid, new.title, new.body);
    END
  `);

  // Populate the index from existing rows (no-op on a fresh DB; reindexes the
  // whole content table when rows already exist).
  db.exec(`INSERT INTO jorvis_memory_fts(jorvis_memory_fts) VALUES ('rebuild')`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jorvis_amendments (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      decision_reason TEXT,
      proposed_at INTEGER NOT NULL,
      decided_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS jorvis_amendments_status_idx ON jorvis_amendments(status)`);

  // KV seed (0040 DEFAULTS idiom): empty path means "use the vendored bundled
  // charter" (P2 Task 4's loadJorvisCharter fails-soft to the bundled default
  // when this key is absent/empty). INSERT OR IGNORE is safe to re-run — it
  // skips the row once the key already exists (e.g. an operator has set a
  // custom charter path).
  db.prepare(
    `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, (unixepoch() * 1000))`,
  ).run('jorvis.charter.path', '');
}
