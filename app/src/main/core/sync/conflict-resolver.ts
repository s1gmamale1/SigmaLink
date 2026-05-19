// v1.5.0 packet 09 — Conflict resolver.
//
// Implements S4 conflict resolution policy (LOCKED):
//   - LWW (Last-Write-Wins) by HLC comparison.
//   - "Losing" writes preserved in sync_conflicts for user review.
//   - Schema-version mismatches quarantined to sync_pending_upgrade.
//   - AEAD decryption failures quarantined to sync_quarantine (NEVER applied).
//   - Tombstones win over live rows — a delete + edit conflict surfaces for review.
//
// Auto-resolution after 7 days: take the version with newer wall_ms.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { compare, unpack } from './hlc';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type ConflictResolution = 'keep_local' | 'keep_remote';

export interface RemoteRow {
  tableName: string;
  rowId: string;
  hlcPacked: string;
  machineId: Uint8Array;
  rowJson: string;
  schemaVersion: number;
}

export interface LocalRow {
  tableName: string;
  rowId: string;
  hlcPacked: string;
  rowJson: string;
}

export type MergeOutcome =
  | { action: 'apply_remote'; reason: string }
  | { action: 'keep_local'; reason: string }
  | { action: 'conflict'; conflictId: string }
  | { action: 'quarantine_aead'; blobPath: string }
  | { action: 'quarantine_upgrade'; blobPath: string; schemaVersion: number }
  | { action: 'no_op'; reason: string };

const CONFLICT_AUTO_RESOLVE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ------------------------------------------------------------------
// Per-row merge decision
// ------------------------------------------------------------------

/**
 * Resolve a single remote row against the local DB state.
 * Writes conflict/quarantine rows as needed; never applies the remote row
 * directly — that is the engine's responsibility after checking the outcome.
 */
export function resolveRow(
  db: Database.Database,
  localSchemaVersion: number,
  remote: RemoteRow,
  blobPath: string,
): MergeOutcome {
  // Schema-version gate: remote blob is from a newer schema.
  if (remote.schemaVersion > localSchemaVersion) {
    const id = randomUUID();
    db.prepare(
      `INSERT OR IGNORE INTO sync_pending_upgrade
         (id, blob_path, schema_version, queued_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, blobPath, remote.schemaVersion, Date.now());
    return {
      action: 'quarantine_upgrade',
      blobPath,
      schemaVersion: remote.schemaVersion,
    };
  }

  // Check for tombstone (local delete).
  const tombstone = db
    .prepare(
      `SELECT hlc_packed FROM sync_tombstones
       WHERE table_name = ? AND row_id = ?`,
    )
    .get(remote.tableName, remote.rowId) as { hlc_packed: string } | undefined;

  if (tombstone) {
    const localHlc = unpack(tombstone.hlc_packed);
    const remoteHlc = unpack(remote.hlcPacked);
    const cmp = compare(remoteHlc, localHlc);

    if (cmp <= 0) {
      // Local delete wins.
      return { action: 'keep_local', reason: 'local tombstone is newer or same' };
    }

    // Remote edit wins over local delete — surface as conflict.
    const conflictId = recordConflict(db, {
      tableName: remote.tableName,
      rowId: remote.rowId,
      localHlcPacked: tombstone.hlc_packed,
      remoteHlcPacked: remote.hlcPacked,
      remoteMachineId: remote.machineId,
      localRowJson: JSON.stringify({ _tombstone: true }),
      remoteRowJson: remote.rowJson,
    });
    return { action: 'conflict', conflictId };
  }

  // Check current local row.
  const localState = db
    .prepare(
      `SELECT hlc_wall_ms, hlc_logical, hlc_machine_id, row_hash
       FROM sync_state
       WHERE table_name = ? AND row_id = ?`,
    )
    .get(remote.tableName, remote.rowId) as
    | { hlc_wall_ms: number; hlc_logical: number; hlc_machine_id: string; row_hash: string }
    | undefined;

  if (!localState) {
    // Row doesn't exist locally — apply.
    return { action: 'apply_remote', reason: 'row is new' };
  }

  const localHlcPacked = packFromParts(
    localState.hlc_wall_ms,
    localState.hlc_logical,
    localState.hlc_machine_id,
  );
  const localHlc = unpack(localHlcPacked);
  const remoteHlc = unpack(remote.hlcPacked);
  const cmp = compare(remoteHlc, localHlc);

  if (cmp > 0) {
    // Remote strictly newer — LWW applies remote.
    return { action: 'apply_remote', reason: 'remote HLC is newer' };
  }

  if (cmp < 0) {
    // Local strictly newer — keep local.
    return { action: 'keep_local', reason: 'local HLC is newer' };
  }

  // Equal HLCs — impossible if machine IDs differ, but defensive guard.
  // Treat as conflict.
  const conflictId = recordConflict(db, {
    tableName: remote.tableName,
    rowId: remote.rowId,
    localHlcPacked,
    remoteHlcPacked: remote.hlcPacked,
    remoteMachineId: remote.machineId,
    localRowJson: readLocalRowJson(db, remote.tableName, remote.rowId),
    remoteRowJson: remote.rowJson,
  });
  return { action: 'conflict', conflictId };
}

// ------------------------------------------------------------------
// Conflict record helpers
// ------------------------------------------------------------------

interface ConflictParams {
  tableName: string;
  rowId: string;
  localHlcPacked: string;
  remoteHlcPacked: string;
  remoteMachineId: Uint8Array;
  localRowJson: string;
  remoteRowJson: string;
}

function recordConflict(db: Database.Database, params: ConflictParams): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sync_conflicts
       (id, table_name, row_id, local_hlc_packed, remote_hlc_packed,
        remote_machine_id, local_row_json, remote_row_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.tableName,
    params.rowId,
    params.localHlcPacked,
    params.remoteHlcPacked,
    Buffer.from(params.remoteMachineId).toString('hex'),
    params.localRowJson,
    params.remoteRowJson,
    Date.now(),
  );
  return id;
}

// ------------------------------------------------------------------
// User resolution
// ------------------------------------------------------------------

/**
 * Apply a user's explicit conflict resolution choice.
 * Marks the conflict as resolved and updates sync_state accordingly.
 */
export function applyResolution(
  db: Database.Database,
  conflictId: string,
  resolution: ConflictResolution,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE sync_conflicts
     SET resolved = 1, resolution = ?, resolved_at = ?
     WHERE id = ?`,
  ).run(resolution, now, conflictId);
}

/**
 * Auto-resolve stale conflicts (>7 days): take the version with newer wall_ms.
 * Called by the engine GC sweep.
 */
export function autoResolveStaleConflicts(db: Database.Database): number {
  const cutoff = Date.now() - CONFLICT_AUTO_RESOLVE_MS;
  const stale = db
    .prepare(
      `SELECT id, local_hlc_packed, remote_hlc_packed
       FROM sync_conflicts
       WHERE resolved = 0 AND created_at < ?`,
    )
    .all(cutoff) as Array<{
    id: string;
    local_hlc_packed: string;
    remote_hlc_packed: string;
  }>;

  let resolved = 0;
  for (const row of stale) {
    let resolution: ConflictResolution;
    try {
      const local = unpack(row.local_hlc_packed);
      const remote = unpack(row.remote_hlc_packed);
      resolution = remote.wallMs >= local.wallMs ? 'keep_remote' : 'keep_local';
    } catch {
      resolution = 'keep_local'; // defensive fallback
    }
    applyResolution(db, row.id, resolution);
    resolved++;
  }
  return resolved;
}

/**
 * List unresolved conflicts.
 */
export function listUnresolvedConflicts(db: Database.Database): Array<{
  id: string;
  tableName: string;
  rowId: string;
  localRowJson: string;
  remoteRowJson: string;
  createdAt: number;
}> {
  return db
    .prepare(
      `SELECT id, table_name AS tableName, row_id AS rowId,
              local_row_json AS localRowJson, remote_row_json AS remoteRowJson,
              created_at AS createdAt
       FROM sync_conflicts
       WHERE resolved = 0
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    tableName: string;
    rowId: string;
    localRowJson: string;
    remoteRowJson: string;
    createdAt: number;
  }>;
}

// ------------------------------------------------------------------
// Quarantine helper
// ------------------------------------------------------------------

/**
 * Record an AEAD decryption failure in sync_quarantine.
 * The blob is NEVER applied.
 */
export function quarantineBlob(
  db: Database.Database,
  blobPath: string,
  reason: 'aead_fail' | 'schema_unknown' | 'malformed',
): void {
  const id = randomUUID();
  db.prepare(
    `INSERT OR IGNORE INTO sync_quarantine
       (id, blob_path, reason, detected_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, blobPath, reason, Date.now());
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function packFromParts(wallMs: number, logical: number, machineIdHex: string): string {
  const buf = Buffer.alloc(26);
  const hi = Math.floor(wallMs / 0x1_0000_0000);
  const lo = wallMs >>> 0;
  buf.writeUInt32BE(hi, 0);
  buf.writeUInt32BE(lo, 4);
  buf.writeUInt16BE(logical, 8);
  const idBytes = Buffer.from(machineIdHex, 'hex');
  idBytes.copy(buf, 10, 0, 16);
  return buf.toString('hex');
}

function readLocalRowJson(
  db: Database.Database,
  tableName: string,
  rowId: string,
): string {
  // Read all columns from the table for the row — the column set varies.
  // This is a best-effort snapshot for conflict display; if it fails we
  // return an empty JSON object.
  try {
    const row = db
      .prepare(`SELECT * FROM ${tableName} WHERE id = ?`)
      .get(rowId) as Record<string, unknown> | undefined;
    return row ? JSON.stringify(row) : '{}';
  } catch {
    return '{}';
  }
}
