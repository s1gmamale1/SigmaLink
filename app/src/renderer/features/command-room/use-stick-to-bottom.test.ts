import { describe, expect, it } from 'vitest';
import { computeStick, STICK_SLOP_PX } from './use-stick-to-bottom';

const base = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, lastTop: 0, wasSticking: true };

describe('computeStick', () => {
  it('follows when within slop of the bottom', () => {
    // distance = 1000 - 790 - 200 = 10 <= 24
    expect(computeStick({ ...base, scrollTop: 790, lastTop: 790 })).toBe(true);
  });

  it('detaches when the user scrolls UP beyond slop', () => {
    // distance = 1000 - 400 - 200 = 400 > 24, and scrollTop dropped 790 -> 400
    expect(computeStick({ ...base, scrollTop: 400, lastTop: 790, wasSticking: true })).toBe(false);
  });

  it('STAYS stuck when content grows (distance jumps) but the user did NOT scroll up', () => {
    // The "follows then stops" bug: scrollHeight grew so distance is large, but
    // scrollTop did not decrease -> must keep the prior sticking intent.
    expect(
      computeStick({ scrollTop: 800, scrollHeight: 2000, clientHeight: 200, lastTop: 800, wasSticking: true }),
    ).toBe(true);
  });

  it('re-engages once the user returns within slop', () => {
    expect(computeStick({ ...base, scrollTop: 800, lastTop: 400, wasSticking: false })).toBe(true);
  });

  it('stays detached while away from bottom and not returning to it', () => {
    expect(computeStick({ ...base, scrollTop: 300, lastTop: 300, wasSticking: false })).toBe(false);
  });

  it('exposes a generous default slop', () => {
    expect(STICK_SLOP_PX).toBe(24);
  });
});
