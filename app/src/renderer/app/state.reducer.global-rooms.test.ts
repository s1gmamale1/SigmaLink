// @vitest-environment node
//
// 2026-06-10 audit, finding 1 — GLOBAL_ROOMS anti-drift.
//
// Four sites must agree on "global rooms are never persisted per-workspace":
//   site 1: SET_ROOM               (state.reducer.ts — was already enforced)
//   site 2: SET_ROOM_FOR_WORKSPACE (state.reducer.ts — was already enforced)
//   site 3: WORKSPACE_OPEN seed    (state.reducer.ts — HAD DRIFTED to a
//           hand-rolled `state.room === 'workspaces'` check, leaking
//           'settings'/'automations' into roomByWorkspace)
//   site 4: snapshot fallbackRoom  (use-session-restore.ts — covered by
//           use-session-restore.snapshot.test.ts, same enumeration)
//
// Every test iterates GLOBAL_ROOMS itself, so adding a new global room to
// state.types.ts automatically extends coverage to all sites — drift between
// the list and any one site fails here, not in production.
//
// Pure reducer — no React, no DOM. (Split out of state.reducer.test.ts to
// keep that file under the 500-line cap; precedent:
// state.reducer.memory-graph.test.ts.)

import { describe, it, expect } from 'vitest';

import { appStateReducer } from './state.reducer';
import { GLOBAL_ROOMS, initialAppState, isGlobalRoom } from './state.types';
import type { Workspace } from '../../shared/types';

function workspace(id: string): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    rootPath: `/tmp/${id}`,
    repoRoot: `/tmp/${id}`,
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

describe('GLOBAL_ROOMS — membership + helper', () => {
  it('contains the three known global surfaces', () => {
    expect([...GLOBAL_ROOMS].sort()).toEqual(['automations', 'settings', 'workspaces']);
  });

  it('isGlobalRoom agrees with the list and rejects workspace rooms', () => {
    for (const room of GLOBAL_ROOMS) expect(isGlobalRoom(room)).toBe(true);
    expect(isGlobalRoom('command')).toBe(false);
    expect(isGlobalRoom('swarm')).toBe(false);
    expect(isGlobalRoom('memory')).toBe(false);
  });
});

describe('GLOBAL_ROOMS anti-drift — reducer sites 1–3', () => {
  const wsA = workspace('a');

  // ── site 1: SET_ROOM ───────────────────────────────────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 1 — SET_ROOM(%s) switches the room but never writes roomByWorkspace',
    (room) => {
      let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA }); // activates 'a'
      s = appStateReducer(s, { type: 'SET_ROOM', room: 'command' }); // seed a real room
      const before = s.roomByWorkspace;
      s = appStateReducer(s, { type: 'SET_ROOM', room });
      expect(s.room).toBe(room);
      expect(s.roomByWorkspace).toEqual(before); // entry for 'a' still 'command'
    },
  );

  // ── site 2: SET_ROOM_FOR_WORKSPACE ─────────────────────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 2 — SET_ROOM_FOR_WORKSPACE(%s) is a strict no-op (same state reference)',
    (room) => {
      const s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      const after = appStateReducer(s, {
        type: 'SET_ROOM_FOR_WORKSPACE',
        workspaceId: 'a',
        room,
      });
      expect(after).toBe(s);
    },
  );

  // ── site 3: WORKSPACE_OPEN seed (THE drifted site) ─────────────────────────
  it.each([...GLOBAL_ROOMS])(
    'site 3 — WORKSPACE_OPEN while the current room is %s does NOT seed roomByWorkspace',
    (room) => {
      // SET_ROOM with no active workspace sets `room` without touching the map.
      let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
      s = appStateReducer(s, { type: 'SET_ROOM', room });
      s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
      // Pre-fix this failed for 'settings' and 'automations': the seed guard
      // only checked `state.room === 'workspaces'`, so the global room leaked
      // into the per-workspace map → persisted → restored on next boot.
      expect(s.roomByWorkspace['a']).toBeUndefined();
    },
  );

  // Positive control — seeding must still work for real workspace rooms.
  it('site 3 control — WORKSPACE_OPEN while in command DOES seed roomByWorkspace', () => {
    let s = appStateReducer(initialAppState, { type: 'READY', workspaces: [wsA] });
    s = appStateReducer(s, { type: 'SET_ROOM', room: 'command' });
    s = appStateReducer(s, { type: 'WORKSPACE_OPEN', workspace: wsA });
    expect(s.roomByWorkspace['a']).toBe('command');
  });
});
