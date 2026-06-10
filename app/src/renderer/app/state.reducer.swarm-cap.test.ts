// Perf audit 2026-06-10 #4 — APPEND_SWARM_MESSAGE growth cap.
// Hydrate tails 200 messages (SwarmRoom/SwarmRailTab `rpc.swarms.tail`); live
// appends then grew the per-swarm array unbounded (dedupe, no cap). The
// reducer caps each thread at 500 by dropping the oldest, bounding bubble row
// count and SideChat's (already-memoized) runGroups rebuild on long swarms.
//
// Pure reducer — no React, no DOM, no DB. Safe under vitest.

import { describe, expect, it } from 'vitest';
import { appStateReducer } from './state.reducer';
import { initialAppState } from './state.types';
import type { SwarmMessage } from '../../shared/types';

function swarmMsg(id: string, ts: number): SwarmMessage {
  return {
    id,
    swarmId: 'sw-1',
    fromAgent: 'coordinator',
    toAgent: '*',
    kind: 'SAY',
    body: `msg ${id}`,
    ts,
  };
}

function hydrated(count: number) {
  const messages = Array.from({ length: count }, (_, i) => swarmMsg(`m-${i}`, 1000 + i));
  return appStateReducer(initialAppState, {
    type: 'SET_SWARM_MESSAGES',
    swarmId: 'sw-1',
    messages,
  });
}

describe('APPEND_SWARM_MESSAGE cap (perf audit #4)', () => {
  it('appends normally under the cap', () => {
    const s1 = hydrated(10);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-next', 2000),
    });
    expect(s2.swarmMessages['sw-1']).toHaveLength(11);
    expect(s2.swarmMessages['sw-1'].at(-1)!.id).toBe('m-next');
  });

  it('caps at 500 by dropping the head once full', () => {
    const s1 = hydrated(500);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-next', 2000),
    });
    const arr = s2.swarmMessages['sw-1'];
    expect(arr).toHaveLength(500);
    expect(arr[0].id).toBe('m-1'); // m-0 (oldest) dropped
    expect(arr.at(-1)!.id).toBe('m-next'); // newest kept at the tail
  });

  it('preserves dedupe-by-id (same state reference returned)', () => {
    const s1 = hydrated(3);
    const s2 = appStateReducer(s1, {
      type: 'APPEND_SWARM_MESSAGE',
      message: swarmMsg('m-1', 9999),
    });
    expect(s2).toBe(s1);
  });
});
