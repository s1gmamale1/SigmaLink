// @vitest-environment jsdom
//
// Minimal-chrome brand bar (2026-07-02 spec). ONE bar for both the empty and
// active-workspace states: rooms menu · Σ monogram · "SigmaLink" wordmark ·
// muted version, with the functional icon cluster right-aligned. The old
// `Workspace N / user — name` text (and the `breadcrumb-empty` testid) are
// retired — there is a single `data-testid="breadcrumb"` for both states.
//
// v1.2.0 Windows port — the WCO padding cases still assert that the bar
// reserves 140px on the right edge under win32 so its right-cluster does not
// collide with the Windows native Window Caption Overlay.
//
// `IS_WIN32` is captured at module-load time inside
// `src/renderer/lib/platform.ts`, so we must stub `window.sigma` BEFORE the
// Breadcrumb module is imported. `vi.resetModules()` between cases ensures a
// fresh evaluation of the platform constant for each platform value.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

interface MockWorkspace {
  id: string;
  name: string;
  rootPath: string;
}

// The version is read once on mount via `rpc.app.getVersion()` and cached in
// local state. Hoisted so the (hoisted) rpc mock factory closes over the same
// fn we drive per-case, and so it survives `vi.resetModules()`.
const versionMock = vi.hoisted(() => vi.fn<() => Promise<string>>());

// Mutable app-state holder — the breadcrumb reads `s.activeWorkspace`. Hoisted
// so the re-run state mock factory (after resetModules) keeps referencing it.
const stateHolder = vi.hoisted(() => ({
  current: { activeWorkspace: null as MockWorkspace | null, workspaces: [] as MockWorkspace[] },
}));

// Shared mocks — none of these touch real RPC / state / Electron.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    app: { getVersion: versionMock },
  },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
}));

vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

vi.mock('@/renderer/app/state', () => ({
  useAppStateSelector: (sel: (s: typeof stateHolder.current) => unknown) => sel(stateHolder.current),
  useAppDispatch: () => vi.fn(),
}));

// The Monogram renders an SVG whose <title> is also "SigmaLink"; stub it to a
// marker so `getByText('SigmaLink')` unambiguously matches the wordmark span.
vi.mock('@/renderer/components/Monogram', () => ({
  Monogram: ({ size }: { size?: number }) => <svg data-testid="monogram" data-size={size} />,
}));

// The RufloReadinessPill + RightRailSwitcher + RoomsMenuButton have their own
// dependency graphs (icons, contexts, RPC). Stub them to lightweight markers —
// these cases care about the wrapper <div> + the brand + the memory-graph gate.
vi.mock('@/renderer/components/RufloReadinessPill', () => ({
  RufloReadinessPill: () => null,
}));
vi.mock('./RoomsMenuButton', () => ({
  RoomsMenuButton: () => null,
}));
vi.mock('./RightRailSwitcher', () => ({
  RightRailSwitcher: () => null,
}));
// v1.4.9 #07 — bell is mounted from Breadcrumb. Stub to a lightweight marker
// so we can assert it renders; the bell's own tests cover the badge math.
vi.mock('@/renderer/features/notifications/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="notification-bell-stub" />,
}));

function stubPlatform(platform: NodeJS.Platform | undefined) {
  // Build a minimal SigmaPreloadApi-shaped stub. The component only reads
  // `window.sigma?.platform`, so the other fields can be no-op functions.
  (window as unknown as { sigma?: { platform?: NodeJS.Platform } & Record<string, unknown> }).sigma =
    platform === undefined
      ? undefined
      : {
          platform,
          invoke: vi.fn(),
          eventOn: vi.fn(() => () => undefined),
          eventSend: vi.fn(),
          getPathForFile: vi.fn(() => ''),
        };
}

async function renderBreadcrumb(
  opts: { platform?: NodeJS.Platform; activeWorkspace?: MockWorkspace | null } = {},
) {
  // `'platform' in opts` distinguishes "not passed → darwin" from an explicit
  // `undefined` (the non-Electron host case), which a default param cannot.
  const platform = 'platform' in opts ? opts.platform : 'darwin';
  const activeWorkspace = opts.activeWorkspace ?? null;
  stubPlatform(platform);
  stateHolder.current = {
    activeWorkspace,
    workspaces: activeWorkspace ? [activeWorkspace] : [],
  };
  // Re-import after platform stubbed so the module-level `IS_WIN32` constant
  // picks up the freshly mocked `window.sigma.platform`.
  vi.resetModules();
  const { Breadcrumb } = await import('./Breadcrumb');
  render(<Breadcrumb />);
}

describe('Breadcrumb — Windows WCO right padding', () => {
  beforeEach(() => {
    versionMock.mockReset().mockResolvedValue('0.0.0');
    stubPlatform(undefined);
  });

  afterEach(() => {
    cleanup();
    stubPlatform(undefined);
  });

  it('reserves 140px right padding when window.sigma.platform === "win32"', async () => {
    await renderBreadcrumb({ platform: 'win32' });
    const bar = screen.getByTestId('breadcrumb');
    // jsdom normalises numeric style values to "140px" strings.
    expect(bar.style.paddingRight).toBe('140px');
  });

  it('does not set paddingRight on darwin', async () => {
    await renderBreadcrumb({ platform: 'darwin' });
    expect(screen.getByTestId('breadcrumb').style.paddingRight).toBe('');
  });

  it('does not set paddingRight on linux', async () => {
    await renderBreadcrumb({ platform: 'linux' });
    expect(screen.getByTestId('breadcrumb').style.paddingRight).toBe('');
  });

  it('falls back to darwin default (no padding) when window.sigma is missing', async () => {
    // Simulates a non-Electron host (Storybook, raw vite preview). The
    // platform helper defaults to 'darwin' which is not win32 → no padding.
    await renderBreadcrumb({ platform: undefined });
    expect(screen.getByTestId('breadcrumb').style.paddingRight).toBe('');
  });

  it('mounts the notification bell (v1.4.9 #07)', async () => {
    await renderBreadcrumb({ platform: 'darwin' });
    expect(screen.getByTestId('notification-bell-stub')).toBeTruthy();
  });
});

describe('Breadcrumb — minimal brand bar', () => {
  const someWorkspace: MockWorkspace = { id: 'ws-1', name: 'demo', rootPath: '/Users/leo/demo' };

  beforeEach(() => {
    versionMock.mockReset().mockResolvedValue('9.9.9');
    stubPlatform(undefined);
  });

  afterEach(() => {
    cleanup();
    stubPlatform(undefined);
  });

  it('renders the brand bar: monogram + wordmark + version', async () => {
    versionMock.mockResolvedValue('9.9.9');
    await renderBreadcrumb();
    expect(screen.getByTestId('monogram')).toBeTruthy();
    expect(screen.getByText('SigmaLink')).toBeTruthy();
    expect(await screen.findByText('v9.9.9')).toBeTruthy();
  });

  it('never renders the old workspace/user text', async () => {
    await renderBreadcrumb({ activeWorkspace: someWorkspace });
    expect(screen.queryByText(/Workspace \d/)).toBeNull();
    expect(screen.queryByText(/No workspace open/)).toBeNull();
  });

  it('renders ONE breadcrumb testid regardless of workspace state', async () => {
    await renderBreadcrumb({ activeWorkspace: null });
    expect(screen.getByTestId('breadcrumb')).toBeTruthy();
    expect(screen.queryByTestId('breadcrumb-empty')).toBeNull();
  });

  it('does NOT render the memory-graph without an active workspace', async () => {
    await renderBreadcrumb({ activeWorkspace: null });
    expect(screen.queryByTestId('breadcrumb-memory-graph')).toBeNull();
  });

  it('renders the memory-graph WITH an active workspace', async () => {
    await renderBreadcrumb({ activeWorkspace: someWorkspace });
    expect(screen.getByTestId('breadcrumb-memory-graph')).toBeTruthy();
  });
});
