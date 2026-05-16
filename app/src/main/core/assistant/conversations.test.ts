import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import {
  appendMessage,
  createConversation,
  getClaudeSessionId,
  getConversation,
  listConversations,
  setClaudeSessionId,
} from './conversations';
import { buildConversationsHandlers } from './conversations-controller';
import {
  createDbFake,
  seedWorkspace,
  type DbFake,
} from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

describe('assistant conversation Claude session ids', () => {
  it('setClaudeSessionId round-trips and null clears', () => {
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const sessionId = '11111111-1111-4111-8111-111111111111';

    expect(conv.claudeSessionId).toBeNull();
    expect(getClaudeSessionId(conv.id)).toBeNull();

    setClaudeSessionId(conv.id, sessionId);
    expect(getClaudeSessionId(conv.id)).toBe(sessionId);
    expect(getConversation(conv.id)?.claudeSessionId).toBe(sessionId);

    setClaudeSessionId(conv.id, null);
    expect(getClaudeSessionId(conv.id)).toBeNull();
    expect(getConversation(conv.id)?.claudeSessionId).toBeNull();
  });

  it('listConversations carries claudeSessionId with hydrated messages', () => {
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const sessionId = '22222222-2222-4222-8222-222222222222';
    setClaudeSessionId(conv.id, sessionId);
    appendMessage({ conversationId: conv.id, role: 'user', content: 'hello' });

    const rows = listConversations({ workspaceId: 'ws-1', kind: 'assistant' });

    expect(rows).toHaveLength(1);
    expect(rows[0].claudeSessionId).toBe(sessionId);
    expect(rows[0].messages).toHaveLength(1);
  });

  it('assistant.conversations list/get include claudeSessionId', async () => {
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const sessionId = '33333333-3333-4333-8333-333333333333';
    setClaudeSessionId(conv.id, sessionId);
    const handlers = buildConversationsHandlers();

    const list = (await handlers.list({ workspaceId: 'ws-1' })) as Array<{
      claudeSessionId: string | null;
    }>;
    const get = await handlers.get({ conversationId: conv.id });

    expect(list).toHaveLength(1);
    expect(list[0].claudeSessionId).toBe(sessionId);
    expect(
      (
        get as {
          conversation: { claudeSessionId: string | null } | null;
        }
      ).conversation?.claudeSessionId,
    ).toBe(sessionId);
  });

  it('resumeHint reports available when the Claude JSONL exists', async () => {
    const rootPath = '/Users/sigma/project';
    seedWorkspace(fake, { id: 'ws-1', rootPath });
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const sessionId = '44444444-4444-4444-8444-444444444444';
    setClaudeSessionId(conv.id, sessionId);
    const seenPaths: string[] = [];
    const handlers = buildConversationsHandlers({
      homeDir: '/home/sigma',
      existsSync: (p) => {
        seenPaths.push(p);
        return true;
      },
    });

    await expect(handlers.resumeHint({ conversationId: conv.id })).resolves.toEqual({
      available: true,
      sessionId,
    });
    expect(seenPaths).toEqual([
      path.join(
        '/home/sigma',
        '.claude',
        'projects',
        '-Users-sigma-project',
        `${sessionId}.jsonl`,
      ),
    ]);
  });

  it('resumeHint reports missing when the Claude JSONL is absent', async () => {
    seedWorkspace(fake, { id: 'ws-1', rootPath: '/Users/sigma/project' });
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const sessionId = '55555555-5555-4555-8555-555555555555';
    setClaudeSessionId(conv.id, sessionId);
    const handlers = buildConversationsHandlers({
      homeDir: '/home/sigma',
      existsSync: () => false,
    });

    await expect(handlers.resumeHint({ conversationId: conv.id })).resolves.toEqual({
      available: false,
      sessionId,
    });
  });

  it('resumeHint reports unavailable when no Claude session id is stored', async () => {
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    const handlers = buildConversationsHandlers({
      homeDir: '/home/sigma',
      existsSync: vi.fn(() => true),
    });

    await expect(handlers.resumeHint({ conversationId: conv.id })).resolves.toEqual({
      available: false,
      sessionId: null,
    });
  });
});
