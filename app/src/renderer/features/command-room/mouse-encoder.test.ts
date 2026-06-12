import { describe, expect, it } from 'vitest';
import { encodeSgrMouse, shouldReportMouse } from './mouse-encoder';

const NOMOD = { shift: false, alt: false, ctrl: false };

describe('encodeSgrMouse', () => {
  it('press/release/motion grammar', () => {
    expect(encodeSgrMouse('press', 0, 5, 3, NOMOD)).toBe('\x1b[<0;5;3M');
    expect(encodeSgrMouse('release', 0, 5, 3, NOMOD)).toBe('\x1b[<0;5;3m');
    expect(encodeSgrMouse('motion', 0, 6, 3, NOMOD)).toBe('\x1b[<32;6;3M');
    expect(encodeSgrMouse('press', 2, 1, 1, NOMOD)).toBe('\x1b[<2;1;1M'); // right
  });
  it('modifier bits: shift 4, alt 8, ctrl 16', () => {
    expect(encodeSgrMouse('press', 0, 1, 1, { shift: true, alt: false, ctrl: false })).toBe('\x1b[<4;1;1M');
    expect(encodeSgrMouse('press', 1, 1, 1, { shift: false, alt: true, ctrl: true })).toBe('\x1b[<25;1;1M');
  });
  it('wheel buttons pass through (64 up / 65 down)', () => {
    expect(encodeSgrMouse('press', 64, 9, 2, NOMOD)).toBe('\x1b[<64;9;2M');
  });
});

describe('shouldReportMouse', () => {
  it('x10: press only', () => {
    expect(shouldReportMouse('x10', 'press', false)).toBe(true);
    expect(shouldReportMouse('x10', 'release', false)).toBe(false);
    expect(shouldReportMouse('x10', 'motion', true)).toBe(false);
  });
  it('vt200: press+release, no motion', () => {
    expect(shouldReportMouse('vt200', 'release', false)).toBe(true);
    expect(shouldReportMouse('vt200', 'motion', true)).toBe(false);
  });
  it('drag: motion only while a button is held; any: all motion', () => {
    expect(shouldReportMouse('drag', 'motion', true)).toBe(true);
    expect(shouldReportMouse('drag', 'motion', false)).toBe(false);
    expect(shouldReportMouse('any', 'motion', false)).toBe(true);
  });
  it('none: never', () => {
    expect(shouldReportMouse('none', 'press', false)).toBe(false);
  });
});
