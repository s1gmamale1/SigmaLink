import { describe, expect, it } from 'vitest';
import {
  measureCellW,
  measureLineH,
  proposeGrid,
  PAD_X,
  PROBE_LEN,
  SCROLLBAR_W,
} from './pane-metrics';

describe('pane-metrics', () => {
  describe('proposeGrid', () => {
    it('reserves FlowView padding AND the vertical scrollbar so cols never overcounts', () => {
      // The "inline break" bug: cols was measured from the outer container minus
      // only the 12px padding, but the text renders inside FlowView whose 6px
      // (layout-taking, because ::-webkit-scrollbar is styled in src/index.css)
      // scrollbar eats width. Naive math → 98 cols; reserving the scrollbar → 97,
      // so a full child-wrapped line still fits the real text box (no pre-wrap
      // stranding of the trailing word).
      const naive = Math.floor((720 - PAD_X * 2) / 7.2); // 98 (the buggy count)
      const { cols } = proposeGrid(720, 400, 7.2, 17);
      expect(cols).toBe(Math.floor((720 - PAD_X * 2 - SCROLLBAR_W) / 7.2)); // 97
      expect(cols).toBeLessThan(naive);
    });

    it('derives rows from height / lineH', () => {
      expect(proposeGrid(720, 408, 7.2, 17).rows).toBe(24);
    });

    it('clamps to a minimum 2x1 grid for degenerate sizes', () => {
      expect(proposeGrid(1, 1, 7.2, 17)).toEqual({ cols: 2, rows: 1 });
    });
  });

  describe('measureCellW', () => {
    it('uses sub-pixel getBoundingClientRect width, NOT the integer offsetWidth', () => {
      // A 10-char probe spanning 73.6px → 7.36px/cell. offsetWidth would round to
      // 74 → 7.4 and overcount cols over ~100 columns → strand the last word.
      const probe = {
        getBoundingClientRect: () => ({ width: 73.6, height: 16.8 }),
      } as unknown as HTMLElement;
      expect(measureCellW(probe)).toBeCloseTo(73.6 / PROBE_LEN, 5);
    });

    it('falls back to 7.2 when the probe has not measured (jsdom / unmounted)', () => {
      expect(measureCellW(null)).toBe(7.2);
      const zero = {
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
      } as unknown as HTMLElement;
      expect(measureCellW(zero)).toBe(7.2);
    });
  });

  describe('measureLineH', () => {
    it('uses the probe height, falling back to 17', () => {
      const probe = {
        getBoundingClientRect: () => ({ width: 72, height: 16.8 }),
      } as unknown as HTMLElement;
      expect(measureLineH(probe)).toBeCloseTo(16.8, 5);
      expect(measureLineH(null)).toBe(17);
    });
  });
});
