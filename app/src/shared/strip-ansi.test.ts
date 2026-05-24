import { describe, it, expect } from 'vitest';
import { stripAnsi, compactScrollback } from './strip-ansi';
describe('strip-ansi', () => {
  it('strips CSI + OSC sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok')).toBe('red ok');
  });
  it('compactScrollback keeps the tail and marks truncation', () => {
    const out = compactScrollback('A'.repeat(50) + 'TAIL', 10);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('[…truncated…]');
  });
  it('compactScrollback leaves short input untouched', () => {
    expect(compactScrollback('hi', 100)).toBe('hi');
  });
});
