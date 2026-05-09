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
