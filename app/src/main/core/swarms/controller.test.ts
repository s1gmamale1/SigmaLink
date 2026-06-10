// Spec 2026-06-10 (D) — swarms.resume RPC controller tests.
//
// Mirrors controller-split.test.ts setup (db-fake mock + buildSwarmController)
// and tools.test.ts db-fake pattern (getRawDb returns the fake's raw shim).
// NEVER uses `new Database()` — better-sqlite3 is Electron-ABI and vitest
// cannot load it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../providers/launcher', () => ({
  resolveAndSpawn: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import {
  createDbFake,
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import { buildSwarmController } from './controller';

let fake: DbFake;

function makeMailboxStub() {
  return {
    ensureInbox: vi.fn(
      (_swarmId: string, agentKey: string) => `/tmp/inbox-${agentKey}.jsonl`,
    ),
    append: vi.fn(async () => ({
      id: 'msg-1',
      swarmId: 'swarm-1',
      fromAgent: 'operator',
      toAgent: '*',
      kind: 'SYSTEM',
      body: 'ok',
      ts: 1,
    })),
    tail: vi.fn(async () => []),
  } as unknown as Parameters<typeof buildSwarmController>[0]['mailbox'];
}

function makePtyStub() {
  return {
    create: vi.fn(),
    list: vi.fn(() => []),
    write: vi.fn(),
    kill: vi.fn(),
  } as unknown as Parameters<typeof buildSwarmController>[0]['pty'];
}

function makeWorktreePoolStub() {
  return {
    create: vi.fn(async () => ({
      worktreePath: '/tmp/fresh-worktree',
      branch: 'sigmalink/builder-X',
    })),
  } as unknown as Parameters<typeof buildSwarmController>[0]['worktreePool'];
}

function makeDeps() {
  return {
    pty: makePtyStub(),
    worktreePool: makeWorktreePoolStub(),
    mailbox: makeMailboxStub(),
    userDataDir: '/tmp/sigmalink-resume-test',
  };
}

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
});

describe("swarms.resume (spec 2026-06-10 D)", () => {
  it("heals a 'failed' swarm to running and reports healed=true", async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, { id: 'swarm-1', workspaceId: 'ws-1', status: 'failed' });

    const ctl = buildSwarmController(makeDeps());
    const out = await ctl.resume('swarm-1');

    expect(out).toEqual({ ok: true, healed: true });

    // Assert the swarms-table row is now status:'running'
    const rows = (fake.store.tables.get('swarms') ?? []) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['id'] === 'swarm-1');
    expect(row?.['status']).toBe('running');
  });

  it("clears ended_at when healing a 'failed' swarm that had a non-null ended_at", async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, { id: 'swarm-5', workspaceId: 'ws-1', status: 'failed', endedAt: 1234567 });

    const ctl = buildSwarmController(makeDeps());
    expect(await ctl.resume('swarm-5')).toEqual({ ok: true, healed: true });

    const rows = (fake.store.tables.get('swarms') ?? []) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['id'] === 'swarm-5');
    expect(row?.['status']).toBe('running');
    expect(row?.['endedAt']).toBeNull();
  });

  it("heals a 'paused' swarm to running and reports healed=true", async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, { id: 'swarm-2', workspaceId: 'ws-1', status: 'paused' });

    const ctl = buildSwarmController(makeDeps());
    const out = await ctl.resume('swarm-2');

    expect(out).toEqual({ ok: true, healed: true });

    const rows = (fake.store.tables.get('swarms') ?? []) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['id'] === 'swarm-2');
    expect(row?.['status']).toBe('running');
  });

  it("leaves a 'completed' swarm ended (healed=false)", async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, { id: 'swarm-3', workspaceId: 'ws-1', status: 'completed' });

    const ctl = buildSwarmController(makeDeps());
    expect(await ctl.resume('swarm-3')).toEqual({ ok: true, healed: false });

    // Row must still be 'completed'
    const rows = (fake.store.tables.get('swarms') ?? []) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r['id'] === 'swarm-3');
    expect(row?.['status']).toBe('completed');
  });

  it("leaves a 'running' swarm untouched (healed=false — nothing needed healing)", async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, { id: 'swarm-4', workspaceId: 'ws-1', status: 'running' });

    const ctl = buildSwarmController(makeDeps());
    expect(await ctl.resume('swarm-4')).toEqual({ ok: true, healed: false });
  });

  it('rejects a blank id', async () => {
    const ctl = buildSwarmController(makeDeps());
    expect(await ctl.resume('')).toEqual({ ok: false, healed: false });
  });

  it('rejects a whitespace-only id', async () => {
    const ctl = buildSwarmController(makeDeps());
    expect(await ctl.resume('   ')).toEqual({ ok: false, healed: false });
  });
});
