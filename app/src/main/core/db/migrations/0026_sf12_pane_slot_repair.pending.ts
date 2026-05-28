// SF-12 pending operator-signoff migration — pane slot data repair.
//
// NOT registered in ALL_MIGRATIONS yet. The operator must approve running this
// data mutation before the lead wires it into startup.
//
// Semantics: all live panes in a workspace share the same workspace-level slot
// namespace because agent_sessions enforces uniqueness on
// (workspace_id, pane_index). This migration makes that namespace explicit by
// re-slotting live rows densely from 0..k-1 per workspace and nulling terminal
// rows so they no longer reserve pane slots. It keeps all rows and worktree
// paths for history.
//
// H-7: no db.transaction(), BEGIN, COMMIT, or ROLLBACK here. The migration
// runner already calls migrations during startup, and nested BEGIN caused
// fresh-DB crashes. Each DDL/DML operation below is issued as a single
// db.prepare(sql).run() statement.

import type Database from 'better-sqlite3';

export const name = '0026_sf12_pane_slot_repair';

interface PreimageRow {
  id: string;
  pane_index: number | null;
  status: string;
}

interface CountRow {
  cnt: number;
}

interface KeyRow {
  key: string;
}

interface PreimagePayload {
  migration: typeof name;
  createdAt: number;
  rows: PreimageRow[];
}

let lastPreimageKey: string | null = null;

function count(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as CountRow | undefined;
  return Number(row?.cnt ?? 0);
}

function capturePreimage(db: Database.Database, now: number): string {
  const rows = db
    .prepare(
      `SELECT id, pane_index, status
       FROM agent_sessions
       ORDER BY id ASC`,
    )
    .all() as PreimageRow[];
  const key = `sf12.preimage.${now}`;
  const payload: PreimagePayload = {
    migration: name,
    createdAt: now,
    rows,
  };
  db.prepare(
    `INSERT OR REPLACE INTO kv (key, value, updated_at)
     VALUES (?, ?, ?)`,
  ).run(key, JSON.stringify(payload), now);
  lastPreimageKey = key;
  return key;
}

function assertPostCondition(db: Database.Database): void {
  const liveNulls = count(
    db,
    `SELECT COUNT(*) AS cnt
     FROM agent_sessions
     WHERE status IN ('running', 'starting')
       AND pane_index IS NULL`,
  );
  if (liveNulls !== 0) {
    throw new Error(`SF-12 pane repair failed: ${liveNulls} live rows have NULL pane_index`);
  }

  const duplicateLiveSlots = count(
    db,
    `SELECT COUNT(*) AS cnt
     FROM (
       SELECT workspace_id, pane_index
       FROM agent_sessions
       WHERE status IN ('running', 'starting')
       GROUP BY workspace_id, pane_index
       HAVING COUNT(*) > 1
     )`,
  );
  if (duplicateLiveSlots !== 0) {
    throw new Error(`SF-12 pane repair failed: ${duplicateLiveSlots} duplicate live pane slots`);
  }

  const nonContiguousWorkspaces = count(
    db,
    `SELECT COUNT(*) AS cnt
     FROM (
       SELECT
         workspace_id,
         COUNT(*) AS n,
         COUNT(DISTINCT pane_index) AS uniq,
         MIN(pane_index) AS min_idx,
         MAX(pane_index) AS max_idx
       FROM agent_sessions
       WHERE status IN ('running', 'starting')
       GROUP BY workspace_id
       HAVING min_idx != 0
          OR max_idx != n - 1
          OR uniq != n
     )`,
  );
  if (nonContiguousWorkspaces !== 0) {
    throw new Error(
      `SF-12 pane repair failed: ${nonContiguousWorkspaces} workspaces are not dense 0..k-1`,
    );
  }
}

export function up(db: Database.Database, now = Date.now()): string {
  const preimageKey = capturePreimage(db, now);
  try {
    db.prepare(
      `UPDATE agent_sessions
       SET pane_index = NULL
       WHERE pane_index IS NOT NULL
         AND status NOT IN ('running', 'starting')`,
    ).run();

    db.prepare(
      `WITH live AS (
         SELECT
           id,
           -1 - ROW_NUMBER() OVER (ORDER BY workspace_id ASC, started_at ASC, id ASC) AS tmp_idx
         FROM agent_sessions
         WHERE status IN ('running', 'starting')
       )
       UPDATE agent_sessions
       SET pane_index = (
         SELECT tmp_idx FROM live WHERE live.id = agent_sessions.id
       )
       WHERE id IN (SELECT id FROM live)`,
    ).run();

    db.prepare(
      `WITH ranked AS (
         SELECT
           id,
           ROW_NUMBER() OVER (
             PARTITION BY workspace_id
             ORDER BY started_at ASC, id ASC
           ) - 1 AS new_idx
         FROM agent_sessions
         WHERE status IN ('running', 'starting')
       )
       UPDATE agent_sessions
       SET pane_index = (
         SELECT new_idx FROM ranked WHERE ranked.id = agent_sessions.id
       )
       WHERE id IN (SELECT id FROM ranked)`,
    ).run();

    assertPostCondition(db);
    return preimageKey;
  } catch (err) {
    down(db, preimageKey);
    throw err;
  }
}

// Re-running down() with the same preimage is safe: each row is set back to
// the captured values, so partial-failure recovery can call it again.
export function down(db: Database.Database, preimageKey = lastPreimageKey): void {
  const key =
    preimageKey ??
    ((db
      .prepare(
        `SELECT key
         FROM kv
         WHERE key LIKE 'sf12.preimage.%'
         ORDER BY key DESC
         LIMIT 1`,
      )
      .get() as KeyRow | undefined)?.key ?? null);
  if (!key) {
    throw new Error('SF-12 pane repair rollback failed: no preimage key available');
  }

  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (!row) {
    throw new Error(`SF-12 pane repair rollback failed: preimage not found for ${key}`);
  }

  const payload = JSON.parse(row.value) as PreimagePayload;
  const restore = db.prepare(
    `UPDATE agent_sessions
     SET pane_index = ?, status = ?
     WHERE id = ?`,
  );
  for (const preimage of payload.rows) {
    restore.run(preimage.pane_index, preimage.status, preimage.id);
  }
}
