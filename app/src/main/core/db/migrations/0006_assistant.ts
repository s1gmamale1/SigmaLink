// V3-W13-013 — Bridge Assistant conversations + messages.
//
// Forward-only. Adds two new tables that back the assistant.* RPC namespace:
//
//   conversations       — one row per chat thread (assistant or future swarm-DM)
//   messages            — per-turn rows (user / assistant / tool / system)
//
// The DDL is gated on `CREATE TABLE IF NOT EXISTS` so re-running the migration
// on a DB that already has the tables is a no-op. The migrations runner records
// success in `schema_migrations` regardless so future boots skip this entirely.
//
// CASCADE delete on `messages.conversation_id` keeps the schema self-cleaning
// when an operator drops a conversation.

import type Database from 'better-sqlite3';

export const name = '0006_assistant';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('assistant','swarm_dm')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS conversations_ws_idx ON conversations(workspace_id);
      CREATE INDEX IF NOT EXISTS conversations_kind_idx ON conversations(kind);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
