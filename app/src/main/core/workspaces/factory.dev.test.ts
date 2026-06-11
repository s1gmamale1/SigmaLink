// Tests for openDevWorkspace (SigmaLink Dev singleton factory).
//
// openDevWorkspace inserts a forced-plain workspace at os.homedir(), pointed
// to by a KV row, with ZERO open side effects (no MCP autowrite, no ruflo
// trust, no memory seeding, no git probe).
//
// better-sqlite3 cannot load under vitest (Electron ABI) — all DB interaction
// is mocked via the same harness as factory.test.ts.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external modules BEFORE importing factory.ts
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  },
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual };
});

vi.mock('node:os', () => ({
  default: { homedir: vi.fn(() => '/home/testuser') },
  homedir: vi.fn(() => '/home/testuser'),
}));

let _uuidCounter = 0;
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => `uuid-${++_uuidCounter}`),
}));

vi.mock('../git/git-ops', () => ({
  getRepoRoot: vi.fn(async () => null),
}));

vi.mock('./mcp-autowrite', () => ({
  KV_RUFLO_AUTOWRITE_MCP: 'ruflo.autowriteMcp',
  KV_RUFLO_AUTOTRUST_MCP: 'ruflo.autotrustMcp',
  writeWorkspaceMcpConfig: vi.fn(),
}));
vi.mock('./mcp-trust', () => ({ ensureRufloTrusted: vi.fn() }));
vi.mock('./ruflo-fallback-notice', () => ({ maybeNotifyStdioFallback: vi.fn() }));
vi.mock('../ruflo/seed-workspace-memory', () => ({ seedWorkspaceMemory: vi.fn(async () => {}) }));
vi.mock('../ruflo/verify', () => ({
  KV_RUFLO_STRICT_MCP_VERIFICATION: 'ruflo.strictMcpVerification',
  verifyForWorkspace: vi.fn(async () => ({ ok: true })),
}));

// ---------------------------------------------------------------------------
// Fake drizzle db + raw db — captured insert/select/update calls
// ---------------------------------------------------------------------------

interface FakeWorkspaceRow {
  id: string;
  name: string;
  rootPath: string;
  repoRoot: string | null;
  repoMode: 'git' | 'plain';
  createdAt: number;
  lastOpenedAt: number;
}

let _dbRows: FakeWorkspaceRow[] = [];
let _insertMock: Mock;
let _selectMock: Mock;
let _updateMock: Mock;
let _rawDbPrepare: Mock;
let _rawDbPragma: Mock;

// Tracks KV state for the raw db prepare mock per test.
// key → { value: string } | undefined
let _kvStore: Map<string, string> = new Map();
// Tracks how many times the KV upsert was run.
let _kvUpsertRuns: { key: string; value: string }[] = [];

function resetDb() {
  _dbRows = [];
  _kvStore = new Map();
  _kvUpsertRuns = [];

  _insertMock = vi.fn();
  _updateMock = vi.fn();
  _rawDbPragma = vi.fn();

  // prepare() is called for two purposes:
  //   1. SELECT value FROM kv WHERE key = ?  → .get(key)
  //   2. INSERT INTO kv ... ON CONFLICT ...  → .run(key, value)
  _rawDbPrepare = vi.fn((sql: string) => {
    if (typeof sql === 'string' && sql.trim().toUpperCase().startsWith('SELECT')) {
      return {
        get: vi.fn((key: string) => {
          const v = _kvStore.get(key);
          return v !== undefined ? { value: v } : undefined;
        }),
      };
    }
    // INSERT/upsert
    return {
      run: vi.fn((key: string, value: string) => {
        _kvStore.set(key, value);
        _kvUpsertRuns.push({ key, value });
      }),
    };
  });

  // select().from().where().get() — looks up by id in _dbRows
  _selectMock = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        get: vi.fn(() => {
          // Return the last inserted row as a safe default (matches the
          // original factory.test.ts behaviour for openWorkspaceNew path).
          // Tests that need a specific lookup override _selectMockFindById.
          return _selectMockFindById ? _selectMockFindById() : (_dbRows[_dbRows.length - 1] ?? null);
        }),
        all: vi.fn(() => _dbRows),
      })),
    })),
  }));

  // insert().values().run() — capture the row
  const runInsert = vi.fn((row: FakeWorkspaceRow) => {
    _dbRows.push(row);
  });
  _insertMock.mockReturnValue({
    values: vi.fn((row: FakeWorkspaceRow) => ({
      run: () => runInsert(row),
    })),
  });

  // update().set().where().run() — no-op
  _updateMock.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ run: vi.fn() })),
    })),
  });

  _selectMockFindById = null;
}

// Override hook: when set, _selectMock's .get() calls this instead.
let _selectMockFindById: (() => FakeWorkspaceRow | null | undefined) | null = null;

vi.mock('../db/client', () => ({
  getDb: vi.fn(() => ({
    get insert() { return _insertMock; },
    get select() { return _selectMock; },
    get update() { return _updateMock; },
    get delete() {
      return vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
    },
  })),
  getRawDb: vi.fn(() => ({
    pragma: (...args: unknown[]) => _rawDbPragma(...args),
    prepare: (...args: unknown[]) => _rawDbPrepare(...args),
  })),
}));

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------
import { openDevWorkspace } from './factory';
import { DEV_WORKSPACE_KV_KEY, DEV_WORKSPACE_NAME } from '../../../shared/special-workspace';
import { getRepoRoot } from '../git/git-ops';
import { writeWorkspaceMcpConfig } from './mcp-autowrite';
import { ensureRufloTrusted } from './mcp-trust';
import { seedWorkspaceMemory } from '../ruflo/seed-workspace-memory';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openDevWorkspace (singleton dev workspace factory)', () => {
  beforeEach(() => {
    resetDb();
  });

  it('first call: inserts a forced-plain row at ~ and writes the KV pointer', async () => {
    // KV has no pointer yet (_kvStore is empty).
    const ws = await openDevWorkspace();

    // Workspace fields
    expect(ws.name).toBe(DEV_WORKSPACE_NAME);
    expect(ws.rootPath).toBe('/home/testuser');
    expect(ws.repoMode).toBe('plain');
    expect(ws.repoRoot).toBeNull();

    // A row was inserted
    expect(_insertMock).toHaveBeenCalledTimes(1);
    const inserted = _dbRows[0];
    expect(inserted).toBeDefined();
    expect(inserted.name).toBe(DEV_WORKSPACE_NAME);
    expect(inserted.rootPath).toBe('/home/testuser');
    expect(inserted.repoMode).toBe('plain');
    expect(inserted.repoRoot).toBeNull();

    // KV upsert was called with the correct key and the new id
    expect(_kvUpsertRuns).toHaveLength(1);
    expect(_kvUpsertRuns[0].key).toBe(DEV_WORKSPACE_KV_KEY);
    expect(_kvUpsertRuns[0].value).toBe(ws.id);
  });

  it('never probes git', async () => {
    await openDevWorkspace();
    expect(vi.mocked(getRepoRoot)).not.toHaveBeenCalled();
  });

  it('skips ALL open side effects (MCP autowrite, ruflo trust, memory seeding)', async () => {
    await openDevWorkspace();
    expect(vi.mocked(writeWorkspaceMcpConfig)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureRufloTrusted)).not.toHaveBeenCalled();
    expect(vi.mocked(seedWorkspaceMemory)).not.toHaveBeenCalled();
  });

  it('second call reuses the pointed-at row (no new insert)', async () => {
    // Simulate a pre-existing row already in DB and KV pointing to it.
    const firstId = 'existing-dev-uuid';
    const existingRow: FakeWorkspaceRow = {
      id: firstId,
      name: DEV_WORKSPACE_NAME,
      rootPath: '/home/testuser',
      repoRoot: null,
      repoMode: 'plain',
      createdAt: 1000,
      lastOpenedAt: 1000,
    };
    _dbRows.push(existingRow);
    _kvStore.set(DEV_WORKSPACE_KV_KEY, firstId);

    // select.get() should return the existing row (found by id).
    _selectMockFindById = () => existingRow;

    const ws = await openDevWorkspace();

    // Same id returned — no new insert
    expect(ws.id).toBe(firstId);
    expect(_insertMock).not.toHaveBeenCalled();
  });

  it('self-heals a dangling KV pointer (deleted row → fresh insert + re-point)', async () => {
    // KV points to a gone id; workspace select returns undefined for it.
    _kvStore.set(DEV_WORKSPACE_KV_KEY, 'gone-uuid');

    // After the new insert, return the new row.
    let callCount = 0;
    _selectMockFindById = () => {
      callCount++;
      if (callCount === 1) {
        // First select: looking up the gone-uuid → not found
        return undefined;
      }
      // Second select: looking up the freshly inserted row
      return _dbRows[_dbRows.length - 1] ?? null;
    };

    const ws = await openDevWorkspace();

    // A new row was inserted
    expect(_insertMock).toHaveBeenCalledTimes(1);
    expect(ws.id).not.toBe('gone-uuid');

    // KV was re-pointed to the new id
    expect(_kvUpsertRuns).toHaveLength(1);
    expect(_kvUpsertRuns[0].key).toBe(DEV_WORKSPACE_KV_KEY);
    expect(_kvUpsertRuns[0].value).toBe(ws.id);
  });
});
