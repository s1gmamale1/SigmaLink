// @vitest-environment jsdom
//
// PERF-13 / MEM-10 — covers the testable seams of MemoryGraphView:
//   • kineticEnergy()      — settle detection input
//   • resolveThemeColors() — MEM-10 theme-driven canvas colors (with fallback)
//   • reduced-motion       — JS guard short-circuits to a single static draw
//                            (no perpetual requestAnimationFrame loop)
//   • settle               — the RAF loop sleeps once the layout goes quiet

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

// P4 MEM-1 — a mixed graph: a local note + a Ruflo agent-memory node joined by a
// `similarity` edge (the new node/edge classes). Used to exercise the draw path.
const RUFLO_GRAPH: MemoryGraph = {
  nodes: [
    { id: 'n1' as never, label: 'Local note', tagCount: 1, refCount: 1, kind: 'note' },
    {
      id: 'r1' as never,
      label: 'Agent memory',
      tagCount: 0,
      refCount: 0,
      kind: 'ruflo',
      group: 'patterns',
    },
  ],
  edges: [{ from: 'n1' as never, to: 'r1' as never, kind: 'similarity', weight: 0.7 }],
};

// A single Ruflo node placed deterministically near a known canvas coordinate so
// a pointerup can hit it. With Math.random stubbed to 0.5 (jitter→0) the node-build
// for index 0 lands at (w/2 + cos(0)*80, h/2 + sin(0)*80) = (380, 200) for a 600×400 box.
const SINGLE_NODE: MemoryGraph = {
  nodes: [{ id: 'solo' as never, label: 'Solo', tagCount: 0, refCount: 0, kind: 'ruflo', group: 'verdict' }],
  edges: [],
};
const SOLO_X = 380;
const SOLO_Y = 200;

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

  it('renders the node-class legend', () => {
    setReducedMotion(false);
    const { container } = render(<MemoryGraphView graph={GRAPH} onSelect={() => undefined} />);
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).toContain('Agent memory');
  });
});

describe('MemoryGraphView Ruflo node class (P4 MEM-1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function installRafNoop() {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1 as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockReturnValue(undefined);
  }

  it('draws a ruflo node + similarity edge without throwing (reduced-motion sync draw)', () => {
    installCanvasEnv();
    installRafNoop();
    // Reduced-motion path settles + draws a single frame synchronously, so the
    // new diamond/dashed-edge branches run during render.
    setReducedMotion(true);
    expect(() =>
      render(<MemoryGraphView graph={RUFLO_GRAPH} onSelect={() => undefined} />),
    ).not.toThrow();
  });

  it('calls onSelectNode with the clicked node incl. its kind + group', () => {
    installCanvasEnv();
    installRafNoop();
    // Pin layout: motion on (RAF mocked → no step()), random jitter → 0, so the
    // single node sits at the known SOLO_X/SOLO_Y coordinate.
    setReducedMotion(false);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const onSelectNode = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <MemoryGraphView graph={SINGLE_NODE} onSelect={onSelect} onSelectNode={onSelectNode} />,
    );
    const canvas = container.querySelector('canvas')!;
    // A bare pointerUp (no prior drag) exercises the select branch directly,
    // avoiding jsdom's missing canvas.setPointerCapture.
    fireEvent.pointerUp(canvas, { clientX: SOLO_X, clientY: SOLO_Y, pointerId: 1 });
    expect(onSelectNode).toHaveBeenCalledWith({
      id: 'solo',
      label: 'Solo',
      kind: 'ruflo',
      group: 'verdict',
    });
    // Preferred callback wins; the legacy label-only one is NOT invoked.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('falls back to onSelect(label) when onSelectNode is absent', () => {
    installCanvasEnv();
    installRafNoop();
    setReducedMotion(false);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const onSelect = vi.fn();
    const { container } = render(<MemoryGraphView graph={SINGLE_NODE} onSelect={onSelect} />);
    const canvas = container.querySelector('canvas')!;
    fireEvent.pointerUp(canvas, { clientX: SOLO_X, clientY: SOLO_Y, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith('Solo');
  });
});
