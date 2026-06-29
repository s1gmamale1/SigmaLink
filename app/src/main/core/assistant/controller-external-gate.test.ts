// Control MCP — supervised-autonomy gate tests for origin:'external'.
// Mirrors the authorization.test.ts harness exactly (same DB mock, same
// makeDeps / makeInvoke pattern) and adds cases for the external branch.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { buildAssistantController } from './controller';
import type { AssistantControllerDeps } from './controller';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';

// ── fixtures ──────────────────────────────────────────────────────────────

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
  origin?: 'local' | 'telegram' | 'external';
  confirmDangerous?: (toolName: string, summary: string) => Promise<boolean>;
}) => Promise<{ ok: boolean; result: unknown; error?: string }>;

function makeInvoke(overrides: Partial<AssistantControllerDeps> = {}): {
  invoke: InvokeTool;
  ptyWrite: ReturnType<typeof vi.fn>;
  ptyKill: ReturnType<typeof vi.fn>;
} {
  const ptyWrite = vi.fn();
  const ptyKill = vi.fn();
  // read_pane needs has/snapshot/isLive on pty; snapshot returns a raw string
  const ptyHas = vi.fn(() => true);
  const ptySnapshot = vi.fn(() => 'hello world output');
  const ptyIsLive = vi.fn(() => true);

  const deps: AssistantControllerDeps = {
    pty: {
      write: ptyWrite,
      kill: ptyKill,
      has: ptyHas,
      snapshot: ptySnapshot,
      isLive: ptyIsLive,
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

// ── external gate: read_pane (free tool) ───────────────────────────────────

describe('external gate — read_pane (free tool)', () => {
  it('read_pane runs without calling confirmDangerous', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invoke } = makeInvoke();
    const out = await invoke({
      name: 'read_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      confirmDangerous,
    });
    // Tool runs (ok:true) — free tools are not gated
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
  });
});

// ── external gate: close_pane (escalate — always destructive) ──────────────

describe('external gate — close_pane (always escalate)', () => {
  it('close_pane with no confirmDangerous → BLOCKED', async () => {
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('operator confirmation');
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('close_pane + confirmDangerous → false → BLOCKED', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invoke, ptyKill } = makeInvoke();
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('operator confirmation');
    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('close_pane + confirmDangerous → true → ALLOWED', async () => {
    const confirmDangerous = vi.fn(async () => true);
    const killFn = vi.fn();
    const { invoke } = makeInvoke({
      pty: {
        write: vi.fn(),
        kill: killFn,
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ''),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
    });
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(killFn).toHaveBeenCalledWith('sess-1');
  });
});

// ── external gate: prompt_agent targeting shell provider ───────────────────

describe('external gate — prompt_agent (provider-gated)', () => {
  it('prompt_agent → shell provider, no approval → BLOCKED', async () => {
    const { invoke, ptyWrite } = makeInvoke({
      resolveSessionProvider: (sid) => (sid === 'sess-shell' ? 'shell' : null),
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-shell', prompt: 'rm -rf /' },
      origin: 'external',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('operator confirmation');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('prompt_agent → shell provider + confirmDangerous false → BLOCKED', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const { invoke, ptyWrite } = makeInvoke({
      resolveSessionProvider: () => 'shell',
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-shell', prompt: 'evil' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('operator confirmation');
    expect(confirmDangerous).toHaveBeenCalledOnce();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('prompt_agent → claude provider → FREE (no confirmation needed)', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const writeFn = vi.fn();
    const { invoke } = makeInvoke({
      pty: {
        write: writeFn,
        kill: vi.fn(),
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ''),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
      resolveSessionProvider: (sid) => (sid === 'sess-claude' ? 'claude' : null),
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-claude', prompt: 'echo hi' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
    // settle-submit: body write then submit byte separately (two distinct PTY writes)
    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(writeFn).toHaveBeenNthCalledWith(1, 'sess-claude', 'echo hi');
    expect(writeFn).toHaveBeenNthCalledWith(2, 'sess-claude', '\r');
  });

  it('prompt_agent → codex provider → FREE', async () => {
    const confirmDangerous = vi.fn(async () => false);
    const ptyWrite = vi.fn();
    const { invoke } = makeInvoke({
      pty: {
        write: ptyWrite,
        kill: vi.fn(),
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ({ lines: [] })),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
      resolveSessionProvider: () => 'codex',
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-codex', prompt: 'hi' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(true);
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('prompt_agent → unknown provider (resolveSessionProvider returns null) → escalate → BLOCKED', async () => {
    const { invoke, ptyWrite } = makeInvoke({
      resolveSessionProvider: () => null,
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-unknown', prompt: 'hi' },
      origin: 'external',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('operator confirmation');
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

// ── external gate: kill-switch (controlFrozen) ─────────────────────────────

describe('external gate — controlFrozen kill-switch', () => {
  it('read_pane with controlFrozen:true → DENIED (even free tools blocked)', async () => {
    const { invoke } = makeInvoke({
      controlFrozen: () => true,
    });
    const out = await invoke({
      name: 'read_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('frozen');
  });

  it('prompt_agent (claude) with controlFrozen:true → DENIED', async () => {
    const { invoke, ptyWrite } = makeInvoke({
      controlFrozen: () => true,
      resolveSessionProvider: () => 'claude',
    });
    const out = await invoke({
      name: 'prompt_agent',
      args: { sessionId: 'sess-claude', prompt: 'hi' },
      origin: 'external',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('frozen');
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it('close_pane with controlFrozen:true → DENIED (kill-switch wins over escalate)', async () => {
    const confirmDangerous = vi.fn(async () => true);
    const { invoke, ptyKill } = makeInvoke({
      controlFrozen: () => true,
    });
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('frozen');
    expect(confirmDangerous).not.toHaveBeenCalled();
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('controlFrozen:false → normal behaviour (free tool passes through)', async () => {
    const { invoke } = makeInvoke({
      controlFrozen: () => false,
    });
    const out = await invoke({
      name: 'read_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
    });
    expect(out.ok).toBe(true);
  });
});

// ── Task 4: non-blocking escalation (external origin with pendingEscalations) ──

describe('external gate — non-blocking escalation (Task 4)', () => {
  it('external escalate-class tool returns needs_approval immediately (no 60s wait)', async () => {
    const { PendingEscalationStore } = await import('../control/pending-escalations');
    let t = 1000;
    const store = new PendingEscalationStore({ now: () => t });
    const confirmDangerous = vi.fn(async () => true); // should NOT be awaited
    const { invoke } = makeInvoke({ pendingEscalations: store });
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      confirmDangerous,
    });
    expect(out.ok).toBe(false);
    // Returns a status:'needs_approval' result immediately (no blocking).
    expect((out.result as { status: string })?.status).toBe('needs_approval');
    expect((out.result as { escalationId: string })?.escalationId).toBeDefined();
    // confirmDangerous is NOT called (non-blocking path).
    expect(confirmDangerous).not.toHaveBeenCalled();
  });

  it('check_escalation reflects pending status', async () => {
    const { PendingEscalationStore } = await import('../control/pending-escalations');
    const store = new PendingEscalationStore({ now: () => 1000 });
    const { invoke } = makeInvoke({ pendingEscalations: store });
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
    });
    const escalationId = (out.result as { escalationId: string }).escalationId;
    // Poll check_escalation — should be pending.
    const poll = await invoke({
      name: 'check_escalation',
      args: { escalationId },
      origin: 'external',
    });
    expect(poll.ok).toBe(true);
    expect((poll.result as { status: string }).status).toBe('pending');
  });

  it('approved escalation: re-issued call passes through (grant consumed)', async () => {
    const { PendingEscalationStore } = await import('../control/pending-escalations');
    const store = new PendingEscalationStore({ now: () => 1000 });
    const ptyKill = vi.fn();
    const { invoke } = makeInvoke({
      pendingEscalations: store,
      pty: {
        write: vi.fn(),
        kill: ptyKill,
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ''),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
    });
    // 1. First call → needs_approval
    const first = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      clientLabel: 'bot',
    });
    expect(first.ok).toBe(false);
    const escalationId = (first.result as { escalationId: string }).escalationId;
    // 2. Operator approves → records one-shot grant
    store.resolveEscalation(escalationId, true);
    expect(store.checkEscalation(escalationId)).toBe('approved');
    // 3. Re-issue the same call → grant consumed → FREE → executes
    const second = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      clientLabel: 'bot',
    });
    expect(second.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
    // 4. A third call (grant consumed) → escalate again
    const third = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'external',
      clientLabel: 'bot',
    });
    expect(third.ok).toBe(false);
    expect((third.result as { status: string })?.status).toBe('needs_approval');
  });

  it('local origin still blocks (unaffected by pendingEscalations store)', async () => {
    const { PendingEscalationStore } = await import('../control/pending-escalations');
    const store = new PendingEscalationStore({ now: () => 1000 });
    const ptyKill = vi.fn();
    const { invoke } = makeInvoke({
      pendingEscalations: store,
      pty: {
        write: vi.fn(),
        kill: ptyKill,
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ''),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
    });
    // local origin: close_pane runs without any gate
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'local',
    });
    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
    // pendingEscalations store is untouched
    expect(store.listPending()).toHaveLength(0);
  });
});

// ── external gate: local/telegram origins unaffected ──────────────────────

describe('external gate — other origins bypass the external branch', () => {
  it('local origin: close_pane is NOT gated (no gate at all)', async () => {
    const ptyKill = vi.fn();
    const { invoke } = makeInvoke({
      pty: {
        write: vi.fn(),
        kill: ptyKill,
        has: vi.fn(() => true),
        snapshot: vi.fn(() => ({ lines: [] })),
        isLive: vi.fn(() => true),
      } as unknown as AssistantControllerDeps['pty'],
      controlFrozen: () => true, // kill-switch ON but origin is local — must NOT deny
    });
    const out = await invoke({
      name: 'close_pane',
      args: { sessionId: 'sess-1' },
      origin: 'local',
    });
    // local origin bypasses all external logic, kill-switch is irrelevant
    expect(out.ok).toBe(true);
    expect(ptyKill).toHaveBeenCalledWith('sess-1');
  });
});
