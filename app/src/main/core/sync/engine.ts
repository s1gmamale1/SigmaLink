// v1.5.0 packet 09 — Sync engine.
//
// Orchestrates push + pull cycles:
//   1. PULL: fetch remote, decrypt new blobs, resolve conflicts (LWW + HLC).
//   2. PUSH: collect dirty rows, encrypt, stage + commit + push (with retry).
//
// Interval: 30s ± 5s jitter (per brief).
// One-at-a-time: no concurrent push/pull. Skips if already running.
//
// Security contracts maintained here:
//   - AEAD failures → sync_quarantine, never applied.
//   - credentials table → HARD-DENY (enforced by dirty-tracker + isSyncable).
//   - Key obtained via KeyManager.withKey(); zero'd after cycle.
//   - Commit author = sigma-sync@localhost (set by git-client on clone init).
//   - Lock file guards against concurrent Electron instances.

import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import { KeyManager } from './key-manager';
import { encrypt, decrypt, buildAad, buildAadV1, peekHeader } from './crypto';
import { init as hlcInit, now as hlcNow, recv as hlcRecv, pack as hlcPack, unpack as hlcUnpack } from './hlc';
import { listDirtyRows, markClean, markDeleted, SYNCED_TABLES } from './dirty-tracker';
import { resolveRow, quarantineBlob, type RemoteRow } from './conflict-resolver';
import {
  ensureRepo,
  pull,
  push,
  writeBlobToWorkTree,
  writeTombstoneToWorkTree,
  stageAndCommit,
  readBlob,
  listBlobs,
} from './git-client';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const SYNC_INTERVAL_MS = 30_000;
const SYNC_JITTER_MS = 5_000;
const SCHEMA_VERSION = 19; // matches migration 0019

// ------------------------------------------------------------------
// SQL column allowlists (caveat 4 — defense-in-depth)
// ------------------------------------------------------------------
//
// Per-table column allowlists derived from the drizzle schema. Any column
// name NOT in this set is silently dropped before SQL interpolation.
// Inclusion criterion: any column that is part of the declared Drizzle
// schema for that table at the current migration ceiling. Unknown columns
// (e.g. from a future schema or a tampered blob) are dropped with a warning.
//
// NB: column names here are the SQLite column names as declared in the
// migration DDL. Most tables use snake_case, but the three V3-era tables
// `boards`, `swarm_origins`, and `swarm_replay_snapshots` were declared
// with camelCase column names — their allowlist entries below reflect
// that. Cross-check against `schema.ts` if you add a new synced table.

export const COLUMN_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['workspaces', new Set(['id', 'name', 'root_path', 'repo_root', 'repo_mode', 'created_at', 'last_opened_at'])],
  ['agent_sessions', new Set(['id', 'workspace_id', 'provider_id', 'cwd', 'branch', 'worktree_path', 'status', 'exit_code', 'initial_prompt', 'started_at', 'exited_at', 'provider_effective', 'external_session_id', 'pane_index', 'jorvis_monitor_conversation_id', 'split_group_id', 'split_direction', 'split_index', 'minimised', 'auto_approve', 'display_provider_id'])],
  ['swarms', new Set(['id', 'workspace_id', 'name', 'mission', 'preset', 'status', 'created_at', 'ended_at'])],
  ['swarm_agents', new Set(['id', 'swarm_id', 'role', 'role_index', 'provider_id', 'session_id', 'status', 'inbox_path', 'agent_key', 'auto_approve', 'coordinator_id', 'created_at'])],
  ['swarm_messages', new Set(['id', 'swarm_id', 'from_agent', 'to_agent', 'kind', 'body', 'payload_json', 'ts', 'delivered_at', 'read_at', 'resolved_at'])],
  ['swarm_skills', new Set(['swarm_id', 'skill_key', 'on_flag', 'group_key', 'updated_at'])],
  ['conversations', new Set(['id', 'workspace_id', 'kind', 'claude_session_id', 'created_at'])],
  ['messages', new Set(['id', 'conversation_id', 'role', 'content', 'tool_call_id', 'created_at'])],
  // W-6 Cluster B: renamed from 'sigma_pane_events'. See migration 0022.
  // CROSS-SYNC CAVEAT: this rename changes the wire format — a v1.10.x peer
  // syncing 'sigma_pane_events' won't match a renamed peer syncing
  // 'jorvis_pane_events'. This is an intentional coordinated rename.
  ['jorvis_pane_events', new Set(['id', 'conversation_id', 'session_id', 'kind', 'body', 'ts'])],
  ['memories', new Set(['id', 'workspace_id', 'name', 'body', 'frontmatter_json', 'created_at', 'updated_at'])],
  ['memory_links', new Set(['id', 'from_memory_id', 'to_memory_name', 'created_at'])],
  ['memory_tags', new Set(['memory_id', 'tag'])],
  ['tasks', new Set(['id', 'workspace_id', 'title', 'description', 'status', 'assigned_session_id', 'assigned_swarm_id', 'assigned_swarm_agent_id', 'labels_json', 'created_at', 'updated_at', 'archived_at'])],
  ['task_comments', new Set(['id', 'task_id', 'author', 'body', 'created_at'])],
  ['canvases', new Set(['id', 'workspace_id', 'title', 'last_providers', 'created_at'])],
  ['canvas_dispatches', new Set(['id', 'canvas_id', 'prompt', 'providers', 'ts'])],
  ['boards', new Set(['id', 'swarmId', 'agentId', 'postId', 'title', 'bodyMd', 'attachmentsJson', 'createdAt'])],
  ['swarm_origins', new Set(['swarmId', 'conversationId', 'messageId', 'createdAt'])],
  ['swarm_replay_snapshots', new Set(['id', 'swarmId', 'label', 'frameIdx', 'createdAt'])],
]);

// ------------------------------------------------------------------
// Path anonymisation helpers (caveat 2)
// ------------------------------------------------------------------

/**
 * Anonymise the user's home-directory prefix in all string fields of a row.
 *
 * When `kv['sync.anonymisePaths'] === '1'`, any value of the form
 * `/Users/<username>/...` (macOS) or `C:\Users\<username>\...` (Windows) is
 * replaced with `~/...`. The replacement is best-effort — it only rewrites
 * values that start with `os.homedir()`. On pull, the `~/` prefix is left
 * as-is so the operator can re-attach the workspace by clicking it; expanding
 * `~/` on the receiving machine would embed that machine's username.
 */
function anonymiseRowPaths(rowData: Record<string, unknown>): Record<string, unknown> {
  const home = os.homedir();
  if (!home) return rowData;
  // Normalise trailing separator.
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rowData)) {
    if (typeof v === 'string' && v.startsWith(homeWithSep)) {
      result[k] = '~/' + v.slice(homeWithSep.length);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Read `kv['sync.anonymisePaths']` from the application DB.
 * Returns true when the value is '1'. Defaults to false if absent.
 */
function readAnonymisePaths(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(`SELECT value FROM kv WHERE key = ?`)
      .get('sync.anonymisePaths') as { value: string } | undefined;
    return row?.value === '1';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SyncConfig {
  remoteUrl: string;
  username?: string;
  password?: string;
  cloneDir: string;
}

export interface SyncStatus {
  enabled: boolean;
  lastPushAt?: number;
  lastPullAt?: number;
  lastError?: string;
  pendingConflicts: number;
  pendingUpgrade: number;
}

// ------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------

export class SyncEngine {
  private _config: SyncConfig | null = null;
  private _db: Database.Database;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _status: SyncStatus = { enabled: false, pendingConflicts: 0, pendingUpgrade: 0 };
  private _onStatusChange?: (s: SyncStatus) => void;

  constructor(db: Database.Database, onStatusChange?: (s: SyncStatus) => void) {
    this._db = db;
    this._onStatusChange = onStatusChange;
  }

  /**
   * Enable sync with the given config. Initialises the HLC with the
   * device's machine ID, clones the repo if needed, then starts the
   * periodic sync cycle.
   */
  async enable(config: SyncConfig): Promise<void> {
    if (this._running) return;
    this._config = config;
    this._status = { ...this._status, enabled: true };
    this._emit();

    // Initialise HLC with this device's machine ID.
    const machineId = await KeyManager.getMachineId();
    hlcInit(machineId);

    // Ensure the local clone exists.
    await KeyManager.withKey(async () => {
      await ensureRepo(config);
    });

    // Start the periodic cycle.
    this._scheduleNext();
  }

  /**
   * Disable sync. Stops the timer; local data is preserved.
   */
  disable(): void {
    this._config = null;
    this._status = { ...this._status, enabled: false };
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._emit();
  }

  getStatus(): SyncStatus {
    return { ...this._status };
  }

  // ------------------------------------------------------------------
  // Internal cycle
  // ------------------------------------------------------------------

  private _scheduleNext(): void {
    if (!this._status.enabled) return;
    const jitter = Math.floor(Math.random() * SYNC_JITTER_MS * 2) - SYNC_JITTER_MS;
    const delay = SYNC_INTERVAL_MS + jitter;
    this._timer = setTimeout(() => {
      void this._cycle().catch((err) => {
        this._status = {
          ...this._status,
          lastError: err instanceof Error ? err.message : String(err),
        };
        this._emit();
      }).finally(() => {
        this._scheduleNext();
      });
    }, delay);
  }

  /**
   * Run one full push + pull cycle. Called by the timer and can also be
   * triggered manually from tests or the settings UI.
   */
  async runCycle(): Promise<void> {
    return this._cycle();
  }

  private async _cycle(): Promise<void> {
    if (this._running) return; // skip if already running
    if (!this._config) return;

    this._running = true;
    const cloneDir = this._config.cloneDir;
    // Acquire process-level lock so two concurrent Electron instances cannot
    // race on the same clone directory. `realpath: false` avoids fs.realpath
    // calls on Windows where symlinks may be restricted.
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(cloneDir, { realpath: false });
      await this._pullCycle();
      await this._pushCycle();
    } finally {
      this._running = false;
      if (release) {
        try { await release(); } catch { /* best-effort lock release */ }
      }
    }
  }

  // ------------------------------------------------------------------
  // Pull cycle
  // ------------------------------------------------------------------

  private async _pullCycle(): Promise<void> {
    if (!this._config) return;

    // 1. Fetch remote changes.
    const pullResult = await pull(this._config);
    if (!pullResult.ok) {
      throw new Error(`sync pull failed: ${pullResult.error}`);
    }

    // 2. Process each blob in the working tree.
    const cloneDir = this._config.cloneDir;
    const blobPaths = listBlobs(cloneDir);

    await KeyManager.withKey(async (key) => {
      for (const relPath of blobPaths) {
        // Parse table + rowId from path: sync/blobs/<table>/<rowId>.bin
        const parts = relPath.split(path.sep);
        if (parts.length < 4) continue;
        const tableName = parts[parts.length - 2]!;
        const fileName = parts[parts.length - 1]!;
        const rowId = fileName.replace(/\.bin$/, '');

        // Skip non-synced tables (includes HARD-DENY tables).
        if (!SYNCED_TABLES.has(tableName)) continue;

        const payload = readBlob(cloneDir, tableName, rowId);
        if (!payload) continue;

        // --- Schema-skew gate (caveat 3): read outer header BEFORE AEAD ----
        // For v2 blobs the schema_version is in the unencrypted header.
        // If schema > local, route to sync_pending_upgrade without decrypting.
        // For v1 blobs (legacy), schema is inside the encrypted envelope; we
        // decrypt first, then check schema from the JSON envelope below.
        const headerPeek = peekHeader(payload);
        if (!headerPeek) {
          quarantineBlob(this._db, relPath, 'malformed');
          continue;
        }

        if (headerPeek.outerVersion === 2 && headerPeek.schemaVersion !== undefined) {
          if (headerPeek.schemaVersion > SCHEMA_VERSION) {
            // Schema mismatch: queue for future upgrade, don't decrypt.
            const upId = randomUUID();
            this._db
              .prepare(
                `INSERT OR IGNORE INTO sync_pending_upgrade
                   (id, blob_path, schema_version, queued_at)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(upId, relPath, headerPeek.schemaVersion, Date.now());
            continue;
          }
        }

        // Build the correct AAD for the blob's version:
        //   v2: "${table_name}|${row_id}"
        //   v1 (legacy): "${schema_version}|${table_name}|${row_id}" (schema from
        //     envelope JSON; for v1 we pass SCHEMA_VERSION as a best-effort since
        //     we haven't decrypted yet — this matches how v1 blobs were pushed).
        const aad =
          headerPeek.outerVersion === 2
            ? buildAad(tableName, rowId)
            : buildAadV1(SCHEMA_VERSION, tableName, rowId);

        const decResult = await decrypt({ key, payload, aad });

        if (!decResult.ok) {
          // AEAD failure → quarantine. NEVER apply.
          quarantineBlob(this._db, relPath, decResult.reason === 'malformed' ? 'malformed' : 'aead_fail');
          continue;
        }

        // Parse the row JSON.
        let rowJson: string;
        try {
          rowJson = new TextDecoder().decode(decResult.plaintext);
          JSON.parse(rowJson); // validate
        } catch {
          quarantineBlob(this._db, relPath, 'malformed');
          continue;
        }

        // Extract HLC from the JSON envelope.
        let hlcPacked: string;
        let schemaVersion: number;
        let machineIdHex: string;
        let rowData: Record<string, unknown>;
        try {
          const envelope = JSON.parse(rowJson) as {
            _hlc?: string;
            _schema?: number;
            _machineId?: string;
            data?: Record<string, unknown>;
          };
          hlcPacked = envelope._hlc ?? '';
          // v2: schemaVersion comes from the wire header (already checked above).
          // v1: fall back to the envelope _schema field.
          schemaVersion =
            headerPeek.outerVersion === 2 && headerPeek.schemaVersion !== undefined
              ? headerPeek.schemaVersion
              : (envelope._schema ?? SCHEMA_VERSION);
          machineIdHex = envelope._machineId ?? '0'.repeat(32);
          rowData = envelope.data ?? {};
        } catch {
          quarantineBlob(this._db, relPath, 'malformed');
          continue;
        }

        if (!hlcPacked) {
          quarantineBlob(this._db, relPath, 'malformed');
          continue;
        }

        // Update local HLC to account for remote's timestamp.
        try {
          const remoteHlc = hlcUnpack(hlcPacked);
          hlcRecv(remoteHlc);
        } catch {
          // HLC parse failure — quarantine.
          quarantineBlob(this._db, relPath, 'malformed');
          continue;
        }

        const remote: RemoteRow = {
          tableName,
          rowId,
          hlcPacked,
          machineId: Uint8Array.from(Buffer.from(machineIdHex, 'hex')),
          rowJson: JSON.stringify(rowData),
          schemaVersion,
        };

        const outcome = resolveRow(this._db, SCHEMA_VERSION, remote, relPath);

        if (outcome.action === 'apply_remote') {
          // Apply the remote row to the local DB.
          this._applyRemoteRow(tableName, rowId, rowData, hlcPacked);
        }
        // Other outcomes (keep_local, conflict, quarantine) are handled
        // by resolveRow writing to the appropriate sync_* tables.
      }
    });

    this._status = { ...this._status, lastPullAt: Date.now() };
    this._updatePendingCounts();
    this._emit();
  }

  // ------------------------------------------------------------------
  // Push cycle
  // ------------------------------------------------------------------

  private async _pushCycle(): Promise<void> {
    if (!this._config) return;

    const dirtyRows = listDirtyRows(this._db);
    if (dirtyRows.length === 0) return;

    const cloneDir = this._config.cloneDir;

    await KeyManager.withKey(async (key) => {
      // Encode the current dirty set + commit.
      let staged = await this._encodeDirtyRowsAndCommit(key, dirtyRows, cloneDir);
      if (staged.length === 0) {
        // Nothing to commit (all rows were skipped / no commit produced).
        return;
      }

      // Push (with one retry after a FULL reconcile on conflict).
      const pushResult = await push(this._config!);
      if (!pushResult.ok) {
        // BUG-3: push rejected because the peer pushed concurrently. A bare
        // pull() would only fetch into the git working tree and SKIP the
        // decrypt→resolveRow→_applyRemoteRow reconciliation, so the retry push
        // would overwrite (silently drop) the peer's edits. Instead run the
        // FULL pull cycle so remote rows are actually applied to the local DB,
        // THEN re-collect the dirty set (which now includes any rows the
        // reconciliation touched / re-dirtied) and re-stage + re-commit so the
        // newly-applied remote rows participate in the retry push.
        await this._pullCycle();
        const dirtyAfterReconcile = listDirtyRows(this._db);
        const restaged = await this._encodeDirtyRowsAndCommit(
          key,
          dirtyAfterReconcile,
          cloneDir,
        );
        // The rows to mark clean after a successful retry are whatever we just
        // re-staged (falls back to the original set if nothing new was staged,
        // e.g. the reconcile produced no further local changes).
        staged = restaged.length > 0 ? restaged : staged;

        const retryResult = await push(this._config!);
        if (!retryResult.ok) {
          throw new Error(`sync push failed after retry: ${retryResult.error}`);
        }
      }

      // Mark all successfully-pushed rows as clean.
      const pushedAt = Date.now();
      for (const row of staged) {
        markClean(this._db, row.table_name, row.row_id, pushedAt);
      }
    });

    this._status = { ...this._status, lastPushAt: Date.now() };
    this._emit();
  }

  /**
   * Encrypt + write each dirty row to the working tree, then stage + commit.
   *
   * Shared by the initial push and the post-reconcile retry path (BUG-3) so the
   * retry re-encodes the CURRENT dirty set (which may now include remote rows
   * applied by `_pullCycle()`) rather than reusing the stale pre-reconcile blobs.
   *
   * @returns the dirty rows that were committed (empty if `stageAndCommit`
   *   produced no commit — e.g. all rows were deleted/skipped and no change was
   *   staged), so the caller knows which rows to mark clean after a successful push.
   */
  private async _encodeDirtyRowsAndCommit(
    key: Uint8Array,
    dirtyRows: ReturnType<typeof listDirtyRows>,
    cloneDir: string,
  ): Promise<ReturnType<typeof listDirtyRows>> {
    if (dirtyRows.length === 0) return [];

    // Read anonymise-paths setting once (avoids per-row lookup).
    const doAnonymise = readAnonymisePaths(this._db);

    for (const row of dirtyRows) {
      const { table_name: tableName, row_id: rowId } = row;

      // Read the row from the application table.
      let rowData: Record<string, unknown>;
      try {
        rowData = this._db
          .prepare(`SELECT * FROM ${tableName} WHERE id = ?`)
          .get(rowId) as Record<string, unknown>;
        if (!rowData) {
          // Row was deleted since we marked it dirty — write tombstone instead.
          const hlc = hlcNow();
          const packed = hlcPack(hlc);
          writeTombstoneToWorkTree(cloneDir, tableName, rowId, packed);
          markDeleted(this._db, tableName, rowId, packed);
          continue;
        }
      } catch {
        continue; // unknown table shape — skip
      }

      // Optionally anonymise home-directory paths before encryption.
      const serialisedData = doAnonymise ? anonymiseRowPaths(rowData) : rowData;

      // Generate HLC for this write.
      const hlc = hlcNow();
      const hlcPacked = hlcPack(hlc);

      // Build the sync envelope: row data + metadata.
      const machineIdHex = Buffer.from(hlc.machineId).toString('hex');
      const envelope = {
        _hlc: hlcPacked,
        _schema: SCHEMA_VERSION,
        _machineId: machineIdHex,
        data: serialisedData,
      };
      const plaintext = JSON.stringify(envelope);
      // v2 AAD: "${table_name}|${row_id}" (schema_version is in the outer header).
      const aad = buildAad(tableName, rowId);

      const { payload } = await encrypt({ key, plaintext, aad, schemaVersion: SCHEMA_VERSION });
      writeBlobToWorkTree(cloneDir, tableName, rowId, payload);
    }

    const oid = await stageAndCommit(cloneDir, `sigma-sync: push ${dirtyRows.length} rows`);
    return oid ? dirtyRows : [];
  }

  // ------------------------------------------------------------------
  // Apply remote row
  // ------------------------------------------------------------------

  private _applyRemoteRow(
    tableName: string,
    rowId: string,
    rowData: Record<string, unknown>,
    hlcPacked: string,
  ): void {
    // Defense-in-depth: filter columns through the per-table allowlist (caveat 4).
    // Unknown columns (from a future schema or tampered blob) are dropped rather
    // than interpolated into SQL. tableName is already bounded by SYNCED_TABLES.
    const allowed = COLUMN_ALLOWLIST.get(tableName);
    let filteredData = rowData;
    if (allowed) {
      const unknownCols = Object.keys(rowData).filter((c) => !allowed.has(c));
      if (unknownCols.length > 0) {
        console.warn(
          `[sync] _applyRemoteRow: dropping unknown columns for ${tableName}: ${unknownCols.join(', ')}`,
        );
        filteredData = Object.fromEntries(
          Object.entries(rowData).filter(([c]) => allowed.has(c)),
        );
      }
    }

    // Build column list from the filtered row data.
    const columns = Object.keys(filteredData);
    if (columns.length === 0) return;

    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((c) => filteredData[c] ?? null);

    // Upsert the row using INSERT OR REPLACE (all columns present).
    try {
      this._db
        .prepare(
          `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
        )
        .run(...values);
    } catch {
      // Schema mismatch — row might have columns we don't know about.
      // Quarantine is handled upstream (schema_version check in resolveRow).
      return;
    }

    // Record in sync_history.
    this._db
      .prepare(
        `INSERT INTO sync_history (id, table_name, row_id, applied_at, source)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), tableName, rowId, Date.now(), 'remote');

    // Update sync_state for the applied row.
    const hlc = hlcUnpack(hlcPacked);
    this._db
      .prepare(
        `INSERT INTO sync_state
           (table_name, row_id, hlc_wall_ms, hlc_logical, hlc_machine_id, row_hash, dirty)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (table_name, row_id) DO UPDATE SET
           hlc_wall_ms    = excluded.hlc_wall_ms,
           hlc_logical    = excluded.hlc_logical,
           hlc_machine_id = excluded.hlc_machine_id,
           row_hash       = excluded.row_hash,
           dirty          = 0`,
      )
      .run(
        tableName,
        rowId,
        hlc.wallMs,
        hlc.logical,
        Buffer.from(hlc.machineId).toString('hex'),
        hlcPacked, // use packed as hash for now — fine for tracking
      );
  }

  // ------------------------------------------------------------------
  // GC helpers
  // ------------------------------------------------------------------

  /**
   * GC sync_tombstones older than 30 days.
   */
  gcTombstones(): number {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const result = this._db
      .prepare(`DELETE FROM sync_tombstones WHERE deleted_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  /**
   * GC sync_history older than 30 days.
   */
  gcHistory(): number {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const result = this._db
      .prepare(`DELETE FROM sync_history WHERE applied_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private _updatePendingCounts(): void {
    try {
      const conflicts = (
        this._db
          .prepare(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0`)
          .get() as { n: number }
      ).n;
      const upgrades = (
        this._db
          .prepare(`SELECT COUNT(*) AS n FROM sync_pending_upgrade`)
          .get() as { n: number }
      ).n;
      this._status = { ...this._status, pendingConflicts: conflicts, pendingUpgrade: upgrades };
    } catch {
      // DB might not have the tables yet on first run.
    }
  }

  private _emit(): void {
    this._onStatusChange?.({ ...this._status });
  }
}
