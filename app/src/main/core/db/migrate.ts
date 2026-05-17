// V3-W12-016 — Forward-only migrations runner.
//
// Why hand-roll instead of `drizzle-kit migrate`? The Electron main bundle is
// a single esbuild output; pulling drizzle-kit's runtime would balloon startup
// and require shipping its transitive deps. Each migration is a tiny TS module
// that exports `name` + `up(db)`; the runner records applied migrations in
// `schema_migrations` and runs everything pending in lexical order.

import type Database from 'better-sqlite3';
import * as mig0001 from './migrations/0001_v3_mailbox';
import * as mig0002 from './migrations/0002_credentials';
import * as mig0003 from './migrations/0003_boards';
import * as mig0004 from './migrations/0004_swarm_skills';
import * as mig0005 from './migrations/0005_coordinator_id';
import * as mig0006 from './migrations/0006_assistant';
import * as mig0007 from './migrations/0007_canvases';
import * as mig0008 from './migrations/0008_swarm_replay';
import * as mig0009 from './migrations/0009_swarm_origins';
import * as mig0010 from './migrations/0010_provider_effective';
import * as mig0011 from './migrations/0011_agent_session_external_id';
import * as mig0012 from './migrations/0012_agent_session_pane_index';
import * as mig0013 from './migrations/0013_conversations_claude_session_id';
import * as mig0014 from './migrations/0014_sigma_pane_events';
import * as mig0015 from './migrations/0015_agent_session_sigma_monitor';
import * as mig0016 from './migrations/0016_dead_row_hygiene';

export interface Migration {
  name: string;
  up: (db: Database.Database) => void;
}

interface MigrationRow {
  name: string;
}

// Ordered list of every migration this app knows about. New W13/W14/W15
// migrations append here; the runner runs whichever rows are missing from
// `schema_migrations`. Keep this list lexically sorted by `name` so the
// "apply in order" contract holds.
export const ALL_MIGRATIONS: Migration[] = [
  mig0001,
  mig0002,
  mig0003,
  mig0004,
  mig0005,
  mig0006,
  mig0007,
  mig0008,
  mig0009,
  mig0010,
  mig0011,
  mig0012,
  mig0013,
  mig0014,
  mig0015,
  mig0016,
];

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;

/**
 * Apply every pending migration in `ALL_MIGRATIONS`. Safe to call repeatedly.
 * Returns the names of migrations that were applied during this call.
 */
export function migrate(db: Database.Database): string[] {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as MigrationRow[]).map(
      (r) => r.name,
    ),
  );
  const ran: string[] = [];
  const insertApplied = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const m of ALL_MIGRATIONS) {
    if (applied.has(m.name)) continue;
    m.up(db);
    insertApplied.run(m.name);
    ran.push(m.name);
  }
  return ran;
}
