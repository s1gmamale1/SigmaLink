// Unit tests for the v1.1.4 Step 2 rooms-menu button. We intentionally avoid
// pulling in @testing-library/react + jsdom (neither installed) and instead
// validate behaviour through three independent angles:
//
//   1. The exported `ROOMS_MENU_ITEMS` array (data contract, drift-proofs the
//      list vs. the legacy sidebar `ITEMS`).
//   2. The exported `isRoomDisabled` predicate (the only piece of business
//      logic the component owns beyond wiring).
//   3. A reducer-level integration check: feeding `SET_ROOM { room: 'swarm' }`
//      into `appStateReducer` produces the state transition we expect from a
//      click on the "Swarm Room" entry.
//
// This keeps the test fast, deterministic, and free of DOM dependencies while
// still asserting the contract callers (the lead, the parallel coder editing
// Sidebar.tsx) rely on.

import { describe, expect, it, vi } from 'vitest';

// state.tsx imports the renderer's `rpc` module which would try to talk to a
// real preload bridge under vitest's node environment. Mock it before the
// state module loads.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {},
}));

import {
  ROOMS_MENU_ITEMS,
  isRoomDisabled,
} from './rooms-menu-items';
import {
  appStateReducer,
  initialAppState,
  type RoomId,
} from '@/renderer/app/state';

describe('ROOMS_MENU_ITEMS', () => {
  it('exposes the 11-room sidebar inventory verbatim', () => {
    const ids: RoomId[] = ROOMS_MENU_ITEMS.map((item) => item.id);
    // Order matches Sidebar.tsx ITEMS so the two surfaces never drift.
    expect(ids).toEqual([
      'workspaces',
      'command',
      'swarm',
      'operator',
      'review',
      'tasks',
      'memory',
      'browser',
      'skills',
      'bridge',
      'settings',
    ]);
  });

  it('gives every entry a non-empty label and a renderable icon', () => {
    for (const item of ROOMS_MENU_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      // lucide icons are functional components; `typeof` is 'function' or
      // 'object' depending on the build target. We only assert "truthy".
      expect(item.icon).toBeTruthy();
    }
  });

  it('contains no duplicate room ids', () => {
    const seen = new Set<RoomId>();
    for (const item of ROOMS_MENU_ITEMS) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    expect(seen.size).toBe(ROOMS_MENU_ITEMS.length);
  });
});

describe('isRoomDisabled', () => {
  // When a workspace is open every room must be reachable. That's the lever
  // the breadcrumb relies on to swap rooms inside the active workspace.
  it('enables every room when a workspace is active', () => {
    for (const item of ROOMS_MENU_ITEMS) {
      expect(isRoomDisabled(item.id, true)).toBe(false);
    }
  });

  // Mirror of Sidebar.tsx line ~186: Workspaces / Settings / Skills / Bridge
  // remain reachable so the user can recover from a "no workspace" state.
  it('keeps Workspaces / Settings / Skills / Bridge enabled with no workspace', () => {
    const alwaysEnabled: RoomId[] = ['workspaces', 'settings', 'skills', 'bridge'];
    for (const id of alwaysEnabled) {
      expect(isRoomDisabled(id, false)).toBe(false);
    }
  });

  it('disables every other room when no workspace is active', () => {
    const alwaysEnabled = new Set<RoomId>(['workspaces', 'settings', 'skills', 'bridge']);
    for (const item of ROOMS_MENU_ITEMS) {
      if (alwaysEnabled.has(item.id)) continue;
      expect(isRoomDisabled(item.id, false)).toBe(true);
    }
  });
});

describe('selecting a room dispatches SET_ROOM', () => {
  // The button's onSelect handler runs `dispatch({ type: 'SET_ROOM', room })`.
  // Feeding the same action through the reducer is the cleanest way to assert
  // that selecting "Swarm Room" actually transitions `state.room` to 'swarm'.
  it('selecting Swarm Room transitions state.room to "swarm"', () => {
    const next = appStateReducer(initialAppState, { type: 'SET_ROOM', room: 'swarm' });
    expect(next.room).toBe('swarm');
  });

  it('every listed room is a valid SET_ROOM target', () => {
    for (const item of ROOMS_MENU_ITEMS) {
      const next = appStateReducer(initialAppState, { type: 'SET_ROOM', room: item.id });
      expect(next.room).toBe(item.id);
    }
  });
});
