// v1.4.3 #06 — controller-level coverage for the new splitPane + minimisePane
// RPC handlers. The factory.test.ts file already exercises `addAgentToSwarm`
// in depth; this file focuses on the splitPane wiring (worktree-share,
// max-depth rejection, group annotation) and the minimisePane toggle.

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
  seedAgentSession,
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import { buildSwarmController } from './controller';
import { findPaneById, getPaneSplitGroup } from './split-dao';
import { WorktreeDiskGuardError } from '../git/worktree';

let fake: DbFake;
let spawnCallSeq = 0;

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
    userDataDir: '/tmp/sigmalink-controller-test',
  };
}

function stubSpawn() {
  vi.mocked(resolveAndSpawn).mockImplementation(() => {
    spawnCallSeq += 1;
    const id = `sess-spawned-${spawnCallSeq}`;
    return {
      ptySession: {
        id,
        providerId: 'shell',
        cwd: '/tmp/parent-cwd',
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

function seedSwarmWithParentPane(): {
  parentSessionId: string;
  swarmId: string;
} {
  seedWorkspace(fake, {
    id: 'ws-1',
    name: 'ws-1',
    rootPath: '/tmp/ws-1',
    repoMode: 'plain',
  });
  seedSwarm(fake, {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Build',
    mission: 'test',
    preset: 'custom',
    status: 'running',
  });
  // The parent pane has a worktree path that the split sub-pane must inherit.
  seedAgentSession(fake, {
    id: 'parent-sess',
    workspaceId: 'ws-1',
    providerId: 'shell',
    cwd: '/tmp/parent-cwd',
    branch: 'main',
    worktreePath: '/tmp/parent-worktree',
    status: 'running',
  });
  seedAgent(fake, {
    id: 'parent-agent',
    swarmId: 'swarm-1',
    role: 'builder',
    roleIndex: 1,
    providerId: 'claude',
    sessionId: 'parent-sess',
    status: 'idle',
    inboxPath: '/tmp/inbox-builder-1',
    agentKey: 'builder-1',
  });
  return { parentSessionId: 'parent-sess', swarmId: 'swarm-1' };
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

describe('splitPane RPC', () => {
  it('happy path: annotates parent + new sub-pane with a shared split_group_id', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const ctl = buildSwarmController(makeDeps());

    const session = await ctl.splitPane({
      paneId: parentSessionId,
      direction: 'horizontal',
      provider: 'codex',
    });

    expect(session.id).toMatch(/^sess-spawned-/);

    const parent = findPaneById(parentSessionId);
    expect(parent?.splitGroupId).toBeTruthy();
    expect(parent?.splitDirection).toBe('horizontal');
    expect(parent?.splitIndex).toBe(0);

    const child = findPaneById(session.id);
    expect(child?.splitGroupId).toBe(parent?.splitGroupId);
    expect(child?.splitDirection).toBe('horizontal');
    expect(child?.splitIndex).toBe(1);
  });

  it('sub-pane shares the parent worktree (no new worktree allocated)', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const deps = makeDeps();
    const ctl = buildSwarmController(deps);

    const session = await ctl.splitPane({
      paneId: parentSessionId,
      direction: 'vertical',
      provider: 'codex',
    });

    // The worktree pool MUST NOT have been called for the split sub-pane —
    // worktree-share is the intentional design (see R-06-1).
    expect(deps.worktreePool.create as unknown as { mock: { calls: unknown[] } }).toBeDefined();
    expect((deps.worktreePool.create as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);

    // The sub-pane's persisted row inherits the parent's worktree + cwd +
    // branch verbatim.
    const child = findPaneById(session.id);
    expect(child?.worktreePath).toBe('/tmp/parent-worktree');
    expect(child?.cwd).toBe('/tmp/parent-cwd');
    expect(child?.branch).toBe('main');
  });

  it('rejects splitPane when the parent is already in a split group (max-depth 2)', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const ctl = buildSwarmController(makeDeps());

    // First split — succeeds.
    await ctl.splitPane({
      paneId: parentSessionId,
      direction: 'horizontal',
      provider: 'codex',
    });

    // Second split on the same (now-grouped) parent — must reject.
    await expect(
      ctl.splitPane({
        paneId: parentSessionId,
        direction: 'horizontal',
        provider: 'codex',
      }),
    ).rejects.toThrow(/max 2-level deep/);
  });

  it('rejects splitPane when the parent pane does not exist', async () => {
    seedSwarmWithParentPane(); // seed unrelated state for realism
    const ctl = buildSwarmController(makeDeps());

    await expect(
      ctl.splitPane({
        paneId: 'ghost-session',
        direction: 'horizontal',
        provider: 'codex',
      }),
    ).rejects.toThrow(/parent pane not found/);
  });
});

describe('minimisePane RPC', () => {
  it('toggles minimised=true on the target pane', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const ctl = buildSwarmController(makeDeps());

    await ctl.minimisePane({ paneId: parentSessionId, minimised: true });

    const row = findPaneById(parentSessionId) as unknown as { minimised: number };
    expect(row.minimised).toBe(1);
  });

  it('toggles minimised=false on the target pane', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const ctl = buildSwarmController(makeDeps());

    await ctl.minimisePane({ paneId: parentSessionId, minimised: true });
    await ctl.minimisePane({ paneId: parentSessionId, minimised: false });

    const row = findPaneById(parentSessionId) as unknown as { minimised: number };
    expect(row.minimised).toBe(0);
  });
});

describe('split group integration', () => {
  it('getPaneSplitGroup returns both halves after a split', async () => {
    const { parentSessionId } = seedSwarmWithParentPane();
    const ctl = buildSwarmController(makeDeps());

    const session = await ctl.splitPane({
      paneId: parentSessionId,
      direction: 'horizontal',
      provider: 'codex',
    });

    const parent = findPaneById(parentSessionId);
    const group = getPaneSplitGroup(parent!.splitGroupId!);
    expect(group).toHaveLength(2);
    expect(group.map((p) => p.id).sort()).toEqual(
      [parentSessionId, session.id].sort(),
    );
  });
});

// ── C6 obs (HIGH fix) — controller threads the notifications sink end-to-end ──
//
// The disk-guard catch in the spawn paths is only useful if the PROD wiring
// actually supplies a `notifications` sink. The existing factory/spawn tests
// inject the sink DIRECTLY, so they can't catch a regression where the
// controller (or the router) stops threading it. These tests build the
// controller exactly as rpc-router does — `buildSwarmController({ ...,
// notifications })` — and prove the sink reaches the disk-guard catch through
// the controller → SwarmFactoryDeps → addAgentToSwarm chain. If the
// `notifications: deps.notifications` thread in controller.ts is removed, these
// go red.
describe('controller notifications threading — C6 disk-guard reaches the sink', () => {
  function seedGitSwarmForAddAgent(): void {
    seedWorkspace(fake, {
      id: 'ws-1',
      name: 'ws-1',
      rootPath: '/tmp/ws-1',
      repoMode: 'git',
      repoRoot: '/tmp/repo-1',
    });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'custom',
      status: 'running',
    });
  }

  it('addAgent: a disk-guard refusal fires the threaded notifications.add (critical)', async () => {
    seedGitSwarmForAddAgent();

    const deps = makeDeps();
    // Git gate reaches worktreePool.create; refuse on the disk floor.
    (deps.worktreePool.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new WorktreeDiskGuardError('DISK_FLOOR', 'disk floor reached: 0.5 GB free < 2 GB'),
    );

    const notificationsAdd = vi.fn();
    // Build the controller the SAME way rpc-router does: with a notifications sink.
    const ctl = buildSwarmController({
      ...deps,
      notifications: { add: notificationsAdd },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      ctl.addAgent({ swarmId: 'swarm-1', providerId: 'shell' }),
    ).rejects.toThrow(/disk floor/);

    // The sink supplied to the controller reached the spawn-path catch.
    expect(notificationsAdd).toHaveBeenCalledOnce();
    const addArg = notificationsAdd.mock.calls[0]![0] as {
      severity: string;
      kind: string;
      dedupKey: string;
    };
    expect(addArg.severity).toBe('critical');
    expect(addArg.kind).toBe('disk-guard');
    expect(addArg.dedupKey).toBe('disk-guard:DISK_FLOOR');

    warnSpy.mockRestore();
  });

  it('addAgent: omitting the sink is safe (no throw beyond the spawn error)', async () => {
    seedGitSwarmForAddAgent();

    const deps = makeDeps();
    (deps.worktreePool.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new WorktreeDiskGuardError('WORKTREE_CAP', 'worktree cap reached: 40/40'),
    );

    // No notifications sink — the catch must guard the optional call (`?.`).
    const ctl = buildSwarmController(deps);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      ctl.addAgent({ swarmId: 'swarm-1', providerId: 'shell' }),
    ).rejects.toThrow(/worktree cap/);

    // Still logged for the dev console even without a sink.
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(
      warnCalls.find((s) => s.includes('disk-guard')),
    ).toBeDefined();

    warnSpy.mockRestore();
  });
});
