// SQLite client + first-run migration. We use the simplest possible approach:
// run CREATE TABLE IF NOT EXISTS statements derived from the schema at boot.
// Drizzle migrations can be added later; this avoids a build-time codegen step.

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

let dbHandle: ReturnType<typeof drizzle<typeof schema>> | null = null;
let rawDb: Database.Database | null = null;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  repo_root TEXT,
  repo_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_opened_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_idx ON workspaces(root_path);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  initial_prompt TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  exited_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_sessions_ws_idx ON agent_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions(status);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS swarms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mission TEXT NOT NULL,
  preset TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  ended_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarms_ws_idx ON swarms(workspace_id);
CREATE INDEX IF NOT EXISTS swarms_status_idx ON swarms(status);

CREATE TABLE IF NOT EXISTS swarm_agents (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL,
  role TEXT NOT NULL,
  role_index INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  inbox_path TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarm_agents_swarm_idx ON swarm_agents(swarm_id);
CREATE UNIQUE INDEX IF NOT EXISTS swarm_agents_role_uq ON swarm_agents(swarm_id, role, role_index);

CREATE TABLE IF NOT EXISTS swarm_messages (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT,
  ts INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  FOREIGN KEY (swarm_id) REFERENCES swarms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS swarm_messages_swarm_time_idx ON swarm_messages(swarm_id, ts);
CREATE INDEX IF NOT EXISTS swarm_messages_to_idx ON swarm_messages(swarm_id, to_agent);

CREATE TABLE IF NOT EXISTS browser_tabs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_visited_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_tabs_ws_idx ON browser_tabs(workspace_id);
`;

export function initializeDatabase(userDataDir: string): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  raw: Database.Database;
  filePath: string;
} {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const filePath = path.join(userDataDir, 'sigmalink.db');
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(BOOTSTRAP_SQL);
  rawDb = sqlite;
  dbHandle = drizzle(sqlite, { schema });
  return { db: dbHandle, raw: sqlite, filePath };
}

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!dbHandle) throw new Error('Database not initialized — call initializeDatabase() first.');
  return dbHandle;
}

export function getRawDb(): Database.Database {
  if (!rawDb) throw new Error('Database not initialized — call initializeDatabase() first.');
  return rawDb;
}

/**
 * Gracefully close the SQLite handle. Runs `PRAGMA wal_checkpoint(TRUNCATE)`
 * so the WAL file is collapsed into the main DB, then closes the connection.
 * Safe to call repeatedly — subsequent calls are no-ops.
 */
export function closeDatabase(): void {
  if (!rawDb) return;
  try {
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best-effort */
  }
  try {
    rawDb.close();
  } catch {
    /* ignore */
  }
  rawDb = null;
  dbHandle = null;
}
