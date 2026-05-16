// P3-S7 — Swarm origins: link a swarm back to the Sigma Assistant chat that
// triggered its creation.
//
//   swarm_origins — one row per swarm spawned via the assistant `create_swarm`
//                   tool. The (conversationId, messageId) pair is the chat +
//                   tool-call message that produced the swarm; CASCADE keeps
//                   the table self-cleaning when any of the three rows drop.
//
// Forward-only. Idempotent via `CREATE TABLE IF NOT EXISTS`. Migration 0006
// owns conversations + messages; this migration is gated lexically after 0008
// so it always runs on a DB that already has both swarms and conversations.

import type Database from 'better-sqlite3';

export const name = '0009_swarm_origins';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_origins (
        swarmId TEXT PRIMARY KEY REFERENCES swarms(id) ON DELETE CASCADE,
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS swarm_origins_conv_idx
        ON swarm_origins(conversationId);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
