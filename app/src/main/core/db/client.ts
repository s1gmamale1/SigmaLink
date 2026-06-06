// SQLite client + first-run migration. We use the simplest possible approach:
// run CREATE TABLE IF NOT EXISTS statements derived from the schema at boot.
// Drizzle migrations can be added later; this avoids a build-time codegen step.

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrate } from './migrate';
import { isCorruptionError, shouldQuarantine, corruptBackupPath } from './corruption';

let dbHandle: ReturnType<typeof drizzle<typeof schema>> | null = null;
let rawDb: Database.Database | null = null;
/** DB-2 — retained so restoreDatabase() can swap + reopen the same file. */
let dbFilePath: string | null = null;

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
  runtime_profile_id TEXT NOT NULL DEFAULT 'ruflo-core',
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

/**
 * Open a SQLite connection, apply the standard pragmas, and run a
 * `PRAGMA quick_check` integrity probe.
 *
 * @throws if the file is corrupt — either the open/pragma call throws a
 *   `SQLITE_CORRUPT`/`SQLITE_NOTADB` error, or `quick_check` reports a
 *   non-`'ok'` result (we close the handle and re-throw a synthetic error so
 *   the caller's corruption branch fires uniformly).
 */
function openAndCheck(filePath: string): Database.Database {
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // H-7: wait up to 5s for a lock instead of throwing SQLITE_BUSY immediately.
  // With WAL + multiple connections (HTTP daemon, sync engine) a migration's
  // write transaction can briefly contend; the timeout makes it wait, not fail.
  sqlite.pragma('busy_timeout = 5000');
  // DB-1: integrity probe BEFORE bootstrap/migrate. quick_check is far cheaper
  // than integrity_check and catches the corruption cases that make the file
  // unusable as a database.
  const quickCheck = sqlite.pragma('quick_check');
  if (shouldQuarantine(quickCheck)) {
    try { sqlite.close(); } catch { /* ignore */ }
    const synthetic = new Error(
      `sigmalink.db failed PRAGMA quick_check: ${JSON.stringify(quickCheck)}`,
    ) as Error & { code: string };
    synthetic.code = 'SQLITE_CORRUPT';
    throw synthetic;
  }
  return sqlite;
}

/** DB-1 — bootstrap schema + forward-only migrations + legacy kv key migration. */
function bootstrapAndMigrate(sqlite: Database.Database): void {
  sqlite.exec(BOOTSTRAP_SQL);
  // V3-W12-016: run forward-only migrations after bootstrap so existing
  // installs pick up new columns; fresh installs already have the columns
  // because the migration runner short-circuits via PRAGMA introspection.
  migrate(sqlite);
  runKvMigrations(sqlite);
}

/**
 * v1.4.1 — transparently migrate the old `bridge.*` kv keys to `sigma.*` so
 * existing users don't lose their preferences after the RoomId rename. Each
 * block is independent (a user may have toggled one preference but not the
 * other) and idempotent. Wrapped in try/catch because the kv table may not
 * exist on very old schemas. Mirrored by client.kv-migration.test.ts.
 */
function runKvMigrations(sqlite: Database.Database): void {
  try {
    const oldRow = sqlite.prepare("SELECT value FROM kv WHERE key = 'bridge.activeConversationId'").get() as { value: string } | undefined;
    if (oldRow) {
      const newRow = sqlite.prepare("SELECT 1 FROM kv WHERE key = 'sigma.activeConversationId'").get() as { value: string } | undefined;
      if (!newRow) {
        sqlite.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run('sigma.activeConversationId', oldRow.value, Date.now());
      }
      sqlite.prepare("DELETE FROM kv WHERE key = 'bridge.activeConversationId'").run();
    }
  } catch {
    /* kv table may not exist on very old schemas — ignore */
  }
  try {
    const oldAutoFocusRow = sqlite.prepare("SELECT value FROM kv WHERE key = 'bridge.autoFocusOnDispatch'").get() as { value: string } | undefined;
    if (oldAutoFocusRow) {
      const newAutoFocusRow = sqlite.prepare("SELECT 1 FROM kv WHERE key = 'sigma.autoFocusOnDispatch'").get() as { value: string } | undefined;
      if (!newAutoFocusRow) {
        sqlite.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run('sigma.autoFocusOnDispatch', oldAutoFocusRow.value, Date.now());
      }
      sqlite.prepare("DELETE FROM kv WHERE key = 'bridge.autoFocusOnDispatch'").run();
    }
  } catch {
    /* kv table may not exist on very old schemas — ignore */
  }
}

export function initializeDatabase(userDataDir: string): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  raw: Database.Database;
  filePath: string;
} {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const filePath = path.join(userDataDir, 'sigmalink.db');

  let sqlite: Database.Database;
  try {
    // DB-1: open + pragmas + quick_check. A corrupt file throws here (either a
    // SQLITE_CORRUPT/NOTADB open error or our synthetic quick_check error).
    sqlite = openAndCheck(filePath);
  } catch (err) {
    if (!isCorruptionError(err)) throw err; // not a corruption signal — surface it.
    // DB-1 recovery: PRESERVE the bad file (rename, don't delete), warn loudly,
    // then recreate a fresh database so the app still boots. Data loss is
    // unavoidable for the corrupt file, but the app remains usable and the old
    // bytes are kept for forensic / manual-recovery purposes.
    const backupPath = corruptBackupPath(filePath, Date.now());
    console.warn(
      `[db] sigmalink.db is corrupt (${err instanceof Error ? err.message : String(err)}). ` +
        `Quarantining to ${backupPath} and recreating a fresh database.`,
    );
    try {
      // Move the corrupt main file and any stale WAL/SHM sidecars out of the way
      // so the fresh Database() starts clean.
      if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
      for (const sidecar of ['-wal', '-shm']) {
        const sidecarPath = filePath + sidecar;
        if (fs.existsSync(sidecarPath)) {
          try { fs.renameSync(sidecarPath, backupPath + sidecar); } catch { /* best-effort */ }
        }
      }
    } catch (renameErr) {
      console.warn(
        `[db] failed to quarantine corrupt database at ${filePath}: ` +
          `${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
      );
    }
    // Recreate. If THIS throws it is not recoverable — let it surface.
    sqlite = openAndCheck(filePath);
  }

  bootstrapAndMigrate(sqlite);
  rawDb = sqlite;
  dbHandle = drizzle(sqlite, { schema });
  dbFilePath = filePath;
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

/**
 * DB-2 — write a clean, WAL-free snapshot of the live database to `destPath`
 * via `VACUUM INTO` (atomic + fully compacted). `destPath` MUST NOT already
 * exist (a SQLite requirement). Checkpoints the WAL first so the snapshot is
 * complete. Throws on failure.
 */
export function backupDatabase(destPath: string): void {
  const db = getRawDb();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best-effort — VACUUM INTO still yields a consistent snapshot */
  }
  // VACUUM INTO requires the destination NOT to exist. The save dialog already
  // confirmed any overwrite, so clear a stale file first.
  if (fs.existsSync(destPath)) {
    try { fs.rmSync(destPath); } catch { /* surfaced by the exec below if it matters */ }
  }
  // No bind param for VACUUM INTO; escape single quotes for the SQL literal.
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

/**
 * DB-2 — replace the live database with a previously-exported backup. DESTRUCTIVE.
 * Validates `srcPath` is a healthy SQLite database (read-only open + quick_check)
 * BEFORE clobbering anything; keeps a one-shot `<db>.pre-restore` copy of the
 * current file; clears stale WAL/SHM; then reopens (re-running pragmas +
 * quick_check + pending migrations on the restored file). Throws — leaving the
 * live DB intact — if the source is missing or fails validation.
 */
export function restoreDatabase(srcPath: string): void {
  if (!dbFilePath) throw new Error('restoreDatabase: database not initialized');
  if (!fs.existsSync(srcPath)) {
    throw new Error(`restoreDatabase: backup file not found at ${srcPath}`);
  }
  // Validate the incoming file READ-ONLY (so we never mutate the backup) before
  // touching the live DB.
  let probe: Database.Database | null = null;
  try {
    probe = new Database(srcPath, { readonly: true });
    const res = probe.pragma('quick_check', { simple: true });
    if (res !== 'ok') {
      throw new Error(`restoreDatabase: backup failed integrity check (${String(res)})`);
    }
  } catch (err) {
    if (probe) {
      try { probe.close(); } catch { /* ignore */ }
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  probe.close();

  const target = dbFilePath;
  const userDataDir = path.dirname(target);
  closeDatabase();
  // One-shot pre-restore safety copy so a bad restore is recoverable.
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.pre-restore`);
  } catch {
    /* best-effort */
  }
  fs.copyFileSync(srcPath, target);
  // Drop stale WAL/SHM from the old DB so the restored file opens clean.
  for (const sidecar of ['-wal', '-shm']) {
    const p = target + sidecar;
    if (fs.existsSync(p)) {
      try { fs.rmSync(p); } catch { /* best-effort */ }
    }
  }
  // Reopen — re-runs openAndCheck + bootstrapAndMigrate on the restored file.
  initializeDatabase(userDataDir);
}
