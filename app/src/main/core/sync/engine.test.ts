// v1.5.0 packet 09 — SyncEngine tests (unit-level, mocked deps).

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SyncEngine } from './engine';

// ------------------------------------------------------------------
// Mocks
// ------------------------------------------------------------------

vi.mock('./key-manager', () => ({
  KeyManager: {
    getMachineId: vi.fn(async () => new Uint8Array(16)),
    withKey: vi.fn(async (fn: (key: Uint8Array) => Promise<unknown>) => {
      return fn(new Uint8Array(32));
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
  stageAndCommit: vi.fn(async () => null),
  readBlob: vi.fn(() => null),
  listBlobs: vi.fn(() => []),
}));

vi.mock('./crypto', () => ({
  encrypt: vi.fn(async ({ plaintext }: { plaintext: string }) => ({
    payload: Buffer.from(plaintext),
  })),
  decrypt: vi.fn(async ({ payload }: { payload: Buffer }) => ({
    ok: true,
    plaintext: new Uint8Array(payload),
  })),
  buildAad: vi.fn((schema: number, table: string, row: string) => `${schema}|${table}|${row}`),
}));

vi.mock('./hlc', () => ({
  init: vi.fn(),
  now: vi.fn(() => ({ wallMs: Date.now(), logical: 0, machineId: new Uint8Array(16) })),
  recv: vi.fn((h: unknown) => h),
  pack: vi.fn(() => '0'.repeat(52)),
  unpack: vi.fn(() => ({ wallMs: Date.now(), logical: 0, machineId: new Uint8Array(16) })),
}));

vi.mock('./dirty-tracker', () => ({
  listDirtyRows: vi.fn(() => []),
  markClean: vi.fn(),
  markDeleted: vi.fn(),
  SYNCED_TABLES: new Set(['conversations', 'tasks']),
}));

vi.mock('./conflict-resolver', () => ({
  resolveRow: vi.fn(() => ({ action: 'apply_remote', reason: 'new row' })),
  quarantineBlob: vi.fn(),
}));

// ------------------------------------------------------------------
// Minimal mock DB
// ------------------------------------------------------------------

class MockDb {
  data = new Map<string, unknown>();

  prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    return {
      run: () => ({ changes: 0 }),
      get: (): unknown => {
        if (norm.includes('COUNT(*)')) return { n: 0 };
        return undefined;
      },
      all: () => [],
    };
  }
}

let db: MockDb;
let engine: SyncEngine;
const config = { remoteUrl: 'https://example.com/repo.git', cloneDir: '/tmp/sync-test' };

beforeEach(async () => {
  db = new MockDb();
  engine = new SyncEngine(db as never);
  vi.clearAllMocks();
  // Re-apply mock return values after clearAllMocks
  const gitClient = vi.mocked(await import('./git-client'));
  gitClient.pull.mockResolvedValue({ ok: true, updatedPaths: [] });
  gitClient.push.mockResolvedValue({ ok: true });
  gitClient.listBlobs.mockReturnValue([]);
  gitClient.stageAndCommit.mockResolvedValue(null);
});

describe('SyncEngine.enable', () => {
  it('sets status.enabled = true', async () => {
    await engine.enable(config);
    expect(engine.getStatus().enabled).toBe(true);
    engine.disable();
  });
});

describe('SyncEngine.disable', () => {
  it('sets status.enabled = false', async () => {
    await engine.enable(config);
    engine.disable();
    expect(engine.getStatus().enabled).toBe(false);
  });
});

describe('SyncEngine.runCycle', () => {
  it('runs without error when no dirty rows and no remote blobs', async () => {
    await engine.enable(config);
    await expect(engine.runCycle()).resolves.not.toThrow();
    engine.disable();
  });

  it('updates lastPullAt after a successful pull', async () => {
    await engine.enable(config);
    const before = Date.now();
    await engine.runCycle();
    const after = Date.now();
    const status = engine.getStatus();
    expect(status.lastPullAt).toBeGreaterThanOrEqual(before);
    expect(status.lastPullAt).toBeLessThanOrEqual(after);
    engine.disable();
  });
});

describe('SyncEngine.getStatus', () => {
  it('returns initial status with enabled=false', () => {
    const status = engine.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.pendingConflicts).toBe(0);
  });
});

describe('SyncEngine.gcTombstones', () => {
  it('returns 0 when no tombstones', () => {
    const count = engine.gcTombstones();
    expect(count).toBe(0);
  });
});

describe('SyncEngine.gcHistory', () => {
  it('returns 0 when no history', () => {
    const count = engine.gcHistory();
    expect(count).toBe(0);
  });
});
