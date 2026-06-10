// R-1 (Jorvis Telegram remote) — Lane H security tests.
// Covers (1) the origin-aware authorization gate in invokeAssistantTool and
// (2) the read_files / open_url hardening that applies to ALL origins.
//
// DB is mocked with the in-memory DbFake (better-sqlite3 cannot load under
// vitest — see reference_better_sqlite3_electron_abi). The tool handlers are
// driven directly via findTool(); the gate is driven via the public
// `invokeTool` RPC which forwards origin + confirmDangerous.

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

import { getDb, getRawDb } from '../db/client';
import { buildAssistantController } from './controller';
import { DANGEROUS_REMOTE, findTool, summarizeArgs } from './tools';
import type { AssistantControllerDeps } from './controller';
import type { ToolContext } from './tools';
import { createDbFake, seedWorkspace, type DbFake } from '@/test-utils/db-fake';

// ── fixtures ──────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-authz-test-')));
  tmpDirs.push(dir);
  return dir;
}

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<AssistantControllerDeps> = {}): AssistantControllerDeps {
  return {
    pty: { write: vi.fn() } as unknown as AssistantControllerDeps['pty'],
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

// A ToolContext whose worktreePool answers poolPathForRepo and whose pty
// records writes, for the read_files / open_url handler-level tests.
function makeToolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    pty: { write: vi.fn() },
    worktreePool: { poolPathForRepo: (repo: string) => path.join(repo, '.worktrees') },
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/test-userData',
    ...overrides,
  } as unknown as ToolContext;
}

// ── contract: DANGEROUS_REMOTE membership ───────────────────────────────────

describe('DANGEROUS_REMOTE contract', () => {
  it('contains exactly prompt_agent and close_pane', () => {
    expect([...DANGEROUS_REMOTE].sort()).toEqual(['close_pane', 'prompt_agent']);
  });

  it('close_pane is gated (kills a pane — strictly more destructive than prompt_agent)', () => {
    expect(DANGEROUS_REMOTE.has('close_pane')).toBe(true);
  });

  it('summarizeArgs renders a one-liner and truncates long values', () => {
    const s = summarizeArgs('prompt_agent', { sessionId: 'sess-1', prompt: 'x'.repeat(500) });
    expect(s).toContain('prompt_agent(');
    expect(s).toContain('sessionId=sess-1');
    expect(s).toContain('…');
    expect(s.length).toBeLessThan(300);
  });

  it('summarizeArgs renders close_pane { sessionId } via the generic path', () => {
    const s = summarizeArgs('close_pane', { sessionId: 'sess-1' });
    expect(s).toBe('close_pane(sessionId=sess-1)');
  });
});

// ── authorization gate (via public invokeTool RPC) ─────────────────────────

describe('R-1 authorization gate — prompt_agent', () => {
  type InvokeTool = (input: {
    conversationId?: string;
    name: string;
    args: Record<string, unknown>;
    origin?: 'local' | 'telegram';
    confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
  }) => Promise<{ ok: boolean; result: unknown; error?: string }>;

  function makeInvoke(): { invoke: InvokeTool; ptyWrite: ReturnType<typeof vi.fn> } {
    const ptyWrite = vi.fn();
    const deps = makeDeps({ pty: { write: ptyWrite } as unknown as AssistantControllerDeps['pty'] });
    const { controller } = buildAssistantController(deps);
    const invoke = (controller as unknown as { invokeTool: InvokeTool }).invokeTool;
    return { invoke, ptyWrite };
  }

  it('telegram + no confirmDangerous → BLOCKED, handler not run', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'rm -rf /' },
      origin: 'telegram',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('telegram + confirmDangerous resolves true → ALLOWED', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const confirmDangerous = vi.fn(async () => true);
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
      origin: 'telegram',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).toHaveBeenCalledWith('prompt_agent', expect.stringContaining('prompt_agent('));
    expect(ptyWrite).toHaveBeenCalledWith('sess-1', 'echo hi\n');
  });

  it('telegram + confirmDangerous resolves false → BLOCKED, handler not run', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const confirmDangerous = vi.fn(async () => false);
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
      origin: 'telegram',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('telegram + confirmDangerous throws → BLOCKED (fail-closed)', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const confirmDangerous = vi.fn(async () => {
      throw new Error('bridge offline');
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
      origin: 'telegram',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('local origin → NOT gated (confirmDangerous never consulted)', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const confirmDangerous = vi.fn(async () => false);
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
      origin: 'local',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(ptyWrite).toHaveBeenCalledWith('sess-1', 'echo hi\n');
  });

  it('omitted origin defaults to local → NOT gated', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
    });
    expect(out.ok).toBe(true);
    expect(ptyWrite).toHaveBeenCalledWith('sess-1', 'echo hi\n');
  });

  it('telegram + the dispatch_pane alias still resolves to gated prompt_agent', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const out = await invoke({
      name: 'dispatch_pane',
      args: { sessionId: 'sess-1', prompt: 'echo hi' },
      origin: 'telegram',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('telegram + a FREE tool (list_workspaces) passes through ungated', async () => {
    const { invoke } = makeInvoke();
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
    const out = await invoke({ name: 'list_workspaces', args: {}, origin: 'telegram' });
    expect(out.ok).toBe(true);
  });
});

// ── authorization gate — close_pane (kills a pane) ──────────────────────────

describe('R-1 authorization gate — close_pane', () => {
  type InvokeTool = (input: {
    conversationId?: string;
    name: string;
    args: Record<string, unknown>;
    origin?: 'local' | 'telegram';
    confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
  }) => Promise<{ ok: boolean; result: unknown; error?: string }>;

  function makeInvoke(): { invoke: InvokeTool; ptyKill: ReturnType<typeof vi.fn> } {
    const ptyKill = vi.fn();
    const deps = makeDeps({
      pty: { write: vi.fn(), kill: ptyKill } as unknown as AssistantControllerDeps['pty'],
    });
    const { controller } = buildAssistantController(deps);
    const invoke = (controller as unknown as { invokeTool: InvokeTool }).invokeTool;
    return { invoke, ptyKill };
  }

  it('telegram + no confirmDangerous → BLOCKED, pane not killed', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'telegram',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('telegram + confirmDangerous resolves false → BLOCKED, pane not killed', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const confirmDangerous = vi.fn(async () => false);
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'telegram',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(confirmDangerous).toHaveBeenCalledWith('close_pane', expect.stringContaining('close_pane('));
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('telegram + confirmDangerous resolves true → ALLOWED, pane killed', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const confirmDangerous = vi.fn(async () => true);
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'telegram',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });

  it('local origin → NOT gated (confirmDangerous never consulted)', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const confirmDangerous = vi.fn(async () => false);
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'local',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });
});

// ── read_files hardening (all origins) ──────────────────────────────────────

describe('R-1 read_files path containment', () => {
  const readFiles = findTool('read_files')!;

  it('rejects an out-of-tree absolute path (~/.ssh style)', async () => {
    const root = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    const ctx = makeToolCtx();

    const out = (await readFiles.handler(
      { paths: ['/etc/passwd'] },
      ctx,
    )) as { files: Array<{ path: string; ok: boolean; error?: string }> };

    expect(out.files[0].ok).toBe(false);
    expect(out.files[0].error).toBe('path outside workspace');
  });

  it('rejects a traversal escape from inside the workspace root', async () => {
    const root = makeTmp();
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    const ctx = makeToolCtx();

    const escape = path.join(root, '..', '..', '..', 'etc', 'passwd');
    const out = (await readFiles.handler(
      { paths: [escape] },
      ctx,
    )) as { files: Array<{ ok: boolean; error?: string }> };

    expect(out.files[0].ok).toBe(false);
    expect(out.files[0].error).toBe('path outside workspace');
  });

  it('allows an in-tree path and returns its content', async () => {
    const root = makeTmp();
    const filePath = path.join(root, 'note.txt');
    fs.writeFileSync(filePath, 'hello world');
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    const ctx = makeToolCtx();

    const out = (await readFiles.handler(
      { paths: [filePath] },
      ctx,
    )) as { files: Array<{ ok: boolean; content?: string }> };

    expect(out.files[0].ok).toBe(true);
    expect(out.files[0].content).toBe('hello world');
  });

  it('allows a path inside repoRoot too', async () => {
    const repo = makeTmp();
    const filePath = path.join(repo, 'src.ts');
    fs.writeFileSync(filePath, 'export const x = 1;');
    seedWorkspace(fake, { id: 'ws-1', rootPath: path.join(repo, 'sub'), repoRoot: repo });
    const ctx = makeToolCtx();

    const out = (await readFiles.handler(
      { paths: [filePath] },
      ctx,
    )) as { files: Array<{ ok: boolean; content?: string }> };

    expect(out.files[0].ok).toBe(true);
    expect(out.files[0].content).toBe('export const x = 1;');
  });

  it('rejects a symlink inside the workspace that points out of tree', async () => {
    const root = makeTmp();
    const secret = path.join(makeTmp(), 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE KEY');
    const link = path.join(root, 'innocent.txt');
    try {
      fs.symlinkSync(secret, link);
    } catch {
      // Symlink creation may fail on restricted CI — skip gracefully.
      return;
    }
    seedWorkspace(fake, { id: 'ws-1', rootPath: root });
    const ctx = makeToolCtx();

    const out = (await readFiles.handler(
      { paths: [link] },
      ctx,
    )) as { files: Array<{ ok: boolean; error?: string }> };

    expect(out.files[0].ok).toBe(false);
    expect(out.files[0].error).toBe('path outside workspace');
  });

  it('deny-all when no workspaces exist', async () => {
    const ctx = makeToolCtx();
    const out = (await readFiles.handler(
      { paths: ['/tmp/anything.txt'] },
      ctx,
    )) as { files: Array<{ ok: boolean; error?: string }> };

    expect(out.files[0].ok).toBe(false);
    expect(out.files[0].error).toBe('path outside workspace');
  });
});

// ── open_url hardening (all origins) ────────────────────────────────────────

describe('R-1 open_url scheme check', () => {
  const openUrl = findTool('open_url')!;

  function browserCtx() {
    const navigate = vi.fn(async () => undefined);
    const openTab = vi.fn(async () => ({ id: 'tab-1' }));
    const ctx = makeToolCtx({
      browserRegistry: {
        get: () => ({
          listTabs: () => [{ id: 'tab-1', active: true }],
          navigate,
          openTab,
        }),
      } as unknown as ToolContext['browserRegistry'],
    });
    return { ctx, navigate };
  }

  it('allows an https URL', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'https://example.com' },
      ctx,
    )) as { tabId?: string; ok?: boolean };
    expect(out.tabId).toBe('tab-1');
    expect(navigate).toHaveBeenCalledWith('tab-1', 'https://example.com');
  });

  it('rejects http (downgrade)', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'http://example.com' },
      ctx,
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('https only');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects file://', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'file:///etc/passwd' },
      ctx,
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('file:');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects javascript:', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'javascript:alert(1)' },
      ctx,
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects data:', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'data:text/html,<script>1</script>' },
      ctx,
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects a malformed url', async () => {
    const { ctx, navigate } = browserCtx();
    const out = (await openUrl.handler(
      { url: 'not a url' },
      ctx,
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBe('invalid url');
    expect(navigate).not.toHaveBeenCalled();
  });
});
