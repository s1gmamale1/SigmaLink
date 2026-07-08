// P1b Task 4b (security fix, surfaced by the Task 4 review) — the claude CLI
// executes its registered MCP tools over the McpHostSigma unix socket, whose
// wire payload is `{conversationId?, name, args}` ONLY (see mcp-host-sigma.ts's
// `ToolInvoker` type) — no origin, because the child process has no way to
// know it. Wiring the plain `invokeTool` to that socket let `origin` silently
// default to 'local' (controller.ts's `invokeAssistantTool`), so the
// DANGEROUS_REMOTE confirmation gate NEVER fired for a telegram- or
// autonomous-origin turn's MCP-executed tool calls — an unattended turn could
// run close_pane/kill_swarm/prompt_agent/close_workspace with zero
// confirmation. `invokeToolForConversation` closes this by resolving origin +
// confirmDangerous off the live turn for `conversationId` (the P0.1
// concurrent-turn guard guarantees at most one live turn per conversation).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

// Hang the CLI turn driver so the turn `send()` starts stays "live" in
// activeTurns/liveTurnByConversation while the test invokes
// invokeToolForConversation against it — mirrors controller.busy-guard.test.ts.
vi.mock('./runClaudeCliTurn', () => ({
  runClaudeCliTurn: vi.fn(() => new Promise(() => {})),
  cancelClaudeCliTurn: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { buildAssistantController } from './controller';
import type { AssistantControllerDeps, ToolOrigin } from './controller';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

type SendFn = (input: {
  workspaceId: string;
  conversationId?: string;
  prompt: string;
  origin?: ToolOrigin;
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
}) => Promise<{ conversationId: string; turnId: string; busy?: boolean }>;

type InvokeForConvFn = (input: {
  conversationId?: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<{ ok: boolean; result: unknown; error?: string }>;

function makeController(overrides: Partial<AssistantControllerDeps> = {}) {
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
  const bundle = buildAssistantController(deps);
  const send = (bundle.controller as unknown as { send: SendFn }).send;
  const invokeToolForConversation = (
    bundle as unknown as { invokeToolForConversation: InvokeForConvFn }
  ).invokeToolForConversation;
  return { send, invokeToolForConversation, ptyWrite, ptyKill };
}

describe('invokeToolForConversation — origin resolved from the live turn (MCP-host socket path)', () => {
  it('a live autonomous turn gates a DANGEROUS_REMOTE call — confirmDangerous consulted, blocked on false', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { send, invokeToolForConversation, ptyKill } = makeController();

    const started = await send({
      workspaceId: 'ws-1',
      prompt: 'do the mission',
      origin: 'autonomous',
      confirmDangerous,
    });
    expect(started.busy).toBeFalsy();

    // Simulates the claude CLI dialing tools.invoke over the McpHostSigma
    // socket for this SAME conversation — the wire payload carries no origin.
    const out = await invokeToolForConversation({
      conversationId: started.conversationId,
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
    });

    expect(confirmDangerous).toHaveBeenCalledWith('close_pane', expect.any(String));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('This action needs confirmation and was not approved.');
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('a live autonomous turn ALLOWS the DANGEROUS_REMOTE call when confirmDangerous resolves true', async () => {
    const confirmDangerous = vi.fn(async () => true);
    const { send, invokeToolForConversation, ptyKill } = makeController();

    const started = await send({
      workspaceId: 'ws-1',
      prompt: 'do the mission',
      origin: 'autonomous',
      confirmDangerous,
    });

    const out = await invokeToolForConversation({
      conversationId: started.conversationId,
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
    });

    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });

  it('a live telegram turn gates the SAME way — MCP-path parity with the stdout dispatchTool path', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { send, invokeToolForConversation, ptyKill } = makeController();

    const started = await send({
      workspaceId: 'ws-1',
      prompt: 'remote op',
      origin: 'telegram',
      confirmDangerous,
    });

    const out = await invokeToolForConversation({
      conversationId: started.conversationId,
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
    });

    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(out.ok).toBe(false);
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('no live turn for the conversationId → a free tool runs fine (origin local fallback)', async () => {
    const { invokeToolForConversation } = makeController();

    const out = await invokeToolForConversation({
      conversationId: 'convo-with-no-live-turn',
      name: 'list_workspaces',
      args: {},
    });

    expect(out.ok).toBe(true);
  });

  // Documents the intended behaviour: with no live turn to inherit provenance
  // from, invokeToolForConversation falls back to origin:'local' — the same
  // full-trust default the existing direct `invokeTool` RPC has always used
  // for a local operator's explicit call. 'local' is never DANGEROUS_REMOTE-
  // gated (see invokeAssistantTool's gate — only 'telegram'/'autonomous'
  // trigger it), so this path stays ungated by design, not by omission.
  it('no live turn for the conversationId → DANGEROUS_REMOTE runs UNGATED (local direct-RPC fallback, by design)', async () => {
    const { invokeToolForConversation, ptyKill } = makeController();

    const out = await invokeToolForConversation({
      conversationId: 'convo-with-no-live-turn',
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
    });

    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });

  it('no conversationId at all → also falls back to local (ungated)', async () => {
    const { invokeToolForConversation, ptyKill } = makeController();

    const out = await invokeToolForConversation({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
    });

    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });
});
