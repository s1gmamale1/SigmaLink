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
});
