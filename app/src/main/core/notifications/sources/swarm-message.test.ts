// v1.4.9 #07 — swarm-message source unit tests. Verifies the gate
// (broadcastToSidebar + allowlist kinds) + D1 severity mapping + dedup key.

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

import { pushSwarmMessageNotification } from './swarm-message';
import type { NotificationsManager, AddInput } from '../manager';
import type { SwarmMessage, SwarmMessageKind } from '../../../../shared/types';

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

function makeMsg(partial: Partial<SwarmMessage>): SwarmMessage {
  return {
    id: 'm-1',
    swarmId: 'sw-1',
    fromAgent: 'agent-a',
    toAgent: '*',
    kind: 'swarm-broadcast' as unknown as SwarmMessageKind,
    body: 'hello',
    payload: { broadcastToSidebar: true },
    ts: 0,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pushSwarmMessageNotification', () => {
  it('drops messages without payload.broadcastToSidebar=true', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(mgr, makeMsg({ payload: {} }));
    expect(calls).toHaveLength(0);
  });

  it('drops messages with an out-of-allowlist kind', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(
      mgr,
      makeMsg({ kind: 'SAY' as SwarmMessageKind, payload: { broadcastToSidebar: true } }),
    );
    expect(calls).toHaveLength(0);
  });

  it('emits info for a broadcast envelope', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(mgr, makeMsg({}));
    expect(calls).toHaveLength(1);
    expect(calls[0].severity).toBe('info');
    expect(calls[0].dedupKey).toBe('swarm:sw-1:swarm-broadcast:agent-a');
    expect(calls[0].sourceEvent).toBe('swarm:message');
  });

  it('escalates to warn for escalation kind (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(
      mgr,
      makeMsg({ kind: 'escalation' as unknown as SwarmMessageKind }),
    );
    expect(calls[0].severity).toBe('warn');
  });

  it('escalates to warn for error_report kind (D1)', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(
      mgr,
      makeMsg({ kind: 'error_report' as unknown as SwarmMessageKind }),
    );
    expect(calls[0].severity).toBe('warn');
  });

  it('attaches swarmId + messageId in the payload for deep-link', () => {
    const { mgr, calls } = makeMgr();
    pushSwarmMessageNotification(mgr, makeMsg({ id: 'm-99', swarmId: 'sw-99' }));
    expect(calls[0].payload).toEqual(
      expect.objectContaining({ swarmId: 'sw-99', messageId: 'm-99' }),
    );
  });
});
