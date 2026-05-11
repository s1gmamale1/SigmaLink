import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, getRawDb, closeDatabase } from '../db/client';
import { findTool } from './tools';
import type { ToolContext } from './tools';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-assistant-tools-'));
  tmpDirs.push(dir);
  return dir;
}

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

function seedWorkspace(id: string, rootPath: string, lastOpenedAt: number): void {
  getRawDb()
    .prepare(
      `INSERT INTO workspaces (id, name, root_path, repo_mode, created_at, last_opened_at)
       VALUES (?, ?, ?, 'plain', ?, ?)`,
    )
    .run(id, path.basename(rootPath), rootPath, lastOpenedAt, lastOpenedAt);
}

beforeEach(() => {
  initializeDatabase(makeTmpDir());
});

afterEach(() => {
  closeDatabase();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assistant list_* tools', () => {
  it('list_active_sessions returns live registry sessions with swarm metadata', async () => {
    const root = '/tmp/ws-1';
    seedWorkspace('ws-1', root, 100);
    getRawDb()
      .prepare(
        `INSERT INTO agent_sessions
         (id, workspace_id, provider_id, cwd, status, started_at, provider_effective)
         VALUES ('sess-1', 'ws-1', 'bridgecode', ?, 'running', 101, 'codex')`,
      )
      .run(root);
    getRawDb()
      .prepare(
        `INSERT INTO swarms (id, workspace_id, name, mission, preset, status, created_at)
         VALUES ('swarm-1', 'ws-1', 'Build', 'test', 'squad', 'running', 102)`,
      )
      .run();
    getRawDb()
      .prepare(
        `INSERT INTO swarm_agents
         (id, swarm_id, role, role_index, provider_id, session_id, status, inbox_path, agent_key)
         VALUES ('agent-1', 'swarm-1', 'coordinator', 1, 'codex', 'sess-1', 'idle', '/tmp/inbox', 'coordinator-1')`,
      )
      .run();

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
    seedWorkspace('ws-1', '/tmp/ws-1', 100);
    getRawDb()
      .prepare(
        `INSERT INTO swarms (id, workspace_id, name, mission, preset, status, created_at)
         VALUES ('swarm-1', 'ws-1', 'Build', 'test', 'team', 'running', 102)`,
      )
      .run();
    getRawDb()
      .prepare(
        `INSERT INTO swarm_agents
         (id, swarm_id, role, role_index, provider_id, session_id, status, inbox_path, agent_key)
         VALUES ('agent-1', 'swarm-1', 'builder', 1, 'codex', 'sess-1', 'busy', '/tmp/inbox', 'builder-1')`,
      )
      .run();

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
    seedWorkspace('ws-old', '/tmp/old', 100);
    seedWorkspace('ws-active', '/tmp/active', 200);

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
    seedWorkspace('ws-1', '/tmp/ws-1', 100);
    getRawDb()
      .prepare(
        `INSERT INTO swarms (id, workspace_id, name, mission, preset, status, created_at)
         VALUES ('swarm-1', 'ws-1', 'Build', 'test', 'custom', 'running', 102)`,
      )
      .run();
    const stmt = getRawDb().prepare(
      `INSERT INTO swarm_agents
       (id, swarm_id, role, role_index, provider_id, session_id, status, inbox_path, agent_key)
       VALUES (?, 'swarm-1', 'builder', ?, 'shell', ?, 'idle', ?, ?)`,
    );
    for (let i = 1; i <= count; i += 1) {
      stmt.run(
        `agent-${i}`,
        i,
        `sess-${i}`,
        `/tmp/inbox-builder-${i}`,
        `builder-${i}`,
      );
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
    const agent = getRawDb()
      .prepare(
        `SELECT agent_key, session_id, role, role_index
         FROM swarm_agents WHERE swarm_id = 'swarm-1' AND agent_key = 'builder-2'`,
      )
      .get() as
      | { agent_key: string; session_id: string; role: string; role_index: number }
      | undefined;
    expect(agent).toEqual({
      agent_key: 'builder-2',
      session_id: 'sess-new',
      role: 'builder',
      role_index: 2,
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
