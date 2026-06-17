import { describe, it, expect, vi } from 'vitest';

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

describe('send_keys tool', () => {
  it('encodes keys and writes them to the pty', async () => {
    const tool = findTool('send_keys')!;
    const write = vi.fn();
    const ctx = { pty: { write } } as unknown as ToolContext;
    const r = await tool.handler({ sessionId: 's1', keys: ['l', 's', 'Enter'] }, ctx);
    expect(write).toHaveBeenCalledWith('s1', 'ls\r');
    expect(r).toEqual({ ok: true, sessionId: 's1' });
  });
});
