// N1 — unit tests for the pure mode-aware step derivation (modes.ts).
//
// These pin the contract the Launcher relies on: only the SigmaLink grid mode
// ('space') shows Layout → Agents → Sessions; every other mode is intent →
// launch (Start only). 'single' pins the pane budget to one.

import { describe, expect, it } from 'vitest';
import {
  fixedPaneCountForMode,
  nextStepForMode,
  prevStepForMode,
  stepAfterStart,
  stepsForMode,
} from './modes';

describe('stepsForMode', () => {
  it('grid mode shows the full four-step sequence', () => {
    expect(stepsForMode('space')).toEqual(['intent', 'start', 'layout', 'agents', 'sessions']);
  });

  it('single / swarm / canvas show only the Start step', () => {
    expect(stepsForMode('single')).toEqual(['intent', 'start']);
    expect(stepsForMode('swarm')).toEqual(['intent', 'start']);
    expect(stepsForMode('canvas')).toEqual(['intent', 'start']);
  });
});

describe('nextStepForMode / prevStepForMode', () => {
  it('walks the grid sequence forward', () => {
    expect(nextStepForMode('space', 'start')).toBe('layout');
    expect(nextStepForMode('space', 'layout')).toBe('agents');
    expect(nextStepForMode('space', 'agents')).toBe('sessions');
    expect(nextStepForMode('space', 'sessions')).toBeNull();
  });

  it('walks the grid sequence backward', () => {
    expect(prevStepForMode('space', 'sessions')).toBe('agents');
    expect(prevStepForMode('space', 'agents')).toBe('layout');
    expect(prevStepForMode('space', 'layout')).toBe('start');
    expect(prevStepForMode('space', 'start')).toBe('intent');
  });

  it('non-grid modes have no next/prev beyond Start', () => {
    expect(nextStepForMode('single', 'start')).toBeNull();
    expect(prevStepForMode('single', 'start')).toBe('intent');
    expect(nextStepForMode('swarm', 'start')).toBeNull();
  });

  it('returns null for a step that is not visible in the mode', () => {
    // 'layout' is not part of the single-mode step list.
    expect(nextStepForMode('single', 'layout')).toBeNull();
    expect(prevStepForMode('single', 'layout')).toBeNull();
  });
});

describe('stepAfterStart', () => {
  it('grid advances to Layout; other modes stay on Start', () => {
    expect(stepAfterStart('space')).toBe('layout');
    expect(stepAfterStart('single')).toBe('start');
    expect(stepAfterStart('swarm')).toBe('start');
    expect(stepAfterStart('canvas')).toBe('start');
  });
});

describe('intent landing step (minimal-chrome)', () => {
  it('prepends intent to every mode', () => {
    expect(stepsForMode('space')).toEqual(['intent', 'start', 'layout', 'agents', 'sessions']);
    expect(stepsForMode('single')).toEqual(['intent', 'start']);
    expect(stepsForMode('swarm')).toEqual(['intent', 'start']);
    expect(stepsForMode('canvas')).toEqual(['intent', 'start']);
  });
  it('navigates start ↔ intent', () => {
    expect(prevStepForMode('space', 'start')).toBe('intent');
    expect(nextStepForMode('swarm', 'intent')).toBe('start');
    expect(prevStepForMode('space', 'intent')).toBeNull();
  });
  it('stepAfterStart is unchanged', () => {
    expect(stepAfterStart('space')).toBe('layout');
    expect(stepAfterStart('single')).toBe('start');
  });
});

describe('fixedPaneCountForMode', () => {
  it('single mode pins one pane; others do not pin', () => {
    expect(fixedPaneCountForMode('single')).toBe(1);
    expect(fixedPaneCountForMode('space')).toBeNull();
    expect(fixedPaneCountForMode('swarm')).toBeNull();
    expect(fixedPaneCountForMode('canvas')).toBeNull();
  });
});
