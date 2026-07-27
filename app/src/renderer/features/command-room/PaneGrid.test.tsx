// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const dndHarness = vi.hoisted(() => ({
  contextProps: null as Record<string, unknown> | null,
  overlayProps: null as Record<string, unknown> | null,
  overId: null as string | null,
  pointerWithin: vi.fn<(args: unknown) => { id: string }[]>(() => [
    { id: 'pointer-target' },
  ]),
  closestCenter: vi.fn<(args: unknown) => { id: string }[]>(() => [
    { id: 'keyboard-target' },
  ]),
  useSensor: vi.fn((sensor: unknown, options: unknown) => ({ sensor, options })),
  useSensors: vi.fn((...sensors: unknown[]) => sensors),
  useDraggable: vi.fn(),
  useDroppable: vi.fn(),
}));

const navigationHarness = vi.hoisted(() => ({
  createCoordinates: vi.fn((sessionIds: readonly string[]) => {
    const getter = vi.fn(() => ({ x: 0, y: 0 }));
    Object.assign(getter, { sessionIds: [...sessionIds] });
    return getter;
  }),
}));

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react');
  function PointerSensor() {}
  function KeyboardSensor() {}
  return {
    DndContext: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => {
      dndHarness.contextProps = props;
      return React.createElement(React.Fragment, null, children);
    },
    DragOverlay: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => {
      dndHarness.overlayProps = props;
      return React.createElement(React.Fragment, null, children);
    },
    PointerSensor,
    KeyboardSensor,
    pointerWithin: (args: unknown) => dndHarness.pointerWithin(args),
    closestCenter: (args: unknown) => dndHarness.closestCenter(args),
    useSensor: (sensor: unknown, options: unknown) =>
      dndHarness.useSensor(sensor, options),
    useSensors: (...sensors: unknown[]) => dndHarness.useSensors(...sensors),
    useDraggable: (args: { disabled?: boolean }) => {
      dndHarness.useDraggable(args);
      return {
        attributes: { 'aria-disabled': String(Boolean(args.disabled)) },
        listeners: {},
        setNodeRef: vi.fn(),
        setActivatorNodeRef: vi.fn(),
      };
    },
    useDroppable: (args: { id: string }) => {
      dndHarness.useDroppable(args);
      return {
        isOver: dndHarness.overId === args.id,
        setNodeRef: vi.fn(),
      };
    },
  };
});

vi.mock('./pane-reorder-navigation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./pane-reorder-navigation')>();
  return {
    ...actual,
    createPaneKeyboardCoordinates: (sessionIds: readonly string[]) =>
      navigationHarness.createCoordinates(sessionIds),
  };
});

const kvGet = vi.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null);
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (k: string) => kvGet(k), set: (k: string, v: string) => kvSet(k, v) } },
}));

import { PaneGrid } from './PaneGrid';
import { PaneReorderHandle } from './PaneReorderHandle';
import { KeyboardSensor, PointerSensor } from '@dnd-kit/core';

const leafRender = (id: string) => <div data-testid={`leaf-${id}`}>{id}</div>;

beforeEach(() => {
  kvGet.mockReset().mockResolvedValue(null);
  kvSet.mockReset().mockResolvedValue(undefined);
  dndHarness.contextProps = null;
  dndHarness.overlayProps = null;
  dndHarness.overId = null;
  dndHarness.pointerWithin.mockClear();
  dndHarness.closestCenter.mockClear();
  dndHarness.useSensor.mockClear();
  dndHarness.useSensors.mockClear();
  dndHarness.useDraggable.mockClear();
  dndHarness.useDroppable.mockClear();
  navigationHarness.createCoordinates.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderGrid(
  ids: string[],
  focusedPaneId: string | null = null,
  activeSessionId = ids[0] ?? null,
  overrides: Partial<React.ComponentProps<typeof PaneGrid>> = {},
) {
  return render(
    <PaneGrid
      sessionIds={ids}
      activeSessionId={activeSessionId}
      focusedPaneId={focusedPaneId}
      workspaceId="ws1"
      onActivate={() => {}}
      renderLeaf={leafRender}
      reorderEnabled
      onSwapPanes={() => false}
      getPaneLabel={(id) => `Pane ${id.toUpperCase()}`}
      {...overrides}
    />,
  );
}

function currentDndProps() {
  if (!dndHarness.contextProps) throw new Error('DndContext did not render');
  return dndHarness.contextProps as {
    sensors: unknown[];
    collisionDetection: (args: Record<string, unknown>) => unknown;
    accessibility: {
      announcements: {
        onDragStart: (event: Record<string, unknown>) => string | undefined;
        onDragOver: (event: Record<string, unknown>) => string | undefined;
        onDragEnd: (event: Record<string, unknown>) => string | undefined;
        onDragCancel: (event: Record<string, unknown>) => string | undefined;
      };
    };
    onDragStart: (event: Record<string, unknown>) => void;
    onDragEnd: (event: Record<string, unknown>) => void;
    onDragCancel: (event: Record<string, unknown>) => void;
  };
}

function active(id: string) {
  return {
    id,
    data: { current: { kind: 'pane-reorder', sessionId: id.split(':')[1] } },
    rect: { current: { initial: null, translated: null } },
  };
}

function over(id: string) {
  return {
    id,
    data: { current: { kind: 'pane-reorder-target', sessionId: id.split(':')[1] } },
    rect: {},
    disabled: false,
  };
}

function startDrag(sessionId: string) {
  act(() => {
    currentDndProps().onDragStart({ active: active(`pane-reorder:${sessionId}`) });
  });
}

function endDrag(sourceSessionId: string, targetSessionId: string | null) {
  act(() => {
    currentDndProps().onDragEnd({
      active: active(`pane-reorder:${sourceSessionId}`),
      over: targetSessionId ? over(`pane-slot:${targetSessionId}`) : null,
    });
  });
}

const reorderLeaf = (id: string) => (
  <div data-testid={`leaf-${id}`}>
    <PaneReorderHandle
      sessionId={id}
      paneName={`Pane ${id.toUpperCase()}`}
      position={1}
      count={5}
      disabled={false}
    />
    <div data-testid={`terminal-${id}`}>terminal {id}</div>
  </div>
);

describe('PaneGrid', () => {
  it('renders a cell per session', async () => {
    renderGrid(['a', 'b', 'c']);
    await act(async () => {});
    expect(screen.getAllByTestId('pane-cell')).toHaveLength(3);
    expect(screen.getByTestId('leaf-a')).toBeTruthy();
    expect(screen.getByTestId('leaf-c')).toBeTruthy();
  });

  it('3 panes → 2 rows (one vertical divider in the top row + one horizontal divider between rows)', async () => {
    renderGrid(['a', 'b', 'c']);
    await act(async () => {});
    const dividers = screen.getAllByTestId('pane-divider');
    const vertical = dividers.filter((d) => d.getAttribute('data-orientation') === 'vertical');
    const horizontal = dividers.filter((d) => d.getAttribute('data-orientation') === 'horizontal');
    expect(vertical).toHaveLength(1); // top row [a,b]
    expect(horizontal).toHaveLength(1); // between row0 and row1
  });

  it('6 panes → a 3×2 grid (two rows, 2 vertical dividers each + 1 horizontal)', async () => {
    renderGrid(['a', 'b', 'c', 'd', 'e', 'f']);
    await act(async () => {});
    const dividers = screen.getAllByTestId('pane-divider');
    expect(dividers.filter((d) => d.getAttribute('data-orientation') === 'vertical')).toHaveLength(4);
    expect(dividers.filter((d) => d.getAttribute('data-orientation') === 'horizontal')).toHaveLength(1);
  });

  it('renders square corners (no rounded class on cells)', async () => {
    renderGrid(['a', 'b']);
    await act(async () => {});
    for (const cell of screen.getAllByTestId('pane-cell')) {
      expect(cell.className).not.toMatch(/rounded/);
    }
  });

  it('marks the active cell with the focus-glow class', async () => {
    renderGrid(['a', 'b'], null, 'b');
    await act(async () => {});
    const active = screen.getAllByTestId('pane-cell').find((c) => c.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('b');
    // The theme-aware glow is the `.sl-pane-active::after` overlay (glass-material.css).
    expect(active?.className).toMatch(/sl-pane-active/);
  });

  // Flicker fix regression guard: switching the active pane must NOT toggle a
  // cell's z-index between auto and a value (that create/destroyed a stacking
  // context around the terminal's GPU canvas → one-frame re-raster flash), and
  // there must be NO transition on the focus state (the earlier transition-shadow
  // fade read as a flicker animation). Every cell keeps a non-auto z floor.
  it('keeps a stable stacking context with no focus transition (no flicker)', async () => {
    renderGrid(['a', 'b'], null, 'b');
    await act(async () => {});
    const cells = screen.getAllByTestId('pane-cell');
    const active = cells.find((c) => c.getAttribute('data-active') === 'true')!;
    const idle = cells.find((c) => c.getAttribute('data-active') !== 'true')!;

    // Active is lifted (z-1); idle has a z-0 floor — both non-auto, so the
    // stacking context exists in BOTH states and never churns on switch.
    expect(active.className).toMatch(/z-\[1\]/);
    expect(idle.className).toMatch(/z-0/);
    expect(active.className).not.toMatch(/z-0/);

    // Only the active/focused cell carries the glow class; idle does not.
    expect(active.className).toMatch(/sl-pane-active/);
    expect(idle.className).not.toMatch(/sl-pane-active/);

    // No transition utility on the cell — focus glow is instant, not animated.
    expect(active.className).not.toMatch(/transition/);
    expect(idle.className).not.toMatch(/transition/);
  });

  it('fullscreen: focused cell overlays (absolute z-50), others mounted but hidden', async () => {
    renderGrid(['a', 'b'], 'a');
    await act(async () => {});
    const a = screen.getByTestId('leaf-a').closest('[data-testid="pane-cell"]') as HTMLElement;
    const b = screen.getByTestId('leaf-b').closest('[data-testid="pane-cell"]') as HTMLElement;
    expect(a.style.position).toBe('absolute');
    expect(a.style.zIndex).toBe('50');
    expect(b.style.display).toBe('none'); // sibling stays mounted (terminal preserved)
    // The focused (fullscreen) pane carries the glow class too — the theme-aware
    // `.sl-pane-active` glow keys off isActive OR isFocused, so a focused surface
    // always reads as glowing.
    expect(a.className).toMatch(/sl-pane-active/);
  });

  it('seeds resize fractions from persisted KV when the shape matches', async () => {
    kvGet.mockResolvedValue(JSON.stringify({ sig: '2', rows: [1], cols: [[0.7, 0.3]] }));
    renderGrid(['a', 'b']);
    await act(async () => {});
    // The live track sizes live in the row's `--pg-cols` custom property; the
    // grid template carries the persisted fraction as a `minmax(0,Nfr)` track.
    const row = screen.getByTestId('pane-row');
    expect(row.style.getPropertyValue('--pg-cols')).toContain('0.7fr');
  });

  it('ignores persisted fractions whose shape signature no longer matches', async () => {
    kvGet.mockResolvedValue(JSON.stringify({ sig: '9x9', rows: [1], cols: [[0.7, 0.3]] }));
    renderGrid(['a', 'b']);
    await act(async () => {});
    // falls back to even split (0.5)
    const row = screen.getByTestId('pane-row');
    expect(row.style.getPropertyValue('--pg-cols')).toContain('0.5fr');
  });
});

describe('PaneGrid reorder lifecycle', () => {
  it('configures 5px pointer activation and deterministic keyboard coordinates', () => {
    renderGrid(['a', 'b', 'c']);

    expect(navigationHarness.createCoordinates).toHaveBeenCalledWith([
      'a',
      'b',
      'c',
    ]);
    expect(dndHarness.useSensor).toHaveBeenCalledWith(PointerSensor, {
      activationConstraint: { distance: 5 },
    });
    expect(dndHarness.useSensor).toHaveBeenCalledWith(KeyboardSensor, {
      coordinateGetter: expect.objectContaining({
        sessionIds: ['a', 'b', 'c'],
      }),
    });
    expect(currentDndProps().sensors).toHaveLength(2);
  });

  it('uses pointer collisions for pointer input and closest-center for keyboard input', () => {
    renderGrid(['a', 'b']);
    const collisionDetection = currentDndProps().collisionDetection;
    const pointerArgs = { pointerCoordinates: { x: 12, y: 8 } };
    const keyboardArgs = { pointerCoordinates: null };

    expect(collisionDetection(pointerArgs)).toEqual([{ id: 'pointer-target' }]);
    expect(dndHarness.pointerWithin).toHaveBeenCalledWith(pointerArgs);
    expect(collisionDetection(keyboardArgs)).toEqual([{ id: 'keyboard-target' }]);
    expect(dndHarness.closestCenter).toHaveBeenCalledWith(keyboardArgs);
  });

  it('announces pickup, target, drop, and cancellation using visual positions', () => {
    renderGrid(['a', 'b', 'c']);
    const announcements = currentDndProps().accessibility.announcements;
    const source = active('pane-reorder:b');
    const target = over('pane-slot:c');

    expect(announcements.onDragStart({ active: source })).toBe(
      'Picked up Pane B, position 2 of 3.',
    );
    expect(announcements.onDragOver({ active: source, over: target })).toBe(
      'Pane B will swap with position 3 of 3.',
    );
    expect(announcements.onDragEnd({ active: source, over: target })).toBe(
      'Moved Pane B to position 3 of 3.',
    );
    expect(announcements.onDragCancel({ active: source, over: target })).toBe(
      'Pane move cancelled.',
    );
  });

  it('marks only the source, shields terminal hit testing, and renders a lightweight label overlay', () => {
    dndHarness.overId = 'pane-slot:e';
    renderGrid(['a', 'b', 'c', 'd', 'e'], null, 'a', {
      renderLeaf: reorderLeaf,
    });

    startDrag('a');

    const sourceCells = screen
      .getAllByTestId('pane-cell')
      .filter(
        (cell) => cell.getAttribute('data-pane-reorder-source') === 'true',
      );
    expect(sourceCells).toHaveLength(1);
    expect(sourceCells[0]?.getAttribute('data-session-id')).toBe('a');
    expect(screen.getAllByTestId('pane-reorder-shield')).toHaveLength(5);
    expect(
      screen.getAllByTestId('pane-cell').find(
        (cell) => cell.getAttribute('data-session-id') === 'e',
      )?.className,
    ).toMatch(/\bring-2\b/);

    const overlay = screen.getByTestId('pane-reorder-overlay');
    expect(overlay.textContent).toContain('Pane A');
    expect(overlay.textContent).toContain('position 1 of 5');
    expect(overlay.querySelector('[data-testid^="leaf-"]')).toBeNull();
    expect(overlay.querySelector('[data-testid^="terminal-"]')).toBeNull();
  });

  it('commits one exact target-slot swap and cleans every transient drag affordance', () => {
    const onSwapPanes = vi.fn(() => true);
    dndHarness.overId = 'pane-slot:e';
    renderGrid(['a', 'b', 'c', 'd', 'e'], null, 'a', {
      renderLeaf: reorderLeaf,
      onSwapPanes,
    });

    startDrag('a');
    const grid = screen.getByTestId('pane-grid');
    expect(grid.className).toMatch(/\bselect-none\b/);
    expect(grid.className).toMatch(/\bcursor-grabbing\b/);

    endDrag('a', 'e');

    expect(onSwapPanes).toHaveBeenCalledTimes(1);
    expect(onSwapPanes).toHaveBeenCalledWith('a', 'e');
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();
    expect(grid.className).not.toMatch(/\bselect-none\b/);
    expect(grid.className).not.toMatch(/\bcursor-grabbing\b/);
    for (const cell of screen.getAllByTestId('pane-cell')) {
      expect(cell.getAttribute('data-pane-reorder-source')).toBeNull();
      expect(cell.className).not.toMatch(/\bring-2\b/);
    }
  });

  it.each([
    ['same target', true, 'pane-reorder:a', 'pane-slot:a'],
    ['missing target session', true, 'pane-reorder:a', 'pane-slot:missing'],
    ['wrong active prefix', true, 'context:a', 'pane-slot:b'],
    ['wrong target prefix', true, 'pane-reorder:a', 'pane-reorder:b'],
    ['disabled', false, 'pane-reorder:a', 'pane-slot:b'],
    ['outside drop', true, 'pane-reorder:a', null],
  ])(
    'does not commit a %s drop',
    (_name, reorderEnabled, activeId, overId) => {
      const onSwapPanes = vi.fn(() => true);
      renderGrid(['a', 'b'], null, 'a', { reorderEnabled, onSwapPanes });

      act(() => {
        currentDndProps().onDragStart({ active: active('pane-reorder:a') });
        currentDndProps().onDragEnd({
          active: active(activeId),
          over: overId ? over(overId) : null,
        });
      });

      expect(onSwapPanes).not.toHaveBeenCalled();
      expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
      expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();
    },
  );

  it('cancels an Escape-driven drag without swapping and restores hit testing', () => {
    const onSwapPanes = vi.fn(() => true);
    dndHarness.overId = 'pane-slot:b';
    renderGrid(['a', 'b'], null, 'a', { onSwapPanes });

    startDrag('a');
    act(() => {
      currentDndProps().onDragCancel({
        active: active('pane-reorder:a'),
        over: over('pane-slot:b'),
      });
    });

    expect(onSwapPanes).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();
    expect(screen.getByTestId('pane-grid').className).not.toMatch(
      /\bselect-none\b|\bcursor-grabbing\b/,
    );
  });

  it('unmounts an active reorder without committing a swap', () => {
    const onSwapPanes = vi.fn(() => true);
    const view = renderGrid(['a', 'b'], null, 'a', { onSwapPanes });

    startDrag('a');
    view.unmount();

    expect(onSwapPanes).not.toHaveBeenCalled();
  });

  it('keeps the grip isolated from pane activation and native context MIME', () => {
    const onActivate = vi.fn();
    const setData = vi.fn();
    renderGrid(['a', 'b'], null, 'a', {
      onActivate,
      renderLeaf: reorderLeaf,
    });

    const grip = screen.getByRole('button', {
      name: 'Reorder Pane A, position 1 of 5',
    });
    fireEvent.mouseDown(grip);
    fireEvent.dragStart(grip, {
      dataTransfer: { effectAllowed: 'none', setData },
    });

    expect(onActivate).not.toHaveBeenCalled();
    expect(grip.getAttribute('draggable')).not.toBe('true');
    expect(setData).not.toHaveBeenCalled();
  });

  it('uses a zero-duration drop animation when reduced motion is requested', () => {
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    try {
      renderGrid(['a', 'b']);
      expect(dndHarness.overlayProps?.dropAnimation).toEqual(
        expect.objectContaining({ duration: 0 }),
      );
    } finally {
      window.matchMedia = previousMatchMedia;
    }
  });
});

describe('PaneGrid reorder geometry and refit', () => {
  const persisted =
    '{"sig":"3x2","rows":[0.65,0.35],"cols":[[0.2,0.3,0.5],[0.7,0.3]]}';

  function paneGridElement(
    ids: string[],
    onSwapPanes: (source: string, target: string) => boolean,
    focusedPaneId: string | null = null,
    activeSessionId: string | null = 'c',
  ) {
    return (
      <PaneGrid
        sessionIds={ids}
        activeSessionId={activeSessionId}
        focusedPaneId={focusedPaneId}
        workspaceId="ws1"
        onActivate={() => {}}
        renderLeaf={reorderLeaf}
        reorderEnabled={focusedPaneId === null}
        onSwapPanes={onSwapPanes}
        getPaneLabel={(id) => `Pane ${id.toUpperCase()}`}
      />
    );
  }

  function geometrySnapshot() {
    return {
      rows: screen.getByTestId('pane-grid').style.getPropertyValue('--pg-rows'),
      cols: screen
        .getAllByTestId('pane-row')
        .map((row) => row.style.getPropertyValue('--pg-cols')),
    };
  }

  it('preserves every resize variable and persisted blob across a same-row swap without refit', async () => {
    kvGet.mockResolvedValue(persisted);
    const onSwapPanes = vi.fn(() => true);
    const onResizeStart = vi.fn();
    const onResizeEnd = vi.fn();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);
    const view = render(paneGridElement(['a', 'b', 'c', 'd', 'e'], onSwapPanes));
    await act(async () => {});
    const before = geometrySnapshot();

    startDrag('a');
    endDrag('a', 'c');
    await act(async () => {
      view.rerender(
        paneGridElement(['c', 'b', 'a', 'd', 'e'], onSwapPanes),
      );
    });

    expect(geometrySnapshot()).toEqual(before);
    expect(kvGet).toHaveBeenCalledWith('panegrid.ws1');
    expect(kvSet).not.toHaveBeenCalled();
    expect(onResizeStart).not.toHaveBeenCalled();
    expect(onResizeEnd).not.toHaveBeenCalled();
    window.removeEventListener('sigma:pane-resize-start', onResizeStart);
    window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
  });

  it('emits exactly one unpaired refit after a committed cross-row rerender and restores focus by session ID', async () => {
    kvGet.mockResolvedValue(persisted);
    const onSwapPanes = vi.fn(() => true);
    const onResizeStart = vi.fn();
    const onResizeEnd = vi.fn();
    window.addEventListener('sigma:pane-resize-start', onResizeStart);
    window.addEventListener('sigma:pane-resize-end', onResizeEnd);
    const view = render(paneGridElement(['a', 'b', 'c', 'd', 'e'], onSwapPanes));
    await act(async () => {});
    const before = geometrySnapshot();

    startDrag('a');
    endDrag('a', 'e');
    expect(onSwapPanes).toHaveBeenCalledTimes(1);
    expect(onResizeEnd).not.toHaveBeenCalled();

    await act(async () => {
      view.rerender(
        paneGridElement(['e', 'b', 'c', 'd', 'a'], onSwapPanes),
      );
    });

    expect(geometrySnapshot()).toEqual(before);
    expect(kvSet).not.toHaveBeenCalled();
    expect(onResizeStart).not.toHaveBeenCalled();
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      document.querySelector(
        '[data-pane-reorder-handle][data-session-id="a"]',
      ),
    );
    window.removeEventListener('sigma:pane-resize-start', onResizeStart);
    window.removeEventListener('sigma:pane-resize-end', onResizeEnd);
  });

  it('keeps active, fullscreen, and hidden state attached to session identities after order changes', async () => {
    const onSwapPanes = vi.fn(() => false);
    const view = render(
      paneGridElement(['a', 'b', 'c', 'd', 'e'], onSwapPanes, null, 'c'),
    );
    await act(async () => {});

    await act(async () => {
      view.rerender(
        paneGridElement(['e', 'b', 'c', 'd', 'a'], onSwapPanes, null, 'c'),
      );
    });
    expect(
      screen
        .getAllByTestId('pane-cell')
        .find((cell) => cell.getAttribute('data-active') === 'true')
        ?.getAttribute('data-session-id'),
    ).toBe('c');

    await act(async () => {
      view.rerender(
        paneGridElement(['e', 'b', 'c', 'd', 'a'], onSwapPanes, 'e', 'c'),
      );
    });
    const focused = screen
      .getByTestId('leaf-e')
      .closest('[data-testid="pane-cell"]') as HTMLElement;
    const hidden = screen
      .getByTestId('leaf-a')
      .closest('[data-testid="pane-cell"]') as HTMLElement;
    expect(focused.style.position).toBe('absolute');
    expect(focused.style.zIndex).toBe('50');
    expect(hidden.getAttribute('data-bsp-hidden')).toBe('true');
    expect(hidden.style.display).toBe('none');
  });
});

// Maximize (⤢) same-frame refit (pane-refit follow-up 2026-06-11): flipping
// focusedPaneId must dispatch the divider-release refit signal so terminals
// fit in the SAME frame as the layout flip instead of waiting out Terminal's
// 60ms non-drag debounce (box snapped, text lagged, then the TUI repainted —
// reads as "every line re-arranges"). Hidden-by-this-flip siblings are safe:
// Terminal's runFit zero-size guard + the controller's hidden skip.
describe('fullscreen toggle → immediate refit signal', () => {
  function countResizeEnd() {
    const counter = { n: 0 };
    const onEnd = () => {
      counter.n += 1;
    };
    window.addEventListener('sigma:pane-resize-end', onEnd);
    return { counter, off: () => window.removeEventListener('sigma:pane-resize-end', onEnd) };
  }

  const gridProps = (focusedPaneId: string | null, activeSessionId = 'a') => (
    <PaneGrid
      sessionIds={['a', 'b']}
      activeSessionId={activeSessionId}
      focusedPaneId={focusedPaneId}
      workspaceId="ws1"
      onActivate={() => {}}
      renderLeaf={leafRender}
      reorderEnabled
      onSwapPanes={() => false}
      getPaneLabel={(id) => `Pane ${id.toUpperCase()}`}
    />
  );

  it('dispatches sigma:pane-resize-end when a pane enters and exits fullscreen', async () => {
    const { counter, off } = countResizeEnd();
    const view = render(gridProps(null));
    await act(async () => {});
    expect(counter.n).toBe(0); // initial mount: nothing to refit

    await act(async () => {
      view.rerender(gridProps('a'));
    });
    expect(counter.n).toBe(1); // enter fullscreen

    await act(async () => {
      view.rerender(gridProps(null));
    });
    expect(counter.n).toBe(2); // exit fullscreen
    off();
  });

  it('does not dispatch on unrelated re-renders with unchanged focusedPaneId', async () => {
    const { counter, off } = countResizeEnd();
    const view = render(gridProps(null));
    await act(async () => {});
    await act(async () => {
      view.rerender(gridProps(null, 'b')); // active pane changes, focus does not
    });
    expect(counter.n).toBe(0);
    off();
  });
});
