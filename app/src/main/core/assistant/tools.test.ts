import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import {
  closeDatabase,
  getDb,
  getRawDb,
  initializeDatabase,
} from '../db/client';
import { findTool } from './tools';
import type { ToolContext } from './tools';
import {
  createDbFake,
  seedAgent,
  seedSwarm,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';

const tmpDirs: string[] = [];

function makeCtx(
  sessions: Array<{
    id: string;
    providerId: string;
    cwd: string;
    alive: boolean;
  }> = [],
  defaultWorkspaceId: string | null = 'ws-1',
): ToolContext {
  return {
    pty: {
      list: () => sessions,
    },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId,
    userDataDir: '/tmp/sigmalink-test',
  } as unknown as ToolContext;
}

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  vi.mocked(initializeDatabase).mockReturnValue({
    db: fake.drizzle as unknown as ReturnType<typeof initializeDatabase>['db'],
    raw: fake.raw as unknown as ReturnType<typeof initializeDatabase>['raw'],
    filePath: '/tmp/fake.db',
  });
  vi.mocked(closeDatabase).mockReturnValue(undefined);
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assistant list_* tools', () => {
  it('list_active_sessions returns live registry sessions with swarm metadata', async () => {
    const root = '/tmp/ws-1';
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: root });
    // Seed an agent_sessions row via the raw shim (mirrors how production
    // tests previously seeded with `INSERT INTO agent_sessions ...`).
    getRawDb()
      .prepare(
        `INSERT INTO agent_sessions
         (id, workspace_id, provider_id, cwd, status, started_at, provider_effective)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-1', 'ws-1', 'bridgecode', root, 'running', 101, 'codex');
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'squad',
      status: 'running',
      createdAt: 102,
    });
    seedAgent(fake, {
      id: 'agent-1',
      swarmId: 'swarm-1',
      role: 'coordinator',
      roleIndex: 1,
      providerId: 'codex',
      sessionId: 'sess-1',
      status: 'idle',
      inboxPath: '/tmp/inbox',
      agentKey: 'coordinator-1',
    });

    const out = await findTool('list_active_sessions')!.handler(
      { workspaceId: 'ws-1' },
      makeCtx([
        { id: 'sess-1', providerId: 'bridgecode', cwd: root, alive: true },
        { id: 'dead-1', providerId: 'codex', cwd: root, alive: false },
        { id: 'other-1', providerId: 'codex', cwd: '/tmp/other', alive: true },
      ]),
    );

    expect(out).toEqual({
      sessions: [
        {
          sessionId: 'sess-1',
          provider: 'codex',
          status: 'running',
          agentKey: 'coordinator-1',
          swarmId: 'swarm-1',
          paneIndex: 0,
        },
      ],
    });
  });

  it('list_swarms returns swarm summaries with role roster', async () => {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'team',
      status: 'running',
      createdAt: 102,
    });
    seedAgent(fake, {
      id: 'agent-1',
      swarmId: 'swarm-1',
      role: 'builder',
      roleIndex: 1,
      providerId: 'codex',
      sessionId: 'sess-1',
      status: 'busy',
      inboxPath: '/tmp/inbox',
      agentKey: 'builder-1',
    });

    const out = await findTool('list_swarms')!.handler({}, makeCtx());

    expect(out).toEqual({
      swarms: [
        {
          swarmId: 'swarm-1',
          name: 'Build',
          status: 'running',
          agentCount: 1,
          roles: [
            {
              agentKey: 'builder-1',
              role: 'builder',
              status: 'busy',
              sessionId: 'sess-1',
              provider: 'codex',
            },
          ],
        },
      ],
    });
  });

  it('list_workspaces marks the active assistant workspace', async () => {
    seedWorkspace(fake, { id: 'ws-old', name: 'old', rootPath: '/tmp/old', lastOpenedAt: 100 });
    seedWorkspace(fake, {
      id: 'ws-active',
      name: 'active',
      rootPath: '/tmp/active',
      lastOpenedAt: 200,
    });

    const out = await findTool('list_workspaces')!.handler(
      {},
      makeCtx([], 'ws-active'),
    );

    expect(out).toEqual({
      workspaces: [
        { id: 'ws-active', name: 'active', rootPath: '/tmp/active', active: true },
        { id: 'ws-old', name: 'old', rootPath: '/tmp/old', active: false },
      ],
    });
  });
});

describe('assistant add_agent tool', () => {
  function seedSwarmWithBuilders(count: number): void {
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
    seedSwarm(fake, {
      id: 'swarm-1',
      workspaceId: 'ws-1',
      name: 'Build',
      mission: 'test',
      preset: 'custom',
      status: 'running',
      createdAt: 102,
    });
    for (let i = 1; i <= count; i += 1) {
      seedAgent(fake, {
        id: `agent-${i}`,
        swarmId: 'swarm-1',
        role: 'builder',
        roleIndex: i,
        providerId: 'shell',
        sessionId: `sess-${i}`,
        status: 'idle',
        inboxPath: `/tmp/inbox-builder-${i}`,
        agentKey: `builder-${i}`,
      });
    }
  }

  function makeAddAgentCtx() {
    const ptyHandle = {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    };
    const pty = {
      create: vi.fn((input: { providerId: string; cwd: string }) => ({
        id: 'sess-new',
        providerId: input.providerId,
        cwd: input.cwd,
        pid: ptyHandle.pid,
        alive: true,
        startedAt: 1234,
        pty: ptyHandle,
      })),
      list: vi.fn(() => []),
      write: vi.fn(),
    };
    const mailbox = {
      ensureInbox: vi.fn((_swarmId: string, agentKey: string) => `/tmp/${agentKey}.jsonl`),
      append: vi.fn(async () => ({
        id: 'msg-1',
        swarmId: 'swarm-1',
        fromAgent: 'operator',
        toAgent: '*',
        kind: 'SYSTEM',
        body: 'ok',
        ts: 1,
      })),
    };
    return {
      ...makeCtx(),
      pty,
      mailbox,
    } as unknown as ToolContext;
  }

  it('add_agent appends a builder to an existing swarm', async () => {
    seedSwarmWithBuilders(1);
    const ctx = makeAddAgentCtx();

    const out = await findTool('add_agent')!.handler(
      { swarmId: 'swarm-1', providerId: 'shell' },
      ctx,
    );

    expect(out).toEqual({
      sessionId: 'sess-new',
      paneIndex: 1,
      agentKey: 'builder-2',
    });
    const rows = fake.store.tables.get('swarm_agents') ?? [];
    const agent = rows.find(
      (r) => r.swarmId === 'swarm-1' && r.agentKey === 'builder-2',
    );
    expect(agent).toMatchObject({
      agentKey: 'builder-2',
      sessionId: 'sess-new',
      role: 'builder',
      roleIndex: 2,
    });
  });

  it('add_agent refuses swarms at 20 agents before spawning', async () => {
    seedSwarmWithBuilders(20);
    const ctx = makeAddAgentCtx();

    await expect(
      findTool('add_agent')!.handler({ swarmId: 'swarm-1', providerId: 'shell' }, ctx),
    ).rejects.toThrow(/20 agents/);
    expect(
      (ctx.pty as unknown as { create: ReturnType<typeof vi.fn> }).create,
    ).not.toHaveBeenCalled();
  });
});
