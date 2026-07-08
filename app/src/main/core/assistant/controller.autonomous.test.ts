// P1b Task 4 — controller origin:'autonomous' tests. Mirrors
// authorization.test.ts's harness exactly (same DB mock, same
// makeDeps/makeInvoke pattern) and asserts the supervisor's model-in-the-loop
// wakes get the SAME DANGEROUS_REMOTE gating telegram-origin calls get —
// escalate-class tools need confirmDangerous approval, free tools run
// straight through, unapproved-by-default fails closed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { buildAssistantController } from './controller';
import type { AssistantControllerDeps, ToolOrigin } from './controller';
import { createDbFake, seedWorkspace, type DbFake } from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

type InvokeTool = (input: {
  conversationId?: string;
  name: string;
  args: Record<string, unknown>;
  origin?: ToolOrigin;
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
}) => Promise<{ ok: boolean; result: unknown; error?: string }>;

function makeInvoke(overrides: Partial<AssistantControllerDeps> = {}): {
  invoke: InvokeTool;
  ptyWrite: ReturnType<typeof vi.fn>;
  ptyKill: ReturnType<typeof vi.fn>;
} {
  const ptyWrite = vi.fn();
  const ptyKill = vi.fn();
  const deps: AssistantControllerDeps = {
    pty: {
      write: ptyWrite,
      kill: ptyKill,
      has: vi.fn(() => true),
      snapshot: vi.fn(() => ''),
      isLive: vi.fn(() => true),
    } as unknown as AssistantControllerDeps['pty'],
    worktreePool: {} as AssistantControllerDeps['worktreePool'],
    mailbox: {} as AssistantControllerDeps['mailbox'],
    memory: {} as AssistantControllerDeps['memory'],
    tasks: {} as AssistantControllerDeps['tasks'],
    browserRegistry: {} as AssistantControllerDeps['browserRegistry'],
    userDataDir: '/tmp/test-userData',
    emit: vi.fn(),
    ...overrides,
  };
  const { controller } = buildAssistantController(deps);
  const invoke = (controller as unknown as { invokeTool: InvokeTool }).invokeTool;
  return { invoke, ptyWrite, ptyKill };
}

describe('autonomous origin — DANGEROUS_REMOTE gate (mirrors telegram)', () => {
  it('autonomous + close_pane + no confirmDangerous → BLOCKED, handler not run', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'autonomous',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('autonomous + close_pane + confirmDangerous resolves false → BLOCKED', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'autonomous',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('autonomous + close_pane + confirmDangerous resolves true → ALLOWED, pane killed', async () => {
    const confirmDangerous = vi.fn(async () => true);
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'autonomous',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });

  it('autonomous + prompt_agent + no confirmDangerous → BLOCKED, no write', async () => {
    const { invoke, ptyWrite } = makeInvoke();
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-1', prompt: 'rm -rf /' },
      origin: 'autonomous',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('autonomous + a FREE mission tool (mission_board) runs without calling confirmDangerous', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invoke } = makeInvoke();
    const out = await invoke({
      name: 'mission_board',
      args: {},
      origin: 'autonomous',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('autonomous + list_workspaces (free tool) passes through ungated', async () => {
    const { invoke } = makeInvoke();
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
    const out = await invoke({ name: 'list_workspaces', args: {}, origin: 'autonomous' });
    expect(out.ok).toBe(true);
  });
});

type SendFn = (input: {
  workspaceId: string;
  conversationId?: string;
  prompt: string;
  origin?: ToolOrigin;
}) => Promise<{ conversationId: string; turnId: string; busy?: boolean }>;

describe('autonomous origin — send() accepts it and threads it through', () => {
  it('send({origin:"autonomous"}) does not throw and returns a turnId', async () => {
    const { controller } = buildAssistantController({
      pty: { write: vi.fn(), isLive: () => true } as unknown as AssistantControllerDeps['pty'],
      worktreePool: {} as AssistantControllerDeps['worktreePool'],
      mailbox: {} as AssistantControllerDeps['mailbox'],
      memory: {} as AssistantControllerDeps['memory'],
      tasks: {} as AssistantControllerDeps['tasks'],
      browserRegistry: {} as AssistantControllerDeps['browserRegistry'],
      userDataDir: '/tmp/test-userData',
      emit: vi.fn(),
    });
    seedWorkspace(fake, { id: 'ws-1', name: 'ws-1', rootPath: '/tmp/ws-1' });
    const send = (controller as unknown as { send: SendFn }).send;
    const out = await send({
      workspaceId: 'ws-1',
      prompt: 'decompose this mission',
      origin: 'autonomous',
    });
    expect(typeof out.conversationId).toBe('string');
    expect(typeof out.turnId).toBe('string');
  });
});
