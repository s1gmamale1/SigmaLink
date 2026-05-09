// SQLite client + first-run migration. We use the simplest possible approach:
// run CREATE TABLE IF NOT EXISTS statements derived from the schema at boot.
// Drizzle migrations can be added later; this avoids a build-time codegen step.

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrate } from './migrate';

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

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT,
  content_hash TEXT NOT NULL,
  managed_path TEXT NOT NULL,
  installed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  tags_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_name_uq ON skills(name);

CREATE TABLE IF NOT EXISTS skill_provider_state (
  skill_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_fanout_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (skill_id, provider_id),
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS skill_provider_state_skill_idx ON skill_provider_state(skill_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  frontmatter_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memories_ws_idx ON memories(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS memories_ws_name_uq ON memories(workspace_id, name);

CREATE TABLE IF NOT EXISTS memory_links (
  id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL,
  to_memory_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (from_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links(from_memory_id);
CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_memory_name);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memory_tags_tag_idx ON memory_tags(tag);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  assigned_session_id TEXT,
  assigned_swarm_id TEXT,
  assigned_swarm_agent_id TEXT,
  labels_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  archived_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tasks_ws_idx ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'operator',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id);

CREATE TABLE IF NOT EXISTS session_review (
  session_id TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT '',
  decision TEXT,
  decided_at INTEGER,
  last_test_command TEXT,
  last_test_exit_code INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
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
  // V3-W12-016: run forward-only migrations after bootstrap so existing
  // installs pick up new columns; fresh installs already have the columns
  // because the migration runner short-circuits via PRAGMA introspection.
  migrate(sqlite);
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
