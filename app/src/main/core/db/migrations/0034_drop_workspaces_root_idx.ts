// 0034 — Drop the unique index on workspaces.root_path.
//
// Root cause (DEV-W3a): the schema enforced 1 workspace per directory via
// `workspaces_root_idx` (UNIQUE on root_path). Two distinct workspaces sharing
// one directory (disambiguated by custom name — DEV-W2) was therefore blocked.
// This migration drops the unique constraint and replaces it with a non-unique
// index so rootPath lookups remain fast without the uniqueness restriction.
//
// Reverse note: re-adding the unique index requires deduplicating existing rows
// first (any rootPath appearing more than once would violate the constraint).
//
// H-7: the runner owns the transaction; this migration MUST NOT issue its own
// BEGIN/COMMIT.

import type Database from 'better-sqlite3';

export const name = '0034_drop_workspaces_root_idx';

export function up(db: Database.Database): void {
  // DEV-W3a — allow >1 workspace per directory (disambiguated by custom name).
  db.exec(`DROP INDEX IF EXISTS workspaces_root_idx`);
  // Keep a non-unique index so rootPath lookups stay fast.
  db.exec(
    `CREATE INDEX IF NOT EXISTS workspaces_root_lookup_idx ON workspaces (root_path)`,
  );
}
