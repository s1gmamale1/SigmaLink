// v1.4.9 #07 — pty-exit source unit tests. Verifies the D1 severity mapping
// and dedup key shape. The notifications manager is stubbed; we assert the
// args the source forwards.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', () => ({
  getDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: () => ({ workspaceId: 'ws-1' }) }),
      }),
    }),
  })),
}));

import { pushPtyExitNotification } from './pty-exit';
import type { NotificationsManager } from '../manager';
import type { AddInput } from '../manager';

type AddInputCapture = AddInput;

function makeMgr(): { mgr: NotificationsManager; calls: AddInputCapture[] } {
  const calls: AddInputCapture[] = [];
  const mgr = {
    add: (input: AddInput) => {
      calls.push(input as AddInputCapture);
      return {
        id: 'n-1',
        workspaceId: input.workspaceId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body ?? null,
        payload: input.payload ?? null,
        sourceEvent: input.sourceEvent ?? null,
        dedupKey: input.dedupKey,
        dupCount: 1,
        createdAt: 0,
        readAt: null,
      };
    },
  } as unknown as NotificationsManager;
  return { mgr, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pushPtyExitNotification', () => {
  it('maps exit code 0 to info (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'exited', exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe('info');
    expect(calls[0].dedupKey).toBe('pty-exit:s-1');
    expect(calls[0].kind).toBe('pty-exit');
    expect(calls[0].sourceEvent).toBe('pty:exit');
  });

  it('maps non-zero exit code to warn (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'exited', exitCode: 1 });
    expect(calls[0].severity).toBe('warn');
  });

  it('maps kind=error (signal-killed) to warn (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'error' });
    expect(calls[0].severity).toBe('warn');
  });

  it('ignores `started`, `output-spike`, `idle` events', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'started' });
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'output-spike' });
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'idle' });
    expect(calls).toHaveLength(0);
  });

  it('uses sessionId in the dedupKey so two panes do not collapse', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 'pane-a', kind: 'exited', exitCode: 0 });
    pushPtyExitNotification(mgr, { sessionId: 'pane-b', kind: 'exited', exitCode: 0 });
    expect(calls[0].dedupKey).toBe('pty-exit:pane-a');
    expect(calls[1].dedupKey).toBe('pty-exit:pane-b');
  });

  it('attaches the resolved workspaceId from agent_sessions', () => {
    const { mgr, calls } = makeMgr();
    pushPtyExitNotification(mgr, { sessionId: 's-1', kind: 'exited', exitCode: 0 });
    expect(calls[0].workspaceId).toBe('ws-1');
  });
});
