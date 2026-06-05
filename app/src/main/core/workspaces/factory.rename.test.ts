// DEV-W2 — unit tests for renameWorkspace.
//
// Uses a mock drizzle-like DB — better-sqlite3 is built for Electron's ABI and
// CANNOT load under vitest (see reference_better_sqlite3_electron_abi).
// The mock captures UPDATE + SELECT calls and returns pre-staged row data.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Captured state ─────────────────────────────────────────────────────────
interface UpdateCall {
  set: Record<string, unknown>;
  whereId: string;
}

let updateCalls: UpdateCall[] = [];
let selectRow: Record<string, unknown> | undefined = undefined;
let mockDb: ReturnType<typeof buildMockDb>;

// ── Mock drizzle-like DB ───────────────────────────────────────────────────
function buildMockDb() {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          run: () => {
            // Capture the set values; condition is an opaque drizzle object,
            // but we derive the id from the staged selectRow.
            updateCalls.push({ set: values, whereId: selectRow?.id as string ?? '' });
            // Simulate the update by patching the staged row.
            if (selectRow) {
              Object.assign(selectRow, values);
            }
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => selectRow,
        }),
      }),
    }),
  };
}

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock('../db/client', () => ({
  getDb: () => mockDb,
  getRawDb: () => ({
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => undefined,
    }),
    pragma: () => undefined,
  }),
}));

// Stub modules that have side effects (autowrite, trust, etc.) but are not
// needed for the rename path.
vi.mock('./mcp-autowrite', () => ({
  KV_RUFLO_AUTOWRITE_MCP: 'ruflo.autowriteMcp',
  KV_RUFLO_AUTOTRUST_MCP: 'ruflo.autotrust',
  writeWorkspaceMcpConfig: () => undefined,
}));
vi.mock('./mcp-trust', () => ({ ensureRufloTrusted: () => undefined }));
vi.mock('./ruflo-fallback-notice', () => ({ maybeNotifyStdioFallback: () => undefined }));
vi.mock('../ruflo/seed-workspace-memory', () => ({ seedWorkspaceMemory: async () => undefined }));
vi.mock('../git/git-ops', () => ({ getRepoRoot: async () => null }));
vi.mock('../ruflo/verify', () => ({
  KV_RUFLO_STRICT_MCP_VERIFICATION: 'ruflo.strictVerify',
  verifyForWorkspace: async () => ({ status: 'ok' }),
}));

// ── Import SUT after mocks ─────────────────────────────────────────────────
import { renameWorkspace } from './factory';

// ── Tests ──────────────────────────────────────────────────────────────────
describe('renameWorkspace', () => {
  beforeEach(() => {
    updateCalls = [];
    selectRow = {
      id: 'ws-1',
      name: 'OldName',
      rootPath: '/projects/test',
      repoRoot: '/projects/test',
      repoMode: 'git',
      createdAt: 1000,
      lastOpenedAt: 2000,
    };
    mockDb = buildMockDb();
  });

  it('updates the name column and returns the updated workspace', () => {
    const result = renameWorkspace('ws-1', 'NewName');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set).toEqual({ name: 'NewName' });
    expect(result.id).toBe('ws-1');
    expect(result.name).toBe('NewName');
    expect(result.rootPath).toBe('/projects/test');
  });

  it('trims leading and trailing whitespace before storing', () => {
    const result = renameWorkspace('ws-1', '  Trimmed  ');

    expect(updateCalls[0]?.set).toEqual({ name: 'Trimmed' });
    expect(result.name).toBe('Trimmed');
  });

  it('throws when the trimmed name is empty', () => {
    expect(() => renameWorkspace('ws-1', '   ')).toThrow(/must not be empty/);
    expect(updateCalls).toHaveLength(0);
  });

  it('throws when the name exceeds 120 characters', () => {
    const longName = 'a'.repeat(121);
    expect(() => renameWorkspace('ws-1', longName)).toThrow(/120 characters or fewer/);
    expect(updateCalls).toHaveLength(0);
  });

  it('accepts exactly 120 characters', () => {
    const maxName = 'a'.repeat(120);
    const result = renameWorkspace('ws-1', maxName);
    expect(result.name).toBe(maxName);
  });

  it('throws when the id is an empty string', () => {
    expect(() => renameWorkspace('', 'SomeName')).toThrow(/id must be/);
  });

  it('throws when the row is not found after update', () => {
    selectRow = undefined;
    expect(() => renameWorkspace('ws-missing', 'SomeName')).toThrow(/workspace not found/);
  });
});
