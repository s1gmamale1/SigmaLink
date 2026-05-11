// V1.1.8 — Unit tests for the swarm factory contract that CommandRoom and
// the assistant `add_agent` tool depend on (paneIndex derivation, 20-cap
// refusal).
//
// We mock the db client and the providers launcher so the test never touches
// better-sqlite3 (host node and Electron ship different NODE_MODULE_VERSIONs)
// nor the real PTY spawn path. The in-memory fake shares state between the
// raw and drizzle surfaces — see `src/test-utils/db-fake.ts`.

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
import { resolveAndSpawn } from '../providers/launcher';
import {
  createDbFake,
  seedAgent,
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import type {
  AddAgentToSwarmInput,
  SwarmFactoryDeps,
} from './factory';
import { addAgentToSwarm } from './factory';

// ── Fakes wired in beforeEach ──────────────────────────────────────────────

let fake: DbFake;
let spawnCallSeq = 0;

function makeMailboxStub(): SwarmFactoryDeps['mailbox'] {
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
  } as unknown as SwarmFactoryDeps['mailbox'];
}

function makePtyStub(): SwarmFactoryDeps['pty'] {
  return {
    create: vi.fn(),
    list: vi.fn(() => []),
    write: vi.fn(),
  } as unknown as SwarmFactoryDeps['pty'];
}

function makeWorktreePoolStub(): SwarmFactoryDeps['worktreePool'] {
  return {
    create: vi.fn(),
  } as unknown as SwarmFactoryDeps['worktreePool'];
}

function makeDeps(): SwarmFactoryDeps {
  return {
    pty: makePtyStub(),
    worktreePool: makeWorktreePoolStub(),
    mailbox: makeMailboxStub(),
    userDataDir: '/tmp/sigmalink-factory-test',
  };
}

function stubSpawn(): void {
  vi.mocked(resolveAndSpawn).mockImplementation(() => {
    spawnCallSeq += 1;
    const id = `sess-spawned-${spawnCallSeq}`;
    return {
      ptySession: {
        id,
        providerId: 'shell',
        cwd: '/tmp/ws-1',
        pid: 4242,
        alive: true,
        startedAt: Date.now(),
        externalSessionId: null,
        pty: {
          pid: 4242,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(() => () => undefined),
          onExit: vi.fn(() => () => undefined),
        },
      },
      providerEffective: 'shell',
      fallbackOccurred: false,
    } as unknown as ReturnType<typeof resolveAndSpawn>;
  });
}

beforeEach(() => {
  fake = createDbFake();
  spawnCallSeq = 0;
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  stubSpawn();
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
  vi.mocked(resolveAndSpawn).mockReset();
});

// ── Helpers that seed a running swarm with N existing agents ───────────────

function seedSwarmOf(
  count: number,
  roleFor: (idx: number) => 'coordinator' | 'builder' | 'scout' | 'reviewer' = () => 'builder',
): void {
  seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
  seedSwarm(fake, {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Build',
    mission: 'test',
    preset: 'custom',
    status: 'running',
  });
  for (let i = 1; i <= count; i += 1) {
    const role = roleFor(i);
    seedAgent(fake, {
      id: `agent-${i}`,
      swarmId: 'swarm-1',
      role,
      roleIndex: i,
      providerId: 'shell',
      sessionId: `sess-${i}`,
      status: 'idle',
      inboxPath: `/tmp/inbox-${role}-${i}`,
      agentKey: `${role}-${i}`,
    });
  }
}

const input: AddAgentToSwarmInput = { swarmId: 'swarm-1', providerId: 'shell' };

// ── paneIndex derivation ───────────────────────────────────────────────────

describe('paneIndex derivation', () => {
  it('first agent gets paneIndex 0', async () => {
    // No prior agents — the very first add maps to pane 0.
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'custom',
      status: 'running',
    });

    const result = await addAgentToSwarm(input, makeDeps());

    expect(result.paneIndex).toBe(0);
    expect(result.agentKey).toBe('builder-1');
  });

  it('Nth agent gets paneIndex = agentRows.length', async () => {
    // After 5 existing agents the next add lands on pane 5.
    seedSwarmOf(5);

    const result = await addAgentToSwarm(input, makeDeps());

    expect(result.paneIndex).toBe(5);
    expect(result.agentKey).toBe('builder-6');
  });

  it('rejects 21st agent (20-cap)', async () => {
    // Cap is exclusive — 20 existing agents block the 21st before any side
    // effects fire (no PTY spawn, no mailbox append, no DB insert).
    seedSwarmOf(20);
    const deps = makeDeps();

    await expect(addAgentToSwarm(input, deps)).rejects.toThrow(/20 agents/);

    expect(vi.mocked(resolveAndSpawn)).not.toHaveBeenCalled();
    expect((deps.mailbox.append as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(20);
  });
});

// ── addAgentToSwarm result contract ────────────────────────────────────────

describe('addAgentToSwarm', () => {
  it('happy path returns { sessionId, paneIndex, agentKey }', async () => {
    seedSwarmOf(3);

    const result = await addAgentToSwarm(input, makeDeps());

    expect(result.sessionId).toMatch(/^sess-spawned-/);
    expect(result.paneIndex).toBe(3);
    expect(result.agentKey).toBe('builder-4');
    // session + swarm metadata are reloaded — assert the agent row is wired
    // back to the spawn result.
    expect(result.swarm.agents.some((a) => a.agentKey === 'builder-4')).toBe(true);
    expect(result.session.id).toBe(result.sessionId);
  });

  it('capacity refusal at roster.length === 20', async () => {
    seedSwarmOf(20);
    const deps = makeDeps();

    await expect(addAgentToSwarm(input, deps)).rejects.toThrow(/swarm already has 20 agents/);

    // No insert into swarm_agents (we're still at 20), no PTY spawn, no
    // mailbox audit trail for the rejection.
    expect((fake.store.tables.get('swarm_agents') ?? []).length).toBe(20);
    expect(vi.mocked(resolveAndSpawn)).not.toHaveBeenCalled();
  });
});
