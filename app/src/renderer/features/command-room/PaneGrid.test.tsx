// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PaneGrid } from './PaneGrid';

const leafRender = (id: string) => <div data-testid={`leaf-${id}`}>{id}</div>;

afterEach(() => cleanup());

function renderGrid(ids: string[], focusedPaneId: string | null = null, activeSessionId = ids[0] ?? null) {
  return render(
    <PaneGrid
      sessionIds={ids}
      activeSessionId={activeSessionId}
      focusedPaneId={focusedPaneId}
      onActivate={() => {}}
      renderLeaf={leafRender}
    />,
  );
}

describe('PaneGrid', () => {
  it('renders a cell per session', () => {
    renderGrid(['a', 'b', 'c']);
    expect(screen.getAllByTestId('pane-cell')).toHaveLength(3);
    expect(screen.getByTestId('leaf-a')).toBeTruthy();
    expect(screen.getByTestId('leaf-c')).toBeTruthy();
  });

  it('lays out 6 panes as a 3×2 grid', () => {
    renderGrid(['a', 'b', 'c', 'd', 'e', 'f']);
    const grid = screen.getByTestId('pane-grid');
    expect(grid.getAttribute('data-cols')).toBe('3');
    expect(grid.getAttribute('data-rows')).toBe('2');
  });

  it('widens the bottom pane to fill on 3 panes (no dead space)', () => {
    renderGrid(['a', 'b', 'c']);
    const c = screen.getByTestId('leaf-c').closest('[data-testid="pane-cell"]') as HTMLElement;
    expect(c.style.gridColumn).toBe('span 2');
  });

  it('renders square corners (no rounded class on cells)', () => {
    renderGrid(['a', 'b']);
    for (const cell of screen.getAllByTestId('pane-cell')) {
      expect(cell.className).not.toMatch(/rounded/);
    }
  });

  it('marks the active cell with the accent ring', () => {
    renderGrid(['a', 'b'], null, 'b');
    const cells = screen.getAllByTestId('pane-cell');
    const active = cells.find((c) => c.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('b');
    expect(active?.className).toMatch(/ring-inset/);
  });

  it('fullscreen: focused cell overlays (absolute z-50), others kept mounted but hidden', () => {
    renderGrid(['a', 'b'], 'a');
    const a = screen.getByTestId('leaf-a').closest('[data-testid="pane-cell"]') as HTMLElement;
    const b = screen.getByTestId('leaf-b').closest('[data-testid="pane-cell"]') as HTMLElement;
    expect(a.style.position).toBe('absolute');
    expect(a.style.zIndex).toBe('50');
    // sibling stays mounted (terminal preserved) but hidden
    expect(b).toBeTruthy();
    expect(b.style.display).toBe('none');
  });

  it('keeps the same cell element across a reflow (no remount → terminal preserved)', () => {
    const { rerender } = renderGrid(['a', 'b']);
    const before = screen.getByTestId('leaf-a').closest('[data-testid="pane-cell"]');
    rerender(
      <PaneGrid
        sessionIds={['a', 'b', 'c']}
        activeSessionId="a"
        focusedPaneId={null}
        onActivate={() => {}}
        renderLeaf={leafRender}
      />,
    );
    const after = screen.getByTestId('leaf-a').closest('[data-testid="pane-cell"]');
    expect(after).toBe(before); // same DOM node — React kept it (key=sessionId)
  });
});
