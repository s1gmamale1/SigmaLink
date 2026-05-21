// @vitest-environment jsdom
//
// v1.4.8 packet-02 — EditorTab sidebar resize handle coverage.
// W-8 — Root selector: worktree browsing, KV persistence, follow-focused-pane.
//
// Asserts:
//   - On mount, kv.get is called and the persisted width is applied to the aside
//   - A synthetic pointerdown → pointermove → pointerup sequence updates the
//     aside width and calls kv.set with the final value
//   - Double-click on the divider resets width to 240 and persists it
//   - Root selector lists workspace root + pane worktrees (W-8)
//   - Selecting a pane root re-roots FileTree (W-8)
//   - "Follow focused pane" switches root on focus change (W-8)
//   - KV persistence round-trips for root selection (W-8)
//   - Default 'workspace' = unchanged behavior for users without worktrees (W-8)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

// ---- mocks ---------------------------------------------------------------

// Monaco lazy import would fail in jsdom; stub it out.
vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco" />,
}));

// FileTree calls rpc internally; stub the whole module.
vi.mock('./FileTree', () => ({
  FileTree: ({ rootPath }: { rootPath: string }) => (
    <div data-testid="file-tree" data-root={rootPath} />
  ),
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

// W-8 — Two mock sessions carrying worktreePaths.
const mockSession1 = {
  id: 'sess-1',
  workspaceId: 'ws-1',
  providerId: 'claude',
  cwd: '/tmp/ws/.worktrees/feat-x',
  branch: 'feat/x',
  status: 'running' as const,
  startedAt: 0,
  worktreePath: '/tmp/ws/.worktrees/feat-x',
};

const mockSession2 = {
  id: 'sess-2',
  workspaceId: 'ws-1',
  providerId: 'codex',
  cwd: '/tmp/ws/.worktrees/feat-y',
  branch: 'feat/y',
  status: 'running' as const,
  startedAt: 0,
  worktreePath: '/tmp/ws/.worktrees/feat-y',
};

// Build a mock state factory so individual tests can override sessions /
// activeSessionId without re-hoisting the entire vi.mock call.
type MockStateOverride = {
  sessions?: typeof mockSession1[];
  activeSessionId?: string | null;
};

let mockStateOverride: MockStateOverride = {};

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: {
      activeWorkspace: mockWorkspace,
      sessions: mockStateOverride.sessions ?? [],
      activeSessionId: mockStateOverride.activeSessionId ?? null,
    },
  }),
  useAppDispatch: () => vi.fn(),
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({
      activeWorkspace: mockWorkspace,
      sessions: mockStateOverride.sessions ?? [],
      activeSessionId: mockStateOverride.activeSessionId ?? null,
    }),
}));

// useEditor — return minimal shape so the "no file open" branch renders
// (avoids the need to set up Monaco).
const saveMock = vi.fn();
vi.mock('./useEditor', () => ({
  useEditor: () => ({
    file: null,
    buffer: '',
    setBuffer: vi.fn(),
    dirty: false,
    loading: false,
    error: null,
    open: vi.fn(),
    save: saveMock,
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
    mockStateOverride = {};
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

// W-8 root selector tests.
describe('EditorTab — W-8 root selector', () => {
  beforeEach(() => {
    mockStateOverride = {};
    kvGetMock.mockReset();
    kvGetMock.mockResolvedValue(null);
    kvSetMock.mockReset();
    kvSetMock.mockResolvedValue(undefined);
    saveMock.mockReset();
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback) => { cb(performance.now()); return 1 as unknown as number; },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('no selector rendered when there are no pane worktrees (default behavior unchanged)', async () => {
    mockStateOverride = { sessions: [], activeSessionId: null };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});
    // No <select> rendered when paneWorktrees is empty.
    expect(container.querySelector('select[aria-label="File tree root"]')).toBeNull();
    // FileTree receives the workspace root.
    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    expect(tree.dataset.root).toBe('/tmp/ws');
  });

  it('selector rendered with workspace root + pane worktrees when sessions have worktreePaths', async () => {
    mockStateOverride = {
      sessions: [mockSession1, mockSession2],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    expect(sel).toBeTruthy();

    const options = Array.from(sel.options).map((o) => o.value);
    expect(options).toContain('workspace');
    expect(options).toContain('follow');
    expect(options).toContain('/tmp/ws/.worktrees/feat-x');
    expect(options).toContain('/tmp/ws/.worktrees/feat-y');
  });

  it('FileTree defaults to workspace root when selection is "workspace"', async () => {
    mockStateOverride = {
      sessions: [mockSession1],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    expect(tree.dataset.root).toBe('/tmp/ws');
  });

  it('selecting a specific pane worktree re-roots FileTree', async () => {
    mockStateOverride = {
      sessions: [mockSession1],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: '/tmp/ws/.worktrees/feat-x' } });
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    expect(tree.dataset.root).toBe('/tmp/ws/.worktrees/feat-x');
    // Selection persisted to KV.
    expect(kvSetMock).toHaveBeenCalledWith(
      'editor.ws-1.rootSelection',
      '/tmp/ws/.worktrees/feat-x',
    );
  });

  it('"Follow focused pane" sets root to active session worktreePath', async () => {
    mockStateOverride = {
      sessions: [mockSession1],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'follow' } });
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    // Should follow the active session's worktreePath.
    expect(tree.dataset.root).toBe('/tmp/ws/.worktrees/feat-x');
    expect(kvSetMock).toHaveBeenCalledWith('editor.ws-1.rootSelection', 'follow');
  });

  it('"Follow focused pane" falls back to workspace root when active session has no worktreePath', async () => {
    const sessionNoWorktree = { ...mockSession1, worktreePath: null };
    mockStateOverride = {
      sessions: [sessionNoWorktree as typeof mockSession1],
      activeSessionId: 'sess-1',
    };
    // We need at least one pane WITH worktreePath for the selector to render.
    // Add a second session that has a worktree.
    mockStateOverride.sessions = [
      sessionNoWorktree as typeof mockSession1,
      mockSession2,
    ];
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'follow' } });
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    // Active session (sess-1) has no worktreePath → fallback to workspace root.
    expect(tree.dataset.root).toBe('/tmp/ws');
  });

  it('KV persistence: hydrates persisted root selection on mount', async () => {
    mockStateOverride = {
      sessions: [mockSession1],
      activeSessionId: 'sess-1',
    };
    // Simulate persisted value of feat-x worktree.
    kvGetMock.mockImplementation((key) => {
      if (key === 'editor.ws-1.rootSelection') {
        return Promise.resolve('/tmp/ws/.worktrees/feat-x');
      }
      return Promise.resolve(null);
    });

    const { container } = renderTab();
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    expect(tree.dataset.root).toBe('/tmp/ws/.worktrees/feat-x');

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    expect(sel.value).toBe('/tmp/ws/.worktrees/feat-x');
  });

  it('KV persistence: defaults to workspace when stored value is missing', async () => {
    mockStateOverride = {
      sessions: [mockSession1],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const tree = container.querySelector('[data-testid="file-tree"]') as HTMLElement;
    expect(tree.dataset.root).toBe('/tmp/ws');
  });

  it('deduplicated pane worktrees: two sessions with same worktreePath show one option', async () => {
    const dupSession = { ...mockSession2, id: 'sess-3', worktreePath: mockSession1.worktreePath };
    mockStateOverride = {
      sessions: [mockSession1, dupSession],
      activeSessionId: 'sess-1',
    };
    kvGetMock.mockResolvedValue(null);
    const { container } = renderTab();
    await act(async () => {});

    const sel = container.querySelector('select[aria-label="File tree root"]') as HTMLSelectElement;
    const worktreeOptions = Array.from(sel.options).filter(
      (o) => o.value === '/tmp/ws/.worktrees/feat-x',
    );
    // Only one option for the deduplicated worktreePath.
    expect(worktreeOptions).toHaveLength(1);
  });
});
