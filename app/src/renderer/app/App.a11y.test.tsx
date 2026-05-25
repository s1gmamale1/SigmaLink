// @vitest-environment jsdom
//
// Stage 4 a11y — skip-link + main landmark.
//
// Asserts:
//   - A skip-link <a href="#main"> is the first focusable element rendered
//   - An element with id="main" exists in the document
//
// The full App tree is mocked at the provider/feature level so this test
// has no Electron IPC or heavy native-module dependencies.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// ---- mocks ------------------------------------------------------------------

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    workspaces: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/renderer/lib/themes', () => ({
  applyTheme: vi.fn(),
  DEFAULT_THEME: 'obsidian',
  isThemeId: vi.fn(() => false),
  KV_KEYS: { theme: 'app.theme' },
}));

// Mock AppStateProvider to avoid Electron context-bridge hooks (window.sigma).
// The skip-link and landmark tests only need the rendered DOM structure, not
// real state; mocking AppStateProvider is the same pattern used by
// ThemeProvider.focus.test.tsx which also stubs the provider layer.
vi.mock('@/renderer/app/state', () => ({
  AppStateProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAppState: () => ({ state: { room: 'command' } }),
  useAppDispatch: () => () => undefined,
  useAppStateSelector: (sel: (s: unknown) => unknown) =>
    sel({ room: 'command', sidebarCollapsed: false }),
}));

// Stub every heavy feature import so the test bundle stays tiny.
vi.mock('@/renderer/features/sidebar/Sidebar', () => ({
  Sidebar: () => <nav data-testid="sidebar-stub" />,
}));
vi.mock('@/renderer/features/top-bar/Breadcrumb', () => ({
  Breadcrumb: () => <div data-testid="breadcrumb-stub" />,
}));
vi.mock('@/renderer/features/voice/VoicePill', () => ({
  VoicePill: () => null,
}));
vi.mock('@/renderer/features/command-room/CommandRoom', () => ({
  CommandRoom: () => <div data-testid="command-room-stub" />,
}));
vi.mock('@/renderer/features/command-palette/CommandPalette', () => ({
  CommandPalette: () => null,
}));
vi.mock('@/renderer/features/onboarding/OnboardingModal', () => ({
  OnboardingModal: () => null,
}));
vi.mock('@/renderer/components/NativeRebuildModal', () => ({
  NativeRebuildModal: () => null,
}));
vi.mock('@/renderer/features/right-rail/RightRail', () => ({
  RightRail: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/features/right-rail/RightRailContext', () => ({
  RightRailProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/features/right-rail/use-right-rail-enabled', () => ({
  useRightRailEnabled: () => ({ enabled: false, ready: true }),
}));
vi.mock('sonner', () => ({ Toaster: () => null }));

// ---- import under test ------------------------------------------------------

import App from './App';

// ---- helpers ----------------------------------------------------------------

function renderApp() {
  return render(<App />);
}

// ---- tests ------------------------------------------------------------------

describe('App — Stage 4 a11y: skip-link + main landmark', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a skip-link <a href="#main">', async () => {
    const { container } = renderApp();
    await act(async () => {});

    const skipLink = container.querySelector('a[href="#main"]') as HTMLAnchorElement | null;
    expect(skipLink).not.toBeNull();
    expect(skipLink!.textContent).toMatch(/skip to main/i);
  });

  it('renders an element with id="main"', async () => {
    const { container } = renderApp();
    await act(async () => {});

    const main = container.querySelector('#main');
    expect(main).not.toBeNull();
  });

  it('skip-link is the first focusable element in the tree', async () => {
    const { container } = renderApp();
    await act(async () => {});

    // Collect all elements that are keyboard-focusable (a[href], button,
    // [tabindex]). The skip-link must come before any other focusable element.
    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button, [tabindex]',
    );
    expect(focusable.length).toBeGreaterThan(0);
    expect(focusable[0].tagName.toLowerCase()).toBe('a');
    expect(focusable[0].getAttribute('href')).toBe('#main');
  });

  it('#main element has tabIndex=-1 to accept programmatic focus', async () => {
    const { container } = renderApp();
    await act(async () => {});

    const main = container.querySelector('#main') as HTMLElement | null;
    expect(main).not.toBeNull();
    // tabIndex attribute -1 means focusable via script but not in tab order.
    expect(main!.tabIndex).toBe(-1);
  });
});
