// H-10 (Wave-2 hardening) — duplicate-pane spawn must not leak a PTY.
//
// `spawnAgentSession` spawns the PTY (via resolveAndSpawn) BEFORE it inserts the
// `agent_sessions` row. When that INSERT trips a `UNIQUE constraint failed`, the
// factory suppresses the error and returns the existing session id — but the
// PTY it just spawned is now orphaned: it has no DB row and is never on a future
// kill path. The fix kills + forgets the spawned PTY in the UNIQUE branch.
//
// We mock the db client and the providers launcher so the test never touches
// better-sqlite3 nor a real PTY (see the project's MockDb convention — the
// Electron-built native binding cannot load under vitest's node ABI).

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
import { spawnAgentSession, type SpawnAgentSessionArgs } from './factory-spawn';
import type { SwarmFactoryDeps } from './factory';

const SPAWNED_PTY_ID = 'sess-spawned-leaky';

interface RegistryStub {
  create: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function makePtyRegistryStub(): RegistryStub {
  return {
    create: vi.fn(),
    kill: vi.fn(),
    forget: vi.fn(),
    write: vi.fn(),
    list: vi.fn(() => []),
  };
}

function makeMailboxStub(): SwarmFactoryDeps['mailbox'] {
  return {
    ensureInbox: vi.fn((_s: string, k: string) => `/tmp/inbox-${k}.jsonl`),
    append: vi.fn(async () => undefined),
  } as unknown as SwarmFactoryDeps['mailbox'];
}

function makeDeps(registry: RegistryStub): SwarmFactoryDeps {
  return {
    pty: registry as unknown as SwarmFactoryDeps['pty'],
    worktreePool: { create: vi.fn() } as unknown as SwarmFactoryDeps['worktreePool'],
    mailbox: makeMailboxStub(),
    userDataDir: '/tmp/sigmalink-factory-spawn-test',
  } as SwarmFactoryDeps;
}

function makeArgs(deps: SwarmFactoryDeps): SpawnAgentSessionArgs {
  return {
    // repoMode 'plain' (no repoRoot) → no worktree pool call, no guardrail write.
    wsRow: {
      id: 'ws-1',
      name: 'ws-1',
      rootPath: '/tmp/ws-1',
      repoRoot: null,
      repoMode: 'plain',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    } as unknown as SpawnAgentSessionArgs['wsRow'],
    swarmId: 'swarm-1',
    agentId: 'agent-1',
    role: 'builder',
    roleIndex: 1,
    providerId: 'shell', // avoids the claude-only prepareClaudeWorkspaceContext branch
    agentKey: 'builder-1',
    deps,
  };
}

/**
 * resolveAndSpawn stub: returns a SessionRecord-shaped object whose id is the
 * PTY we expect to be killed+forgotten when the INSERT fails.
 */
function stubSpawn(): void {
  vi.mocked(resolveAndSpawn).mockImplementation(
    () =>
      ({
        ptySession: {
          id: SPAWNED_PTY_ID,
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
        providerRequested: 'shell',
        providerEffective: 'shell',
        commandUsed: '',
        argsUsed: [],
        fallbackOccurred: false,
      }) as unknown as ReturnType<typeof resolveAndSpawn>,
  );
}

/**
 * getRawDb stub: only the `providers.showLegacy` KV lookup and the best-effort
 * provider_effective UPDATE touch it. Return a benign no-op shim.
 */
function makeRawStub() {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: vi.fn(() => undefined),
    })),
  };
}

beforeEach(() => {
  stubSpawn();
  vi.mocked(getRawDb).mockReturnValue(makeRawStub() as unknown as ReturnType<typeof getRawDb>);
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
  vi.mocked(resolveAndSpawn).mockReset();
  vi.restoreAllMocks();
});

describe('spawnAgentSession — H-10 PTY leak on UNIQUE violation', () => {
  it('kills + forgets the orphaned PTY when the agent_sessions INSERT trips UNIQUE', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // getDb().insert(...).values(...).run() throws a UNIQUE violation, mirroring
    // a duplicate (workspace_id, pane_index) collision.
    const insertRun = vi.fn(() => {
      throw new Error('UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index');
    });
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    const returnedId = await spawnAgentSession(makeArgs(deps));

    // Suppression contract preserved: the existing session id is returned, no throw.
    expect(returnedId).toBe(SPAWNED_PTY_ID);
    // The INSERT was attempted (and threw).
    expect(insertRun).toHaveBeenCalledTimes(1);

    // H-10: the orphaned PTY must be torn down — kill THEN forget, both on the
    // just-spawned session id.
    expect(registry.kill).toHaveBeenCalledTimes(1);
    expect(registry.kill).toHaveBeenCalledWith(SPAWNED_PTY_ID);
    expect(registry.forget).toHaveBeenCalledTimes(1);
    expect(registry.forget).toHaveBeenCalledWith(SPAWNED_PTY_ID);
  });

  it('does NOT kill/forget on the happy path (INSERT succeeds)', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    const insertRun = vi.fn(() => undefined);
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    const returnedId = await spawnAgentSession(makeArgs(deps));

    expect(returnedId).toBe(SPAWNED_PTY_ID);
    expect(insertRun).toHaveBeenCalledTimes(1);
    // No teardown on success — the PTY belongs to a live, persisted session.
    expect(registry.kill).not.toHaveBeenCalled();
    expect(registry.forget).not.toHaveBeenCalled();
  });

  it('re-throws a non-UNIQUE INSERT error WITHOUT killing the PTY (unchanged behavior)', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    const insertRun = vi.fn(() => {
      throw new Error('disk I/O error');
    });
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    await expect(spawnAgentSession(makeArgs(deps))).rejects.toThrow(/disk I\/O error/);
    // The UNIQUE-only teardown must not fire for other errors — the caller
    // (materializeRosterAgent) handles those by marking the agent row errored.
    expect(registry.kill).not.toHaveBeenCalled();
    expect(registry.forget).not.toHaveBeenCalled();
  });
});
