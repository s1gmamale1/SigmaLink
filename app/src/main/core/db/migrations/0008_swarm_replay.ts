// P3-S6 — Persistent Swarm Replay snapshots.
//
// Adds a single table that records named bookmarks within a swarm's mailbox
// timeline:
//
//   swarm_replay_snapshots — one row per bookmark. `frameIdx` is 1-indexed
//                            against the chronologically-ordered
//                            `swarm_messages` rows for the swarm; jumping
//                            back to a snapshot replays cumulative state up
//                            to (and including) message N.
//
// Forward-only. Idempotent via `CREATE TABLE IF NOT EXISTS`. The CASCADE on
// `swarmId` keeps bookmarks self-cleaning when an operator drops the parent
// swarm.

import type Database from 'better-sqlite3';

export const name = '0008_swarm_replay';

export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS swarm_replay_snapshots (
        id TEXT PRIMARY KEY,
        swarmId TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        frameIdx INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS swarm_replay_snapshots_swarm_frame_idx
        ON swarm_replay_snapshots(swarmId, frameIdx);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
