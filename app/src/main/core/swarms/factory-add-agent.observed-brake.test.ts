// C-061 — the OBSERVED-process RAM-brake on the `+ Pane` path.
//
// `addAgentToSwarm` ran only `checkRamBrakeAdmission` (which counts DB rows).
// The observed brake — which inspects the LIVE OS footprint of running panes and
// is the one that catches leaked `@claude-flow/cli … mcp start` chains — had a
// single call site in `workspaces/launcher.ts`. So a workspace correctly blocked
// from a full launch could still grow one leaky pane at a time through `+ Pane`,
// which is exactly the multiplier the brake exists to contain.
// `AddPaneButton.tsx` already parsed the observed hold and offered a Force path;
// that plumbing simply could never fire.
//
// These tests pin the four properties that matter:
//   1. a leaky same-workspace pane HOLDS the add
//   2. `forceRamBrake` completes it
//   3. process inspection being unavailable FAILS OPEN (the add proceeds)
//   4. `ramBrake.observedEnabled = 0` skips the preflight entirely — no snapshots
//
// Mocking mirrors factory.test.ts: the db client and the provider launcher are
// faked so nothing touches better-sqlite3 or a real PTY.

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
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import type { AddAgentToSwarmInput, SwarmFactoryDeps } from './factory';
import { addAgentToSwarm } from './factory';
import type { ProcessTreeSnapshot } from '../process/process-tree';

const WS_ID = 'ws-observed';
const SWARM_ID = 'swarm-observed';
const LIVE_PANE = 'sess-live-leaky';

let fake: DbFake;

/** A live pane whose tree holds two independent claude-flow stdio MCP chains. */
function leakySnapshot(rssBytes = 1024): ProcessTreeSnapshot {
  return {
    rootPid: 10,
    supported: true,
    rssBytes,
    descendantPids: [11, 12],
    nodes: [
      { pid: 10, ppid: 1, rssBytes: 100, command: 'claude', args: 'claude' },
      {
        pid: 11,
        ppid: 10,
        rssBytes: 400,
        command: 'node',
        args: 'node @claude-flow/cli/bin/cli.js mcp start',
      },
      {
        pid: 12,
        ppid: 10,
        rssBytes: 400,
        command: 'node',
        args: 'node @claude-flow/cli/bin/cli.js mcp start',
      },
    ],
  };
}

/**
 * Deps whose pty registry reports ONE live pane in the same workspace.
 * `processSnapshotCached` is overrideable per test.
 */
function makeDeps(
  snapshot: () => Promise<ProcessTreeSnapshot | null> = async () => leakySnapshot(),
): { deps: SwarmFactoryDeps; processSnapshotCached: ReturnType<typeof vi.fn> } {
  const processSnapshotCached = vi.fn(snapshot);
  const pty = {
    create: vi.fn(),
    write: vi.fn(),
    list: vi.fn(() => [{ id: LIVE_PANE, workspaceId: WS_ID }]),
    processSnapshotCached,
  } as unknown as SwarmFactoryDeps['pty'];
  const deps: SwarmFactoryDeps = {
    pty,
    worktreePool: { create: vi.fn() } as unknown as SwarmFactoryDeps['worktreePool'],
    mailbox: {
      ensureInbox: vi.fn((_swarmId: string, agentKey: string) => `/tmp/inbox-${agentKey}.jsonl`),
      append: vi.fn(async () => ({})),
    } as unknown as SwarmFactoryDeps['mailbox'],
    userDataDir: '/tmp/sigmalink-observed-brake-test',
  };
  return { deps, processSnapshotCached };
}

function seedRunningSwarm(): void {
  seedWorkspace(fake, { id: WS_ID, name: WS_ID, rootPath: '/tmp/ws-observed', repoMode: 'plain' });
  seedSwarm(fake, {
    id: SWARM_ID,
    workspaceId: WS_ID,
    name: 'Observed',
    mission: 'test',
    preset: 'custom',
    status: 'running',
  });
}

function setKv(key: string, value: string): void {
  fake.raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, value);
}

const input: AddAgentToSwarmInput = { swarmId: SWARM_ID, providerId: 'claude' };

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  vi.mocked(resolveAndSpawn).mockImplementation(
    () =>
      ({
        ptySession: {
          id: 'sess-spawned-observed',
          providerId: 'claude',
          cwd: '/tmp/ws-observed',
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
        providerEffective: 'claude',
        fallbackOccurred: false,
      }) as unknown as ReturnType<typeof resolveAndSpawn>,
  );
  seedRunningSwarm();
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
  vi.mocked(resolveAndSpawn).mockReset();
});

describe('addAgentToSwarm — observed-process RAM-brake (C-061)', () => {
  it('a leaky same-workspace pane HOLDS the add, before any spawn or agent row', async () => {
    const { deps } = makeDeps();

    await expect(addAgentToSwarm(input, deps)).rejects.toThrow(
      'RAM_BRAKE_OBSERVED_PROCESS_BUDGET:',
    );

    // The hold must land BEFORE the side effects, exactly like the 20-cap
    // refusal: no PTY, no mailbox traffic, no swarm_agents row to clean up.
    expect(vi.mocked(resolveAndSpawn)).not.toHaveBeenCalled();
    expect(deps.mailbox.append).not.toHaveBeenCalled();
    expect(fake.store.tables.get('swarm_agents') ?? []).toHaveLength(0);
  });

  it('the same over-budget pane blocks on RSS alone (per-workspace cap)', async () => {
    // 5 GiB in ONE clean pane — no duplicate MCP chains, only the workspace-RSS
    // cap (4 GiB default). Pins that BOTH observed dimensions reach `+ Pane`.
    const FIVE_GIB = 5 * 1024 * 1024 * 1024;
    const { deps } = makeDeps(async () => ({
      rootPid: 10,
      supported: true,
      rssBytes: FIVE_GIB,
      descendantPids: [],
      nodes: [{ pid: 10, ppid: 1, rssBytes: FIVE_GIB, command: 'claude', args: 'claude' }],
    }));

    await expect(addAgentToSwarm(input, deps)).rejects.toThrow(
      'RAM_BRAKE_OBSERVED_PROCESS_BUDGET:',
    );
  });

  it('forceRamBrake completes the add over the same leaky pane', async () => {
    const { deps } = makeDeps();

    const result = await addAgentToSwarm({ ...input, forceRamBrake: true }, deps);

    expect(result.sessionId).toBe('sess-spawned-observed');
    expect(result.agentKey).toBe('builder-1');
  });

  it('FAILS OPEN when the snapshot rejects — inspection being unavailable must never block', async () => {
    const { deps, processSnapshotCached } = makeDeps(async () => {
      throw new Error('ps: command not found');
    });

    const result = await addAgentToSwarm(input, deps);

    expect(result.sessionId).toBe('sess-spawned-observed');
    expect(processSnapshotCached).toHaveBeenCalledWith(LIVE_PANE);
  });

  it('FAILS OPEN on a null snapshot (unsupported platform)', async () => {
    const { deps } = makeDeps(async () => null);

    await expect(addAgentToSwarm(input, deps)).resolves.toMatchObject({
      sessionId: 'sess-spawned-observed',
    });
  });

  it('ramBrake.observedEnabled = 0 skips the preflight entirely — no snapshots taken', async () => {
    setKv('ramBrake.observedEnabled', '0');
    const { deps, processSnapshotCached } = makeDeps();

    const result = await addAgentToSwarm(input, deps);

    expect(result.sessionId).toBe('sess-spawned-observed');
    // Disabled means SKIPPED, not "checked and forgiven".
    expect(processSnapshotCached).not.toHaveBeenCalled();
  });

  it('does not attribute a foreign-workspace pane to this workspace', async () => {
    // The leaky pane belongs to a DIFFERENT workspace: it counts toward the
    // total-RSS cap (far under it here) but never against this workspace, so the
    // add proceeds. Mirrors the launcher's guarantee.
    const { deps } = makeDeps();
    deps.pty.list = vi.fn(() => [
      { id: LIVE_PANE, workspaceId: 'ws-somewhere-else' },
    ]) as unknown as SwarmFactoryDeps['pty']['list'];

    await expect(addAgentToSwarm(input, deps)).resolves.toMatchObject({
      sessionId: 'sess-spawned-observed',
    });
  });
});
