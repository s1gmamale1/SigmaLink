import { describe, it, expect, vi } from 'vitest';
import { findTool } from './tools';
import type { ToolContext } from './tools';

describe('read_pane_since', () => {
  it('returns text since the cursor + the new cursor', async () => {
    const tool = findTool('read_pane_since')!;
    const ctx = { pty: { snapshot: () => 'hello world' } } as unknown as ToolContext;
    expect(await tool.handler({ sessionId: 's', cursor: 6 }, ctx)).toEqual({ text: 'world', cursor: 11 });
    expect(await tool.handler({ sessionId: 's' }, ctx)).toEqual({ text: 'hello world', cursor: 11 });
  });
});

describe('wait_for_pane', () => {
  it('delegates to ctx.promptSink.wait and tails the ready session', async () => {
    const tool = findTool('wait_for_pane')!;
    const wait = vi.fn(async () => ({ sessionId: 's2', reason: 'prompt', prompt: { question: 'q' } }));
    const ctx = { promptSink: { wait }, pty: { snapshot: () => 'tail-output' } } as unknown as ToolContext;
    const r = await tool.handler({ sessionIds: ['s1', 's2'], until: 'prompt' }, ctx);
    expect(r).toMatchObject({ sessionId: 's2', reason: 'prompt', tail: 'tail-output' });
    expect(wait).toHaveBeenCalledWith({ sessionIds: ['s1', 's2'], until: 'prompt', timeoutMs: 120000 });
  });
  it('returns unavailable when no promptSink is wired', async () => {
    const tool = findTool('wait_for_pane')!;
    const r = await tool.handler({ sessionIds: ['s1'], until: 'exit' }, { pty: { snapshot: () => '' } } as unknown as ToolContext);
    expect(r).toMatchObject({ reason: 'unavailable', sessionId: null });
  });
});
