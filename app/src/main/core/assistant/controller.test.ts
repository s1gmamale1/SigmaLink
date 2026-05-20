// Tests for dispatchBulk and refResolve — V3-W13-013 (SHIPPED-PARTIAL)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { executeLaunchPlan } from '../workspaces/launcher';
import { buildAssistantController } from './controller';
import {
  createDbFake,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';
import type { AssistantControllerDeps } from './controller';
import type { AgentSession, Workspace } from '../../../shared/types';

// The controller object is typed as `Record<string, (...args: never[]) => unknown>`
// at the AssistantController interface level. Cast to a concrete slice here so
// tests can call the new methods without fighting the generic record type.
interface DispatchBulkResult {
  paneId: string | null;
  providerId: string;
  workspaceId: string;
  success: boolean;
  error?: string;
}

interface RefResolveResult {
  absPath: string;
  snippet: string;
}

interface TypedAssistantController {
  dispatchBulk: (items: Array<{
    workspaceId: string;
    provider: string;
    count: number;
    initialPrompt?: string;
    conversationId?: string;
  }>) => Promise<DispatchBulkResult[]>;
  refResolve: (input: { workspaceId: string; atRef: string }) => Promise<RefResolveResult[]>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-ctrl-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeDeps(overrides: Partial<AssistantControllerDeps> = {}): AssistantControllerDeps {
  return {
    pty: {} as AssistantControllerDeps['pty'],
    worktreePool: {} as AssistantControllerDeps['worktreePool'],
    mailbox: {} as AssistantControllerDeps['mailbox'],
    memory: {} as AssistantControllerDeps['memory'],
    tasks: {} as AssistantControllerDeps['tasks'],
    browserRegistry: {} as AssistantControllerDeps['browserRegistry'],
    userDataDir: '/tmp/test-userData',
    emit: vi.fn(),
    ...overrides,
  };
}

const FAKE_WORKSPACE: Workspace = {
  id: 'ws-1',
  name: 'ws-1',
  rootPath: '/tmp/ws-1',
  repoRoot: null,
  repoMode: 'plain',
  createdAt: 0,
  lastOpenedAt: 0,
};

function makeSession(id: string, providerId = 'claude', status: AgentSession['status'] = 'running'): AgentSession {
  return {
    id,
    workspaceId: 'ws-1',
    providerId,
    cwd: '/tmp',
    branch: null,
    status,
    startedAt: Date.now(),
    worktreePath: null,
    error: status === 'error' ? 'launch failed' : undefined,
  };
}

function makeLaunchResult(sessions: AgentSession[]): { workspace: Workspace; sessions: AgentSession[] } {
  return { workspace: FAKE_WORKSPACE, sessions };
}

// ── DB fixture ───────────────────────────────────────────────────────────────

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function getTypedController(deps?: Partial<AssistantControllerDeps>): TypedAssistantController {
  const { controller } = buildAssistantController(makeDeps(deps));
  return controller as unknown as TypedAssistantController;
}

// ── dispatchBulk ─────────────────────────────────────────────────────────────

describe('assistant.dispatchBulk', () => {
  it('single item single count succeeds', async () => {
    const root = makeTmp();
    FAKE_WORKSPACE.rootPath = root;
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    vi.mocked(executeLaunchPlan).mockResolvedValue(makeLaunchResult([makeSession('pane-1', 'claude')]));

    const ctl = getTypedController();
    const results = await ctl.dispatchBulk([
      { workspaceId: 'ws-1', provider: 'claude', count: 1 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].paneId).toBe('pane-1');
    expect(results[0].providerId).toBe('claude');
  });

  it('multi-item spawns across two workspace+provider combos', async () => {
    const root1 = makeTmp();
    const root2 = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root1 });
    seedWorkspace(fake, { id: 'ws-2', rootPath: root2 });

    vi.mocked(executeLaunchPlan)
      .mockResolvedValueOnce(makeLaunchResult([makeSession('pane-a', 'claude'), makeSession('pane-b', 'claude')]))
      .mockResolvedValueOnce(makeLaunchResult([makeSession('pane-c', 'codex')]));

    const ctl = getTypedController();
    const results = await ctl.dispatchBulk([
      { workspaceId: 'ws-1', provider: 'claude', count: 2 },
      { workspaceId: 'ws-2', provider: 'codex', count: 1 },
    ]);

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.success)).toHaveLength(3);
    expect(results.map((r) => r.paneId)).toEqual(['pane-a', 'pane-b', 'pane-c']);
  });

  it('one item fails (unknown provider) but others still spawn', async () => {
    const root = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    vi.mocked(executeLaunchPlan).mockResolvedValue(makeLaunchResult([makeSession('pane-ok', 'claude')]));

    const ctl = getTypedController();
    const results = await ctl.dispatchBulk([
      { workspaceId: 'ws-1', provider: 'unknown-provider-xyz', count: 1 },
      { workspaceId: 'ws-1', provider: 'claude', count: 1 },
    ]);

    // unknown-provider-xyz produces 1 error entry; claude produces 1 success
    expect(results).toHaveLength(2);
    const failed = results.find((r) => !r.success);
    const success = results.find((r) => r.success);
    expect(failed).toBeDefined();
    expect(failed!.error).toMatch(/unknown provider/i);
    expect(success).toBeDefined();
    expect(success!.paneId).toBe('pane-ok');
  });

  it('throws when items array is empty', async () => {
    const ctl = getTypedController();
    await expect(ctl.dispatchBulk([])).rejects.toThrow('non-empty array');
  });
});

// ── refResolve ────────────────────────────────────────────────────────────────

describe('assistant.refResolve', () => {
  it('returns empty array when no files match', async () => {
    const root = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });

    const ctl = getTypedController();
    const results = await ctl.refResolve({ workspaceId: 'ws-1', atRef: 'neverexists.ts' });

    expect(results).toEqual([]);
  });

  it('returns matches with absPath and snippet', async () => {
    const root = makeTmp();
    const filePath = path.join(root, 'myController.ts');
    fs.writeFileSync(filePath, 'export function foo() {}\n// line 2\n// line 3');
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });

    const ctl = getTypedController();
    const results = await ctl.refResolve({ workspaceId: 'ws-1', atRef: '@myController' });

    expect(results).toHaveLength(1);
    expect(results[0].absPath).toBe(filePath);
    expect(results[0].snippet).toContain('export function foo');
  });

  it('does not walk into node_modules or .git', async () => {
    const root = makeTmp();
    // Put a matching file inside node_modules — should be ignored
    const nmDir = path.join(root, 'node_modules', 'pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'target.ts'), 'ignored content');
    // Also a matching file in the repo root — should be found
    fs.writeFileSync(path.join(root, 'target.ts'), 'real content');
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });

    const ctl = getTypedController();
    const results = await ctl.refResolve({ workspaceId: 'ws-1', atRef: 'target' });

    expect(results).toHaveLength(1);
    expect(results[0].absPath).toBe(path.join(root, 'target.ts'));
  });

  it('returns empty array for unknown workspace', async () => {
    const ctl = getTypedController();
    const results = await ctl.refResolve({ workspaceId: 'no-such-ws', atRef: 'foo.ts' });
    expect(results).toEqual([]);
  });
});
