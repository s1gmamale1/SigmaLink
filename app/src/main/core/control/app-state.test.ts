import { describe, it, expect } from 'vitest';
import { buildAppState, type AppStateDeps } from './app-state';

const baseDeps = (over: Partial<AppStateDeps>): AppStateDeps => ({
  listWorkspaces: () => [
    { id: 'w1', name: 'Repo', rootPath: '/r', repoRoot: '/r', repoMode: 'git', lastOpenedAt: 5 },
  ],
  getOpenWorkspaceIds: () => ['w1'],
  windowScopes: () => [{ windowId: 1, isMain: true, workspaceIds: ['w1'] }],
  listSessions: (ws) =>
    ws === 'w1'
      ? [
          {
            id: 's1', workspaceId: 'w1', paneIndex: 0, name: null, providerId: 'claude',
            displayProviderId: null, cwd: '/r', branch: 'main', worktreePath: null,
            status: 'running', exitCode: null, startedAt: 1, exitedAt: null, minimised: false,
            splitGroupId: null, splitDirection: null, splitIndex: null, swarmId: null,
            agentKey: null, swarmRole: null,
          },
          {
            id: 's2', workspaceId: 'w1', paneIndex: 1, name: 'Builder', providerId: 'codex',
            displayProviderId: null, cwd: '/r', branch: 'main', worktreePath: null,
            status: 'running', exitCode: null, startedAt: 2, exitedAt: null, minimised: false,
            splitGroupId: null, splitDirection: null, splitIndex: null, swarmId: 'sw1',
            agentKey: 'builder-1', swarmRole: 'builder',
          },
        ]
      : [],
  ptyAlive: (id) => ({ alive: id === 's1' || id === 's2', pid: 100 }),
  attention: () => new Map([['s1', { ts: 999, reason: 'idle' }]]),
  listSwarms: (ws) =>
    ws === 'w1'
      ? [
          {
            id: 'sw1', name: 'Squad', mission: 'm', preset: 'squad', status: 'running',
            createdAt: 1, endedAt: null,
            agents: [
              { agentKey: 'builder-1', role: 'builder', roleIndex: 0, status: 'busy', sessionId: 's2', providerId: 'codex' },
            ],
          },
        ]
      : [],
  browserState: () => null,
  notifications: () => ({ unreadCount: 2, recent: [] }),
  viewport: () => ({
    activeWorkspaceId: 'w1', activeSessionId: 's1', focusedPaneId: null, room: 'command',
    activeSwarmId: 'sw1', viewportStale: false,
  }),
  derivePaneName: (s) => s.name ?? `agent-${s.id}`,
  shapeSignature: (ids) => `${ids.length}x1`,
  now: () => 12345,
  ...over,
});

describe('buildAppState', () => {
  it('assembles a holistic snapshot from injected sources', () => {
    const snap = buildAppState(baseDeps({}), { workspaceId: 'w1' });
    expect(snap.capturedAt).toBe(12345);
    expect(snap.viewportStale).toBe(false);
    expect(snap.workspaces.all).toHaveLength(1);
    expect(snap.workspaces.openIds).toEqual(['w1']);
    expect(snap.workspaces.activeId).toBe('w1');
    expect(snap.workspaces.attention).toEqual({ w1: 999 });
    expect(snap.workspaces.detachedIds).toEqual([]);
    expect(snap.currentView.room).toBe('command');
    expect(snap.panes.activeSessionId).toBe('s1');
    expect(snap.panes.gridShape).toBe('2x1');
    expect(snap.panes.orderedSessionIds).toEqual(['s1', 's2']);

    const s1 = snap.panes.sessions.find((s) => s.sessionId === 's1')!;
    expect(s1.attentionTs).toBe(999);
    expect(s1.displayName).toBe('agent-s1');
    expect(s1.ptyAlive).toBe(true);
    expect(s1.operatorName).toBeNull();

    const s2 = snap.panes.sessions.find((s) => s.sessionId === 's2')!;
    expect(s2.attentionTs).toBeNull();
    expect(s2.operatorName).toBe('Builder');
    expect(s2.swarmRole).toBe('builder');

    expect(snap.swarms[0].agentCount).toBe(1);
    expect(snap.browser).toBeNull();
    expect(snap.notifications.unreadCount).toBe(2);
    expect(snap.windows).toHaveLength(1);
  });

  it('degrades gracefully when sub-sources throw or are empty (never throws)', () => {
    const snap = buildAppState(
      baseDeps({
        listSessions: () => {
          throw new Error('db down');
        },
        browserState: () => {
          throw new Error('no manager');
        },
        notifications: () => {
          throw new Error('x');
        },
        viewport: () => ({
          activeWorkspaceId: null, activeSessionId: null, focusedPaneId: null, room: null,
          activeSwarmId: null, viewportStale: true,
        }),
      }),
      {},
    );
    expect(snap.panes.sessions).toEqual([]);
    expect(snap.panes.orderedSessionIds).toEqual([]);
    expect(snap.browser).toBeNull();
    expect(snap.notifications.unreadCount).toBe(0);
    expect(snap.viewportStale).toBe(true);
  });

  it('scopes to the active workspace when no workspaceId is given', () => {
    const snap = buildAppState(baseDeps({}), {});
    expect(snap.panes.sessions).toHaveLength(2); // resolved targetWs = viewport.activeWorkspaceId
  });

  // Task 3 — capacity block: driver can see live count + cap + headroom so it
  // knows whether to stop/kill panes before spawning more.
  it('includes capacity block when capacity dep is provided', () => {
    const snap = buildAppState(
      baseDeps({
        capacity: (_workspaceId) => ({
          liveAgents: 3,
          cap: 15,
          workspaceLiveAgents: 2,
          workspaceCap: 8,
          headroom: 12, // cap(15) - liveAgents(3)
        }),
      }),
      { workspaceId: 'w1' },
    );
    expect(snap.capacity).toEqual({
      liveAgents: 3,
      cap: 15,
      workspaceLiveAgents: 2,
      workspaceCap: 8,
      headroom: 12,
    });
  });

  it('capacity is null when dep is absent', () => {
    // baseDeps has no capacity dep → should degrade to null, never throw
    const snap = buildAppState(baseDeps({}), { workspaceId: 'w1' });
    expect(snap.capacity).toBeNull();
  });

  it('capacity degrades to null when dep throws (never crashes the snapshot)', () => {
    const snap = buildAppState(
      baseDeps({
        capacity: () => { throw new Error('db down'); },
      }),
      { workspaceId: 'w1' },
    );
    expect(snap.capacity).toBeNull();
  });

  // Task 4 — pendingEscalations block.
  it('pendingEscalations is [] when dep is absent', () => {
    const snap = buildAppState(baseDeps({}), { workspaceId: 'w1' });
    expect(snap.pendingEscalations).toEqual([]);
  });

  it('pendingEscalations lists entries from dep', () => {
    const snap = buildAppState(
      baseDeps({
        pendingEscalations: () => [
          { id: 'esc-1', toolName: 'close_pane', summary: 's', requestedAt: 999 },
        ],
      }),
      { workspaceId: 'w1' },
    );
    expect(snap.pendingEscalations).toHaveLength(1);
    expect(snap.pendingEscalations[0].id).toBe('esc-1');
    expect(snap.pendingEscalations[0].tool).toBe('close_pane');
  });

  it('pendingEscalations degrades to [] when dep throws', () => {
    const snap = buildAppState(
      baseDeps({
        pendingEscalations: () => { throw new Error('boom'); },
      }),
      { workspaceId: 'w1' },
    );
    expect(snap.pendingEscalations).toEqual([]);
  });

  // Task 5 — authError per-session block.
  it('authError is null for all sessions when authErrors dep is absent', () => {
    const snap = buildAppState(baseDeps({}), { workspaceId: 'w1' });
    for (const s of snap.panes.sessions) {
      expect(s.authError).toBeNull();
    }
  });

  it('authError is populated from the dep for the matching session', () => {
    const snap = buildAppState(
      baseDeps({
        authErrors: () => new Map([['s2', { kind: 'token_expired', atMs: 9999 }]]),
      }),
      { workspaceId: 'w1' },
    );
    const s1 = snap.panes.sessions.find((s) => s.sessionId === 's1')!;
    const s2 = snap.panes.sessions.find((s) => s.sessionId === 's2')!;
    expect(s1.authError).toBeNull(); // no entry for s1
    expect(s2.authError).toEqual({ kind: 'token_expired', atMs: 9999 });
  });

  it('authError degrades to null for all sessions when dep throws', () => {
    const snap = buildAppState(
      baseDeps({
        authErrors: () => { throw new Error('registry down'); },
      }),
      { workspaceId: 'w1' },
    );
    for (const s of snap.panes.sessions) {
      expect(s.authError).toBeNull();
    }
  });
});
