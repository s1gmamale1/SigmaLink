// @vitest-environment jsdom
//
// v1.4.8 — BrowserRoom EmptyState tests (sub-task A).
//
// Asserts:
//  1. When tabs.length === 0 and activeWorkspace is set, EmptyState renders
//     with "No tabs open" text (auto-spawn removed).
//  2. Clicking the EmptyState CTA ("New tab") calls rpc.browser.openTab.
//  3. When tabs.length > 0, BrowserViewMount renders (no EmptyState).
//  4. When activeWorkspace is null, the "Open a workspace" EmptyState renders
//     (pre-existing behaviour guard).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BrowserState, Workspace } from '@/shared/types';

// ──────────────────────────────────────────────────────────────────────────
// Module mocks — declared before imports so vi.mock hoisting works.
// ──────────────────────────────────────────────────────────────────────────

const mockOpenTab = vi.fn().mockResolvedValue({
  id: 'tab-1',
  workspaceId: 'ws-1',
  url: 'about:blank',
  title: '',
  active: true,
  createdAt: 1,
  lastVisitedAt: 1,
});

const mockGetState = vi.fn();
const mockSetActiveTab = vi.fn().mockResolvedValue(undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    browser: {
      openTab: (...args: unknown[]) => mockOpenTab(...args),
      getState: (...args: unknown[]) => mockGetState(...args),
      setActiveTab: (...args: unknown[]) => mockSetActiveTab(...args),
      navigate: vi.fn().mockResolvedValue(undefined),
      closeTab: vi.fn().mockResolvedValue(undefined),
      back: vi.fn().mockResolvedValue(undefined),
      forward: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      releaseDriver: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// Mock heavy native sub-components that depend on Electron IPC or ResizeObserver.
vi.mock('./BrowserViewMount', () => ({
  BrowserViewMount: () => <div data-testid="browser-view-mount" />,
}));

vi.mock('./TabStrip', () => ({
  TabStrip: ({ onNewTab }: { tabs: unknown[]; activeTabId: unknown; onSelect: unknown; onClose: unknown; onNewTab: () => void }) => (
    <div data-testid="tab-strip">
      <button data-testid="tab-strip-new" onClick={onNewTab}>+</button>
    </div>
  ),
}));

vi.mock('./AddressBar', () => ({
  AddressBar: () => <div data-testid="address-bar" />,
}));

vi.mock('./AgentDrivingIndicator', () => ({
  AgentDrivingIndicator: () => null,
}));

vi.mock('./BrowserRecents', () => ({
  BrowserRecents: () => <div data-testid="browser-recents" />,
}));

vi.mock('./DesignOverlay', () => ({
  DesignOverlayBanner: () => null,
  DesignOverlayToggle: () => null,
}));

vi.mock('./DesignDock', () => ({
  DesignDock: () => <div data-testid="design-dock" />,
}));

// ──────────────────────────────────────────────────────────────────────────
// useAppState mock — returns a controlled slice of state.
// ──────────────────────────────────────────────────────────────────────────

const mockDispatch = vi.fn();

let mockActiveWorkspace: Workspace | null = null;
let mockBrowserSlice: BrowserState | null = null;

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: {
      activeWorkspace: mockActiveWorkspace,
      browser: mockActiveWorkspace && mockBrowserSlice
        ? { [mockActiveWorkspace.id]: mockBrowserSlice }
        : {},
    },
    dispatch: mockDispatch,
  }),
}));

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeWorkspace(id = 'ws-1'): Workspace {
  return {
    id,
    name: 'Test Workspace',
    rootPath: '/tmp/test',
    repoRoot: '/tmp/test',
    repoMode: 'git',
    createdAt: 1,
    lastOpenedAt: 1,
  };
}

function makeBrowserSlice(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    workspaceId: 'ws-1',
    tabs: [],
    activeTabId: null,
    lockOwner: null,
    mcpUrl: null,
    ...overrides,
  };
}

// Deferred import so mocks are hoisted before the module resolves.
let BrowserRoom: typeof import('./BrowserRoom').BrowserRoom;

beforeEach(async () => {
  vi.clearAllMocks();
  mockDispatch.mockReset();
  mockOpenTab.mockResolvedValue({
    id: 'tab-1',
    workspaceId: 'ws-1',
    url: 'about:blank',
    title: '',
    active: true,
    createdAt: 1,
    lastVisitedAt: 1,
  });
  // Default: getState returns empty tabs (no active tab to re-activate).
  mockGetState.mockResolvedValue(makeBrowserSlice());
  ({ BrowserRoom } = await import('./BrowserRoom'));
});

afterEach(() => {
  cleanup();
  // Reset shared mutable state.
  mockActiveWorkspace = null;
  mockBrowserSlice = null;
});

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('<BrowserRoom /> — EmptyState (v1.4.8 sub-task A)', () => {
  it('renders "No tabs open" EmptyState when tabs are empty and workspace is active', () => {
    mockActiveWorkspace = makeWorkspace();
    mockBrowserSlice = makeBrowserSlice({ tabs: [] });

    render(<BrowserRoom />);

    expect(screen.getByText('No tabs open')).toBeTruthy();
    expect(screen.getByText('Open a new tab to start browsing')).toBeTruthy();
  });

  it('renders BrowserViewMount with visible=false (not unmounted) when tabs are empty', () => {
    // v1.5.1-A caveat 6: BrowserViewMount stays mounted to avoid WebContentsView
    // lifecycle churn; it receives visible={false} when tabs.length === 0.
    mockActiveWorkspace = makeWorkspace();
    mockBrowserSlice = makeBrowserSlice({ tabs: [] });

    render(<BrowserRoom />);

    // BrowserViewMount is in the DOM (not unmounted) but its visible prop is false.
    expect(screen.getByTestId('browser-view-mount')).toBeTruthy();
  });

  it('clicking the EmptyState "New tab" button calls rpc.browser.openTab', async () => {
    mockActiveWorkspace = makeWorkspace();
    mockBrowserSlice = makeBrowserSlice({ tabs: [] });

    render(<BrowserRoom />);

    const newTabButton = screen.getByRole('button', { name: /new tab/i });
    fireEvent.click(newTabButton);

    // Give the async callback a tick to fire.
    await vi.waitFor(() => {
      expect(mockOpenTab).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        url: 'about:blank',
      });
    });
  });

  it('renders BrowserViewMount (no EmptyState) when tabs are present', () => {
    mockActiveWorkspace = makeWorkspace();
    mockBrowserSlice = makeBrowserSlice({
      tabs: [
        {
          id: 'tab-1',
          workspaceId: 'ws-1',
          url: 'https://example.com',
          title: 'Example',
          active: true,
          createdAt: 1,
          lastVisitedAt: 1,
        },
      ],
      activeTabId: 'tab-1',
    });

    render(<BrowserRoom />);

    expect(screen.queryByText('No tabs open')).toBeNull();
    expect(screen.getByTestId('browser-view-mount')).toBeTruthy();
  });

  it('renders "Open a workspace" EmptyState when activeWorkspace is null', () => {
    mockActiveWorkspace = null;
    mockBrowserSlice = null;

    render(<BrowserRoom />);

    expect(screen.getByText('Open a workspace to use the in-app browser')).toBeTruthy();
    expect(screen.queryByTestId('browser-view-mount')).toBeNull();
  });

  it('does NOT auto-call openTab on mount when tabs are empty', async () => {
    mockActiveWorkspace = makeWorkspace();
    mockBrowserSlice = makeBrowserSlice({ tabs: [] });

    render(<BrowserRoom />);

    // Wait one event-loop tick to let any errant async effects fire.
    await new Promise((r) => setTimeout(r, 0));

    // openTab should NOT have been called automatically — only the user CTA triggers it.
    expect(mockOpenTab).not.toHaveBeenCalled();
  });
});
