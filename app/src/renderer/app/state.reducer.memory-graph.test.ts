// BSP-O5 — unit tests for the SET_PENDING_MEMORY_GRAPH_VIEW reducer action.
//
// Mirrors the pendingSettingsTab / SET_SETTINGS_TAB wiring as the closest
// prior example: the action is a one-shot signal, set to `true` by the
// dispatcher and cleared to `undefined` by the consumer (MemoryRoom) after
// it switches to the graph tab. No React, no DOM.

import { describe, it, expect } from 'vitest';
import { appStateReducer } from './state.reducer';
import { initialAppState } from './state.types';

describe('BSP-O5 — SET_PENDING_MEMORY_GRAPH_VIEW', () => {
  it('initialAppState has pendingMemoryGraphView undefined', () => {
    expect(initialAppState.pendingMemoryGraphView).toBeUndefined();
  });

  it('sets pendingMemoryGraphView to true', () => {
    const after = appStateReducer(initialAppState, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: true,
    });
    expect(after.pendingMemoryGraphView).toBe(true);
  });

  it('clears pendingMemoryGraphView to undefined', () => {
    const with_pending = appStateReducer(initialAppState, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: true,
    });
    const cleared = appStateReducer(with_pending, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: undefined,
    });
    expect(cleared.pendingMemoryGraphView).toBeUndefined();
  });

  it('is a no-op when the value is already identical (preserves state reference)', () => {
    // Setting true twice → second dispatch returns the same object reference.
    const after1 = appStateReducer(initialAppState, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: true,
    });
    const after2 = appStateReducer(after1, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: true,
    });
    expect(after2).toBe(after1);
  });

  it('no-op when clearing an already-undefined signal', () => {
    const after = appStateReducer(initialAppState, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: undefined,
    });
    expect(after).toBe(initialAppState);
  });

  it('does not mutate pendingRufloView or pendingSettingsTab', () => {
    const after = appStateReducer(initialAppState, {
      type: 'SET_PENDING_MEMORY_GRAPH_VIEW',
      pending: true,
    });
    expect(after.pendingRufloView).toBe(initialAppState.pendingRufloView);
    expect(after.pendingSettingsTab).toBe(initialAppState.pendingSettingsTab);
  });
});
