// Direct-handler tests for open_workspace and close_workspace tools.
import { describe, expect, it, vi } from 'vitest';

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

import { findTool } from './tools';
import type { ToolContext } from './tools';

function makeCtx(emit?: (event: string, payload: unknown) => void): ToolContext {
  return {
    pty: {
      list: () => [],
      has: () => false,
      isLive: () => false,
      snapshot: () => '',
      write: vi.fn(),
      kill: vi.fn(),
    } as unknown as ToolContext['pty'],
    worktreePool: { poolPathForRepo: vi.fn() } as unknown as ToolContext['worktreePool'],
    mailbox: {} as ToolContext['mailbox'],
    memory: {} as ToolContext['memory'],
    tasks: {} as ToolContext['tasks'],
    browserRegistry: {} as ToolContext['browserRegistry'],
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/test-user-data',
    emit,
  };
}

describe('open_workspace tool', () => {
  it('emits assistant:open-workspace with root and returns {ok:true, root}', async () => {
    const emitted: Array<[string, unknown]> = [];
    const ctx = makeCtx((event, payload) => { emitted.push([event, payload]); });
    const tool = findTool('open_workspace');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ root: '/home/user/my-project' }, ctx);
    expect(result).toEqual({ ok: true, root: '/home/user/my-project' });
    expect(emitted).toEqual([['assistant:open-workspace', { root: '/home/user/my-project' }]]);
  });

  it('does not throw when ctx.emit is absent', async () => {
    const ctx = makeCtx(undefined);
    const tool = findTool('open_workspace');
    const result = await tool!.handler({ root: '/some/path' }, ctx);
    expect(result).toEqual({ ok: true, root: '/some/path' });
  });

  it('rejects missing root via schema parse', () => {
    const tool = findTool('open_workspace');
    expect(() => tool!.parse({})).toThrow();
    expect(() => tool!.parse({ root: '' })).toThrow();
  });
});

describe('close_workspace tool', () => {
  it('emits assistant:close-workspace with workspaceId and returns {ok:true, workspaceId}', async () => {
    const emitted: Array<[string, unknown]> = [];
    const ctx = makeCtx((event, payload) => { emitted.push([event, payload]); });
    const tool = findTool('close_workspace');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ workspaceId: 'ws-42' }, ctx);
    expect(result).toEqual({ ok: true, workspaceId: 'ws-42' });
    expect(emitted).toEqual([['assistant:close-workspace', { workspaceId: 'ws-42' }]]);
  });

  it('does not throw when ctx.emit is absent', async () => {
    const ctx = makeCtx(undefined);
    const tool = findTool('close_workspace');
    const result = await tool!.handler({ workspaceId: 'ws-99' }, ctx);
    expect(result).toEqual({ ok: true, workspaceId: 'ws-99' });
  });

  it('rejects missing workspaceId via schema parse', () => {
    const tool = findTool('close_workspace');
    expect(() => tool!.parse({})).toThrow();
    expect(() => tool!.parse({ workspaceId: '' })).toThrow();
  });
});
