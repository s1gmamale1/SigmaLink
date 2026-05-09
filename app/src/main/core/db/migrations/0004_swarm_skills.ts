// V3-W13-011 — Swarm Skills 12-tile grid persistence.
//
// Forward-only. Adds `swarm_skills` keyed by (swarmId, skillKey). The renderer
// toggles a skill on/off via `swarms.sendMessage` with `kind='skill_toggle'`;
// the controller mirrors the new state into this table so coordinator system
// prompts can read which skills are active without re-tailing the mailbox.
//
// We deliberately keep this table tiny — 12 rows max per swarm — and use
// idempotent CREATE IF NOT EXISTS so re-running the migration is a no-op.

import type Database from 'better-sqlite3';

export const name = '0004_swarm_skills';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_skills (
        swarm_id TEXT NOT NULL,
        skill_key TEXT NOT NULL,
        on_flag INTEGER NOT NULL DEFAULT 0,
        group_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (swarm_id, skill_key)
      );
    `);
    db.exec(
      `CREATE INDEX IF NOT EXISTS swarm_skills_swarm_idx ON swarm_skills (swarm_id);`,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
