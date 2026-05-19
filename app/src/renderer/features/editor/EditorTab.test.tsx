// @vitest-environment jsdom
//
// v1.4.8 packet-02 — EditorTab sidebar resize handle coverage.
//
// Asserts:
//   - On mount, kv.get is called and the persisted width is applied to the aside
//   - A synthetic pointerdown → pointermove → pointerup sequence updates the
//     aside width and calls kv.set with the final value
//   - Double-click on the divider resets width to 240 and persists it

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

// Monaco lazy import would fail in jsdom; stub it out.
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
}));

// FileTree calls rpc internally; stub the whole module.
vi.mock('./FileTree', () => ({
  FileTree: () => <div data-testid="file-tree" />,
}));

const kvGetMock = vi.fn<(key: string) => Promise<string | null>>();
const kvSetMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: (key: string) => kvGetMock(key),
      set: (key: string, value: string) => kvSetMock(key, value),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/renderer/app/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

// Provide a workspace so the non-empty branch renders.
const mockWorkspace = {
  id: 'ws-1',
  name: 'Test WS',
  rootPath: '/tmp/ws',
  repoRoot: '/tmp/ws',
  repoMode: 'git' as const,
  createdAt: 0,
  lastOpenedAt: 0,
};

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { activeWorkspace: mockWorkspace },
  }),
  useAppDispatch: () => vi.fn(),
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ activeWorkspace: mockWorkspace }),
}));

// useEditor — return minimal shape so the "no file open" branch renders
// (avoids the need to set up Monaco).
vi.mock('./useEditor', () => ({
  useEditor: () => ({
    file: null,
    buffer: '',
    setBuffer: vi.fn(),
    dirty: false,
    loading: false,
    error: null,
    open: vi.fn(),
    save: vi.fn(),
  }),
  EDITOR_FOCUS_EVENT: 'editor:focus',
}));

// ---- helpers -------------------------------------------------------------

import { EditorTab } from './EditorTab';

function renderTab() {
  return render(<EditorTab />);
}

// ---- tests ---------------------------------------------------------------

describe('EditorTab — v1.4.8 sidebar resize', () => {
  beforeEach(() => {
    kvGetMock.mockReset();
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockReset();
    kvSetMock.mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback) => {
        cb(performance.now());
        return 1 as unknown as number;
      },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    delete document.body.dataset.dragging;
    vi.restoreAllMocks();
  });

  it('renders the file-tree aside with default width 240 when kv returns null', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});
    const aside = container.querySelector('aside');
    expect(aside).toBeTruthy();
    expect(aside!.style.width).toBe('240px');
  });

  it('applies persisted width from kv on mount', async () => {
    kvGetMock.mockResolvedValue('320');
    const { container } = renderTab();
    // Flush the useEffect kv.get Promise.
    await act(async () => {});
    const aside = container.querySelector('aside');
    expect(aside!.style.width).toBe('320px');
  });

  it('ignores out-of-range kv values and keeps default', async () => {
    kvGetMock.mockResolvedValue('9999');
    const { container } = renderTab();
    await act(async () => {});
    const aside = container.querySelector('aside');
    expect(aside!.style.width).toBe('240px');
  });

  it('drag sequence updates width and persists final value via kv.set', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    expect(divider).toBeTruthy();

    // Drag: start at x=0, move +80px → width should be 240+80=320.
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    expect(document.body.dataset.dragging).toBe('true');

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 0 }));

    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('320px');

    // pointerup should persist and clear dragging flag.
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(document.body.dataset.dragging).toBeUndefined();
    expect(kvSetMock).toHaveBeenCalledWith('editor.sidebar.width', '320');
  });

  it('clamps width to minimum (160px) when dragged too far left', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    // Move -200px from start (240-200 = 40, below min 160).
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: -200, clientY: 0 }));
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('160px');

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('editor.sidebar.width', '160');
  });

  it('clamps width to maximum (600px) when dragged too far right', async () => {
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 0 }));
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('600px');

    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(kvSetMock).toHaveBeenCalledWith('editor.sidebar.width', '600');
  });

  it('double-click on divider resets width to 240 and persists it', async () => {
    kvGetMock.mockResolvedValue('400');
    const { container } = renderTab();
    await act(async () => {});

    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.style.width).toBe('400px');

    const divider = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.doubleClick(divider);
    await act(async () => {});

    expect(aside.style.width).toBe('240px');
    expect(kvSetMock).toHaveBeenCalledWith('editor.sidebar.width', '240');
  });
});
