// v1.4.9 #07 — tool-error source unit tests. Verifies the trace.ok=false
// gate, D1 critical-bypass for create_workspace and other DB-touching tools,
// and dedup key shape.
// v1.5.1-C caveat 7 — launch_pane, create_swarm, add_agent, create_memory,
// monitor_pane added to CRITICAL_TOOL_NAMES.

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

  it('maps a truly generic (non-DB-touching) tool failure to error (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'read_files' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe('error');
    expect(calls[0].dedupKey).toBe('tool-error:read_files:conv-1');
  });

  it('escalates create_workspace failure to critical (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'create_workspace' }));
    expect(calls[0].severity).toBe('critical');
  });

  it('escalates launch_pane failure to critical (v1.5.1-C: DB-touching tool)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'launch_pane' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe('critical');
    expect(calls[0].dedupKey).toBe('tool-error:launch_pane:conv-1');
  });

  it('escalates create_swarm failure to critical (v1.5.1-C)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'create_swarm' }));
    expect(calls[0].severity).toBe('critical');
  });

  it('escalates add_agent failure to critical (v1.5.1-C)', () => {
    const { mgr, calls } = makeMgr();
    pushToolErrorNotification(mgr, makeTrace({ name: 'add_agent' }));
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
