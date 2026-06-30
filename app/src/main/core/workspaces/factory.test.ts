// Tests for openWorkspaceNew (DEV-W3a).
//
// openWorkspaceNew always inserts a fresh workspace row, even when a row with
// the same rootPath already exists. This contrasts with openWorkspace, which
// returns the existing row on a rootPath match (dedup-reuse).
//
// We mock every external dependency — better-sqlite3 cannot load under vitest
// (Electron ABI), and node:fs / git-ops / side-effects are all isolated.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external modules BEFORE importing factory.ts so that the module's
// top-level imports resolve to our fakes.
// ---------------------------------------------------------------------------

// node:fs — stat / existsSync
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  },
}));

// node:path — let path.resolve and path.basename work naturally in tests
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual };
});

// node:crypto — make randomUUID deterministic so we can assert the inserted id
let _uuidCounter = 0;
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => `uuid-${++_uuidCounter}`),
}));

// git-ops — pretend every directory is a plain (non-git) folder
vi.mock('../git/git-ops', () => ({
  getRepoRoot: vi.fn(async () => null),
}));

// Ruflo side-effects — all no-ops in unit tests
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

// Re-set before every test
function resetDb() {
  _dbRows = [];
  // Do NOT reset _uuidCounter here — randomUUID is mocked to return
  // uuid-${++_uuidCounter}, so resetting to 0 would produce the same id on
  // two consecutive calls within one test.  The counter increments globally
  // across all calls, guaranteeing uniqueness per call.

  _insertMock = vi.fn();
  _updateMock = vi.fn();
  _rawDbPragma = vi.fn();
  _rawDbPrepare = vi.fn(() => ({ get: vi.fn(() => undefined) }));

  _selectMock = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        get: vi.fn(() => {
          // Return the last inserted row (simulates SELECT by id).
          return _dbRows[_dbRows.length - 1] ?? null;
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

  // update().set().where().run() — no-op for tests
  _updateMock.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ run: vi.fn() })),
    })),
  });
}

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
// Finally import the module under test
// ---------------------------------------------------------------------------
import { openWorkspaceNew } from './factory';
import { randomUUID } from 'node:crypto';
import { writeWorkspaceMcpConfig } from './mcp-autowrite';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openWorkspaceNew (DEV-W3a)', () => {
  beforeEach(() => {
    resetDb();
    vi.mocked(randomUUID).mockClear();
  });

  it('always inserts a fresh row even when a row with the same rootPath exists', async () => {
    // Seed an existing row for the same path.
    _dbRows.push({
      id: 'existing-uuid',
      name: 'my-project',
      rootPath: '/tmp/my-project',
      repoRoot: null,
      repoMode: 'plain',
      createdAt: 1000,
      lastOpenedAt: 1000,
    });

    const ws = await openWorkspaceNew('/tmp/my-project');

    // A NEW insert must have been called.
    expect(_insertMock).toHaveBeenCalledTimes(1);
    // _dbRows[0] is the pre-seeded row; _dbRows[1] is the newly inserted row.
    expect(_dbRows).toHaveLength(2);
    const inserted = _dbRows[1];
    expect(inserted.id).not.toBe('existing-uuid');
    expect(inserted.id).toMatch(/^uuid-/);
    // The returned workspace has the new id, not the pre-existing one.
    expect(ws.id).not.toBe('existing-uuid');
  });

  it('does NOT call update (no dedup-reuse path)', async () => {
    await openWorkspaceNew('/tmp/my-project');
    // update() is the dedup-reuse path in openWorkspace; it must NOT be called.
    expect(_updateMock).not.toHaveBeenCalled();
  });

  it('inserts with a random UUID each call — two calls yield two distinct ids', async () => {
    await openWorkspaceNew('/tmp/my-project');
    await openWorkspaceNew('/tmp/my-project');

    expect(_insertMock).toHaveBeenCalledTimes(2);
    // _dbRows captures each inserted row in order; verify the ids differ.
    expect(_dbRows).toHaveLength(2);
    expect(_dbRows[0].id).not.toBe(_dbRows[1].id);
  });

  it('throws when the path does not exist', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.default.existsSync).mockReturnValueOnce(false);
    await expect(openWorkspaceNew('/nonexistent')).rejects.toThrow('Not a directory');
  });

  it('throws when the path is not a directory', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.default.statSync).mockReturnValueOnce({ isDirectory: () => false } as ReturnType<typeof fs.default.statSync>);
    await expect(openWorkspaceNew('/tmp/a-file')).rejects.toThrow('Not a directory');
  });

  it('returns a Workspace with all required fields', async () => {
    const ws = await openWorkspaceNew('/tmp/my-project');
    expect(ws).toHaveProperty('id');
    expect(ws).toHaveProperty('name');
    expect(ws).toHaveProperty('rootPath');
    expect(ws).toHaveProperty('repoMode');
    expect(ws).toHaveProperty('createdAt');
    expect(ws).toHaveProperty('lastOpenedAt');
  });

  // Task 4 — on Windows with no HTTP daemon port, the autowrite is asked to skip
  // the managed Codex stdio Ruflo entry by default (operator opt-out KV unset).
  it('on win32 with no port, asks autowrite to skip codex stdio (default opt-out)', async () => {
    vi.mocked(writeWorkspaceMcpConfig).mockClear();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await openWorkspaceNew('/tmp/win-project');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }

    expect(writeWorkspaceMcpConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ skipCodexStdio: true }),
    );
  });
});
