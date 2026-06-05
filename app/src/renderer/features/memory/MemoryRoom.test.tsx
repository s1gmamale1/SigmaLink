// @vitest-environment jsdom
//
// Stage-4 UX — MemoryRoom no longer calls window.alert on create failure;
// instead it renders an ErrorBanner that can be dismissed.
//
// RSP-1 — the List tab is a horizontal resizable tri-column whose sizes are
// hydrated from / persisted to per-workspace UI KV, and collapses to a single
// (editor) column below the `narrow` breakpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// UX-3 — the new-note flow now opens a themed PromptDialog (not window.prompt).
// This helper opens it, types the name, and clicks Create.
async function createNote(name: string): Promise<void> {
  // The List tab's note-list mounts only after the per-workspace layout
  // hydrates (RSP-1), so wait for the create affordance rather than read it
  // synchronously.
  const createBtn = await screen.findByRole('button', { name: /create note/i });
  fireEvent.click(createBtn);
  const dialog = await waitFor(() => screen.getByRole('dialog'));
  const input = within(dialog).getByRole('textbox');
  fireEvent.change(input, { target: { value: name } });
  const submit = within(dialog).getByRole('button', { name: /create/i });
  fireEvent.click(submit);
}

// ---- mocks -----------------------------------------------------------------

const createMemoryMock = vi.fn();
const initHubMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    memory: {
      init_hub: () => initHubMock(),
      create_memory: (...args: unknown[]) => createMemoryMock(...args),
      getGraph: vi.fn().mockResolvedValue(null),
    },
  },
  onEvent: vi.fn(() => () => undefined),
  rpcSilent: {
    ruflo: { health: vi.fn().mockResolvedValue({ state: 'absent' }) },
  },
}));

// RSP-1 — mock the per-workspace UI KV so hydration is controllable and the
// debounced persist write is observable without driving real RPC.
const readWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<string | null>>();
const writeWorkspaceUiMock = vi.fn<(...a: unknown[]) => Promise<void>>();

vi.mock('@/renderer/lib/workspace-ui-kv', () => ({
  readWorkspaceUi: (...args: unknown[]) => readWorkspaceUiMock(...args),
  writeWorkspaceUi: (...args: unknown[]) => writeWorkspaceUiMock(...args),
}));

// Wrap the real resizable primitives so the group still renders all three
// regions (the structural assertions rely on the live DOM), while capturing
// the latest `onLayoutChanged` prop — jsdom can't fire a measured layout, so
// the persist test invokes it directly with a Layout map.
type LayoutMap = Record<string, number>;
let lastOnLayoutChanged: ((layout: LayoutMap) => void) | undefined;
vi.mock('@/components/ui/resizable', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/resizable')>(
    '@/components/ui/resizable',
  );
  return {
    ...actual,
    ResizablePanelGroup: (props: Record<string, unknown>) => {
      lastOnLayoutChanged = props.onLayoutChanged as ((l: LayoutMap) => void) | undefined;
      return actual.ResizablePanelGroup(props as never);
    },
  };
});

const mockDispatch = vi.fn();
const mockWorkspace = {
  id: 'ws-test',
  name: 'Test WS',
  rootPath: '/tmp',
  repoRoot: null,
  repoMode: 'git' as const,
  createdAt: 0,
  lastOpenedAt: 0,
};

const mockState = {
  activeWorkspace: mockWorkspace,
  activeWorkspaceId: mockWorkspace.id,
  memories: { 'ws-test': [] as never[] },
  activeMemoryName: { 'ws-test': null as string | null },
  memoryGraph: { 'ws-test': null as null },
  pendingRufloView: null as null,
};

vi.mock('@/renderer/app/state', () => ({
  useAppState: vi.fn(() => ({ state: mockState, dispatch: mockDispatch })),
  useAppDispatch: vi.fn(() => mockDispatch),
  useAppStateSelector: vi.fn((selector: (s: typeof mockState) => unknown) =>
    selector(mockState),
  ),
}));

/** Force a viewport width for the `useBelowBreakpoint('narrow')` hook (<900px). */
function setViewportWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

// react-resizable-panels v4 uses ResizeObserver + matchMedia in a layout
// effect; jsdom provides neither. Stub them so the group can mount (we assert
// the data/branch path, not measured pixel sizes — see the RSP-1 brief note).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  setViewportWidth(1400); // wide by default → tri-column path
  readWorkspaceUiMock.mockResolvedValue(null); // → DEFAULT_COLS
  writeWorkspaceUiMock.mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  if (typeof window.matchMedia !== 'function') {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  lastOnLayoutChanged = undefined;
});

import { MemoryRoom } from './MemoryRoom';

describe('MemoryRoom — Stage-4 UX', () => {
  it('does NOT call window.alert when create_memory rejects', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    // Trigger create via the themed prompt dialog.
    await createNote('my-note');

    await waitFor(() => {
      expect(alertSpy).not.toHaveBeenCalled();
    });

    alertSpy.mockRestore();
  });

  it('renders ErrorBanner after create_memory rejects', async () => {
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    await createNote('my-note');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
      expect(screen.getByText(/Duplicate name/i)).toBeDefined();
    });
  });

  it('ErrorBanner can be dismissed', async () => {
    createMemoryMock.mockRejectedValue(new Error('Duplicate name'));

    render(<MemoryRoom />);

    await createNote('my-note');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });

    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('MemoryRoom — RSP-1 resizable tri-column', () => {
  it('renders all three regions inside the resizable group after hydration', async () => {
    render(<MemoryRoom />);

    // Hydration resolves → resizable group mounts.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="resizable-panel-group"]')).not.toBeNull();
    });

    const group = document.querySelector('[data-slot="resizable-panel-group"]') as HTMLElement;

    // Left region: tag facets + the note list's "Create note" affordance.
    expect(within(group).getByTestId('tags-pane')).toBeDefined();
    expect(within(group).getByRole('button', { name: /create note/i })).toBeDefined();
    // Editor region: empty-state copy (no active note in the mock).
    expect(within(group).getByText(/select or create a note/i)).toBeDefined();
    // Right region: the assist panel (Backlinks self-hides with no active note).
    expect(within(group).getByTestId('memory-assist-panel')).toBeDefined();

    // Two handles between the three panels.
    expect(group.querySelectorAll('[data-slot="resizable-handle"]').length).toBe(2);
  });

  it('hydrates panel sizes from stored memory.cols', async () => {
    readWorkspaceUiMock.mockResolvedValue(JSON.stringify([30, 50, 20]));

    render(<MemoryRoom />);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="resizable-panel-group"]')).not.toBeNull();
    });

    // Read was issued for this workspace's `memory.cols` panel.
    expect(readWorkspaceUiMock).toHaveBeenCalledWith('ws-test', 'memory.cols');
  });

  it('persists a layout change (debounced) via writeWorkspaceUi', async () => {
    render(<MemoryRoom />);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="resizable-panel-group"]')).not.toBeNull();
    });

    // react-resizable-panels needs a measured (sized) container to fire a real
    // `onLayoutChanged`; jsdom has none, so we exercise the persist DATA path
    // by invoking the live group's captured `onLayoutChanged` with a Layout
    // map. This verifies the map → panel-ordered `number[]` mapping + the
    // persist key, independent of pixel math (per the RSP-1 jsdom note).
    expect(typeof lastOnLayoutChanged).toBe('function');
    lastOnLayoutChanged?.({ 'mem-left': 30, 'mem-editor': 50, 'mem-right': 20 });

    // The debounced write lands with the right workspace, panel key, and a
    // 3-element number[] in [left, editor, right] order.
    await waitFor(() => {
      expect(writeWorkspaceUiMock).toHaveBeenCalledWith(
        'ws-test',
        'memory.cols',
        JSON.stringify([30, 50, 20]),
      );
    });

    // Never written under a wrong key.
    for (const call of writeWorkspaceUiMock.mock.calls) {
      expect(call[1]).toBe('memory.cols');
    }
  });

  it('renders only the editor (single column) below the narrow breakpoint', async () => {
    setViewportWidth(700); // < 900 → narrow

    render(<MemoryRoom />);

    // No resizable group in the narrow layout.
    await waitFor(() => {
      expect(screen.getByText(/select or create a note/i)).toBeDefined();
    });
    expect(document.querySelector('[data-slot="resizable-panel-group"]')).toBeNull();
    // The side regions are not rendered in the collapsed layout.
    expect(screen.queryByTestId('tags-pane')).toBeNull();
    expect(screen.queryByTestId('memory-assist-panel')).toBeNull();
  });
});
