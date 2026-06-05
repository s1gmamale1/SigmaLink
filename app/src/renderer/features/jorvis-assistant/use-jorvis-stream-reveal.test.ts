// @vitest-environment jsdom
//
// Tests for the rAF catch-up stream-reveal hook.

import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useJorvisStreamReveal } from './use-jorvis-stream-reveal';

vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => false }));

let raf: ((t: number) => void)[] = [];
beforeEach(() => {
  raf = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { raf.push(cb); return raf.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => vi.unstubAllGlobals());
const flush = (n: number) => { for (let i = 0; i < n; i++) { const cbs = raf; raf = []; cbs.forEach((cb) => cb(0)); } };

describe('useJorvisStreamReveal', () => {
  it('reveals progressively, not all at once, while active', () => {
    const { result, rerender } = renderHook(({ text, active }) => useJorvisStreamReveal(text, active), {
      initialProps: { text: 'hello world', active: true },
    });
    expect(result.current.revealed.length).toBe(0);
    act(() => flush(1));
    const afterOne = result.current.revealed.length;
    expect(afterOne).toBeGreaterThan(0);
    expect(afterOne).toBeLessThan('hello world'.length); // capped per frame — NOT instant
    act(() => flush(20));
    expect(result.current.revealed).toBe('hello world');
    expect(result.current.caret).toBe(true); // caret shows while active
    void rerender; // satisfy no-unused-vars
  });

  it('jumps to full + no caret once inactive (turn done)', () => {
    const { result, rerender } = renderHook(({ text, active }) => useJorvisStreamReveal(text, active), {
      initialProps: { text: 'done text', active: true },
    });
    act(() => { rerender({ text: 'done text', active: false }); flush(1); });
    expect(result.current.revealed).toBe('done text');
    expect(result.current.caret).toBe(false);
  });

  it('reduced-motion → instant full text, no caret, no rAF', async () => {
    vi.resetModules();
    vi.doMock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => true }));
    const { useJorvisStreamReveal: hook } = await import('./use-jorvis-stream-reveal');
    const { result } = renderHook(() => hook('instant!', true));
    expect(result.current.revealed).toBe('instant!');
    expect(result.current.caret).toBe(false);
    expect(raf.length).toBe(0);
  });
});
