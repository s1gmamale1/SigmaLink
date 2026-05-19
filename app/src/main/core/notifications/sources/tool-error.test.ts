// v1.4.9 #07 — tool-error source unit tests. Verifies the trace.ok=false
// gate, D1 critical-bypass for create_workspace, and dedup key shape.

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

import { pushToolErrorNotification } from './tool-error';
import type { NotificationsManager, AddInput } from '../manager';
import type { ToolTrace } from '../../assistant/tool-tracer';

function makeMgr(): { mgr: NotificationsManager; calls: AddInput[] } {
  const calls: AddInput[] = [];
  const mgr = {
    add: (input: AddInput) => {
      calls.push(input);
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

function makeTrace(partial: Partial<ToolTrace>): ToolTrace {
  return {
    id: 't-1',
    conversationId: 'conv-1',
    name: 'launch_pane',
    startedAt: 0,
    finishedAt: 0,
    args: {},
    ok: false,
    result: undefined,
    error: 'boom',
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pushToolErrorNotification', () => {
  it('drops successful traces', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ ok: true }));
    expect(calls).toHaveLength(0);
  });

  it('maps a generic tool failure to error (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'launch_pane' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe('error');
    expect(calls[0].dedupKey).toBe('tool-error:launch_pane:conv-1');
  });

  it('escalates create_workspace failure to critical (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'create_workspace' }));
    expect(calls[0].severity).toBe('critical');
  });

  it('attaches conversationId + messageId in the payload', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(
      mgr,
      makeTrace({ conversationId: 'conv-1', messageId: 'msg-9' }),
    );
    expect(calls[0].payload).toEqual(
      expect.objectContaining({ conversationId: 'conv-1', messageId: 'msg-9' }),
    );
  });

  it('uses a `global` sentinel for traces lacking a conversationId', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ conversationId: null }));
    expect(calls[0].dedupKey).toBe('tool-error:launch_pane:global');
  });
});
