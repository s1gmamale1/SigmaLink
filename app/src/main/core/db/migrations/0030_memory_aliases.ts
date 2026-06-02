// P4.2 MEM-5 — note aliases.
//
// The wikilink parser already extracts `[[Target|Alias]]` aliases and the
// frontmatter cache (`frontmatter_json`) already stores an `aliases: [...]`
// array, but nothing ever indexed or resolved them. This migration adds a
// dedicated `aliases_json TEXT` column on `memories` so the upsert path can
// cache the parsed frontmatter aliases (filtered to strings) and the
// link/backlink/graph layers can resolve a wikilink to a note by alias.
//
// H-7: NO db.transaction(), BEGIN, COMMIT, or ROLLBACK here — the migration
// runner (migrate.ts) already wraps each migration's up() in ONE transaction;
// a nested BEGIN throws "cannot start a transaction within a transaction" and
// crashes fresh-DB startup. Each statement below is a plain db.exec / prepared
// db.prepare(...).run(). The static guard in __tests__/migrate.spec.ts enforces
// the no-self-BEGIN rule.
//
// Idempotent: the ADD COLUMN is guarded by a PRAGMA table_info check so a
// second run is a no-op (SQLite has no `ADD COLUMN IF NOT EXISTS`). The `down`
// is best-effort (SQLite cannot DROP COLUMN before 3.35; we leave the column in
// place on rollback since it is nullable and harmless).

import type Database from 'better-sqlite3';

export const name = '0030_memory_aliases';

interface TableInfoRow {
  name: string;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  // `table` is a static literal here, never user input, so this PRAGMA is safe.
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return cols.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  if (!hasColumn(db, 'memories', 'aliases_json')) {
    db.exec(`ALTER TABLE memories ADD COLUMN aliases_json TEXT`);
  }
}

export function down(): void {
  // No-op: SQLite cannot DROP COLUMN on the versions we target, and the column
  // is nullable + ignored by older code, so leaving it is safe on rollback.
}
