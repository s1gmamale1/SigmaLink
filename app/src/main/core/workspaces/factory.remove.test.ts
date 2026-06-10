// MED [ws] 2026-06-10 audit — removeWorkspace stopped the ruflo daemon then
// deleted ONLY the workspaces row: live PTYs kept running headless and
// agent_sessions rows orphaned forever (the bootstrap agent_sessions DDL has
// no FK/cascade, unlike swarms/browser_tabs). Next boot the janitor flips the
// orphans to exited/-1, whose worktrees the keep-predicate protects with no
// time bound. The fixed removeWorkspace mirrors cleanup.ts
// removeWorkspaceAndGc's stopLiveSessions semantics: stop live
// (starting|running) PTYs with {tree:true, forget:true}, delete the
// workspace's agent_sessions rows, THEN delete the workspace row.
//
// better-sqlite3 cannot load under vitest (Electron ABI) — every external
// module factory.ts touches is mocked, same harness as factory.test.ts.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  },
}));
vi.mock('../git/git-ops', () => ({ getRepoRoot: vi.fn(async () => null) }));
vi.mock('./mcp-autowrite', () => ({
  KV_RUFLO_AUTOWRITE_MCP: 'ruflo.autowriteMcp',
  KV_RUFLO_AUTOTRUST_MCP: 'ruflo.autotrustMcp',
  writeWorkspaceMcpConfig: vi.fn(),
}));
vi.mock('./mcp-trust', () => ({ ensureRufloTrusted: vi.fn() }));
vi.mock('./ruflo-fallback-notice', () => ({ maybeNotifyStdioFallback: vi.fn() }));
vi.mock('../ruflo/seed-workspace-memory', () => ({
  seedWorkspaceMemory: vi.fn(async () => {}),
}));
vi.mock('../ruflo/verify', () => ({
  KV_RUFLO_STRICT_MCP_VERIFICATION: 'ruflo.strictMcpVerification',
  verifyForWorkspace: vi.fn(async () => ({ ok: true })),
}));

// ── Fake drizzle db — captures delete-call order by TABLE OBJECT identity ──

interface FakeSessionRow {
  id: string;
  status: string;
  workspaceId: string;
}

let _sessions: FakeSessionRow[] = [];
/** drizzle table objects passed to db.delete(), in call order. */
let _deletedTables: unknown[] = [];

vi.mock('../db/client', () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => _sessions),
          get: vi.fn(() => undefined),
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        run: vi.fn(() => {
          _deletedTables.push(table);
        }),
      })),
    })),
    insert: vi.fn(),
    update: vi.fn(),
  })),
  getRawDb: vi.fn(() => ({
    pragma: vi.fn(),
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })),
  })),
}));

import { removeWorkspace } from './factory';
// schema.ts is pure drizzle-orm/sqlite-core (no native module) — safe to
// import; factory.ts imports the SAME module instance, so identity comparison
// of table objects is sound.
import { agentSessions, workspaces } from '../db/schema';

describe('removeWorkspace — session lifecycle (2026-06-10 audit MED [ws])', () => {
  let ptyStop: Mock<
    (id: string, opts?: { tree?: boolean; forget?: boolean }) => null
  >;

  beforeEach(() => {
    _sessions = [];
    _deletedTables = [];
    ptyStop = vi.fn(() => null);
  });

  it('stops live (starting|running) PTYs with {tree:true, forget:true} and skips dead ones', async () => {
    _sessions = [
      { id: 's-running', status: 'running', workspaceId: 'ws-1' },
      { id: 's-starting', status: 'starting', workspaceId: 'ws-1' },
      { id: 's-exited', status: 'exited', workspaceId: 'ws-1' },
      { id: 's-error', status: 'error', workspaceId: 'ws-1' },
    ];

    await removeWorkspace('ws-1', { pty: { stop: ptyStop } });

    expect(ptyStop).toHaveBeenCalledTimes(2);
    expect(ptyStop).toHaveBeenCalledWith('s-running', { tree: true, forget: true });
    expect(ptyStop).toHaveBeenCalledWith('s-starting', { tree: true, forget: true });
  });

  it('deletes the agent_sessions rows BEFORE the workspaces row', async () => {
    _sessions = [{ id: 's-1', status: 'exited', workspaceId: 'ws-1' }];

    await removeWorkspace('ws-1', { pty: { stop: ptyStop } });

    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('still deletes both row sets when no pty registry is provided', async () => {
    _sessions = [{ id: 's-1', status: 'running', workspaceId: 'ws-1' }];

    await expect(removeWorkspace('ws-1')).resolves.toBeUndefined();

    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('a throwing pty.stop does not abort removal and later sessions are still stopped (fail-open)', async () => {
    _sessions = [
      { id: 's-boom', status: 'running', workspaceId: 'ws-1' },
      { id: 's-2', status: 'running', workspaceId: 'ws-1' },
    ];
    ptyStop.mockImplementation((id: string) => {
      if (id === 's-boom') throw new Error('kill failed');
      return null;
    });

    await expect(
      removeWorkspace('ws-1', { pty: { stop: ptyStop } }),
    ).resolves.toBeUndefined();

    expect(ptyStop).toHaveBeenCalledTimes(2);
    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });

  it('stops the ruflo HTTP daemon and its failure never blocks removal (pre-existing contract)', async () => {
    const daemonStop = vi.fn(async (): Promise<void> => {
      throw new Error('daemon stop failed');
    });

    await expect(
      removeWorkspace('ws-1', { rufloHttpDaemonSupervisor: { stop: daemonStop } }),
    ).resolves.toBeUndefined();

    expect(daemonStop).toHaveBeenCalledWith('ws-1');
    expect(_deletedTables).toEqual([agentSessions, workspaces]);
  });
});
