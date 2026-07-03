// Swarm-cap ghost-agents fix — the 20-agent cap must count LIVE panes, not
// lifetime swarm_agents rows. Pane close (Phase 13A) soft-deletes only
// agent_sessions.closed_at; the swarm_agents row survives forever, so a
// long-lived default swarm accumulated 20 dead rows and permanently disabled
// every provider in the +Pane dropdown (post-#206 presentation).
//
// `countLiveAgentPanes` + `resolvePaneClosedAt` are the single choke point for
// the liveness rule, shared by the renderer gates (AddPaneButton, SwarmRoom)
// and the backend gate (factory-add-agent).

import { describe, expect, it } from 'vitest';
import { countLiveAgentPanes, resolvePaneClosedAt } from './providers';

function agent(providerId: string, closedAt?: number | null) {
  return { providerId, closedAt };
}

describe('countLiveAgentPanes', () => {
  it('counts real-agent panes with no close marker', () => {
    expect(countLiveAgentPanes([agent('claude'), agent('codex', null)])).toBe(2);
  });

  it('excludes shell (plain terminal) panes regardless of liveness', () => {
    expect(countLiveAgentPanes([agent('shell'), agent('shell', null), agent('claude')])).toBe(1);
  });

  it('excludes closed panes (closedAt set)', () => {
    const agents = [
      agent('claude', 1_700_000_000_000),
      agent('claude', null),
      agent('codex', 1),
    ];
    expect(countLiveAgentPanes(agents)).toBe(1);
  });

  it('a swarm of 20 closed agents counts 0 live panes', () => {
    const agents = Array.from({ length: 20 }, () => agent('claude', 123));
    expect(countLiveAgentPanes(agents)).toBe(0);
  });
});

describe('resolvePaneClosedAt', () => {
  it('no sessionId yet (mid-spawn row) → live (null), so concurrent adds still count', () => {
    expect(resolvePaneClosedAt(null, undefined)).toBeNull();
  });

  it('session row missing (hard-deleted by workspace cleanup) → treated as closed', () => {
    expect(resolvePaneClosedAt('sess-1', undefined)).not.toBeNull();
  });

  it('session open (closed_at NULL) → live', () => {
    expect(resolvePaneClosedAt('sess-1', { closedAt: null })).toBeNull();
  });

  it('session deliberately closed → its closed_at passes through', () => {
    expect(resolvePaneClosedAt('sess-1', { closedAt: 42 })).toBe(42);
  });
});
