// P2 Task 8 — propose_amendment tool. Same harness as tools.missions.test.ts
// / tools.memory.test.ts (vi.mock('../db/client') + createDbFake), driven
// through `findTool(id)!.handler(args, ctx)` so this exercises the SAME
// parse/handler path the assistant CLI uses. Proposals are drizzle-only
// (no FTS/raw SQL), so no patchDelete/recording-raw shim is needed here.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { getDb } from '../db/client';
import { createDbFake, type DbFake } from '@/test-utils/db-fake';
import { findTool } from './tools';
import type { ToolContext } from './tools';
import * as amendmentsDao from '../operator/amendments';

function makeCtx(extra?: Partial<ToolContext>): ToolContext {
  return {
    pty: { list: () => [] },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/sigmalink-test',
    ...extra,
  } as unknown as ToolContext;
}

let fake: DbFake;
beforeEach(() => {
  fake = createDbFake();
  vi.mocked(getDb).mockReturnValue(fake.drizzle as unknown as ReturnType<typeof getDb>);
});

describe('propose_amendment tool', () => {
  it('persists a proposed amendment and returns its id', async () => {
    const emit = vi.fn();
    const ctx = makeCtx({ emit });
    const out = (await findTool('propose_amendment')!.handler(
      { text: 'Always run the full gate before shipping.' },
      ctx,
    )) as { amendmentId: string };
    expect(out.amendmentId).toBeTruthy();
    const stored = amendmentsDao.listAmendments().find((a) => a.id === out.amendmentId);
    expect(stored?.text).toBe('Always run the full gate before shipping.');
    expect(stored?.status).toBe('proposed');
    expect(stored?.rationale).toBeNull();
    expect(emit).toHaveBeenCalledWith('jorvis:amendments-changed', {});
  });

  it('honors an explicit rationale', async () => {
    const out = (await findTool('propose_amendment')!.handler(
      { text: 't', rationale: 'because it keeps biting us' },
      makeCtx(),
    )) as { amendmentId: string };
    const stored = amendmentsDao.listAmendments().find((a) => a.id === out.amendmentId);
    expect(stored?.rationale).toBe('because it keeps biting us');
  });
});
