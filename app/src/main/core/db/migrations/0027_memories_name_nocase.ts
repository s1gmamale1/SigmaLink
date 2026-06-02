// P4 BUG-12 — case-insensitive note-name uniqueness for memories.
//
// Problem: `memories_ws_name_uq` is a binary (case-sensitive) unique index, so
// "Foo" and "foo" are distinct rows. But the wikilink / graph layer lowercases
// names when resolving `[[links]]`, and `findBacklinks` now matches COLLATE
// NOCASE. That mismatch means a note and its inbound links can disagree on
// identity. This migration makes the DB agree by recreating the unique index as
// (workspace_id, name COLLATE NOCASE).
//
// DEFENSIVE (H-7): a NOCASE unique index would FAIL to build if case-variant
// duplicate names already exist (e.g. both "Foo" and "foo" in one workspace) —
// and a throwing migration would crash startup. So BEFORE building the index we
// resolve collisions: for each (workspace_id, lower(name)) group with >1 row we
// keep the most-recently-`updated_at` row (tie-break: higher `id`) and rename
// the losers to "<name> (dup <id-prefix>)". The id-prefix keeps the rename
// itself collision-free and lets a human trace which row was renamed.
//
// H-7: NO db.transaction(), BEGIN, COMMIT, or ROLLBACK here — the migration
// runner (migrate.ts) already wraps each migration's up() in ONE transaction;
// a nested BEGIN throws "cannot start a transaction within a transaction" and
// crashes fresh-DB startup. Each statement below is a plain db.exec / prepared
// db.prepare(...).run(). The static guard in __tests__/migrate.spec.ts enforces
// the no-self-BEGIN rule.
//
// Idempotent: a second run finds no collisions (already resolved) and the index
// DDL is DROP IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS, so re-running is a
// no-op once the NOCASE index exists.

import type Database from 'better-sqlite3';

export const name = '0027_memories_name_nocase';

interface CollisionRow {
  id: string;
  workspace_id: string;
  name: string;
  updated_at: number;
}

export function up(db: Database.Database): void {
  // Step 1 — find every row that lives in a case-collision group. A group is
  // (workspace_id, lower(name)); we only care about groups with >1 member.
  // We fetch the members ordered so the FIRST per group is the keeper
  // (newest updated_at, then higher id) and the rest are losers to rename.
  const collisions = db
    .prepare(
      `SELECT id, workspace_id, name, updated_at
         FROM memories
        WHERE (workspace_id, lower(name)) IN (
          SELECT workspace_id, lower(name)
            FROM memories
           GROUP BY workspace_id, lower(name)
          HAVING COUNT(*) > 1
        )
        ORDER BY workspace_id ASC, lower(name) ASC, updated_at DESC, id DESC`,
    )
    .all() as CollisionRow[];

  // Step 2 — within each group keep the first row, rename the others. We rename
  // to "<name> (dup <first-8-of-id>)" which is deterministic and case-distinct
  // from the keeper, so the new NOCASE index will accept all rows.
  const rename = db.prepare(
    `UPDATE memories SET name = ?, updated_at = updated_at WHERE id = ?`,
  );
  const seen = new Set<string>();
  for (const row of collisions) {
    const groupKey = `${row.workspace_id}::${row.name.toLowerCase()}`;
    if (!seen.has(groupKey)) {
      // First (keeper) in this group — leave it alone.
      seen.add(groupKey);
      continue;
    }
    // The 8-char id suffix makes losers distinct from each other and from the
    // keeper. We assume no existing note is literally named "<name> (dup <id8>)"
    // (astronomically unlikely given the random id); if one were, the post-rename
    // set would still hold a NOCASE duplicate and the index build below would
    // throw → the runner rolls back + retries next boot (no partial state).
    const suffix = ` (dup ${row.id.slice(0, 8)})`;
    rename.run(`${row.name}${suffix}`, row.id);
  }

  // Step 3 — recreate the unique index with NOCASE collation. SQLite can't
  // alter an index in place, so drop the binary one and build the NOCASE one.
  db.exec(`DROP INDEX IF EXISTS memories_ws_name_uq;`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS memories_ws_name_uq
       ON memories(workspace_id, name COLLATE NOCASE);`,
  );

  // Step 4 — make inbound-link lookups case-insensitive at the index level too,
  // so `findBacklinks` (which now matches COLLATE NOCASE) can use an index
  // rather than a full scan. The old binary index is replaced by a NOCASE one.
  db.exec(`DROP INDEX IF EXISTS memory_links_to_idx;`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS memory_links_to_idx
       ON memory_links(to_memory_name COLLATE NOCASE);`,
  );
}
