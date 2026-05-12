import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/rpc', () => ({
  rpc: {},
}));

import {
  appStateReducer,
  initialAppState,
  selectActiveWorkspace,
  type AppState,
} from './state';
import type { AgentSession, Swarm, Workspace } from '../../shared/types';

function workspace(id: string, lastOpenedAt = 1): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt,
  };
}

function readyState(workspaces: Workspace[]): AppState {
  return appStateReducer(initialAppState, { type: 'READY', workspaces });
}

function session(id: string, workspaceId: string): AgentSession {
  return {
    id,
    workspaceId,
    providerId: 'claude',
    cwd: `/tmp/${workspaceId}`,
    branch: null,
    status: 'running',
    startedAt: 1,
    worktreePath: null,
  };
}

function swarm(id: string, workspaceId: string): Swarm {
  return {
    id,
    workspaceId,
    name: `Swarm ${id}`,
    mission: 'test',
    preset: 'custom',
    status: 'running',
    createdAt: 1,
    endedAt: null,
    agents: [],
  };
}

describe('appStateReducer multi-workspace state', () => {
  it('opens workspaces and derives activeWorkspace from activeWorkspaceId', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');

    const openedA = appStateReducer(readyState([wsA, wsB]), {
      type: 'WORKSPACE_OPEN',
      workspace: wsA,
    });
    const openedB = appStateReducer(openedA, { type: 'WORKSPACE_OPEN', workspace: wsB });

    expect(openedB.openWorkspaces.map((w) => w.id)).toEqual(['b', 'a']);
    expect(openedB.activeWorkspaceId).toBe('b');
    expect(selectActiveWorkspace(openedB)).toEqual(wsB);
    expect(openedB.activeWorkspace).toEqual(wsB);
  });

  it('sets active workspace by id without dropping other open workspaces', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const state = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );

    const selected = appStateReducer(state, {
      type: 'SET_ACTIVE_WORKSPACE_ID',
      workspaceId: 'a',
    });

    expect(selected.activeWorkspaceId).toBe('a');
    expect(selected.activeWorkspace).toEqual(wsA);
    expect(selected.openWorkspaces.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('falls back to the most-recent remaining workspace when closing active', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const wsC = workspace('c');
    const opened = [wsA, wsB, wsC].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB, wsC]),
    );

    const closed = appStateReducer(opened, { type: 'WORKSPACE_CLOSE', workspaceId: 'c' });

    expect(closed.openWorkspaces.map((w) => w.id)).toEqual(['b', 'a']);
    expect(closed.activeWorkspaceId).toBe('b');
    expect(closed.activeWorkspace).toEqual(wsB);
  });

  it('keeps the existing active workspace when closing a background workspace', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const opened = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );

    const closed = appStateReducer(opened, { type: 'WORKSPACE_CLOSE', workspaceId: 'a' });

    expect(closed.openWorkspaces.map((w) => w.id)).toEqual(['b']);
    expect(closed.activeWorkspaceId).toBe('b');
    expect(closed.activeWorkspace).toEqual(wsB);
  });

  it('maintains sessionsByWorkspace when sessions change', () => {
    const state = appStateReducer(readyState([workspace('a'), workspace('b')]), {
      type: 'ADD_SESSIONS',
      sessions: [session('s1', 'a'), session('s2', 'b'), session('s3', 'a')],
    });

    expect(state.sessionsByWorkspace.a.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(state.sessionsByWorkspace.b.map((s) => s.id)).toEqual(['s2']);

    const exited = appStateReducer(state, { type: 'MARK_SESSION_EXITED', id: 's1', exitCode: 0 });
    expect(exited.sessionsByWorkspace.a[0]?.status).toBe('exited');

    const removed = appStateReducer(exited, { type: 'REMOVE_SESSION', id: 's3' });
    expect(removed.sessionsByWorkspace.a.map((s) => s.id)).toEqual(['s1']);
  });

  it('maintains swarmsByWorkspace when swarms change', () => {
    const state = appStateReducer(readyState([workspace('a'), workspace('b')]), {
      type: 'SET_SWARMS',
      swarms: [swarm('sw1', 'a'), swarm('sw2', 'b')],
    });

    expect(state.swarmsByWorkspace.a.map((s) => s.id)).toEqual(['sw1']);
    expect(state.swarmsByWorkspace.b.map((s) => s.id)).toEqual(['sw2']);

    const upserted = appStateReducer(state, {
      type: 'UPSERT_SWARM',
      swarm: swarm('sw3', 'a'),
    });
    expect(upserted.swarmsByWorkspace.a.map((s) => s.id)).toEqual(['sw3', 'sw1']);

    const ended = appStateReducer(upserted, { type: 'MARK_SWARM_ENDED', id: 'sw3' });
    expect(ended.swarmsByWorkspace.a[0]?.status).toBe('completed');
  });
});
