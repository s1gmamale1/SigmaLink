// @vitest-environment jsdom
//
// PERF-13 / MEM-10 — covers the testable seams of MemoryGraphView:
//   • kineticEnergy()      — settle detection input
//   • resolveThemeColors() — MEM-10 theme-driven canvas colors (with fallback)
//   • reduced-motion       — JS guard short-circuits to a single static draw
//                            (no perpetual requestAnimationFrame loop)
//   • settle               — the RAF loop sleeps once the layout goes quiet

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryGraphView, kineticEnergy, resolveThemeColors } from './MemoryGraph';
import type { MemoryGraph } from '@/shared/types';

const GRAPH: MemoryGraph = {
  nodes: [
    { id: 'a' as never, label: 'Alpha', tagCount: 1, refCount: 2 },
    { id: 'b' as never, label: 'Beta', tagCount: 0, refCount: 0 },
    { id: 'c' as never, label: 'Gamma', tagCount: 3, refCount: 5 },
  ],
  edges: [
    { from: 'a' as never, to: 'b' as never },
    { from: 'b' as never, to: 'c' as never },
  ],
};

// jsdom lacks ResizeObserver + a real canvas 2D context. Provide minimal fakes
// so the component's effects run (the loop only needs a non-null context).
function installCanvasEnv() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fakeCtx = new Proxy(
    {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
    },
    {
      get: (target, prop) =>
        prop in target ? (target as Record<string | symbol, unknown>)[prop] : vi.fn(),
      set: () => true, // swallow fillStyle/strokeStyle/font/lineWidth assignments
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
}

function setReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('kineticEnergy', () => {
  it('is zero for a fully-stopped layout', () => {
    expect(kineticEnergy([{ vx: 0, vy: 0 }, { vx: 0, vy: 0 }])).toBe(0);
  });

  it('sums vx^2 + vy^2 across nodes', () => {
    expect(kineticEnergy([{ vx: 3, vy: 4 }, { vx: 1, vy: 0 }])).toBe(25 + 1);
  });
});

describe('resolveThemeColors (MEM-10)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('falls back to brand hexes when no CSS vars are set', () => {
    const root = document.createElement('div'); // no theme vars
    const colors = resolveThemeColors(root);
    expect(colors.node).toBe('#3b82f6');
    expect(colors.nodeHover).toBe('#f97316');
    expect(colors.edge).toBe('rgba(120,140,180,0.45)');
  });

  it('returns fallbacks for a null root', () => {
    expect(resolveThemeColors(null).node).toBe('#3b82f6');
  });

  it('reads HSL channel vars and wraps them for canvas', () => {
    const root = document.documentElement;
    root.style.setProperty('--primary', '270 60% 55%');
    root.style.setProperty('--accent', '22 65% 45%');
    root.style.setProperty('--muted-foreground', '220 10% 55%');
    const colors = resolveThemeColors(root);
    expect(colors.node).toBe('hsl(270 60% 55%)');
    expect(colors.nodeHover).toBe('hsl(22 65% 45%)');
    // muted-foreground feeds the edge color at reduced alpha.
    expect(colors.edge).toBe('hsl(220 10% 55% / 0.45)');
  });
});

describe('MemoryGraphView animation lifecycle', () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cafSpy: ReturnType<typeof vi.spyOn>;
  let rafCount = 0;

  beforeEach(() => {
    rafCount = 0;
    installCanvasEnv();
    // Deterministic RAF: count scheduling, never auto-run (running would let
    // the loop schedule the next frame). We only assert on scheduling.
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      rafCount += 1;
      return rafCount;
    });
    cafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('schedules an animation frame when motion is allowed', () => {
    setReducedMotion(false);
    render(<MemoryGraphView graph={GRAPH} onSelect={() => undefined} />);
    // The settle loop kicks off with at least one scheduled frame.
    expect(rafCount).toBeGreaterThanOrEqual(1);
  });

  it('does NOT start a continuous loop under prefers-reduced-motion', () => {
    setReducedMotion(true);
    render(<MemoryGraphView graph={GRAPH} onSelect={() => undefined} />);
    // Reduced-motion path settles + draws synchronously without ever calling
    // requestAnimationFrame to schedule a continuous loop.
    expect(rafCount).toBe(0);
  });

  it('renders the notes/links counter', () => {
    setReducedMotion(false);
    const { container } = render(<MemoryGraphView graph={GRAPH} onSelect={() => undefined} />);
    expect(container.textContent).toContain('3 notes');
    expect(container.textContent).toContain('2 links');
  });
});
