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

  it('marks the active cell with the accent ring', async () => {
    renderGrid(['a', 'b'], null, 'b');
    await act(async () => {});
    const active = screen.getAllByTestId('pane-cell').find((c) => c.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('b');
    expect(active?.className).toMatch(/ring-inset/);
  });

  it('fullscreen: focused cell overlays (absolute z-50), others mounted but hidden', async () => {
    renderGrid(['a', 'b'], 'a');
    await act(async () => {});
    const a = screen.getByTestId('leaf-a').closest('[data-testid="pane-cell"]') as HTMLElement;
    const b = screen.getByTestId('leaf-b').closest('[data-testid="pane-cell"]') as HTMLElement;
    expect(a.style.position).toBe('absolute');
    expect(a.style.zIndex).toBe('50');
    expect(b.style.display).toBe('none'); // sibling stays mounted (terminal preserved)
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
