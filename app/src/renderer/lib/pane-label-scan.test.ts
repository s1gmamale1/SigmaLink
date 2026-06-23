import { describe, expect, it } from 'vitest';
import { extractLabel } from './pane-label-scan';

describe('extractLabel', () => {
  it('matches a plain sentinel line', () => {
    expect(extractLabel(['SIGMA::LABEL Async token refresh refactor'])).toBe(
      'Async token refresh refactor',
    );
  });
  it('matches with a leading bullet + indent (TUI render)', () => {
    expect(extractLabel(['  ⏺ SIGMA::LABEL Reviewing auth'])).toBe('Reviewing auth');
  });
  it('collapses cursor-gap multiple spaces', () => {
    expect(extractLabel(['SIGMA::LABEL   say   hello'])).toBe('say hello');
  });
  it('returns the LAST match (freshest task)', () => {
    expect(
      extractLabel(['SIGMA::LABEL First task', 'noise', 'SIGMA::LABEL Second task']),
    ).toBe('Second task');
  });
  it('does NOT match a mid-prose mention', () => {
    expect(extractLabel(['the agent prints a SIGMA::LABEL foo line here'])).toBeNull();
  });
  it('returns null when no line qualifies', () => {
    expect(extractLabel(['just terminal output', ''])).toBeNull();
  });
  it('ignores an empty payload', () => {
    expect(extractLabel(['SIGMA::LABEL    '])).toBeNull();
  });
});
