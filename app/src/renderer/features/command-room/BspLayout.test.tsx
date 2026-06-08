// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null);
const kvSet = vi.fn<(k: string, v: string) => Promise<void>>().mockResolvedValue(undefined);
vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: { kv: { get: (k: string) => kvGet(k), set: (k: string, v: string) => kvSet(k, v) } },
}));
vi.mock('@/renderer/lib/motion', () => ({ prefersReducedMotion: () => true }));

import { BspLayout } from './BspLayout';

const leafRender = (id: string) => <div data-testid={`leaf-${id}`}>{id}</div>;

beforeEach(() => {
  kvGet.mockReset().mockResolvedValue(null);
  kvSet.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderLayout(ids: string[], focusedPaneId: string | null = null) {
  return render(
    <BspLayout
      sessionIds={ids}
      activeSessionId={ids[0] ?? null}
      focusedPaneId={focusedPaneId}
      workspaceId="ws1"
      onActivate={() => {}}
      renderLeaf={leafRender}
    />,
  );
}

describe('BspLayout', () => {
  it('renders a leaf per session', async () => {
    renderLayout(['a', 'b', 'c']);
    await act(async () => {});
    expect(screen.getByTestId('leaf-a')).toBeTruthy();
    expect(screen.getByTestId('leaf-b')).toBeTruthy();
    expect(screen.getByTestId('leaf-c')).toBeTruthy();
  });

  it('renders N-1 dividers for N panes', async () => {
    renderLayout(['a', 'b', 'c']);
    await act(async () => {});
    expect(screen.getAllByTestId('bsp-divider')).toHaveLength(2);
  });

  it('renders only the focused leaf when fullscreen, others kept mounted', async () => {
    renderLayout(['a', 'b'], 'a');
    await act(async () => {});
    // both leaves stay mounted (terminal-cache contract); non-focused is display:none
    const b = screen.getByTestId('leaf-b');
    expect(b).toBeTruthy();
    const hiddenHost = b.closest('[data-bsp-hidden="true"]');
    expect(hiddenHost).not.toBeNull();
  });

  it('persists the tree to KV after a structural change', async () => {
    const { rerender } = renderLayout(['a']);
    await act(async () => {});
    rerender(
      <BspLayout
        sessionIds={['a', 'b']}
        activeSessionId="a"
        focusedPaneId={null}
        workspaceId="ws1"
        onActivate={() => {}}
        renderLeaf={leafRender}
      />,
    );
    await act(async () => {});
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(kvSet).toHaveBeenCalledWith('bsp.tree.ws1', expect.stringContaining('"b"'));
  });

  it('seeds the tree from a persisted KV blob', async () => {
    kvGet.mockResolvedValue(
      JSON.stringify({
        type: 'split',
        dir: 'h',
        ratio: 0.3,
        a: { type: 'leaf', sessionId: 'a' },
        b: { type: 'leaf', sessionId: 'b' },
      }),
    );
    renderLayout(['a', 'b']);
    await act(async () => {});
    expect(screen.getByTestId('bsp-divider').getAttribute('data-dir')).toBe('h');
  });
});
