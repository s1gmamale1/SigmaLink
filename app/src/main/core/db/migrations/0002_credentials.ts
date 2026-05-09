// V3-W12 / closes A5 — credentials table migration.
//
// Registered in `core/db/migrate.ts` `ALL_MIGRATIONS` (P3-S1). The runner
// reads `m.name`, so this module exports `name` (not `id`).
//
// Do NOT change the DDL below — `core/credentials/storage.ts` expects
// exactly these columns and types.

import type { Database } from 'better-sqlite3';

export const name = '0002_credentials';

export const up = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      key TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
};

export const down = (db: Database): void => {
  db.exec(`DROP TABLE IF EXISTS credentials;`);
};
