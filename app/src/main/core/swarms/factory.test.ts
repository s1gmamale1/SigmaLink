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

// ── BUG-V1.1.3-ORCH-02: role_index race ────────────────────────────────────

describe('BUG-V1.1.3-ORCH-02 — addAgentToSwarm role_index atomicity', () => {
  it('5 concurrent same-role adds produce contiguous unique role indices', async () => {
    // The pre-audit implementation read `agentRows` then issued the INSERT
    // outside a transaction. Two concurrent calls would compute the same
    // `roleIndex` and the loser would trip the
    // UNIQUE(swarm_id, role, role_index) constraint.
    //
    // The fix wraps (count guard, max(role_index) lookup, INSERT) in a single
    // better-sqlite3 transaction so the read sees every prior INSERT. This
    // test fires 5 concurrent `addAgentToSwarm` calls for the same role and
    // asserts no rejection and contiguous indices 1..5.
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'custom',
      status: 'running',
    });

    const deps = makeDeps();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'builder' }, deps),
      ),
    );

    // Every call resolved (no UNIQUE constraint violation).
    expect(results).toHaveLength(5);

    // Indices are exactly 1..5 with no duplicates.
    const indices = results.map((r) => Number(r.agentKey.split('-').pop())).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5]);

    // Agent keys are unique builder-1..builder-5.
    const keys = results.map((r) => r.agentKey).sort();
    expect(keys).toEqual(['builder-1', 'builder-2', 'builder-3', 'builder-4', 'builder-5']);

    // The swarm_agents store contains exactly 5 rows.
    const rows = fake.store.tables.get('swarm_agents') ?? [];
    expect(rows).toHaveLength(5);
    // No two rows share the same (role, roleIndex) — the guard against the
    // pre-audit race.
    const seen = new Set<string>();
    for (const row of rows) {
      const k = `${row.role as string}-${row.roleIndex as number}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('mixed-role concurrent adds compute per-role indices independently', async () => {
    // Five concurrent calls split across two roles must produce builder-1..N
    // and scout-1..M with no cross-role contamination.
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1', repoMode: 'plain' });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'custom',
      status: 'running',
    });

    const deps = makeDeps();
    const pending = [
      addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'builder' }, deps),
      addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'scout' }, deps),
      addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'builder' }, deps),
      addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'scout' }, deps),
      addAgentToSwarm({ swarmId: 'swarm-1', providerId: 'shell', role: 'builder' }, deps),
    ];
    const results = await Promise.all(pending);

    const builders = results
      .filter((r) => r.agentKey.startsWith('builder-'))
      .map((r) => r.agentKey)
      .sort();
    const scouts = results
      .filter((r) => r.agentKey.startsWith('scout-'))
      .map((r) => r.agentKey)
      .sort();

    expect(builders).toEqual(['builder-1', 'builder-2', 'builder-3']);
    expect(scouts).toEqual(['scout-1', 'scout-2']);
  });
});
