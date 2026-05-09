// V3-W13-008 — Per-agent board namespace.
//
// Adds a `boards` table that backs the `board_post` mailbox envelope. Each
// row mirrors a markdown file written to:
//   <userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md
//
// Forward-only. The migration is idempotent: it uses `CREATE TABLE IF NOT
// EXISTS` for the table and `CREATE INDEX IF NOT EXISTS` for the lookup
// index. Existing rows in unrelated tables are untouched.

import type Database from 'better-sqlite3';

export const name = '0003_boards';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        swarmId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        postId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyMd TEXT NOT NULL,
        attachmentsJson TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (swarmId) REFERENCES swarms(id) ON DELETE CASCADE
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS boards_swarm_agent_idx ON boards (swarmId, agentId)',
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
