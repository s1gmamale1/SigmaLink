// v1.5.0 packet 09 — App-level dirty tracker.
//
// Tracks which rows in synced tables have been written since the last push.
// Uses application-level write hooks (NOT SQLite triggers — triggers are too
// brittle across migrations and cannot carry HLC metadata).
//
// Callers (controllers, managers) invoke `markDirty(tableName, rowId)` after
// every INSERT or UPDATE to a synced table. The sync engine reads the dirty
// set on each push cycle.
//
// SYNC SCOPE (per brief S6 — autonomous default applied):
//   IN: workspaces, agent_sessions, swarms, swarm_agents, swarm_messages,
//       swarm_skills, conversations, messages, jorvis_pane_events, memories,
//       memory_links, memory_tags, tasks, task_comments, canvases,
//       canvas_dispatches, boards, swarm_origins, swarm_replay_snapshots
//   OUT: credentials (HARD-DENY), kv, skills, skill_provider_state,
//        session_review, browser_tabs, notifications, sync_* (internal tables)
//
// The dirty tracker does NOT persist across process restarts — on startup the
// sync engine performs a full hash comparison to rebuild the dirty set. This
// is safe because the full scan is O(N rows) and runs in the background.

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// ------------------------------------------------------------------
// Sync scope
// ------------------------------------------------------------------

/**
 * Tables that are eligible for sync. Explicit allowlist — any table NOT here
 * is silently excluded from all sync operations.
 */
export const SYNCED_TABLES = new Set<string>([
  'workspaces',
  'agent_sessions',
  'swarms',
  'swarm_agents',
  'swarm_messages',
  'swarm_skills',
  'conversations',
  'messages',
  'jorvis_pane_events',
  'memories',
  'memory_links',
  'memory_tags',
  'tasks',
  'task_comments',
  'canvases',
  'canvas_dispatches',
  'boards',
  'swarm_origins',
  'swarm_replay_snapshots',
]);

/**
 * HARD-DENY set — these tables are NEVER synced, ever. The check is explicit
 * so a future refactor cannot accidentally add them to SYNCED_TABLES.
 */
export const NEVER_SYNC_TABLES = new Set<string>([
  'credentials',
  'kv',
  'skills',
  'skill_provider_state',
  'session_review',
  'browser_tabs',
  'notifications',
]);

// ------------------------------------------------------------------
// Dirty tracker
// ------------------------------------------------------------------

/**
 * Verify that `tableName` is syncable. Throws on HARD-DENY tables.
 * Returns false for tables that are simply out-of-scope.
 */
export function isSyncable(tableName: string): boolean {
  if (NEVER_SYNC_TABLES.has(tableName)) {
    throw new Error(
      `dirty-tracker: "${tableName}" is in the NEVER_SYNC_TABLES list and must NEVER be synced`,
    );
  }
  return SYNCED_TABLES.has(tableName);
}

/**
 * Compute a stable hash for a row's JSON representation.
 * Used to detect whether a row has actually changed since the last push.
 */
export function hashRow(rowJson: string): string {
  return createHash('sha256').update(rowJson, 'utf8').digest('hex');
}

interface SyncStateRow {
  table_name: string;
  row_id: string;
  dirty: number;
}

/**
 * Mark a row as dirty in `sync_state`.
 *
 * - Creates or updates the row's dirty flag.
 * - Also records the HLC packed value for the row (the caller has already
 *   advanced the HLC via `hlc.now()` before the write).
 * - If `tableName` is in NEVER_SYNC_TABLES, throws immediately.
 * - If `tableName` is not in SYNCED_TABLES, no-op (returns false).
 *
 * Returns true if the row was marked dirty, false if not syncable.
 */
export function markDirty(
  db: Database.Database,
  tableName: string,
  rowId: string,
  hlcPacked: string,
  rowHash: string,
): boolean {
  if (!isSyncable(tableName)) return false;

  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_state
       (table_name, row_id, hlc_wall_ms, hlc_logical, hlc_machine_id, row_hash, dirty)
     VALUES (?, ?, ?, 0, X'00000000000000000000000000000000', ?, 1)
     ON CONFLICT (table_name, row_id) DO UPDATE SET
       hlc_wall_ms = excluded.hlc_wall_ms,
       row_hash    = excluded.row_hash,
       dirty       = 1`,
  ).run(tableName, rowId, now, rowHash);

  // Update the packed HLC separately (avoids hex parsing in the upsert).
  db.prepare(
    `UPDATE sync_state SET hlc_wall_ms = ?, hlc_machine_id = ?
     WHERE table_name = ? AND row_id = ?`,
  ).run(now, hlcPacked, tableName, rowId);

  return true;
}

/**
 * Record a tombstone for a deleted row.
 *
 * - Inserts into sync_tombstones.
 * - Removes the row from sync_state (no point tracking dirty for deleted rows).
 * - HARD-DENY tables throw. Non-synced tables are a no-op.
 */
export function markDeleted(
  db: Database.Database,
  tableName: string,
  rowId: string,
  hlcPacked: string,
): boolean {
  if (!isSyncable(tableName)) return false;

  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO sync_tombstones
       (table_name, row_id, deleted_at, hlc_packed)
     VALUES (?, ?, ?, ?)`,
  ).run(tableName, rowId, now, hlcPacked);

  db.prepare(
    `DELETE FROM sync_state WHERE table_name = ? AND row_id = ?`,
  ).run(tableName, rowId);

  return true;
}

/**
 * List all dirty rows (pending push).
 */
export function listDirtyRows(db: Database.Database): SyncStateRow[] {
  return db
    .prepare(
      `SELECT table_name, row_id, dirty FROM sync_state WHERE dirty = 1`,
    )
    .all() as SyncStateRow[];
}

/**
 * Mark a row as clean (after successful push).
 */
export function markClean(
  db: Database.Database,
  tableName: string,
  rowId: string,
  pushedAt: number,
): void {
  db.prepare(
    `UPDATE sync_state SET dirty = 0, last_pushed_at = ?
     WHERE table_name = ? AND row_id = ?`,
  ).run(pushedAt, tableName, rowId);
}

/**
 * Generate a unique sync history entry ID.
 */
export function newHistoryId(): string {
  return randomUUID();
}
