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

  // Task 3 (v2.9.1) — terminal + non-resumable sessions are dead weight on the
  // 20-agent cap. A clean exit or crash leaves closed_at NULL forever (the
  // renderer GC only dispatches REMOVE_SESSION), so counting closed_at alone let
  // each crash+Relaunch leak a cap slot. Treat status IN ('exited','error') AND
  // exit_code !== -1 as non-live by resolving a synthetic close marker.
  it('terminal exited/0 session → non-live (synthetic close marker)', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'exited', exitCode: 0 }),
    ).not.toBeNull();
  });

  it('terminal error session → non-live', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'error', exitCode: 1 }),
    ).not.toBeNull();
  });

  // CRITICAL invariant — exit_code === -1 is killed-at-quit (resume-eligible).
  // These MUST stay live or boot-resume over-admits agents whose slots
  // resurrect on the next launch.
  it('exited/-1 (killed-at-quit, resume-eligible) → still live', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'exited', exitCode: -1 }),
    ).toBeNull();
  });

  it('error/-1 (killed-at-quit) → still live', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'error', exitCode: -1 }),
    ).toBeNull();
  });

  it('running / starting sessions → live regardless of exit_code', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'running', exitCode: null }),
    ).toBeNull();
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: null, status: 'starting', exitCode: null }),
    ).toBeNull();
  });

  it('an explicit deliberate close still wins over the terminal rule', () => {
    expect(
      resolvePaneClosedAt('sess-1', { closedAt: 77, status: 'exited', exitCode: 0 }),
    ).toBe(77);
  });
});

// Task 3 (v2.9.1) — end-to-end: rows resolved through resolvePaneClosedAt and
// counted by countLiveAgentPanes. Proves the cap excludes terminal-non-resumable
// panes and keeps resume-eligible (exit_code -1) ones.
describe('countLiveAgentPanes — terminal sessions excluded end-to-end', () => {
  interface SessionRow {
    closedAt: number | null;
    status: string;
    exitCode: number | null;
  }
  function capAgent(providerId: string, sess: SessionRow) {
    return { providerId, closedAt: resolvePaneClosedAt('sess', sess) };
  }

  it('exited/0 and error rows do not count; exited/-1 and running do', () => {
    const agents = [
      capAgent('claude', { closedAt: null, status: 'exited', exitCode: 0 }), // dead
      capAgent('claude', { closedAt: null, status: 'error', exitCode: 1 }), // dead
      capAgent('claude', { closedAt: null, status: 'exited', exitCode: -1 }), // live (resume)
      capAgent('claude', { closedAt: null, status: 'running', exitCode: null }), // live
    ];
    expect(countLiveAgentPanes(agents)).toBe(2);
  });

  it('20 crashed panes (exited/1) count 0 — the leaked-cap-slot bug', () => {
    const agents = Array.from({ length: 20 }, () =>
      capAgent('claude', { closedAt: null, status: 'exited', exitCode: 1 }),
    );
    expect(countLiveAgentPanes(agents)).toBe(0);
  });
});
