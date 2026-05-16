import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import { getDb, getRawDb, initializeDatabase, closeDatabase } from '../db/client';
import { findTool } from './tools';
import { createDbFake, seedAgentSession, type DbFake } from '@/test-utils/db-fake';

let fake: DbFake;

beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
  vi.mocked(getRawDb).mockReturnValue(fake.raw as unknown as ReturnType<typeof getRawDb>);
  vi.mocked(initializeDatabase).mockReturnValue({
    db: fake.drizzle as unknown as ReturnType<typeof initializeDatabase>['db'],
    raw: fake.raw as unknown as ReturnType<typeof initializeDatabase>['raw'],
    filePath: '/tmp/fake.db',
  });
  vi.mocked(closeDatabase).mockReturnValue(undefined);
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
});

describe('monitor_pane tool', () => {
  it('writes sigmaMonitorConversationId to the session row', async () => {
    seedAgentSession(fake, { id: 'sess-1', workspaceId: 'ws-1', providerId: 'codex', cwd: '/tmp' });
    const out = await findTool('monitor_pane')!.handler(
      { sessionId: 'sess-1', conversationId: 'conv-1' },
      // ToolContext has many fields — we only need the DB mock which is already set up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(out).toEqual({ ok: true });
    const row = fake.store.tables.get('agent_sessions')?.find((r) => r.id === 'sess-1');
    expect(row).toBeDefined();
    expect(row!.sigmaMonitorConversationId).toBe('conv-1');
  });
});
