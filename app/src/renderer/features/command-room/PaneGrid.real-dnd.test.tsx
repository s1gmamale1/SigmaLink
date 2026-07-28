// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneGrid } from './PaneGrid';
import { PaneReorderHandle } from './PaneReorderHandle';

const kvGet = vi.fn<(key: string) => Promise<string | null>>();
const kvSet = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpcSilent: {
    kv: {
      get: (key: string) => kvGet(key),
      set: (key: string, value: string) => kvSet(key, value),
    },
  },
}));

function rect(left: number, top = 0, width = 100, height = 100): DOMRect {
  return {
    x: left,
    y: top,
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  kvGet.mockReset().mockResolvedValue(null);
  kvSet.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function getBoundingClientRect(this: HTMLElement) {
      const sessionId = this.getAttribute('data-session-id');
      if (sessionId === 'a') return rect(0);
      if (sessionId === 'b') return rect(100);
      return rect(0, 0, 200, 100);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function grid(
  sessionIds: string[],
  reorderEnabled: boolean,
  onSwapPanes: (source: string, target: string) => boolean,
) {
  return (
    <PaneGrid
      sessionIds={sessionIds}
      activeSessionId="a"
      focusedPaneId={null}
      workspaceId="ws-real-dnd"
      onActivate={() => {}}
      reorderEnabled={reorderEnabled}
      onSwapPanes={onSwapPanes}
      getPaneLabel={(sessionId) => `Pane ${sessionId.toUpperCase()}`}
      renderLeaf={(sessionId) => (
        <PaneReorderHandle
          sessionId={sessionId}
          paneName={`Pane ${sessionId.toUpperCase()}`}
          position={sessionIds.indexOf(sessionId) + 1}
          count={sessionIds.length}
          disabled={!reorderEnabled}
        />
      )}
    />
  );
}

async function beginKeyboardDragToB() {
  const grip = screen.getByRole('button', {
    name: 'Reorder Pane A, position 1 of 2',
  });
  fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
  await screen.findByTestId('pane-reorder-overlay');

  fireEvent.keyDown(document, { key: 'ArrowRight', code: 'ArrowRight' });
  await act(async () => {});
}

describe('PaneGrid real DnD invalidation', () => {
  it('still commits one current keyboard drag to its exact target', async () => {
    const onSwapPanes = vi.fn(() => true);
    render(grid(['a', 'b'], true, onSwapPanes));

    await beginKeyboardDragToB();
    fireEvent.keyDown(document, { key: ' ', code: 'Space' });

    await waitFor(() => {
      expect(onSwapPanes).toHaveBeenCalledTimes(1);
      expect(onSwapPanes).toHaveBeenCalledWith('a', 'b');
    });
  });

  it('does not commit a stale drag after disable then re-enable', async () => {
    const onSwapPanes = vi.fn(() => true);
    const view = render(grid(['a', 'b'], true, onSwapPanes));
    await beginKeyboardDragToB();

    view.rerender(grid(['a', 'b'], false, onSwapPanes));
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    view.rerender(grid(['a', 'b'], true, onSwapPanes));
    await act(async () => {});
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();

    fireEvent.keyDown(document, { key: ' ', code: 'Space' });
    await act(async () => {});
    expect(onSwapPanes).not.toHaveBeenCalled();
  });

  it('does not commit a stale drag after its source is removed then restored', async () => {
    const onSwapPanes = vi.fn(() => true);
    const view = render(grid(['a', 'b'], true, onSwapPanes));
    await beginKeyboardDragToB();

    view.rerender(grid(['b'], true, onSwapPanes));
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    view.rerender(grid(['a', 'b'], true, onSwapPanes));
    await act(async () => {});
    expect(screen.queryByTestId('pane-reorder-overlay')).toBeNull();
    expect(screen.queryByTestId('pane-reorder-shield')).toBeNull();

    fireEvent.keyDown(document, { key: ' ', code: 'Space' });
    await act(async () => {});
    expect(onSwapPanes).not.toHaveBeenCalled();
  });

  it('does not commit a retained sensor completion after PaneGrid unmounts', async () => {
    const onSwapPanes = vi.fn(() => true);
    const originalRemoveEventListener =
      document.removeEventListener.bind(document);
    const retainedKeydownListeners: Array<{
      listener: EventListenerOrEventListenerObject;
      options?: boolean | EventListenerOptions;
    }> = [];
    vi.spyOn(document, 'removeEventListener').mockImplementation(
      (type, listener, options) => {
        if (type === 'keydown') {
          retainedKeydownListeners.push({ listener, options });
          return;
        }
        originalRemoveEventListener(type, listener, options);
      },
    );

    const view = render(grid(['a', 'b'], true, onSwapPanes));
    await beginKeyboardDragToB();
    view.unmount();

    try {
      fireEvent.keyDown(document, { key: ' ', code: 'Space' });
      await act(async () => {});
      expect(onSwapPanes).not.toHaveBeenCalled();
    } finally {
      for (const { listener, options } of retainedKeydownListeners) {
        originalRemoveEventListener('keydown', listener, options);
      }
    }
  });
});
