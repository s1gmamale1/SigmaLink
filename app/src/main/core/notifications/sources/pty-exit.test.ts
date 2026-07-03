// v1.4.9 #07 — pty-exit source unit tests. Verifies the D1 severity mapping
// and dedup key shape. The notifications manager is stubbed; we assert the
// args the source forwards.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', () => ({
  getDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: () => ({ workspaceId: 'ws-1', closedAt: null }) }),
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

/** Minimal stub for suppression tests that just need to assert add was/wasn't called. */
function fakeManager() {
  return { add: vi.fn() } as unknown as Parameters<typeof pushPtyExitNotification>[0];
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

describe('pushPtyExitNotification — deliberate-close suppression', () => {
  it('does NOT add a notification when the session is closed (closed_at set)', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'error', exitCode: 143 },
      () => ({ workspaceId: 'w1', closedAt: 1234 }),
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
  });

  it('does NOT add a notification for exit code 0 on a closed session', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'exited', exitCode: 0 },
      () => ({ workspaceId: 'w1', closedAt: 9999 }),
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
  });

  it('DOES add a notification for an unexpected exit (closed_at NULL)', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's2', kind: 'error', exitCode: 1 },
      () => ({ workspaceId: 'w1', closedAt: null }),
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledTimes(1);
  });
});

// 2026-07-02 review fix B — quit-time killAll SIGTERMs every pane; those exits
// (code 143, closed_at NULL) must not seed phantom "Pane exited" warns that
// greet the next boot for panes the resume-launcher restores alive.
describe('pushPtyExitNotification — app-shutdown suppression', () => {
  it('does NOT add a notification while the app is shutting down', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'error', exitCode: 143 },
      () => ({ workspaceId: 'w1', closedAt: null }),
      () => true,
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
  });

  it('DOES add a notification when the shutdown gate reports false', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'error', exitCode: 143 },
      () => ({ workspaceId: 'w1', closedAt: null }),
      () => false,
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledTimes(1);
  });

  it('a throwing shutdown gate fails OPEN (notification still recorded)', () => {
    const mgr = fakeManager();
    pushPtyExitNotification(
      mgr,
      { sessionId: 's1', kind: 'error', exitCode: 1 },
      () => ({ workspaceId: 'w1', closedAt: null }),
      () => {
        throw new Error('gate exploded');
      },
    );
    expect((mgr as unknown as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledTimes(1);
  });
});
