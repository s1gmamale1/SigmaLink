import { describe, it, expect } from 'vitest';
import { isLegalTaskTransition, rollupMissionStatus } from './state';

describe('isLegalTaskTransition', () => {
  it('allows the forward lifecycle', () => {
    expect(isLegalTaskTransition('backlog', 'dispatched')).toBe(true);
    expect(isLegalTaskTransition('dispatched', 'working')).toBe(true);
    expect(isLegalTaskTransition('working', 'reviewing')).toBe(true);
    expect(isLegalTaskTransition('reviewing', 'done')).toBe(true);
    expect(isLegalTaskTransition('reviewing', 'working')).toBe(true); // advance re-prompt
    expect(isLegalTaskTransition('working', 'blocked')).toBe(true);
    expect(isLegalTaskTransition('working', 'needs_input')).toBe(true);
    expect(isLegalTaskTransition('needs_input', 'working')).toBe(true);
    expect(isLegalTaskTransition('blocked', 'dispatched')).toBe(true); // retry a blocked task
  });
  it('rejects illegal jumps', () => {
    expect(isLegalTaskTransition('backlog', 'done')).toBe(false);
    expect(isLegalTaskTransition('done', 'working')).toBe(false); // done is terminal
    expect(isLegalTaskTransition('backlog', 'reviewing')).toBe(false);
  });
  it('a status can stay itself (idempotent update)', () => {
    expect(isLegalTaskTransition('working', 'working')).toBe(true);
  });
});

describe('rollupMissionStatus', () => {
  it('promotes active → done only when every task is done', () => {
    expect(rollupMissionStatus(['done', 'done'], 'active')).toBe('done');
    expect(rollupMissionStatus(['done', 'working'], 'active')).toBe('active');
    expect(rollupMissionStatus(['done', 'blocked'], 'active')).toBe('active');
  });
  it('never auto-fails, auto-pauses, or touches a terminal mission', () => {
    expect(rollupMissionStatus(['blocked'], 'active')).toBe('active');
    expect(rollupMissionStatus([], 'active')).toBe('active');
    expect(rollupMissionStatus(['done'], 'cancelled')).toBe('cancelled');
    expect(rollupMissionStatus(['done'], 'failed')).toBe('failed');
  });
});
