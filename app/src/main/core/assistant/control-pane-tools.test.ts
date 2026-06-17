// Direct-handler tests for the three new control tools:
//   switch_workspace, focus_pane, set_pane_label
//
// All three are pure signal tools — they delegate to ctx.emit (± a DB write for
// set_pane_label) and return { ok: true }. Tests confirm:
//   • ctx.emit is called with the expected event name + payload.
//   • set_pane_label wraps the DB write in try/catch so a getRawDb failure
//     doesn't suppress the emit (the handler is still best-effort for the DB).
//   • fullscreen=false (or omitted) does NOT dispatch FOCUS_PANE (separate path).

import { describe, it, expect, vi } from 'vitest';

// Mock the DB client so getRawDb() is controlled per-test.
vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

// Also mock the modules that tools.ts imports which can't load under vitest.
vi.mock('../browser/cdp', () => ({
  runCDP: vi.fn(),
  attachDebugger: vi.fn(() => true),
  detachDebugger: vi.fn(),
}));
vi.mock('../workspaces/launcher', () => ({
  executeLaunchPlan: vi.fn(async () => ({ sessions: [] })),
}));

import { getRawDb } from '../db/client';
import { findTool } from './tools';
import type { ToolContext } from './tools';

function makeCtx(emit?: ReturnType<typeof vi.fn>): ToolContext {
  return {
    pty: { list: () => [], has: () => false, isLive: () => false },
    worktreePool: {},
    mailbox: {},
    memory: {},
    tasks: {},
    browserRegistry: {},
    defaultWorkspaceId: 'ws-1',
    userDataDir: '/tmp/test',
    emit,
  } as unknown as ToolContext;
}

// ── switch_workspace ──────────────────────────────────────────────────────────

describe('switch_workspace tool', () => {
  it('emits assistant:switch-workspace with the workspaceId', async () => {
    const emit = vi.fn();
    const ctx = makeCtx(emit);
    const out = await findTool('switch_workspace')!.handler({ workspaceId: 'ws-42' }, ctx);
    expect(emit).toHaveBeenCalledWith('assistant:switch-workspace', { workspaceId: 'ws-42' });
    expect(out).toEqual({ ok: true, workspaceId: 'ws-42' });
  });

  it('does not throw when ctx.emit is absent (back-compat)', async () => {
    const ctx = makeCtx(); // no emit
    const out = await findTool('switch_workspace')!.handler({ workspaceId: 'ws-42' }, ctx);
    expect(out).toMatchObject({ ok: true });
  });
});

// ── focus_pane ────────────────────────────────────────────────────────────────

describe('focus_pane tool', () => {
  it('emits assistant:focus-pane with fullscreen=true when requested', async () => {
    const emit = vi.fn();
    const ctx = makeCtx(emit);
    const out = await findTool('focus_pane')!.handler(
      { sessionId: 'sess-1', fullscreen: true },
      ctx,
    );
    expect(emit).toHaveBeenCalledWith('assistant:focus-pane', {
      sessionId: 'sess-1',
      fullscreen: true,
    });
    expect(out).toEqual({ ok: true, sessionId: 'sess-1' });
  });

  it('emits assistant:focus-pane with fullscreen=false when fullscreen omitted', async () => {
    const emit = vi.fn();
    const ctx = makeCtx(emit);
    await findTool('focus_pane')!.handler({ sessionId: 'sess-2' }, ctx);
    expect(emit).toHaveBeenCalledWith('assistant:focus-pane', {
      sessionId: 'sess-2',
      fullscreen: false,
    });
  });

  it('emits assistant:focus-pane with fullscreen=false when fullscreen is false', async () => {
    const emit = vi.fn();
    const ctx = makeCtx(emit);
    await findTool('focus_pane')!.handler({ sessionId: 'sess-3', fullscreen: false }, ctx);
    expect(emit).toHaveBeenCalledWith('assistant:focus-pane', {
      sessionId: 'sess-3',
      fullscreen: false,
    });
  });

  it('does not throw when ctx.emit is absent (back-compat)', async () => {
    const ctx = makeCtx();
    const out = await findTool('focus_pane')!.handler({ sessionId: 'sess-1' }, ctx);
    expect(out).toMatchObject({ ok: true });
  });
});

// ── set_pane_label ────────────────────────────────────────────────────────────

describe('set_pane_label tool', () => {
  it('emits panes:session-renamed with sessionId + name', async () => {
    const run = vi.fn();
    vi.mocked(getRawDb).mockReturnValue({
      prepare: vi.fn(() => ({ run })),
    } as unknown as ReturnType<typeof getRawDb>);

    const emit = vi.fn();
    const ctx = makeCtx(emit);
    const out = await findTool('set_pane_label')!.handler(
      { sessionId: 'sess-5', label: 'My Pane' },
      ctx,
    );
    expect(emit).toHaveBeenCalledWith('panes:session-renamed', {
      sessionId: 'sess-5',
      name: 'My Pane',
    });
    expect(out).toEqual({ ok: true, sessionId: 'sess-5', label: 'My Pane' });
  });

  it('performs the DB write UPDATE agent_sessions SET name = ? WHERE id = ?', async () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    vi.mocked(getRawDb).mockReturnValue({
      prepare,
    } as unknown as ReturnType<typeof getRawDb>);

    const ctx = makeCtx(vi.fn());
    await findTool('set_pane_label')!.handler(
      { sessionId: 'sess-5', label: 'My Pane' },
      ctx,
    );
    expect(prepare).toHaveBeenCalledWith('UPDATE agent_sessions SET name = ? WHERE id = ?');
    expect(run).toHaveBeenCalledWith('My Pane', 'sess-5');
  });

  it('still emits panes:session-renamed even when the DB write throws', async () => {
    vi.mocked(getRawDb).mockReturnValue({
      prepare: vi.fn(() => ({
        run: vi.fn(() => { throw new Error('DB unavailable'); }),
      })),
    } as unknown as ReturnType<typeof getRawDb>);

    const emit = vi.fn();
    const ctx = makeCtx(emit);
    // Must not throw.
    const out = await findTool('set_pane_label')!.handler(
      { sessionId: 'sess-6', label: 'Fallback' },
      ctx,
    );
    expect(emit).toHaveBeenCalledWith('panes:session-renamed', {
      sessionId: 'sess-6',
      name: 'Fallback',
    });
    expect(out).toMatchObject({ ok: true });
  });

  it('does not throw when ctx.emit is absent (back-compat)', async () => {
    const run = vi.fn();
    vi.mocked(getRawDb).mockReturnValue({
      prepare: vi.fn(() => ({ run })),
    } as unknown as ReturnType<typeof getRawDb>);

    const ctx = makeCtx(); // no emit
    const out = await findTool('set_pane_label')!.handler(
      { sessionId: 'sess-7', label: 'No Emit' },
      ctx,
    );
    expect(out).toMatchObject({ ok: true });
  });
});
