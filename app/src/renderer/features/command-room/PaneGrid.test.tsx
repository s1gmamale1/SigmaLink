// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null);
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (k: string) => kvGet(k), set: (k: string, v: string) => kvSet(k, v) } },
}));

import { PaneGrid } from './PaneGrid';

const leafRender = (id: string) => <div data-testid={`leaf-${id}`}>{id}</div>;

beforeEach(() => {
  kvGet.mockReset().mockResolvedValue(null);
  kvSet.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

function renderGrid(ids: string[], focusedPaneId: string | null = null, activeSessionId = ids[0] ?? null) {
  return render(
    <PaneGrid
      sessionIds={ids}
      activeSessionId={activeSessionId}
      focusedPaneId={focusedPaneId}
      workspaceId="ws1"
      onActivate={() => {}}
      renderLeaf={leafRender}
    />,
  );
}

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
