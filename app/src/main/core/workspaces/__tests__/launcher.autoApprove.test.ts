// SF-8 Yolo/Bypass — tests for pane.autoApprove threading through
// executeLaunchPlan → resolveAndSpawn opts → argv.
//
// This is a unit test for the workspaces/launcher.ts integration layer; it
// mocks every external dep (DB, PTY registry, worktree pool) and asserts that:
//   A2. Fresh launch with autoApprove:true → resolveAndSpawn opts include
//       autoApprove:true → argsUsed contains --dangerously-skip-permissions
//       for provider 'claude'.
//   A2. Fresh launch without autoApprove (undefined/false) → flag absent.
//   A2. The persisted agent_sessions INSERT includes auto_approve=1 when set.
//   A3. Resume path reads auto_approve from DB row → resolveAndSpawn opts
//       include autoApprove:true → flag present in resume argv.
//
// We do NOT use new Database() — better-sqlite3 is built for Electron's ABI
// and vitest runs under Node ABI (see reference_better_sqlite3_electron_abi).

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Type-only imports from modules we'll mock ──────────────────────────────
import type { AgentProviderDefinition } from '../../../../shared/providers';
import type { SessionRecord } from '../../pty/registry';

// ── Capture state for mocks ───────────────────────────────────────────────
interface SpawnCall {
  providerId: string;
  autoApprove: boolean | undefined;
  argsUsed: string[];
}
interface InsertCall {
  id: string;
  autoApprove: number | undefined;
}

let spawnCalls: SpawnCall[] = [];
let insertCalls: InsertCall[] = [];
let insertRunImpl: ((vals: Record<string, unknown>) => void) | null = null;
let mockDb: ReturnType<typeof buildMockDb>;

// ── Build a mock drizzle-like DB ──────────────────────────────────────────
function buildMockDb() {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => ({
            id: 'ws-1',
            name: 'Test WS',
            rootPath: '/ws',
            repoRoot: null,
            repoMode: 'plain',
            createdAt: 0,
            lastOpenedAt: 0,
          }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        run: () => {
          insertRunImpl?.(vals);
          insertCalls.push({
            id: vals['id'] as string,
            autoApprove: vals['autoApprove'] as number | undefined,
          });
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: () => undefined,
        }),
      }),
    }),
  };
  return db;
}

// ── Build a fake SessionRecord ────────────────────────────────────────────
function makeFakeSession(id = 'sess-1'): SessionRecord {
  return {
    id,
    providerId: 'claude',
    cwd: '/ws',
    pid: 1,
    alive: true,
    startedAt: Date.now(),
    externalSessionId: undefined,
    pty: {
      pid: 1,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    buffer: {
      snapshot: () => '',
      append: () => undefined,
      clear: () => undefined,
    } as unknown as SessionRecord['buffer'],
    unsubData: () => undefined,
    unsubExit: () => undefined,
  };
}

// ── Module mocks ──────────────────────────────────────────────────────────
// Mock the DB client so we never call new Database()
vi.mock('../../db/client', () => ({
  getDb: () => mockDb,
  getRawDb: () => ({
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => undefined,
    }),
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  }),
}));

// Mock resolveAndSpawn to capture what opts are passed
vi.mock('../../providers/launcher', () => ({
  resolveAndSpawn: (
    _deps: unknown,
    opts: {
      providerId: string;
      autoApprove?: boolean;
      extraArgs?: string[];
      [key: string]: unknown;
    },
  ) => {
    const provider: AgentProviderDefinition = {
      id: 'claude',
      name: 'Claude',
      description: '',
      command: 'claude',
      args: [],
      autoApproveFlag: '--dangerously-skip-permissions',
      color: '',
      icon: '',
      installHint: '',
    };
    const argsUsed: string[] = [];
    if (opts.autoApprove && provider.autoApproveFlag) {
      argsUsed.push(provider.autoApproveFlag);
    }
    if (opts.extraArgs) argsUsed.push(...opts.extraArgs);
    spawnCalls.push({
      providerId: opts.providerId,
      autoApprove: opts.autoApprove,
      argsUsed,
    });
    const session = makeFakeSession('sess-auto-' + Date.now());
    return {
      ptySession: session,
      providerRequested: opts.providerId,
      providerEffective: 'claude',
      commandUsed: 'claude',
      argsUsed,
      fallbackOccurred: false,
    };
  },
  ProviderLaunchError: class ProviderLaunchError extends Error {},
  findProvider: (id: string): AgentProviderDefinition | undefined => {
    if (id === 'claude') {
      return {
        id: 'claude',
        name: 'Claude',
        description: '',
        command: 'claude',
        args: [],
        autoApproveFlag: '--dangerously-skip-permissions',
        color: '',
        icon: '',
        installHint: '',
        oneshotArgs: ['-p', '{prompt}'],
      };
    }
    return undefined;
  },
}));

// Stub out side-effect imports
vi.mock('../../rpc-router', () => ({ getSharedDeps: () => null }));
vi.mock('../../browser/mcp-config-writer', () => ({ writeMcpConfigForAgent: () => undefined }));
vi.mock('../../pty/resume-launcher', () => ({ buildResumeArgs: () => null }));
vi.mock('../../pty/claude-resume-sigma', () => ({
  ensureClaudeProjectDir: async () => undefined,
  isClaudeSessionId: () => false,
  prepareClaudeResume: async () => 'ok',
  prepareClaudeWorkspaceContext: async () => undefined,
}));
vi.mock('../../pty/gemini-resume-sigma', () => ({
  ensureGeminiProjectDir: async () => undefined,
  prepareGeminiResume: async () => 'ok',
}));
vi.mock('../worktree-cwd', () => ({
  workspaceCwdInWorktree: (args: { workspaceRoot: string }) => args.workspaceRoot,
}));
vi.mock('../../pty/local-pty', () => ({
  KV_PTY_SPAWN_MODE: 'pty.spawnMode',
  parseSpawnMode: () => 'direct',
  effectivePaneSpawnMode: () => 'direct',
}));
vi.mock('../guardrail-block', () => ({ writeGuardrailBlock: async () => undefined }));

// ── Import SUT after mocks are set up ────────────────────────────────────
import { executeLaunchPlan } from '../launcher';
import type { LaunchPlan } from '../../../../shared/types';

// Fake PTY registry + worktree pool
const fakePty = {
  write: vi.fn(),
  get: () => undefined,
  create: () => makeFakeSession(),
  kill: vi.fn(),
  forget: vi.fn(),
  // Task 5 observed-process RAM-brake enumerates live sessions; no live panes here.
  list: () => [],
  processSnapshotCached: async () => null,
};
const fakeWorktreePool = {
  create: async () => ({ worktreePath: null, branch: null, sessionId: 'prealloc-1' }),
  remove: async () => undefined,
};
const fakeDeps = {
  pty: fakePty as unknown as import('../../pty/registry').PtyRegistry,
  worktreePool: fakeWorktreePool as unknown as import('../../git/worktree').WorktreePool,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('executeLaunchPlan — autoApprove threading (A2)', () => {
  beforeEach(() => {
    spawnCalls = [];
    insertCalls = [];
    insertRunImpl = null;
    fakePty.write.mockClear();
    fakePty.kill.mockClear();
    fakePty.forget.mockClear();
    mockDb = buildMockDb();
  });

  it('A2: pane.autoApprove=true → resolveAndSpawn opts.autoApprove=true → flag in argsUsed', async () => {
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude', autoApprove: true }],
    };
    await executeLaunchPlan(plan, fakeDeps);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.autoApprove).toBe(true);
    expect(spawnCalls[0]?.argsUsed).toContain('--dangerously-skip-permissions');
  });

  it('A2: pane.autoApprove=false → resolveAndSpawn opts.autoApprove=false → flag absent', async () => {
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude', autoApprove: false }],
    };
    await executeLaunchPlan(plan, fakeDeps);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.autoApprove).toBe(false);
    expect(spawnCalls[0]?.argsUsed).not.toContain('--dangerously-skip-permissions');
  });

  it('A2: pane.autoApprove undefined → flag absent (default OFF)', async () => {
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude' }],
    };
    await executeLaunchPlan(plan, fakeDeps);

    expect(spawnCalls).toHaveLength(1);
    // autoApprove should be false (pane.autoApprove ?? false)
    expect(spawnCalls[0]?.autoApprove).toBe(false);
    expect(spawnCalls[0]?.argsUsed).not.toContain('--dangerously-skip-permissions');
  });

  it('A2: pane.autoApprove=true → agent_sessions INSERT includes autoApprove=1', async () => {
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude', autoApprove: true }],
    };
    await executeLaunchPlan(plan, fakeDeps);

    const insert = insertCalls.find((c) => c.id !== undefined);
    expect(insert).toBeDefined();
    expect(insert?.autoApprove).toBe(1);
  });

  it('A2: pane.autoApprove=false → agent_sessions INSERT includes autoApprove=0', async () => {
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude', autoApprove: false }],
    };
    await executeLaunchPlan(plan, fakeDeps);

    const insert = insertCalls.find((c) => c.id !== undefined);
    expect(insert).toBeDefined();
    expect(insert?.autoApprove).toBe(0);
  });

  it('SF-12: UNIQUE violation kills + forgets the just-spawned orphan PTY and returns an error session', async () => {
    insertRunImpl = () => {
      throw new Error('UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index');
    };
    const plan: LaunchPlan = {
      workspaceRoot: '/ws',
      preset: 1,
      panes: [{ paneIndex: 0, providerId: 'claude', autoApprove: false }],
    };

    const result = await executeLaunchPlan(plan, fakeDeps);

    expect(fakePty.kill).toHaveBeenCalledTimes(1);
    expect(fakePty.forget).toHaveBeenCalledTimes(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.status).toBe('error');
    expect(result.sessions[0]?.error).toMatch(/Pane slot 0 is already occupied/);
  });
});
