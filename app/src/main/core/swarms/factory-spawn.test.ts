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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { agentSessions, swarmAgents } from '../db/schema';
import { resolveAndSpawn } from '../providers/launcher';
import { buildExtraArgs, spawnAgentSession, materializeRosterAgent, type SpawnAgentSessionArgs } from './factory-spawn';
import { WorktreeDiskGuardError } from '../git/worktree';
import type { SwarmFactoryDeps } from './factory';
import { KV_PTY_SPAWN_MODE } from '../pty/local-pty';
import * as bridge from '../pty/claude-resume-sigma';
import * as rpcRouter from '../../rpc-router';

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
 * getRawDb stub: the `providers.showLegacy` lookup, the best-effort
 * provider_effective UPDATE, and (SF-15) the ruflo autowrite/autotrust KV reads
 * touch it. Return '0' for the ruflo autowrite key so these PTY-leak tests stay
 * hermetic (no `.mcp.json` written into the stub cwd); everything else is a
 * benign no-op shim.
 */
function makeRawStub(kv: Record<string, string> = {}) {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((key?: string) => {
        if (/FROM kv/i.test(sql) && typeof key === 'string' && key in kv) {
          return { value: kv[key] };
        }
        // SF-15 — opt the per-worktree ruflo write OUT in this suite.
        if (/FROM kv/i.test(sql) && key === 'ruflo.autowriteMcp') return { value: '0' };
        return undefined;
      }),
      all: vi.fn(() => []),
      run: vi.fn(() => undefined),
    })),
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
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

describe('buildExtraArgs — provider oneshot substitution', () => {
  it('substitutes {prompt} into cursor oneshotArgs (-p <prompt>)', () => {
    // R-2 — cursor mirrors claude's oneshot shape: ['-p', '{prompt}'].
    expect(buildExtraArgs('cursor', 'fix the bug')).toEqual(['-p', 'fix the bug']);
  });

  it('returns [] for cursor when no initial prompt is supplied', () => {
    expect(buildExtraArgs('cursor', undefined)).toEqual([]);
    expect(buildExtraArgs('cursor', '')).toEqual([]);
  });

  it('substitutes {prompt} for claude/codex the same way (parity check)', () => {
    expect(buildExtraArgs('claude', 'hi')).toEqual(['-p', 'hi']);
    expect(buildExtraArgs('codex', 'hi')).toEqual(['-q', 'hi']);
  });

  // Audit 2026-06-10 finding 3 — M1 allowlist parity with the launcher twin
  // (core/workspaces/launcher.ts buildExtraArgs): a modelId missing from the
  // shared catalog must be DROPPED, never forwarded as a CLI arg.
  it('drops a modelId not in the shared catalog (M1 allowlist parity)', () => {
    expect(buildExtraArgs('claude', undefined, 'not-a-real-model')).toEqual([]);
    expect(buildExtraArgs('claude', 'hi', '--dangerously-skip-permissions')).toEqual(['-p', 'hi']);
  });

  it('keeps a catalog-listed modelId (with and without a oneshot prompt)', () => {
    expect(buildExtraArgs('claude', undefined, 'claude-sonnet-4-6')).toEqual(['--model', 'claude-sonnet-4-6']);
    expect(buildExtraArgs('claude', 'hi', 'claude-sonnet-4-6')).toEqual(['--model', 'claude-sonnet-4-6', '-p', 'hi']);
  });
});

describe('spawnAgentSession — PTY spawn mode', () => {
  function stubInsert(): void {
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);
  }

  it('threads shell-first into swarm spawns when the provider can receive prompt args', async () => {
    vi.mocked(getRawDb).mockReturnValue(
      makeRawStub({ [KV_PTY_SPAWN_MODE]: 'shell-first' }) as unknown as ReturnType<typeof getRawDb>,
    );
    stubInsert();
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);
    const args = makeArgs(deps);
    args.providerId = 'cursor';
    args.initialPrompt = 'summarize the branch';

    await spawnAgentSession(args);

    expect(vi.mocked(resolveAndSpawn).mock.calls[0]?.[1].spawnMode).toBe('shell-first');
  });

  it('overrides shell-first to direct for prompt-via-stdin swarm providers', async () => {
    vi.mocked(getRawDb).mockReturnValue(
      makeRawStub({ [KV_PTY_SPAWN_MODE]: 'shell-first' }) as unknown as ReturnType<typeof getRawDb>,
    );
    stubInsert();
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);
    const args = makeArgs(deps);
    args.providerId = 'opencode';
    args.initialPrompt = 'summarize the branch';

    await spawnAgentSession(args);

    expect(vi.mocked(resolveAndSpawn).mock.calls[0]?.[1].spawnMode).toBe('direct');
  });
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

    const returned = await spawnAgentSession(makeArgs(deps));

    // Suppression contract preserved: the existing session id is returned, no throw.
    expect(returned.sessionId).toBe(SPAWNED_PTY_ID);
    expect(returned.paneIndex).toBe(-1);
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

    const returned = await spawnAgentSession(makeArgs(deps));

    expect(returned.sessionId).toBe(SPAWNED_PTY_ID);
    expect(returned.paneIndex).toBe(0);
    expect(insertRun).toHaveBeenCalledTimes(1);
    // No teardown on success — the PTY belongs to a live, persisted session.
    expect(registry.kill).not.toHaveBeenCalled();
    expect(registry.forget).not.toHaveBeenCalled();
  });

  it('persists the allocated workspace pane_index on INSERT', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);
    const raw = makeRawStub();
    vi.mocked(raw.prepare).mockImplementation((sql: string) => ({
      get: vi.fn(() => undefined),
      all: vi.fn(() => {
        if (/FROM agent_sessions/i.test(sql)) {
          return [
            { pane_index: 0, status: 'running' },
            { pane_index: 1, status: 'exited' },
            { pane_index: 2, status: 'starting' },
          ];
        }
        return [];
      }),
      run: vi.fn(() => undefined),
    }));
    vi.mocked(getRawDb).mockReturnValue(raw as unknown as ReturnType<typeof getRawDb>);

    const inserted: Record<string, unknown> = {};
    const dbStub = {
      insert: vi.fn(() => ({
        values: vi.fn((vals: Record<string, unknown>) => {
          Object.assign(inserted, vals);
          return { run: vi.fn(() => undefined) };
        }),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    const returned = await spawnAgentSession(makeArgs(deps));

    expect(returned.paneIndex).toBe(1);
    expect(inserted.paneIndex).toBe(1);
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

// ─── SF-15: per-worktree Ruflo MCP must land in the pane's cwd BEFORE spawn ───

describe('spawnAgentSession — SF-15 ruflo MCP written into worktree cwd', () => {
  const tmpDirs: string[] = [];

  function tmpCwd(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-sf15-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('writes a managed ruflo entry into the worktree cwd before the CLI spawns', async () => {
    const cwd = tmpCwd();
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // autowrite ON for THIS test: stub returns undefined for every KV (default ON).
    vi.mocked(getRawDb).mockReturnValue(
      {
        prepare: vi.fn(() => ({
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
          run: vi.fn(() => undefined),
        })),
        transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
      } as unknown as ReturnType<typeof getRawDb>,
    );

    // Assert ordering: at the moment resolveAndSpawn fires, the ruflo entry must
    // already be on disk in the cwd. We re-stub resolveAndSpawn to snapshot the
    // .mcp.json contents at spawn time.
    let mcpAtSpawn: string | null = null;
    vi.mocked(resolveAndSpawn).mockImplementation((_d, input: { cwd: string }) => {
      const f = path.join(input.cwd, '.mcp.json');
      mcpAtSpawn = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
      return {
        ptySession: {
          id: SPAWNED_PTY_ID,
          providerId: 'shell',
          cwd: input.cwd,
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
      } as unknown as ReturnType<typeof resolveAndSpawn>;
    });

    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    const args = makeArgs(deps);
    args.cwdOverride = cwd;
    await spawnAgentSession(args);

    // The ruflo entry was present in the cwd AT the moment of spawn (ordering).
    expect(mcpAtSpawn).not.toBeNull();
    const doc = JSON.parse(mcpAtSpawn as unknown as string) as {
      mcpServers?: { ruflo?: { command?: string; url?: string } };
    };
    expect(doc.mcpServers?.ruflo).toBeDefined();
    // No daemon port in this unit (getSharedDeps returns undefined) → stdio entry.
    expect(doc.mcpServers?.ruflo?.command).toBe('npx');
    // Trust file also landed in the cwd.
    expect(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('defaults swarm-added Claude panes to strict core MCP using shared Ruflo HTTP', async () => {
    const cwd = tmpCwd();
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);
    vi.spyOn(bridge, 'prepareClaudeWorkspaceContext').mockResolvedValue({
      linked: [],
      existing: [],
      missing: [],
      skipped: [],
    });
    vi.spyOn(bridge, 'ensureClaudeProjectDir').mockResolvedValue('/tmp/claude-project');
    vi.spyOn(rpcRouter, 'getSharedDeps').mockReturnValue({
      rufloHttpDaemonSupervisor: {
        port: vi.fn(() => 4567),
        spawn: vi.fn(),
      },
    } as unknown as ReturnType<typeof rpcRouter.getSharedDeps>);
    vi.mocked(getRawDb).mockReturnValue(
      {
        prepare: vi.fn(() => ({
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
          run: vi.fn(() => undefined),
        })),
        transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
      } as unknown as ReturnType<typeof getRawDb>,
    );
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const args = makeArgs(deps);
    args.cwdOverride = cwd;
    args.providerId = 'claude';
    await spawnAgentSession(args);

    const spawnArgs = vi.mocked(resolveAndSpawn).mock.calls[0]![1] as {
      extraArgs?: string[];
    };
    expect(spawnArgs.extraArgs).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{"ruflo":{"type":"http","url":"http://127.0.0.1:4567/mcp"}}}',
    ]);
  });

  it('preserves inherited MCP for swarm-added Claude panes with explicit heavy profiles', async () => {
    const cwd = tmpCwd();
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);
    vi.spyOn(bridge, 'prepareClaudeWorkspaceContext').mockResolvedValue({
      linked: [],
      existing: [],
      missing: [],
      skipped: [],
    });
    vi.spyOn(bridge, 'ensureClaudeProjectDir').mockResolvedValue('/tmp/claude-project');
    vi.spyOn(rpcRouter, 'getSharedDeps').mockReturnValue({
      rufloHttpDaemonSupervisor: {
        port: vi.fn(() => 4567),
        spawn: vi.fn(),
      },
    } as unknown as ReturnType<typeof rpcRouter.getSharedDeps>);
    vi.mocked(getRawDb).mockReturnValue(
      {
        prepare: vi.fn(() => ({
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
          run: vi.fn(() => undefined),
        })),
        transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
      } as unknown as ReturnType<typeof getRawDb>,
    );
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const args = makeArgs(deps);
    args.cwdOverride = cwd;
    args.providerId = 'claude';
    args.runtimeProfileId = 'browser-tools';
    await spawnAgentSession(args);

    const spawnArgs = vi.mocked(resolveAndSpawn).mock.calls[0]![1] as {
      extraArgs?: string[];
    };
    expect(spawnArgs.extraArgs).toEqual([]);
  });
});

// ─── CRIT-1/CRIT-2: worktree must be cleaned up on a suppressed git-mode spawn ─
//
// When repoMode='git', factory-spawn creates a worktree BEFORE the INSERT.
// If the INSERT trips a UNIQUE violation the spawn is suppressed (PTY killed +
// forgotten, paneIndex:-1 returned). Previously the worktree was left on disk —
// the 49 GB disk-fill class (CRIT-1). The fix calls
// worktreePool.removeAndPrune(repoRoot, worktreePath) inside the suppress branch.

describe('spawnAgentSession — CRIT-1/CRIT-2 worktree cleanup on suppressed git spawn', () => {
  it('removeAndPrune is called when a git-repo spawn hits a UNIQUE violation', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Inject a worktreePool that returns a synthetic worktree path and also
    // exposes removeAndPrune so we can assert it is called.
    const removeAndPrune = vi.fn().mockResolvedValue(undefined);
    deps.worktreePool = {
      create: vi.fn().mockResolvedValue({
        worktreePath: '/tmp/wt/pane-0',
        branch: 'agent-builder-1',
        sessionId: SPAWNED_PTY_ID,
      }),
      removeAndPrune,
    } as unknown as SwarmFactoryDeps['worktreePool'];

    // Force the INSERT (inside the raw.transaction wrapper) to throw a UNIQUE
    // violation. The transaction wrapper in makeRawStub() returns fn unchanged
    // (i.e. `transaction(fn)` returns `fn`), so insertSession() calls fn() which
    // runs db.insert(...).values(...).run(). We make that .run() throw here.
    const insertRun = vi.fn(() => {
      throw new Error(
        'UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index',
      );
    });
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    // Build args in git mode with a repoRoot so worktreePath is populated before
    // the INSERT.
    const args = makeArgs(deps);
    (args.wsRow as { repoMode: string; repoRoot: string }).repoMode = 'git';
    (args.wsRow as { repoMode: string; repoRoot: string }).repoRoot = '/tmp/repo';

    const res = await spawnAgentSession(args);

    // Suppression contract: still returns paneIndex:-1 (not a throw).
    expect(res.paneIndex).toBe(-1);
    // PTY still torn down (H-10 contract preserved).
    expect(registry.kill).toHaveBeenCalledWith(SPAWNED_PTY_ID);
    expect(registry.forget).toHaveBeenCalledWith(SPAWNED_PTY_ID);
    // CRIT-1 fix: the leaked worktree is removed + pruned.
    expect(removeAndPrune).toHaveBeenCalledTimes(1);
    expect(removeAndPrune).toHaveBeenCalledWith('/tmp/repo', '/tmp/wt/pane-0');
  });

  it('does NOT call removeAndPrune when repoMode=plain (no worktree to clean)', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    const removeAndPrune = vi.fn().mockResolvedValue(undefined);
    deps.worktreePool = {
      create: vi.fn(),
      removeAndPrune,
    } as unknown as SwarmFactoryDeps['worktreePool'];

    const insertRun = vi.fn(() => {
      throw new Error(
        'UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index',
      );
    });
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    // repoMode='plain' — no worktree is ever created.
    const res = await spawnAgentSession(makeArgs(deps));
    expect(res.paneIndex).toBe(-1);
    // Plain mode: no worktreePath to clean up.
    expect(removeAndPrune).not.toHaveBeenCalled();
  });
});

// ─── BUG-1: swarm-agent PTY exit must be classified with isPtyCrash ───────────
//
// The swarm onExit handler used to destructure only `{ exitCode }`, drop the
// signal, and gate on `exitCode < 0 && earlyDeath`. A swarm CLI exiting code 1
// (or signal-killed) AFTER the 1.5s grace window was therefore recorded CLEAN
// ('exited'/'done') instead of as a crash. These tests pin the SWARM path to
// the same shared `isPtyCrash` classifier the launcher uses: time-only
// earlyDeath + non-zero exitCode/signal → 'error'/'error'; clean exit 0 after
// >1.5s → 'exited'/'done'. Mirrors the launcher.test.ts cases for this path.

describe('spawnAgentSession — BUG-1 PTY-exit crash classification (swarm path)', () => {
  interface CapturedUpdate {
    table: 'agentSessions' | 'swarmAgents' | 'other';
    set: Record<string, unknown>;
  }

  /**
   * Spawn one agent and return the registered `pty.onExit` callback plus a
   * sink that records every `db.update(...).set(...)` payload (keyed by table
   * identity). `startedAt` is forced 5s into the past so the exit lands OUTSIDE
   * the 1.5s grace window — the case the old `exitCode < 0` gate got wrong.
   */
  async function spawnAndCapture(): Promise<{
    fireExit: (info: { exitCode: number; signal?: number }) => void;
    updates: CapturedUpdate[];
  }> {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    let exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
    vi.mocked(resolveAndSpawn).mockImplementation(
      () =>
        ({
          ptySession: {
            id: SPAWNED_PTY_ID,
            providerId: 'shell',
            cwd: '/tmp/ws-1',
            pid: 4242,
            alive: true,
            // 5s ago → exit is NOT earlyDeath (grace window is 1.5s).
            startedAt: Date.now() - 5000,
            externalSessionId: null,
            pty: {
              pid: 4242,
              write: vi.fn(),
              resize: vi.fn(),
              kill: vi.fn(),
              onData: vi.fn(() => () => undefined),
              onExit: vi.fn((cb: (info: { exitCode: number; signal?: number }) => void) => {
                exitCb = cb;
                return () => undefined;
              }),
            },
          },
          providerRequested: 'shell',
          providerEffective: 'shell',
          commandUsed: '',
          argsUsed: [],
          fallbackOccurred: false,
        }) as unknown as ReturnType<typeof resolveAndSpawn>,
    );

    const updates: CapturedUpdate[] = [];
    const dbStub = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn(() => undefined) })) })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((vals: Record<string, unknown>) => {
          const which =
            table === agentSessions
              ? 'agentSessions'
              : table === swarmAgents
                ? 'swarmAgents'
                : 'other';
          updates.push({ table: which, set: vals });
          return { where: vi.fn(() => ({ run: vi.fn(() => undefined) })) };
        }),
      })),
    };
    vi.mocked(getDb).mockReturnValue(dbStub as unknown as ReturnType<typeof getDb>);

    await spawnAgentSession(makeArgs(deps));
    expect(exitCb).not.toBeNull();
    return {
      fireExit: (info) => (exitCb as NonNullable<typeof exitCb>)(info),
      updates,
    };
  }

  it('exit code 1 after the grace window → agentSessions error AND swarmAgents error', async () => {
    const { fireExit, updates } = await spawnAndCapture();
    updates.length = 0; // ignore inserts/best-effort updates during spawn

    fireExit({ exitCode: 1, signal: undefined });

    const sessionUpdate = updates.find((u) => u.table === 'agentSessions');
    const agentUpdate = updates.find((u) => u.table === 'swarmAgents');
    expect(sessionUpdate?.set.status).toBe('error');
    expect(sessionUpdate?.set.exitCode).toBe(1);
    expect(agentUpdate?.set.status).toBe('error');
  });

  it('signal-killed (code 0, signal 15) after the grace window → error / error', async () => {
    const { fireExit, updates } = await spawnAndCapture();
    updates.length = 0;

    fireExit({ exitCode: 0, signal: 15 });

    expect(updates.find((u) => u.table === 'agentSessions')?.set.status).toBe('error');
    expect(updates.find((u) => u.table === 'swarmAgents')?.set.status).toBe('error');
  });

  it('clean exit 0 after the grace window → agentSessions exited AND swarmAgents done', async () => {
    const { fireExit, updates } = await spawnAndCapture();
    updates.length = 0;

    fireExit({ exitCode: 0, signal: undefined });

    const sessionUpdate = updates.find((u) => u.table === 'agentSessions');
    const agentUpdate = updates.find((u) => u.table === 'swarmAgents');
    expect(sessionUpdate?.set.status).toBe('exited');
    expect(sessionUpdate?.set.exitCode).toBe(0);
    expect(agentUpdate?.set.status).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C6 obs — WorktreeDiskGuardError catch in materializeRosterAgent
// ─────────────────────────────────────────────────────────────────────────────

describe('materializeRosterAgent — C6: WorktreeDiskGuardError triggers console.warn + notification', () => {
  it('notifications.add called with severity:critical when disk-guard fires', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Make worktreePool.create throw a WorktreeDiskGuardError.
    vi.mocked(deps.worktreePool.create).mockRejectedValue(
      new WorktreeDiskGuardError('DISK_FLOOR', 'disk floor reached: 0.5 GB free < 2 GB'),
    );

    const notificationsAdd = vi.fn();
    const depsWithNotifications = {
      ...deps,
      notifications: { add: notificationsAdd },
    } as SwarmFactoryDeps;

    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Build a git-mode wsRow so the gate tries to create a worktree.
    const wsRow = {
      id: 'ws-c6',
      name: 'ws-c6',
      rootPath: '/tmp/ws-c6',
      repoRoot: '/tmp/repo-c6',
      repoMode: 'git',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    } as unknown as SpawnAgentSessionArgs['wsRow'];

    const { agent } = await materializeRosterAgent({
      swarmId: 'swarm-c6',
      wsRow,
      assignment: { role: 'builder', roleIndex: 1, providerId: 'shell' },
      coordinatorId: null,
      now: Date.now(),
      deps: depsWithNotifications,
    });

    // Agent should have error status.
    expect(agent.sessionId).toBeNull();

    // Should have logged a warning.
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    const diskGuardWarn = warnCalls.find((s) => s.includes('[factory-spawn]') && s.includes('disk-guard'));
    expect(diskGuardWarn).toBeDefined();

    // Should have called notifications.add with critical severity.
    expect(notificationsAdd).toHaveBeenCalledOnce();
    const addArg = notificationsAdd.mock.calls[0]![0] as { severity: string; dedupKey: string };
    expect(addArg.severity).toBe('critical');
    expect(addArg.dedupKey).toBe('disk-guard:DISK_FLOOR');

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEV-W3b — Gate B: in-place mode skips worktree creation (factory-spawn.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('spawnAgentSession — DEV-W3b: in-place mode skips worktree creation', () => {
  it('in-place mode: worktreePool.create is NOT called even for git+repoRoot workspaces', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Override the default 'plain' fixture to be a git workspace.
    const args = makeArgs(deps);
    args.wsRow = {
      ...args.wsRow,
      repoMode: 'git',
      repoRoot: '/tmp/repo',
    };

    // Stub rawDb so worktreeMode key returns 'in-place' for this workspace.
    vi.mocked(getRawDb).mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn((key?: string) => {
          if (typeof key === 'string' && key.startsWith('workspace.worktreeMode.')) {
            return { value: 'in-place' };
          }
          // Return '0' for ruflo autowrite so no .mcp.json is written.
          if (typeof key === 'string' && key === 'ruflo.autowriteMcp') return { value: '0' };
          return undefined;
        }),
        all: vi.fn(() => []),
        run: vi.fn(() => undefined),
      })),
      transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
    } as unknown as ReturnType<typeof getRawDb>);

    const insertRun = vi.fn(() => undefined);
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const result = await spawnAgentSession(args);

    // Gate B must NOT call worktreePool.create in in-place mode.
    expect(deps.worktreePool.create).not.toHaveBeenCalled();
    expect(result.sessionId).toBe(SPAWNED_PTY_ID);
  });

  it('worktree mode (default git): worktreePool.create IS called', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Stub the worktreePool.create to return a result.
    vi.mocked(deps.worktreePool.create).mockResolvedValue({
      worktreePath: '/tmp/repo/wt-1',
      branch: 'sigmalink/builder-1-aabbccdd',
      sessionId: SPAWNED_PTY_ID,
    });

    // Override the default 'plain' fixture to be a git workspace.
    const args = makeArgs(deps);
    args.wsRow = {
      ...args.wsRow,
      repoMode: 'git',
      repoRoot: '/tmp/repo',
    };

    const insertRun = vi.fn(() => undefined);
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    await spawnAgentSession(args);

    // Default mode (no worktreeMode KV): create IS called.
    expect(deps.worktreePool.create).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEV-W5 — per-spawn `skipWorktree` override
//
// TDD cases:
//   W5-1: skipWorktree=true skips worktree.create even when workspace mode is 'worktree'
//   W5-2: skipWorktree=false forces a worktree even when workspace mode is 'in-place'
//   W5-3: skipWorktree=undefined falls back to the workspace worktreeMode (legacy behavior)
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: stub rawDb to return a specific worktreeMode value (or none). */
function makeRawStubWithWorktreeMode(mode: 'in-place' | 'worktree' | null) {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((key?: string) => {
        if (typeof key === 'string' && key.startsWith('workspace.worktreeMode.')) {
          return mode !== null ? { value: mode } : undefined;
        }
        if (typeof key === 'string' && key === 'ruflo.autowriteMcp') return { value: '0' };
        if (/FROM kv/i.test(sql)) return undefined;
        return undefined;
      }),
      all: vi.fn(() => []),
      run: vi.fn(() => undefined),
    })),
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  };
}

describe('spawnAgentSession — DEV-W5: per-spawn skipWorktree override', () => {
  function makeGitArgs(deps: SwarmFactoryDeps): SpawnAgentSessionArgs {
    return {
      ...makeArgs(deps),
      wsRow: {
        id: 'ws-1',
        name: 'ws-1',
        rootPath: '/tmp/ws-1',
        repoRoot: '/tmp/repo',
        repoMode: 'git',
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      } as unknown as SpawnAgentSessionArgs['wsRow'],
    };
  }

  it('W5-1: skipWorktree=true skips worktree.create even when workspace mode is "worktree"', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Workspace is in 'worktree' mode → would normally create a worktree.
    vi.mocked(getRawDb).mockReturnValue(
      makeRawStubWithWorktreeMode('worktree') as unknown as ReturnType<typeof getRawDb>,
    );

    const insertRun = vi.fn(() => undefined);
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const args = makeGitArgs(deps);
    // Per-spawn override: skip the worktree regardless of workspace mode.
    args.skipWorktree = true;

    const result = await spawnAgentSession(args);

    // skipWorktree=true must suppress worktreePool.create even in 'worktree' mode.
    expect(deps.worktreePool.create).not.toHaveBeenCalled();
    expect(result.sessionId).toBe(SPAWNED_PTY_ID);
  });

  it('W5-2: skipWorktree=false forces a worktree even when workspace mode is "in-place"', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Workspace is 'in-place' → would normally skip worktree creation.
    vi.mocked(getRawDb).mockReturnValue(
      makeRawStubWithWorktreeMode('in-place') as unknown as ReturnType<typeof getRawDb>,
    );

    vi.mocked(deps.worktreePool.create).mockResolvedValue({
      worktreePath: '/tmp/repo/wt-w5',
      branch: 'sigmalink/builder-1-w5',
      sessionId: SPAWNED_PTY_ID,
    });

    const insertRun = vi.fn(() => undefined);
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const args = makeGitArgs(deps);
    // Per-spawn override: force a worktree regardless of in-place mode.
    args.skipWorktree = false;

    await spawnAgentSession(args);

    // skipWorktree=false must force worktreePool.create even in 'in-place' mode.
    expect(deps.worktreePool.create).toHaveBeenCalledOnce();
  });

  it('W5-3: skipWorktree=undefined falls back to workspace worktreeMode (legacy behavior)', async () => {
    const registry = makePtyRegistryStub();
    const deps = makeDeps(registry);

    // Workspace is in-place → legacy path skips worktree.
    vi.mocked(getRawDb).mockReturnValue(
      makeRawStubWithWorktreeMode('in-place') as unknown as ReturnType<typeof getRawDb>,
    );

    const insertRun = vi.fn(() => undefined);
    vi.mocked(getDb).mockReturnValue({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const args = makeGitArgs(deps);
    // No skipWorktree passed → should respect workspace mode.
    args.skipWorktree = undefined;

    const result = await spawnAgentSession(args);

    // Legacy fallback: in-place mode must NOT create a worktree.
    expect(deps.worktreePool.create).not.toHaveBeenCalled();
    expect(result.sessionId).toBe(SPAWNED_PTY_ID);
  });
});
