// P0.1 — per-conversation concurrent-turn guard. A double-send (multi-window,
// telegram, external, or a fast double-tap) against the same conversation
// must NOT spawn a second `claude` CLI child; it should return the existing
// live turn instead. Follows the DB-mock + fake-deps pattern shared by
// controller.test.ts / controller-external-gate.test.ts / authorization.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

// Make the CLI turn "hang" (never resolve) so the first turn stays live —
// activeTurns still holds it when the second `send` runs. Mirrors how the
// sibling assistant tests stub the turn driver instead of hitting a real
// `claude` binary.
vi.mock('./runClaudeCliTurn', () => ({
  runClaudeCliTurn: vi.fn(() => new Promise(() => {})),
  cancelClaudeCliTurn: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import { cancelClaudeCliTurn } from './runClaudeCliTurn';
import { buildAssistantController } from './controller';
import type { AssistantControllerDeps } from './controller';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

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

type SendFn = (input: {
  workspaceId: string;
  conversationId?: string;
  prompt: string;
}) => Promise<{ conversationId: string; turnId: string; busy?: boolean }>;

function getSend(): SendFn {
  const { controller } = buildAssistantController(makeDeps());
  return (controller as unknown as { send: SendFn }).send;
}

type NewSessionFn = (input: { conversationId: string }) => Promise<{ ok: true }>;

// Returns `send` + `newSession` off the SAME controller instance — the
// concurrent-turn guard state (`activeTurns` / `liveTurnByConversation`)
// lives in the controller's closure, so a fresh `buildAssistantController()`
// per helper call would silently decouple the two and the cancel-in-flight
// assertion would test nothing.
function getController(): { send: SendFn; newSession: NewSessionFn } {
  const { controller } = buildAssistantController(makeDeps());
  const typed = controller as unknown as { send: SendFn; newSession: NewSessionFn };
  return { send: typed.send, newSession: typed.newSession };
}

describe('assistant.send concurrent-turn guard', () => {
  it('a second send for a conversation with a live turn returns busy without a new turn', async () => {
    const send = getSend();

    const first = await send({ workspaceId: 'ws1', prompt: 'a' });
    expect(first.busy).toBeFalsy();
    expect(first.turnId).toBeTruthy();

    // Re-issue against the SAME (now-persisted) conversation while the first
    // turn is still live — runClaudeCliTurn never resolves, so activeTurns
    // still holds turnId #1.
    const second = await send({ workspaceId: 'ws1', conversationId: first.conversationId, prompt: 'b' });
    expect(second.busy).toBe(true);
    expect(second.turnId).toBe(first.turnId); // points at the live turn, not a new one
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('a send for a DIFFERENT conversation is not blocked', async () => {
    const send = getSend();

    const a = await send({ workspaceId: 'ws1', prompt: 'a' });
    const b = await send({ workspaceId: 'ws1', prompt: 'b' }); // no conversationId → fresh conversation
    expect(a.busy).toBeFalsy();
    expect(b.busy).toBeFalsy();
    expect(b.turnId).not.toBe(a.turnId);
    expect(b.conversationId).not.toBe(a.conversationId);
  });
});

// P0.4 review fold-in — newSession must actually cancel the in-flight turn it
// walks away from; otherwise the guard above only proves a live turn BLOCKS a
// second send, not that newSession clears the block.
describe('assistant.newSession cancel-in-flight', () => {
  it('cancels a live turn and clears both maps', async () => {
    const { send, newSession } = getController();

    const first = await send({ workspaceId: 'ws1', prompt: 'a' });
    expect(first.busy).toBeFalsy();

    // Sanity: the guard from the describe block above — a second send while
    // the first is still live is rejected as busy, pointing at turn #1.
    const stillBusy = await send({ workspaceId: 'ws1', conversationId: first.conversationId, prompt: 'b' });
    expect(stillBusy.busy).toBe(true);
    expect(stillBusy.turnId).toBe(first.turnId);

    await newSession({ conversationId: first.conversationId });

    expect(vi.mocked(cancelClaudeCliTurn)).toHaveBeenCalledWith(first.turnId);

    // The hung turn's ActiveTurn.cancelled === true is observable indirectly:
    // liveTurnByConversation no longer points at it, so a fresh send against
    // the same conversation succeeds with a NEW turnId instead of returning busy.
    const afterNewSession = await send({ workspaceId: 'ws1', conversationId: first.conversationId, prompt: 'c' });
    expect(afterNewSession.busy).toBeFalsy();
    expect(afterNewSession.turnId).toBeTruthy();
    expect(afterNewSession.turnId).not.toBe(first.turnId);
    expect(afterNewSession.conversationId).toBe(first.conversationId);
  });
});
