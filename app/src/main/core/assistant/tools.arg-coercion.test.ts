// 2026-07-07 operator smoke — LLMs emit quoted primitives ({"count":"2",
// "allWorkspaces":"true"}) and the strict tool schemas hard-failed the calls
// (get_app_state / launch_pane toasts). These tests pin the lossless
// coerce-and-retry at the T() parse choke point: only fields that FAILED as
// boolean/number get coerced, and only when the string form is lossless.

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

describe('tool arg coercion (string primitives from the LLM)', () => {
  it('launch_pane accepts count as a numeric string', () => {
    const parsed = findTool('launch_pane')!.parse({
      workspaceRoot: '/tmp/ws',
      provider: 'claude',
      count: '2',
    });
    expect(parsed.count).toBe(2);
  });

  it('get_app_state accepts allWorkspaces as "true"/"false" strings', () => {
    expect(findTool('get_app_state')!.parse({ allWorkspaces: 'true' }).allWorkspaces).toBe(true);
    expect(findTool('get_app_state')!.parse({ allWorkspaces: 'false' }).allWorkspaces).toBe(false);
  });

  it('coerces multiple failing fields in one call (launch_pane count + autoApprove)', () => {
    const parsed = findTool('launch_pane')!.parse({
      workspaceRoot: '/tmp/ws',
      provider: 'claude',
      count: '3',
      autoApprove: 'true',
    });
    expect(parsed.count).toBe(3);
    expect(parsed.autoApprove).toBe(true);
  });

  it('does NOT corrupt legit string fields whose value looks numeric', () => {
    const parsed = findTool('launch_pane')!.parse({
      workspaceRoot: '/tmp/ws',
      provider: 'claude',
      initialPrompt: '2', // z.string() field — must stay a string
      count: '2',
    });
    expect(parsed.initialPrompt).toBe('2');
    expect(parsed.count).toBe(2);
  });

  it('a non-coercible string still fails with the ORIGINAL error', () => {
    expect(() =>
      findTool('launch_pane')!.parse({
        workspaceRoot: '/tmp/ws',
        provider: 'claude',
        count: 'lots',
      }),
    ).toThrowError(/expected number/);
  });

  it('a coerced value still honors the schema bounds (count max 8)', () => {
    expect(() =>
      findTool('launch_pane')!.parse({
        workspaceRoot: '/tmp/ws',
        provider: 'claude',
        count: '20',
      }),
    ).toThrowError();
  });

  it('boolean coercion only accepts the exact "true"/"false" forms', () => {
    expect(() => findTool('get_app_state')!.parse({ allWorkspaces: 'yes' })).toThrowError(
      /expected boolean/,
    );
  });

  it('untouched valid args parse exactly as before (no behavior change)', () => {
    const parsed = findTool('launch_pane')!.parse({
      workspaceRoot: '/tmp/ws',
      provider: 'claude',
      count: 4,
      autoApprove: false,
    });
    expect(parsed.count).toBe(4);
    expect(parsed.autoApprove).toBe(false);
  });
});
