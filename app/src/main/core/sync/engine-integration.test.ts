// v1.5.2-C — Engine-level integration tests (reviewer follow-up for v1.5.1 PR #57).
//
// Purpose: verify the schema-skew gate, column-allowlist drop, anonymise toggle,
// and v1-blob apply path at the ENGINE level — using the REAL crypto module
// (not mocked), so the integration path is genuinely exercised end-to-end.
//
// Better-sqlite3 native module is not built in the test environment (Electron ABI
// is separate from the plain Node ABI used by Vitest). Consequently, we use a
// capable in-memory MockDb that faithfully implements the subset of SQLite
// semantics the engine actually exercises.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { SyncEngine } from './engine';
import { encrypt, buildAad, buildAadV1 } from './crypto';

// ------------------------------------------------------------------
// Mocks — keep identical to engine.test.ts EXCEPT crypto is NOT mocked.
// ------------------------------------------------------------------

vi.mock('./key-manager', () => ({
  KeyManager: {
    getMachineId: vi.fn(async () => new Uint8Array(16)),
    withKey: vi.fn(async (fn: (key: Uint8Array) => Promise<unknown>) => {
      return fn(TEST_KEY);
    }),
    isConfigured: vi.fn(async () => true),
  },
}));

vi.mock('./git-client', () => ({
  ensureRepo: vi.fn(async () => undefined),
  pull: vi.fn(async () => ({ ok: true, updatedPaths: [] })),
  push: vi.fn(async () => ({ ok: true })),
  writeBlobToWorkTree: vi.fn(() => 'sync/blobs/table/row.bin'),
  writeTombstoneToWorkTree: vi.fn(() => 'sync/tombstones/table/row.tomb'),
  stageAndCommit: vi.fn(async () => 'abc123'),
  readBlob: vi.fn(() => null),
  listBlobs: vi.fn(() => []),
}));

vi.mock('./hlc', () => ({
  init: vi.fn(),
  now: vi.fn(() => ({
    wallMs: 1_700_000_000_000,
    logical: 0,
    machineId: new Uint8Array(16),
  })),
  recv: vi.fn((h: unknown) => h),
  pack: vi.fn(() => '0'.repeat(52)),
  unpack: vi.fn(() => ({
    wallMs: 1_700_000_000_000,
    logical: 0,
    machineId: new Uint8Array(16),
  })),
}));

vi.mock('./dirty-tracker', () => ({
  listDirtyRows: vi.fn(() => []),
  markClean: vi.fn(),
  markDeleted: vi.fn(),
  SYNCED_TABLES: new Set(['conversations', 'tasks', 'workspaces', 'memories']),
}));

vi.mock('./conflict-resolver', () => ({
  resolveRow: vi.fn(() => ({ action: 'apply_remote', reason: 'new row' })),
  quarantineBlob: vi.fn(),
}));

// proper-lockfile: bypass filesystem locking in tests.
vi.mock('proper-lockfile', () => ({
  default: {
    lock: vi.fn(async () => async () => undefined),
  },
}));

// ------------------------------------------------------------------
// Fixed 32-byte test key (all 0x42 bytes — never used outside tests).
// ------------------------------------------------------------------

const TEST_KEY = new Uint8Array(32).fill(0x42);

// SCHEMA_VERSION as declared in engine.ts — must stay in sync.
const SCHEMA_VERSION = 19;

// ------------------------------------------------------------------
// Capable in-memory MockDb
//
// Stores data in typed Maps and handles the SQL patterns the engine uses.
// Supports: INSERT OR IGNORE/REPLACE, SELECT * FROM <table> WHERE id = ?,
// SELECT COUNT(*) AS n FROM <table>, SELECT value FROM kv WHERE key = ?,
// upserts on sync_state, sync_history, and the core application tables.
// ------------------------------------------------------------------

class InMemoryDb {
  // Per-table row stores.  Key = row's `id` column (or composite for
  // tables without a single 'id').
  private tables = new Map<string, Map<string, Record<string, unknown>>>();
  // kv store mirrors the `kv` table.
  kv = new Map<string, string>();

  private getTable(name: string): Map<string, Record<string, unknown>> {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
    }
    return this.tables.get(name)!;
  }

  /** Return all rows in a table. */
  allRows(tableName: string): Record<string, unknown>[] {
    return Array.from(this.getTable(tableName).values());
  }

  /** Return the first row in a table whose 'id' matches. */
  getRow(tableName: string, id: string): Record<string, unknown> | undefined {
    return this.getTable(tableName).get(id);
  }

  // ----------------------------------------------------------------
  // SQLite-style prepare() — returns a statement object.
  // ----------------------------------------------------------------

  prepare(sql: string) {
    const norm = sql
      .replace(/\s+/g, ' ')
      .trim();
    // Capture the instance in a typed reference for use inside the returned object.
    const self: InMemoryDb = this; // eslint-disable-line @typescript-eslint/no-this-alias

    return {
      run: (...args: unknown[]) => {
        const up = norm.toUpperCase();

        // ── kv table ───────────────────────────────────────────────
        if (up.includes('SELECT VALUE FROM KV')) {
          // handled by .get()
          return { changes: 0 };
        }
        if (up.startsWith('INSERT') && up.includes('INTO KV')) {
          const key = args[0] as string;
          const val = args[1] as string;
          self.kv.set(key, val);
          return { changes: 1 };
        }

        // ── sync_pending_upgrade ───────────────────────────────────
        if (up.startsWith('INSERT') && up.includes('INTO SYNC_PENDING_UPGRADE')) {
          const [id, blobPath, schemaVersion, queuedAt] = args as [string, string, number, number];
          const tbl = self.getTable('sync_pending_upgrade');
          if (!tbl.has(id)) {
            tbl.set(id, { id, blob_path: blobPath, schema_version: schemaVersion, queued_at: queuedAt });
          }
          return { changes: 1 };
        }

        // ── sync_quarantine ────────────────────────────────────────
        if (up.startsWith('INSERT') && up.includes('INTO SYNC_QUARANTINE')) {
          const [id, blobPath, reason, detectedAt] = args as [string, string, string, number];
          const tbl = self.getTable('sync_quarantine');
          if (!tbl.has(id)) {
            tbl.set(id, { id, blob_path: blobPath, reason, detected_at: detectedAt });
          }
          return { changes: 1 };
        }

        // ── sync_history ───────────────────────────────────────────
        if (up.startsWith('INSERT') && up.includes('INTO SYNC_HISTORY')) {
          const [id, tableName, rowId, appliedAt, source] = args as [string, string, string, number, string];
          self.getTable('sync_history').set(id, { id, table_name: tableName, row_id: rowId, applied_at: appliedAt, source });
          return { changes: 1 };
        }

        // ── sync_state upsert ──────────────────────────────────────
        if (up.startsWith('INSERT') && up.includes('INTO SYNC_STATE')) {
          const [tableName, rowId] = args as [string, string];
          const key = `${tableName}:${rowId}`;
          self.getTable('sync_state').set(key, { table_name: tableName, row_id: rowId, dirty: 0 });
          return { changes: 1 };
        }

        // ── application table upsert (INSERT OR REPLACE INTO <table>) ─
        // Matches "INSERT OR REPLACE INTO <tableName> (<cols>) VALUES (…)"
        if (up.startsWith('INSERT OR REPLACE INTO')) {
          // Extract table name from SQL (raw sql, not uppercased).
          const tableMatch = norm.match(/INSERT OR REPLACE INTO (\w+)/i);
          const colMatch = norm.match(/\(([^)]+)\)\s+VALUES/i);
          if (tableMatch && colMatch) {
            const tableName = tableMatch[1]!;
            const cols = colMatch[1]!.split(',').map((c) => c.trim());
            const row: Record<string, unknown> = {};
            cols.forEach((c, i) => { row[c] = args[i] ?? null; });
            const rowId = (row['id'] as string) ?? (args[0] as string);
            self.getTable(tableName).set(rowId, row);
          }
          return { changes: 1 };
        }

        // ── GC / DELETE / UPDATE — no-op for integration tests ────
        return { changes: 0 };
      },

      get: (...args: unknown[]): unknown => {
        const up = norm.toUpperCase();

        // kv lookup
        if (up.includes('SELECT VALUE FROM KV WHERE KEY')) {
          const key = args[0] as string;
          const val = self.kv.get(key);
          return val !== undefined ? { value: val } : undefined;
        }

        // COUNT(*) queries
        if (up.includes('COUNT(*)')) {
          if (up.includes('SYNC_CONFLICTS')) return { n: 0 };
          if (up.includes('SYNC_PENDING_UPGRADE')) {
            return { n: self.getTable('sync_pending_upgrade').size };
          }
          return { n: 0 };
        }

        // SELECT * FROM <table> WHERE id = ?
        if (up.startsWith('SELECT * FROM')) {
          const tableMatch = norm.match(/SELECT \* FROM (\w+) WHERE id/i);
          if (tableMatch) {
            const tableName = tableMatch[1]!;
            const rowId = args[0] as string;
            return self.getTable(tableName).get(rowId) ?? null;
          }
        }

        return undefined;
      },

      all: (): unknown[] => {
        const up = norm.toUpperCase();
        if (up.includes('SYNC_STATE') && up.includes('DIRTY = 1')) {
          return Array.from(self.getTable('sync_state').values()).filter((r) => r.dirty === 1);
        }
        return [];
      },
    };
  }
}

// ------------------------------------------------------------------
// Shared test helpers
// ------------------------------------------------------------------

const CLONE_DIR = '/tmp/sync-integration-test';
const CONFIG = { remoteUrl: 'https://example.com/repo.git', cloneDir: CLONE_DIR };

/** Build a v2 encrypted blob for a given table/row/payload. */
async function buildV2Blob(
  tableName: string,
  rowId: string,
  rowData: Record<string, unknown>,
  schemaVersion: number,
): Promise<Buffer> {
  const hlcPacked = '0'.repeat(52);
  const machineIdHex = '0'.repeat(32);
  const envelope = {
    _hlc: hlcPacked,
    _schema: schemaVersion,
    _machineId: machineIdHex,
    data: rowData,
  };
  const plaintext = JSON.stringify(envelope);
  const aad = buildAad(tableName, rowId);
  const { payload } = await encrypt({ key: TEST_KEY, plaintext, aad, schemaVersion });
  return payload;
}

/** Build a v1 (legacy) encrypted blob. */
async function buildV1Blob(
  tableName: string,
  rowId: string,
  rowData: Record<string, unknown>,
): Promise<Buffer> {
  // v1 AAD includes schema version.
  const aad = buildAadV1(SCHEMA_VERSION, tableName, rowId);
  const hlcPacked = '0'.repeat(52);
  const machineIdHex = '0'.repeat(32);
  const envelope = {
    _hlc: hlcPacked,
    _schema: SCHEMA_VERSION,
    _machineId: machineIdHex,
    data: rowData,
  };
  const plaintext = JSON.stringify(envelope);

  // Manually build a v1 wire-format blob:
  //   MAGIC(4) | OUTER_VERSION=1(1) | NONCE(24) | CT+TAG(N+16)
  // We use the crypto module's internal constants by re-implementing the
  // v1 encrypt path here. The real crypto.ts uses PAYLOAD_VERSION = v2
  // for new writes; to produce a genuine v1 blob we must write the header
  // ourselves using the same libsodium primitive.
  const sodium = await import('libsodium-wrappers-sumo');
  await sodium.default.ready;
  const lib = sodium.default;

  const MAGIC = Buffer.from([0x53, 0x47, 0x53, 0x59]);
  const nonce = lib.randombytes_buf(24);
  const aadBytes = lib.from_string(aad);
  const ptBytes = lib.from_string(plaintext);
  const ctWithTag = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ptBytes, aadBytes, null, nonce, TEST_KEY,
  );
  return Buffer.concat([
    MAGIC,
    Buffer.from([1]), // OUTER_VERSION = 1
    Buffer.from(nonce),
    Buffer.from(ctWithTag),
  ]);
}

/** Simulate the engine pull cycle receiving a single blob. */
async function simulatePullWithBlob(
  engine: SyncEngine,
  tableName: string,
  rowId: string,
  payload: Buffer,
): Promise<void> {
  const gitClient = vi.mocked(await import('./git-client'));
  const relPath = path.join('sync', 'blobs', tableName, `${rowId}.bin`);
  // listBlobs returns relative paths in the format the engine parses.
  gitClient.listBlobs.mockReturnValue([relPath]);
  gitClient.readBlob.mockReturnValue(payload);
  await engine.runCycle();
  // Reset mocks for next test.
  gitClient.listBlobs.mockReturnValue([]);
  gitClient.readBlob.mockReturnValue(null);
}

// ------------------------------------------------------------------
// Test suite
// ------------------------------------------------------------------

describe('integration paths (v1.5.1 reviewer follow-up)', () => {
  let db: InMemoryDb;
  let engine: SyncEngine;

  beforeEach(async () => {
    db = new InMemoryDb();
    engine = new SyncEngine(db as never);
    vi.clearAllMocks();

    // Re-apply mock return values after clearAllMocks.
    const gitClient = vi.mocked(await import('./git-client'));
    gitClient.pull.mockResolvedValue({ ok: true, updatedPaths: [] });
    gitClient.push.mockResolvedValue({ ok: true });
    gitClient.listBlobs.mockReturnValue([]);
    gitClient.readBlob.mockReturnValue(null);
    gitClient.stageAndCommit.mockResolvedValue('abc123');

    // Re-apply lockfile mock — cast to any since proper-lockfile types don't expose mock methods.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lockfile = (await import('proper-lockfile')) as any;
    lockfile.default.lock.mockResolvedValue(async () => undefined);

    // Re-apply KeyManager mock — cast to any for mock access.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { KeyManager } = (await import('./key-manager')) as any;
    KeyManager.withKey.mockImplementation(async (fn: (key: Uint8Array) => Promise<unknown>) => fn(TEST_KEY));
    KeyManager.getMachineId.mockResolvedValue(new Uint8Array(16));
    KeyManager.isConfigured.mockResolvedValue(true);

    await engine.enable(CONFIG);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 1 — Schema-skew routing
  //
  // A v2 blob whose unencrypted header carries schemaVersion > SCHEMA_VERSION
  // must be inserted into sync_pending_upgrade, NOT sync_quarantine, and the
  // row must NOT appear in the target table (workspaces).
  // ──────────────────────────────────────────────────────────────────────
  it('routes v2 blob with future schema to sync_pending_upgrade, not quarantine or target table', async () => {
    const tableName = 'workspaces';
    const rowId = 'ws-skew-01';
    const futureSchema = SCHEMA_VERSION + 10; // clearly in the future

    const payload = await buildV2Blob(tableName, rowId, { id: rowId, name: 'Skew WS', root_path: '/tmp/skew' }, futureSchema);
    await simulatePullWithBlob(engine, tableName, rowId, payload);

    // Row must have been inserted into sync_pending_upgrade.
    const pendingRows = db.allRows('sync_pending_upgrade');
    expect(pendingRows.length).toBeGreaterThanOrEqual(1);
    const pending = pendingRows.find((r) => r.blob_path?.toString().includes(rowId));
    expect(pending).toBeDefined();
    expect(pending!.schema_version).toBe(futureSchema);

    // Row must NOT have been inserted into sync_quarantine.
    const quarantine = db.allRows('sync_quarantine');
    expect(quarantine.length).toBe(0);

    // Row must NOT have been applied to the target table.
    expect(db.getRow('workspaces', rowId)).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 2 — Column allowlist drop
  //
  // A v2 blob whose decrypted payload includes a column NOT in the
  // COLUMN_ALLOWLIST (e.g. `attack_vector` on `workspaces`) must be inserted
  // with only allowlisted columns; the unknown column must be dropped and a
  // console.warn must be emitted.
  // ──────────────────────────────────────────────────────────────────────
  it('drops unknown columns from decrypted payload and emits a console.warn', async () => {
    const tableName = 'workspaces';
    const rowId = 'ws-allowlist-01';

    // Include an extra column that is NOT in the COLUMN_ALLOWLIST.
    const rowData = {
      id: rowId,
      name: 'Allowlist WS',
      root_path: '/tmp/allowlist',
      repo_mode: 'plain',
      created_at: 1_700_000_000_000,
      last_opened_at: 1_700_000_000_000,
      attack_vector: 'DROP TABLE workspaces; --', // NOT in allowlist
    };

    const payload = await buildV2Blob(tableName, rowId, rowData, SCHEMA_VERSION);

    // Spy on console.warn to verify the warning is emitted.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // resolveRow mock returns 'apply_remote' so the engine calls _applyRemoteRow.
    const { resolveRow } = vi.mocked(await import('./conflict-resolver'));
    resolveRow.mockReturnValue({ action: 'apply_remote', reason: 'new row' });

    await simulatePullWithBlob(engine, tableName, rowId, payload);

    // console.warn should have been called with mention of the unknown column.
    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((msg) => msg.includes('attack_vector'))).toBe(true);

    // The row must have been inserted.
    const applied = db.getRow('workspaces', rowId);
    expect(applied).toBeDefined();

    // The unknown column must NOT appear in the stored row.
    expect(Object.keys(applied!)).not.toContain('attack_vector');

    // The allowlisted columns that were present must be in the stored row.
    expect(applied!['id']).toBe(rowId);
    expect(applied!['name']).toBe('Allowlist WS');

    warnSpy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 3 — Anonymise toggle
  //
  // With kv['sync.anonymisePaths'] = '1', the push cycle must replace the
  // user's home-directory prefix with '~/'.
  // With kv['sync.anonymisePaths'] = '0', the path must be preserved as-is.
  // ──────────────────────────────────────────────────────────────────────
  it('anonymises home-directory paths on push when sync.anonymisePaths = 1', async () => {
    const home = os.homedir();
    const absolutePath = path.join(home, 'foo', 'bar.md');
    const expectedAnonymised = '~/foo/bar.md';
    const tableName = 'workspaces';
    const rowId = 'ws-anon-01';

    // Place the row in the DB — the push cycle reads it via SELECT *.
    db.prepare(`INSERT OR REPLACE INTO ${tableName} (id, name, root_path, repo_mode, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rowId, 'Anon WS', absolutePath, 'plain', 1_700_000_000_000, 1_700_000_000_000);

    // Mark the row as dirty.
    const dirtyTracker = vi.mocked(await import('./dirty-tracker'));
    dirtyTracker.listDirtyRows.mockReturnValue([{ table_name: tableName, row_id: rowId, dirty: 1 }]);

    // Set anonymise = '1'.
    db.kv.set('sync.anonymisePaths', '1');

    // Capture the payload written to the blob tree.
    const { writeBlobToWorkTree } = vi.mocked(await import('./git-client'));
    let capturedPayload: Buffer | null = null;
    writeBlobToWorkTree.mockImplementation((_cloneDir: string, _table: string, _row: string, payload: Buffer) => {
      capturedPayload = payload;
      return 'sync/blobs/workspaces/ws-anon-01.bin';
    });

    await engine.runCycle();

    // Decrypt and verify the path was anonymised.
    expect(capturedPayload).not.toBeNull();
    const { decrypt } = await import('./crypto');
    const aad = buildAad(tableName, rowId);
    const decResult = await decrypt({ key: TEST_KEY, payload: capturedPayload!, aad });
    expect(decResult.ok).toBe(true);
    if (decResult.ok) {
      const envelope = JSON.parse(new TextDecoder().decode(decResult.plaintext)) as {
        data: Record<string, unknown>;
      };
      expect(envelope.data['root_path']).toBe(expectedAnonymised);
      expect(envelope.data['root_path']).not.toContain(home);
    }

    // Now verify with anonymise = '0': path must be preserved.
    db.kv.set('sync.anonymisePaths', '0');
    capturedPayload = null;
    dirtyTracker.listDirtyRows.mockReturnValue([{ table_name: tableName, row_id: rowId, dirty: 1 }]);

    await engine.runCycle();

    expect(capturedPayload).not.toBeNull();
    const decResult2 = await decrypt({ key: TEST_KEY, payload: capturedPayload!, aad });
    expect(decResult2.ok).toBe(true);
    if (decResult2.ok) {
      const envelope2 = JSON.parse(new TextDecoder().decode(decResult2.plaintext)) as {
        data: Record<string, unknown>;
      };
      expect(envelope2.data['root_path']).toBe(absolutePath);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Test 4 — v1 blob on v2-aware client (full engine apply path)
  //
  // A v1-encoded blob (OUTER_VERSION = 1) must be decoded by the engine and
  // applied to the target table without error. This exercises the FULL engine
  // pull path (peekHeader → buildAadV1 → decrypt → resolveRow → _applyRemoteRow)
  // — distinct from the crypto-unit round-trip tests in crypto.test.ts which
  // only verify that crypto.decrypt() accepts v1 payloads.
  // ──────────────────────────────────────────────────────────────────────
  it('applies v1-encoded blobs through the full engine pull path (backward-compat)', async () => {
    const tableName = 'conversations';
    const rowId = 'conv-v1-legacy-01';
    const rowData = {
      id: rowId,
      workspace_id: 'ws-1',
      kind: 'assistant',
      created_at: 1_700_000_000_000,
    };

    const v1Payload = await buildV1Blob(tableName, rowId, rowData);

    // resolveRow mock returns 'apply_remote'.
    const { resolveRow } = vi.mocked(await import('./conflict-resolver'));
    resolveRow.mockReturnValue({ action: 'apply_remote', reason: 'new row' });

    await simulatePullWithBlob(engine, tableName, rowId, v1Payload);

    // Row must have been applied to the target table.
    const applied = db.getRow('conversations', rowId);
    expect(applied).toBeDefined();
    expect(applied!['id']).toBe(rowId);
    expect(applied!['workspace_id']).toBe('ws-1');
    expect(applied!['kind']).toBe('assistant');

    // Must NOT have been quarantined.
    expect(db.allRows('sync_quarantine').length).toBe(0);
  });
});
