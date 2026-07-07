// P0.4 — fresh-session control DAO test. `clearClaudeSessionId` must null the
// resume id WITHOUT touching the transcript. Follows the MockDb/DI pattern
// used by the sibling `conversations.test.ts` (createDbFake, never
// `new Database()` — better-sqlite3 can't load under vitest's Electron ABI).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
}));

import { getDb, getRawDb } from '../db/client';
import {
  appendMessage,
  clearClaudeSessionId,
  createConversation,
  getClaudeSessionId,
  messagesFor,
  setClaudeSessionId,
} from './conversations';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
});

describe('clearClaudeSessionId', () => {
  it('nulls claude_session_id and leaves messages untouched', () => {
    const conv = createConversation({ workspaceId: 'ws-1', kind: 'assistant' });
    setClaudeSessionId(conv.id, 'S1');
    appendMessage({ conversationId: conv.id, role: 'user', content: 'hello' });
    appendMessage({ conversationId: conv.id, role: 'assistant', content: 'hi there' });

    expect(getClaudeSessionId(conv.id)).toBe('S1');
    expect(messagesFor(conv.id)).toHaveLength(2);

    clearClaudeSessionId(conv.id);

    expect(getClaudeSessionId(conv.id)).toBeNull();
    expect(messagesFor(conv.id)).toHaveLength(2);
  });
});
