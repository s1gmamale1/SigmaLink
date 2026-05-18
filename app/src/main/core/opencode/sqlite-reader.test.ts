// v1.4.7 packet-06 — Tests for the OpenCode SQLite direct-read module.
//
// Note: better-sqlite3 is compiled against Electron's Node ABI (147 at the
// time of writing), but vitest runs against the host Node ABI. Directly
// importing better-sqlite3 here would crash with NODE_MODULE_VERSION. We
// mock it with a hand-rolled fake that captures the queries we care about.
// This is the same pattern used by:
//   - app/src/main/core/db/client.kv-migration.test.ts
//   - app/src/main/core/workspaces/worktree-cleanup.test.ts
//   - app/src/main/core/db/migrations/0014_sigma_pane_events.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// In-memory mock of better-sqlite3.
// ---------------------------------------------------------------------------

interface MockSessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

/** Per-test mutable state the mock reads from. */
interface MockState {
  /** Map from db path → in-memory rows OR sentinel objects.  */
  databases: Map<
    string,
    | { kind: 'sessions'; rows: MockSessionRow[] }
    | { kind: 'no-session-table' }
    | { kind: 'corrupt' }
  >;
}

const mockState: MockState = { databases: new Map() };

vi.mock('better-sqlite3', () => {
  // The mock's default export is the Database constructor.
  const Ctor = function Database(this: unknown, dbPath: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) {
    const entry = mockState.databases.get(dbPath);
    if (!entry) {
      // fileMustExist:true on a missing file throws SQLITE_CANTOPEN.
      throw Object.assign(new Error('SQLITE_CANTOPEN: no such file'), { code: 'SQLITE_CANTOPEN' });
    }
    if (entry.kind === 'corrupt') {
      throw Object.assign(new Error('SQLITE_NOTADB: file is not a database'), { code: 'SQLITE_NOTADB' });
    }
    return {
      readonly: opts?.readonly === true,
      prepare(sql: string) {
        return {
          all(cwd: string, maxCount: number) {
            if (entry.kind === 'no-session-table') {
              throw Object.assign(new Error('SQLITE_ERROR: no such table: session'), { code: 'SQLITE_ERROR' });
            }
            if (!/FROM\s+session/i.test(sql)) {
              throw new Error(`Unhandled SQL: ${sql}`);
            }
            const filtered = entry.rows.filter((r) => r.directory === cwd);
            filtered.sort((a, b) => b.time_updated - a.time_updated);
            // Mirror the SQL `AS timeCreated`/`AS timeUpdated` column renames.
            return filtered.slice(0, maxCount).map((r) => ({
              id: r.id,
              directory: r.directory,
              title: r.title,
              timeCreated: r.time_created,
              timeUpdated: r.time_updated,
            }));
          },
        };
      },
      close() {
        /* no-op */
      },
    };
  } as unknown as typeof import('better-sqlite3');
  return { default: Ctor };
});

// Import AFTER the vi.mock above so the module picks up the mocked
// better-sqlite3.
const { listOpencodeSessionsFromDb, resolveOpencodeDbPath } = await import('./sqlite-reader');

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

let tempDir: string;
let originalEnv: string | undefined;
let dbPath: string;

function seedSessions(rows: MockSessionRow[]): void {
  mockState.databases.set(dbPath, { kind: 'sessions', rows });
  // Also create a stub file on disk so resolveOpencodeDbPath sees it.
  fs.writeFileSync(dbPath, 'stub-content');
}

function seedNoSessionTable(): void {
  mockState.databases.set(dbPath, { kind: 'no-session-table' });
  fs.writeFileSync(dbPath, 'stub-content');
}

function seedCorrupt(): void {
  mockState.databases.set(dbPath, { kind: 'corrupt' });
  fs.writeFileSync(dbPath, 'not-a-sqlite-database');
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sqlite-test-'));
  dbPath = path.join(tempDir, 'opencode.db');
  originalEnv = process.env.OPENCODE_HOME;
  process.env.OPENCODE_HOME = tempDir;
  mockState.databases.clear();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.OPENCODE_HOME;
  else process.env.OPENCODE_HOME = originalEnv;
  fs.rmSync(tempDir, { recursive: true, force: true });
  mockState.databases.clear();
});

// ---------------------------------------------------------------------------
// resolveOpencodeDbPath
// ---------------------------------------------------------------------------

describe('resolveOpencodeDbPath', () => {
  it('returns null when no candidate exists on disk', () => {
    // OPENCODE_HOME is set to an empty temp dir; no opencode.db inside.
    expect(resolveOpencodeDbPath()).toBeNull();
  });

  it('resolves OPENCODE_HOME override when the file exists', () => {
    fs.writeFileSync(dbPath, 'stub');
    expect(resolveOpencodeDbPath()).toBe(dbPath);
  });

  it('returns null when the path exists but is a directory, not a file', () => {
    fs.mkdirSync(dbPath);
    expect(resolveOpencodeDbPath()).toBeNull();
  });

  it('uses OPENCODE_HOME exclusively — does not fall through to OS defaults', () => {
    // Even when OPENCODE_HOME points at an empty dir, we MUST return null
    // rather than falling back to the host's real ~/.local/share/opencode.
    expect(process.env.OPENCODE_HOME).toBe(tempDir);
    expect(resolveOpencodeDbPath()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listOpencodeSessionsFromDb
// ---------------------------------------------------------------------------

describe('listOpencodeSessionsFromDb', () => {
  it('returns sessions filtered by cwd, newest first', () => {
    seedSessions([
      { id: 'ses_a', directory: '/repo', title: 'first', time_created: 1000, time_updated: 2000 },
      { id: 'ses_b', directory: '/repo', title: 'second', time_created: 1500, time_updated: 1800 },
      { id: 'ses_c', directory: '/other', title: 'unrelated', time_created: 2000, time_updated: 2000 },
    ]);

    const rows = listOpencodeSessionsFromDb('/repo');
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      id: 'ses_a',
      directory: '/repo',
      title: 'first',
      timeCreated: 1000,
      timeUpdated: 2000,
    });
    expect(rows[1].id).toBe('ses_b');
    // ses_c excluded by directory filter.
  });

  it('returns empty list when the DB file is missing', () => {
    // No seed → resolveOpencodeDbPath returns null → list returns [].
    expect(listOpencodeSessionsFromDb('/repo')).toEqual([]);
  });

  it('returns empty list when the session table is absent', () => {
    seedNoSessionTable();
    expect(listOpencodeSessionsFromDb('/repo')).toEqual([]);
  });

  it('returns empty list when the DB file is corrupt', () => {
    seedCorrupt();
    expect(listOpencodeSessionsFromDb('/repo')).toEqual([]);
  });

  it('respects the maxCount cap', () => {
    const rows: MockSessionRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push({
        id: `ses_${i}`,
        directory: '/repo',
        title: `title-${i}`,
        time_created: 1000 + i,
        time_updated: 2000 + i,
      });
    }
    seedSessions(rows);

    const result = listOpencodeSessionsFromDb('/repo', 3);
    expect(result.length).toBe(3);
    expect(result[0].id).toBe('ses_9');
    expect(result[1].id).toBe('ses_8');
    expect(result[2].id).toBe('ses_7');
  });

  it('returns empty list when no rows match the directory', () => {
    seedSessions([
      { id: 'ses_a', directory: '/other', title: '', time_created: 1, time_updated: 1 },
    ]);
    expect(listOpencodeSessionsFromDb('/repo')).toEqual([]);
  });
});
