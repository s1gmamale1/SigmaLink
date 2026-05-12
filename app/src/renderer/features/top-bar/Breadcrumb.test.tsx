// @vitest-environment jsdom
//
// v1.2.0 Windows port — verifies the Breadcrumb reserves 140px on the right
// edge when running under Windows so its right-cluster (RightRailSwitcher +
// settings gear) does not collide with the Windows native Window Caption
// Overlay (min / max / close buttons).
//
// `IS_WIN32` is captured at module-load time inside
// `src/renderer/lib/platform.ts`, so we must stub `window.sigma` BEFORE the
// Breadcrumb module is imported. `vi.resetModules()` between cases ensures a
// fresh evaluation of the platform constant for each platform value.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Shared mocks — none of these touch real RPC / state / Electron.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  rpcSilent: { kv: { get: vi.fn().mockResolvedValue(null) } },
}));

vi.mock('@/renderer/lib/drag-region', () => ({
  dragStyle: () => ({}),
  noDragStyle: () => ({}),
}));

vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({
    state: { workspaces: [], activeWorkspace: null },
    dispatch: vi.fn(),
  }),
}));

// The RufloReadinessPill + RightRailSwitcher + RoomsMenuButton have their own
// dependency graphs (icons, contexts, RPC). Stub them to lightweight markers —
// this test cares about the wrapper <div>'s inline style only.
vi.mock('@/renderer/components/RufloReadinessPill', () => ({
  RufloReadinessPill: () => null,
}));
vi.mock('./RoomsMenuButton', () => ({
  RoomsMenuButton: () => null,
}));
vi.mock('./RightRailSwitcher', () => ({
  RightRailSwitcher: () => null,
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

async function loadBreadcrumb() {
  // Re-import after platform stubbed so the module-level `IS_WIN32` constant
  // picks up the freshly mocked `window.sigma.platform`.
  vi.resetModules();
  const mod = await import('./Breadcrumb');
  return mod.Breadcrumb;
}

describe('Breadcrumb — Windows WCO right padding', () => {
  beforeEach(() => {
    stubPlatform(undefined);
  });

  afterEach(() => {
    cleanup();
    stubPlatform(undefined);
  });

  it('reserves 140px right padding when window.sigma.platform === "win32"', async () => {
    stubPlatform('win32');
    const Breadcrumb = await loadBreadcrumb();
    render(<Breadcrumb />);

    // No active workspace → render the empty-state bar (testid="breadcrumb-empty").
    const bar = screen.getByTestId('breadcrumb-empty');
    // jsdom normalises numeric style values to "140px" strings.
    expect(bar.style.paddingRight).toBe('140px');
  });

  it('does not set paddingRight on darwin', async () => {
    stubPlatform('darwin');
    const Breadcrumb = await loadBreadcrumb();
    render(<Breadcrumb />);

    const bar = screen.getByTestId('breadcrumb-empty');
    expect(bar.style.paddingRight).toBe('');
  });

  it('does not set paddingRight on linux', async () => {
    stubPlatform('linux');
    const Breadcrumb = await loadBreadcrumb();
    render(<Breadcrumb />);

    const bar = screen.getByTestId('breadcrumb-empty');
    expect(bar.style.paddingRight).toBe('');
  });

  it('falls back to darwin default (no padding) when window.sigma is missing', async () => {
    // Simulates a non-Electron host (Storybook, raw vite preview). The
    // platform helper defaults to 'darwin' which is not win32 → no padding.
    stubPlatform(undefined);
    const Breadcrumb = await loadBreadcrumb();
    render(<Breadcrumb />);

    const bar = screen.getByTestId('breadcrumb-empty');
    expect(bar.style.paddingRight).toBe('');
  });
});
