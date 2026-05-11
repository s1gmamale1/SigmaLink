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
import type { Workspace } from '../../shared/types';

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
});
