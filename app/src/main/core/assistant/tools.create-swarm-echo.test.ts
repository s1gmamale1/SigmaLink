// Phase 3 follow-up (Task 4) — create_swarm must echo assistant:dispatch-echo
// for each spawned agent pane so the Command Room grid renders the swarm's
// panes LIVE (use-jorvis-dispatch-echo refetches panes + swarms). Without the
// echo a Jorvis-created swarm's panes only appeared on a workspace reopen
// (the renderer only refetches swarms on a workspace-id CHANGE).
//
// The swarm factory (createSwarm) spawns real PTYs/worktrees, so this isolated
// file mocks `../swarms/factory` to return a deterministic Swarm shape and
// asserts the handler's echo loop. Kept SEPARATE from tools.test.ts, whose
// add_agent tests deliberately exercise the REAL addAgentToSwarm against the
// DB fake — mocking the factory there would break them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));

const createSwarmMock = vi.fn();
vi.mock('../swarms/factory', () => ({
  createSwarm: (...args: unknown[]) => createSwarmMock(...args),
  addAgentToSwarm: vi.fn(),
  listSwarmsForWorkspace: vi.fn(() => []),
}));

import { findTool } from './tools';
import type { ToolContext } from './tools';
import { getDb, getRawDb } from '../db/client';
import { createDbFake, seedWorkspace, type DbFake } from '@/test-utils/db-fake';
import type { Swarm, SwarmAgent } from '../../../shared/types';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  createSwarmMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeCtx(emit?: (event: string, payload: unknown) => void): ToolContext {
  return {
    pty: { list: () => [] },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/sigmalink-test',
    emit,
  } as unknown as ToolContext;
}

function agent(overrides: Partial<SwarmAgent>): SwarmAgent {
  return {
    id: 'agent-x',
    swarmId: 'swarm-1',
    role: 'builder',
    roleIndex: 1,
    providerId: 'claude',
    sessionId: 'sess-x',
    status: 'idle',
    inboxPath: '/tmp/inbox',
    agentKey: 'builder-1',
    ...overrides,
  };
}

function swarmWith(agents: SwarmAgent[]): Swarm {
  return {
    id: 'swarm-1',
    workspaceId: 'ws-1',
    name: 'Build',
    mission: 'ship it',
    preset: 'squad',
    status: 'running',
    createdAt: 1,
    endedAt: null,
    agents,
  };
}

describe('create_swarm dispatch-echo (Phase 3 follow-up Task 4)', () => {
  it('emits one assistant:dispatch-echo per agent that got a session', async () => {
    createSwarmMock.mockResolvedValue(
      swarmWith([
        agent({ id: 'a1', sessionId: 'sess-1', providerId: 'claude', status: 'idle', agentKey: 'builder-1' }),
        agent({ id: 'a2', sessionId: 'sess-2', providerId: 'codex', status: 'idle', agentKey: 'builder-2', roleIndex: 2 }),
      ]),
    );
    const emit = vi.fn();
    const ctx = makeCtx(emit);

    await findTool('create_swarm')!.handler({ mission: 'ship it', preset: 'squad' }, ctx);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, 'assistant:dispatch-echo', {
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      providerId: 'claude',
      ok: true,
      error: null,
      conversationId: null,
    });
    expect(emit).toHaveBeenNthCalledWith(2, 'assistant:dispatch-echo', {
      workspaceId: 'ws-1',
      sessionId: 'sess-2',
      providerId: 'codex',
      ok: true,
      error: null,
      conversationId: null,
    });
  });

  it('skips agents with a null sessionId and marks an errored agent ok:false', async () => {
    createSwarmMock.mockResolvedValue(
      swarmWith([
        agent({ id: 'a1', sessionId: null, agentKey: 'builder-1' }), // never spawned — no echo
        agent({ id: 'a2', sessionId: 'sess-2', providerId: 'codex', status: 'error', agentKey: 'builder-2', roleIndex: 2 }),
      ]),
    );
    const emit = vi.fn();

    await findTool('create_swarm')!.handler({ mission: 'm', preset: 'squad' }, makeCtx(emit));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('assistant:dispatch-echo', {
      workspaceId: 'ws-1',
      sessionId: 'sess-2',
      providerId: 'codex',
      ok: false,
      error: null,
      conversationId: null,
    });
  });

  it('does not throw when ctx.emit is absent (back-compat)', async () => {
    createSwarmMock.mockResolvedValue(swarmWith([agent({ sessionId: 'sess-1' })]));
    const out = await findTool('create_swarm')!.handler(
      { mission: 'm', preset: 'squad' },
      makeCtx(undefined),
    );
    expect(out).toMatchObject({ swarm: { id: 'swarm-1' } });
  });

  it('emits nothing for an empty (custom) swarm', async () => {
    createSwarmMock.mockResolvedValue(swarmWith([]));
    const emit = vi.fn();
    await findTool('create_swarm')!.handler({ mission: 'm', preset: 'custom' }, makeCtx(emit));
    expect(emit).not.toHaveBeenCalled();
  });
});
