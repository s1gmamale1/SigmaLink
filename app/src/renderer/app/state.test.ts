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

  it('switches active workspace without mutating session state', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    let state = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    state = appStateReducer(state, {
      type: 'ADD_SESSIONS',
      sessions: [session('s1', 'a'), session('s2', 'b')],
    });
    state = appStateReducer(state, { type: 'SET_ACTIVE_SESSION', id: 's2' });

    const selected = appStateReducer(state, {
      type: 'SET_ACTIVE_WORKSPACE_ID',
      workspaceId: 'a',
    });

    expect(selected.sessions).toEqual(state.sessions);
    expect(selected.sessionsByWorkspace).toEqual(state.sessionsByWorkspace);
    expect(selected.activeSessionId).toBe('s2');
  });

  it('switches active workspace without closing background swarms', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    let state = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    state = appStateReducer(state, {
      type: 'SET_SWARMS',
      swarms: [swarm('sw-a', 'a'), swarm('sw-b', 'b')],
    });

    const selected = appStateReducer(state, {
      type: 'SET_ACTIVE_WORKSPACE_ID',
      workspaceId: 'a',
    });

    expect(selected.swarms).toEqual(state.swarms);
    expect(selected.swarmsByWorkspace).toEqual(state.swarmsByWorkspace);
    expect(selected.activeWorkspaceId).toBe('a');
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

// v1.1.10 — fixes from the warning-level audit pass:
// - Fix 1: per-workspace room state lost on snapshot.
// - Fix 2: SET_ACTIVE_WORKSPACE_ID silently ignores unknown IDs (now warns).
// - Fix 3: REMOVE_SESSION fallback picks live session first.
// - Fix 4: UPSERT_SWARM does not override intentional deselection.
describe('appStateReducer v1.1.10 reliability fixes', () => {
  it('Fix 1: SET_ROOM stamps roomByWorkspace under the active workspace', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const opened = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    // wsB is active after the second open. Switch its room.
    const swarm = appStateReducer(opened, { type: 'SET_ROOM', room: 'swarm' });
    expect(swarm.room).toBe('swarm');
    expect(swarm.roomByWorkspace.b).toBe('swarm');
    expect(swarm.roomByWorkspace.a).toBeUndefined();

    // Switch to A and set a different room.
    const activeA = appStateReducer(swarm, { type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'a' });
    const command = appStateReducer(activeA, { type: 'SET_ROOM', room: 'command' });
    expect(command.roomByWorkspace.a).toBe('command');
    expect(command.roomByWorkspace.b).toBe('swarm');
  });

  it('Fix 1: SET_ROOM_FOR_WORKSPACE seeds entries without touching state.room', () => {
    const wsA = workspace('a');
    const state = appStateReducer(readyState([wsA]), { type: 'WORKSPACE_OPEN', workspace: wsA });
    expect(state.room).toBe('workspaces');
    const seeded = appStateReducer(state, {
      type: 'SET_ROOM_FOR_WORKSPACE',
      workspaceId: 'a',
      room: 'memory',
    });
    expect(seeded.roomByWorkspace.a).toBe('memory');
    expect(seeded.room).toBe('workspaces'); // unchanged
  });

  it('Fix 1: WORKSPACE_CLOSE drops the closed workspace from roomByWorkspace', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const opened = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    const withRooms = appStateReducer(
      appStateReducer(opened, { type: 'SET_ROOM_FOR_WORKSPACE', workspaceId: 'a', room: 'command' }),
      { type: 'SET_ROOM_FOR_WORKSPACE', workspaceId: 'b', room: 'swarm' },
    );
    expect(withRooms.roomByWorkspace).toEqual({ a: 'command', b: 'swarm' });
    const closedB = appStateReducer(withRooms, { type: 'WORKSPACE_CLOSE', workspaceId: 'b' });
    expect(closedB.roomByWorkspace).toEqual({ a: 'command' });
  });

  it('Fix 1: snapshot path remembers different rooms per workspace', () => {
    // Simulates the full snapshot scenario: workspace A is in `command`, B is
    // in `swarm`. Pre-v1.1.10 the snapshot writer used a single global room
    // for both entries; the reducer now preserves them independently so the
    // serialiser can read state.roomByWorkspace directly.
    const wsA = workspace('a');
    const wsB = workspace('b');
    const base = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    // Active is B (most recently opened).
    const bSwarm = appStateReducer(base, { type: 'SET_ROOM', room: 'swarm' });
    const activeA = appStateReducer(bSwarm, { type: 'SET_ACTIVE_WORKSPACE_ID', workspaceId: 'a' });
    const aCommand = appStateReducer(activeA, { type: 'SET_ROOM', room: 'command' });

    expect(aCommand.roomByWorkspace).toEqual({ a: 'command', b: 'swarm' });
    // Simulate the snapshot writer mapping over openWorkspaces.
    const entries = aCommand.openWorkspaces.map((w) => ({
      workspaceId: w.id,
      room: aCommand.roomByWorkspace[w.id] ?? aCommand.room,
    }));
    const rooms = Object.fromEntries(entries.map((e) => [e.workspaceId, e.room]));
    expect(rooms).toEqual({ a: 'command', b: 'swarm' });
  });

  it('Fix 2: SET_ACTIVE_WORKSPACE_ID warns on unknown id without mutating state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const wsA = workspace('a');
      const opened = appStateReducer(readyState([wsA]), {
        type: 'WORKSPACE_OPEN',
        workspace: wsA,
      });
      const result = appStateReducer(opened, {
        type: 'SET_ACTIVE_WORKSPACE_ID',
        workspaceId: 'ghost',
      });
      expect(result).toBe(opened); // strict identity — no churn
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('SET_ACTIVE_WORKSPACE_ID'),
        'ghost',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('Fix 3: REMOVE_SESSION prefers a live session over exited ones', () => {
    const wsA = workspace('a');
    let s = readyState([wsA]);
    s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
    s = appStateReducer(s, {
      type: 'ADD_SESSIONS',
      sessions: [session('exited1', 'a'), session('live1', 'a'), session('exited2', 'a')],
    });
    // Mark the two exited.
    s = appStateReducer(s, { type: 'MARK_SESSION_EXITED', id: 'exited1', exitCode: 1 });
    s = appStateReducer(s, { type: 'MARK_SESSION_EXITED', id: 'exited2', exitCode: 1 });
    // Make the live session active, then remove it. The fallback should
    // prefer running > exited even if exited comes first in the array.
    s = appStateReducer(s, { type: 'SET_ACTIVE_SESSION', id: 'live1' });
    const removed = appStateReducer(s, { type: 'REMOVE_SESSION', id: 'live1' });
    // No live session left — fall back to first remaining (exited).
    expect(removed.activeSessionId).toBe('exited1');
  });

  it('Fix 3: REMOVE_SESSION picks a live session when available', () => {
    const wsA = workspace('a');
    let s = readyState([wsA]);
    s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
    s = appStateReducer(s, {
      type: 'ADD_SESSIONS',
      sessions: [session('exited1', 'a'), session('live1', 'a'), session('live2', 'a')],
    });
    s = appStateReducer(s, { type: 'MARK_SESSION_EXITED', id: 'exited1', exitCode: 1 });
    s = appStateReducer(s, { type: 'SET_ACTIVE_SESSION', id: 'live1' });
    const removed = appStateReducer(s, { type: 'REMOVE_SESSION', id: 'live1' });
    // exited1 sits at index 0, live2 at index 2 — fallback must skip the
    // exited one and pick the running session.
    expect(removed.activeSessionId).toBe('live2');
  });

  it('Fix 4: UPSERT_SWARM does not auto-activate when other swarms exist in the workspace', () => {
    let s = readyState([workspace('a'), workspace('b')]);
    s = appStateReducer(s, { type: 'SET_SWARMS', swarms: [swarm('sw1', 'a')] });
    expect(s.activeSwarmId).toBe('sw1');
    // User intentionally clears active swarm.
    s = appStateReducer(s, { type: 'SET_ACTIVE_SWARM', id: null });
    expect(s.activeSwarmId).toBeNull();
    // A second swarm is upserted (e.g. swarm:message updates sw1's roster).
    s = appStateReducer(s, { type: 'UPSERT_SWARM', swarm: swarm('sw2', 'a') });
    // Pre-v1.1.10 this would re-set activeSwarmId to 'sw2'.
    expect(s.activeSwarmId).toBeNull();
  });

  it('Fix 4: UPSERT_SWARM auto-activates the FIRST swarm in a workspace', () => {
    let s = readyState([workspace('a')]);
    expect(s.activeSwarmId).toBeNull();
    // First swarm ever — auto-activate is still expected.
    s = appStateReducer(s, { type: 'UPSERT_SWARM', swarm: swarm('sw1', 'a') });
    expect(s.activeSwarmId).toBe('sw1');
    // Re-upserting the same swarm (e.g. status change) keeps active.
    s = appStateReducer(s, { type: 'UPSERT_SWARM', swarm: swarm('sw1', 'a') });
    expect(s.activeSwarmId).toBe('sw1');
  });

  it('v1.4.2: SET_ACTIVE_WORKSPACE_ID after Settings visit routes to Command Room', () => {
    const wsA = workspace('a');
    const opened = appStateReducer(readyState([wsA]), {
      type: 'WORKSPACE_OPEN',
      workspace: wsA,
    });
    // User visits Settings from workspace A.
    const settings = appStateReducer(opened, { type: 'SET_ROOM', room: 'settings' });
    expect(settings.room).toBe('settings');
    // 'settings' must NOT be persisted into roomByWorkspace.
    expect(settings.roomByWorkspace.a).toBeUndefined();

    // Click the same workspace row in the sidebar → should land on Command Room.
    const back = appStateReducer(settings, {
      type: 'SET_ACTIVE_WORKSPACE_ID',
      workspaceId: 'a',
    });
    expect(back.room).toBe('command');
    expect(back.roomByWorkspace.a).toBeUndefined();
  });

  it('v1.4.2: SET_ROOM does not persist global rooms (workspaces, settings)', () => {
    const wsA = workspace('a');
    const wsB = workspace('b');
    const opened = [wsA, wsB].reduce(
      (next, ws) => appStateReducer(next, { type: 'WORKSPACE_OPEN', workspace: ws }),
      readyState([wsA, wsB]),
    );
    // wsB is active.
    const toSettings = appStateReducer(opened, { type: 'SET_ROOM', room: 'settings' });
    expect(toSettings.room).toBe('settings');
    expect(toSettings.roomByWorkspace.b).toBeUndefined();

    const toWorkspaces = appStateReducer(toSettings, { type: 'SET_ROOM', room: 'workspaces' });
    expect(toWorkspaces.room).toBe('workspaces');
    expect(toWorkspaces.roomByWorkspace.b).toBeUndefined();

    // Non-global rooms ARE persisted.
    const toMemory = appStateReducer(toWorkspaces, { type: 'SET_ROOM', room: 'memory' });
    expect(toMemory.room).toBe('memory');
    expect(toMemory.roomByWorkspace.b).toBe('memory');
  });
});
