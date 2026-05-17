// @vitest-environment jsdom
//
// V1.4.2 packets 12 + 07 — GridLayout coverage.
//
// Packet 12 (fullscreen pane):
//   - When `focusedKey` matches an item, only that cell is visible; siblings
//     stay mounted (their DOM stays in the tree) but get `display: none` so
//     the #03 terminal-cache keeps the xterm subtree alive without remount.
//   - Empty trailing cells + divider handles disappear in fullscreen — the
//     focused pane fills the viewport on a single-cell grid template.
//
// Packet 07 (rAF responsiveness):
//   - The pointermove handler coalesces multiple ticks through a single
//     requestAnimationFrame so a fast drag generates at most one state
//     update per frame. We assert that 5 synthetic pointermoves before the
//     rAF callback collapse into one `setColFracs` write.
//   - `document.body.dataset.dragging` flips to 'true' on pointerdown and
//     is removed on pointerup so Terminal.tsx's ResizeObserver can relax
//     its fit() debounce.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { GridLayout } from './GridLayout';

interface Item {
  id: string;
}

const ITEMS: Item[] = [
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
];

// jsdom does not implement ResizeObserver. The component uses one indirectly
// via the embedded ResizeObserver in Terminal.tsx, but GridLayout itself
// only consults document.body.dataset and the rAF queue. Stub minimally so
// any unexpected consumer in the render tree doesn't crash.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  delete document.body.dataset.dragging;
});

function renderCell(item: Item, ctx: { index: number; isActive: boolean }) {
  return (
    <div data-testid={`cell-${item.id}`} data-active={ctx.isActive ? 'true' : 'false'}>
      {item.id}
    </div>
  );
}

describe('GridLayout — v1.4.2 packet-12 fullscreen mode', () => {
  it('renders the regular grid (all cells visible) when focusedKey is null', () => {
    const { container, getByTestId } = render(
      <GridLayout<Item>
        items={ITEMS}
        getKey={(i) => i.id}
        renderCell={renderCell}
        activeIndex={0}
        onActiveChange={() => undefined}
        focusedKey={null}
      />,
    );
    // All four cells render and none are hidden via inline style.
    for (const it of ITEMS) {
      const cell = getByTestId(`cell-${it.id}`).parentElement as HTMLElement;
      expect(cell.style.display).not.toBe('none');
    }
    const grid = container.firstChild as HTMLElement;
    expect(grid.dataset.fullscreen).toBeUndefined();
    // Dividers are present for a 2x2 (1 column handle + 1 row handle).
    expect(container.querySelectorAll('[role="separator"]').length).toBe(2);
  });

  it('renders ONLY the focused cell when focusedKey matches; siblings stay mounted but hidden', () => {
    const { container, getByTestId } = render(
      <GridLayout<Item>
        items={ITEMS}
        getKey={(i) => i.id}
        renderCell={renderCell}
        activeIndex={0}
        onActiveChange={() => undefined}
        focusedKey="c"
      />,
    );
    // Every cell still mounts — critical for the #03 terminal cache contract
    // (we don't unmount panes during fullscreen, we just hide them).
    for (const it of ITEMS) {
      expect(getByTestId(`cell-${it.id}`)).toBeTruthy();
    }
    // Non-focused cells have display:none; the focused cell does not.
    const focused = getByTestId('cell-c').parentElement as HTMLElement;
    expect(focused.style.display).not.toBe('none');
    expect(focused.dataset.paneFocused).toBe('true');
    for (const id of ['a', 'b', 'd']) {
      const cell = getByTestId(`cell-${id}`).parentElement as HTMLElement;
      expect(cell.style.display).toBe('none');
    }
    // Container is marked as fullscreen and dividers are suppressed.
    const grid = container.firstChild as HTMLElement;
    expect(grid.dataset.fullscreen).toBe('true');
    expect(container.querySelectorAll('[role="separator"]').length).toBe(0);
  });

  it('falls back to the regular grid when focusedKey does not match any item', () => {
    const { container } = render(
      <GridLayout<Item>
        items={ITEMS}
        getKey={(i) => i.id}
        renderCell={renderCell}
        activeIndex={0}
        onActiveChange={() => undefined}
        focusedKey="ghost-id"
      />,
    );
    const grid = container.firstChild as HTMLElement;
    expect(grid.dataset.fullscreen).toBeUndefined();
  });

  it('drops focus ring chrome in fullscreen mode', () => {
    // Even when activeIndex points at a different pane, the focused pane
    // should not draw a ring (it fills the viewport — the ring is noise).
    const { getByTestId } = render(
      <GridLayout<Item>
        items={ITEMS}
        getKey={(i) => i.id}
        renderCell={renderCell}
        activeIndex={0}
        onActiveChange={() => undefined}
        focusedKey="c"
      />,
    );
    const focusedWrap = getByTestId('cell-c').parentElement as HTMLElement;
    // The component composes ring classes when isActive && !isFullscreen.
    // In fullscreen the wrapper falls through to `border-border` only.
    expect(focusedWrap.className).not.toMatch(/border-\[hsl\(var\(--ring\)\)\]/);
  });
});

describe('GridLayout — v1.4.2 packet-07 rAF coalescing on divider drag', () => {
  it('coalesces multiple pointermoves into a single state update per frame', () => {
    // Hijack requestAnimationFrame so we control when the queued callback
    // runs. This lets us synthesise 5 pointermoves and assert exactly ONE
    // setColFracs render happened before the rAF tick.
    let pendingCb: FrameRequestCallback | null = null;
    let raisedCount = 0;
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        pendingCb = cb;
        raisedCount += 1;
        return raisedCount as unknown as number;
      });
    const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

    let renderCount = 0;
    function TrackedCell(item: Item, ctx: { index: number; isActive: boolean }) {
      // Count renders to confirm the React commit happened (or didn't).
      renderCount += 1;
      return (
        <div data-testid={`cell-${item.id}`} data-active={ctx.isActive ? 'true' : 'false'}>
          {item.id}
        </div>
      );
    }

    const { container } = render(
      <GridLayout<Item>
        items={ITEMS}
        getKey={(i) => i.id}
        renderCell={TrackedCell}
        activeIndex={0}
        onActiveChange={() => undefined}
        focusedKey={null}
      />,
    );
    // Stub getBoundingClientRect so the drag math has a stable canvas.
    const grid = container.firstChild as HTMLElement;
    grid.getBoundingClientRect = () =>
      ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const divider = container.querySelector('[aria-label="Resize column 1"]') as HTMLElement;
    expect(divider).toBeTruthy();

    const baselineRenders = renderCount;
    // Start drag.
    fireEvent.pointerDown(divider, { clientX: 400, clientY: 300 });
    expect(document.body.dataset.dragging).toBe('true');
    expect(rafSpy).not.toHaveBeenCalled();

    // Fire 5 pointermoves before the rAF fires. The handler is bound on
    // window — dispatch to window so the listener receives them.
    for (let i = 0; i < 5; i += 1) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 + i * 10, clientY: 300 }));
    }
    // Exactly one rAF is queued no matter how many pointermoves arrived.
    expect(rafSpy).toHaveBeenCalledTimes(1);
    // No React commits yet — the setter only fires when the rAF callback runs.
    expect(renderCount).toBe(baselineRenders);

    // Flush the rAF — single setState batch, single re-render.
    expect(pendingCb).toBeTruthy();
    act(() => {
      pendingCb?.(performance.now());
    });
    const rendersAfterFlush = renderCount;
    expect(rendersAfterFlush).toBeGreaterThan(baselineRenders);

    // After flush, the next pointermove can queue a new rAF (one per frame).
    rafSpy.mockClear();
    pendingCb = null;
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 460, clientY: 300 }));
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // pointerup flushes any pending state synchronously and clears the
    // dragging flag.
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(document.body.dataset.dragging).toBeUndefined();
    expect(cafSpy).toHaveBeenCalled();

    rafSpy.mockRestore();
    cafSpy.mockRestore();
  });

  it('sets document.body.dataset.dragging during a drag and clears it on pointerup', () => {
    // Same hijack but we don't care about counts — we only assert the flag
    // cycles correctly because Terminal.tsx reads it to relax its debounce.
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1 as unknown as number);
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    try {
      const { container } = render(
        <GridLayout<Item>
          items={ITEMS}
          getKey={(i) => i.id}
          renderCell={renderCell}
          activeIndex={0}
          onActiveChange={() => undefined}
          focusedKey={null}
        />,
      );
      const grid = container.firstChild as HTMLElement;
      grid.getBoundingClientRect = () =>
        ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      const divider = container.querySelector('[aria-label="Resize column 1"]') as HTMLElement;

      expect(document.body.dataset.dragging).toBeUndefined();
      fireEvent.pointerDown(divider, { clientX: 400, clientY: 300 });
      expect(document.body.dataset.dragging).toBe('true');
      window.dispatchEvent(new PointerEvent('pointerup'));
      expect(document.body.dataset.dragging).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
