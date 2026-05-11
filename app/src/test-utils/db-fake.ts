// In-memory DB fake for unit tests that bypasses better-sqlite3 entirely.
//
// Why this exists: the host node and the Electron runtime ship different
// NODE_MODULE_VERSIONs, so any test that calls `initializeDatabase()` from
// the main-process code path explodes when bindings refuse to load the
// Electron-built better-sqlite3 binary. Mocking `db/client` and substituting
// these in-memory shims sidesteps the native module entirely.
//
// Two surfaces are exported:
//
//   1. `fakeDb()` — legacy minimal raw-prepare shim used by
//      `session-restore.test.ts`. Only supports the kv-row pattern (single
//      key/value column, SELECT/INSERT). Re-exported here so historical
//      tests keep their original import shape after the extraction.
//
//   2. `createDbFake()` — the full fake. Returns `{ raw, drizzle, store }`
//      where both surfaces share one backing store. The raw shim
//      (`db-fake-raw.ts`) parses simple INSERT/SELECT/UPDATE statements
//      used for test seeding. The drizzle shim (`db-fake-drizzle.ts`)
//      handles the SELECT/INSERT/UPDATE chain that production code
//      (mailbox.ts, tools.ts, factory.ts) uses via `getDb()`.

import { randomUUID } from 'node:crypto';
import * as schema from '@/main/core/db/schema';
import {
  DRIZZLE_COLUMNS,
  DRIZZLE_NAME,
  ensureTable,
  makeStore,
  registerTable,
  type DbStore,
  type DrizzleTable,
} from './db-fake-store';
import { makeDrizzleFake, type DrizzleLikeDb } from './db-fake-drizzle';
import { makeRawFake, type RawDbLike } from './db-fake-raw';

export type { DbStore, DrizzleTable } from './db-fake-store';
export type { DrizzleLikeDb } from './db-fake-drizzle';
export type { RawDbLike } from './db-fake-raw';

// ── Public surface ──────────────────────────────────────────────────────────

export interface DbFake {
  raw: RawDbLike;
  drizzle: DrizzleLikeDb;
  store: DbStore;
}

/**
 * Build a fresh in-memory DB fake. The returned `raw` and `drizzle` share
 * one backing store so seeds inserted via raw SQL are visible to drizzle
 * reads and vice versa.
 *
 * Typical wiring:
 *
 *   vi.mock('../db/client', () => ({
 *     getRawDb: vi.fn(),
 *     getDb: vi.fn(),
 *     initializeDatabase: vi.fn(),
 *     closeDatabase: vi.fn(),
 *   }));
 *   const fake = createDbFake();
 *   vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
 *   vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
 */
export function createDbFake(): DbFake {
  const store = makeStore();
  // Pre-register every drizzle table from the live schema so the raw shim
  // can translate sql column names to JS keys even when production code
  // hasn't yet touched a given table through the drizzle surface. This
  // mirrors what `initializeDatabase` would do via the bootstrap SQL.
  for (const exported of Object.values(schema)) {
    if (!exported || typeof exported !== 'object') continue;
    const maybeTable = exported as unknown as Record<symbol, unknown>;
    if (maybeTable[DRIZZLE_NAME] && maybeTable[DRIZZLE_COLUMNS]) {
      registerTable(store, exported as unknown as DrizzleTable);
    }
  }
  return {
    store,
    raw: makeRawFake(store),
    drizzle: makeDrizzleFake(store),
  };
}

// ── Seed helpers ────────────────────────────────────────────────────────────
// Each helper writes a row directly into the store using JS-camelCase keys
// — matches what drizzle inserts use, and what drizzle reads return.

export interface SeedWorkspace {
  id?: string;
  name?: string;
  rootPath?: string;
  repoMode?: 'git' | 'plain';
  repoRoot?: string | null;
  createdAt?: number;
  lastOpenedAt?: number;
}

export function seedWorkspace(fake: DbFake, partial: SeedWorkspace = {}): Record<string, unknown> {
  const now = Date.now();
  const id = partial.id ?? randomUUID();
  const rootPath = partial.rootPath ?? `/tmp/${id}`;
  const row = {
    id,
    name: partial.name ?? id,
    rootPath,
    repoRoot: partial.repoRoot ?? null,
    repoMode: partial.repoMode ?? 'plain',
    createdAt: partial.createdAt ?? now,
    lastOpenedAt: partial.lastOpenedAt ?? now,
  };
  ensureTable(fake.store, 'workspaces').push(row);
  return row;
}

export interface SeedSwarm {
  id?: string;
  workspaceId?: string;
  name?: string;
  mission?: string;
  preset?: 'squad' | 'team' | 'platoon' | 'battalion' | 'legion' | 'custom';
  status?: 'running' | 'paused' | 'completed' | 'failed';
  createdAt?: number;
  endedAt?: number | null;
}

export function seedSwarm(fake: DbFake, partial: SeedSwarm = {}): Record<string, unknown> {
  const id = partial.id ?? randomUUID();
  const now = Date.now();
  const row = {
    id,
    workspaceId: partial.workspaceId ?? 'ws-1',
    name: partial.name ?? 'test-swarm',
    mission: partial.mission ?? 'test mission',
    preset: partial.preset ?? 'squad',
    status: partial.status ?? 'running',
    createdAt: partial.createdAt ?? now,
    endedAt: partial.endedAt ?? null,
  };
  ensureTable(fake.store, 'swarms').push(row);
  return row;
}

export interface SeedAgent {
  id?: string;
  swarmId: string;
  role?: 'coordinator' | 'builder' | 'scout' | 'reviewer';
  roleIndex?: number;
  providerId?: string;
  sessionId?: string | null;
  status?: 'idle' | 'busy' | 'blocked' | 'done' | 'error';
  inboxPath?: string;
  agentKey?: string;
  coordinatorId?: string | null;
  autoApprove?: number;
  createdAt?: number;
}

export function seedAgent(fake: DbFake, partial: SeedAgent): Record<string, unknown> {
  const role = partial.role ?? 'builder';
  const roleIndex = partial.roleIndex ?? 1;
  const agentKey = partial.agentKey ?? `${role}-${roleIndex}`;
  const row = {
    id: partial.id ?? randomUUID(),
    swarmId: partial.swarmId,
    role,
    roleIndex,
    providerId: partial.providerId ?? 'codex',
    sessionId: partial.sessionId ?? null,
    status: partial.status ?? 'idle',
    inboxPath: partial.inboxPath ?? `/tmp/inbox-${agentKey}`,
    agentKey,
    coordinatorId: partial.coordinatorId ?? null,
    autoApprove: partial.autoApprove ?? 0,
    createdAt: partial.createdAt ?? Date.now(),
  };
  ensureTable(fake.store, 'swarm_agents').push(row);
  return row;
}

export interface SeedAgentSession {
  id: string;
  workspaceId?: string;
  providerId?: string;
  cwd?: string;
  branch?: string | null;
  worktreePath?: string | null;
  status?: 'starting' | 'running' | 'exited' | 'error';
  exitCode?: number | null;
  initialPrompt?: string | null;
  startedAt?: number;
  exitedAt?: number | null;
  providerEffective?: string | null;
  externalSessionId?: string | null;
}

export function seedAgentSession(
  fake: DbFake,
  partial: SeedAgentSession,
): Record<string, unknown> {
  const row = {
    id: partial.id,
    workspaceId: partial.workspaceId ?? 'ws-1',
    providerId: partial.providerId ?? 'codex',
    cwd: partial.cwd ?? '/tmp',
    branch: partial.branch ?? null,
    worktreePath: partial.worktreePath ?? null,
    status: partial.status ?? 'running',
    exitCode: partial.exitCode ?? null,
    initialPrompt: partial.initialPrompt ?? null,
    startedAt: partial.startedAt ?? Date.now(),
    exitedAt: partial.exitedAt ?? null,
    providerEffective: partial.providerEffective ?? null,
    externalSessionId: partial.externalSessionId ?? null,
  };
  ensureTable(fake.store, 'agent_sessions').push(row);
  return row;
}

// ── Legacy minimal kv shim ──────────────────────────────────────────────────
// `session-restore.test.ts` previously defined its own inline `fakeDb()` that
// only spoke the kv-row protocol. Re-exported here so that test can use the
// shared helper without behavioural drift. Independent of `createDbFake()`.

export interface FakeKvRow {
  value?: string;
}

export interface FakeKvStatement {
  get: (key: string) => FakeKvRow | undefined;
  run: (key: string, value: string) => void;
}

export interface FakeKvDb {
  storage: Map<string, string>;
  prepare: (sql: string) => FakeKvStatement;
}

export function fakeDb(): FakeKvDb {
  const storage = new Map<string, string>();
  return {
    storage,
    prepare: (sql: string): FakeKvStatement => {
      const isWrite = sql.trim().toUpperCase().startsWith('INSERT');
      return {
        get: (key: string): FakeKvRow | undefined => {
          if (isWrite) throw new Error('fakeDb: get on write statement');
          const value = storage.get(key);
          return value === undefined ? undefined : { value };
        },
        run: (key: string, value: string): void => {
          if (!isWrite) throw new Error('fakeDb: run on read statement');
          storage.set(key, value);
        },
      };
    },
  };
}
