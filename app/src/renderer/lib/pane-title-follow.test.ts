import { afterEach, describe, expect, it } from 'vitest';
import { __resetTitleFollow, setTitleFollow, shouldFollowTitle } from './pane-title-follow';

afterEach(() => __resetTitleFollow());

describe('pane-title-follow', () => {
  it('defaults to FOLLOW when never called (providerId unresolved)', () => {
    expect(shouldFollowTitle('never-seen')).toBe(true);
  });

  it('disable → shouldFollowTitle false', () => {
    setTitleFollow('s1', false);
    expect(shouldFollowTitle('s1')).toBe(false);
  });

  it('re-enable → true', () => {
    setTitleFollow('s2', false);
    setTitleFollow('s2', true);
    expect(shouldFollowTitle('s2')).toBe(true);
  });

  it('enable on an unknown session keeps the default (FOLLOW)', () => {
    setTitleFollow('s3', true);
    expect(shouldFollowTitle('s3')).toBe(true);
  });

  it('per-session isolation', () => {
    setTitleFollow('shell-pane', false);
    expect(shouldFollowTitle('shell-pane')).toBe(false);
    expect(shouldFollowTitle('agent-pane')).toBe(true);
  });

  it('__resetTitleFollow restores the default', () => {
    setTitleFollow('s4', false);
    __resetTitleFollow();
    expect(shouldFollowTitle('s4')).toBe(true);
  });
});
