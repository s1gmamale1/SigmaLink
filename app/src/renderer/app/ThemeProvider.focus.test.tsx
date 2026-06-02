// @vitest-environment jsdom
//
// C2 — ThemeProvider window focus/blur → data-window-focused.
//
// Asserts:
//   - blur event → dataset.windowFocused === 'false'
//   - focus event → dataset.windowFocused === 'true'
//   - listeners are removed after unmount (no calls after cleanup)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

// ---- mocks ------------------------------------------------------------------

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@/renderer/lib/themes', () => ({
  applyTheme: vi.fn(),
  DEFAULT_THEME: 'obsidian',
  isThemeId: vi.fn(() => false),
  // P5.2 density — ThemeProvider now also hydrates/applies density on mount.
  applyDensity: vi.fn(),
  DEFAULT_DENSITY: 'comfortable',
  isDensityId: vi.fn(() => false),
  KV_KEYS: { theme: 'app.theme', density: 'app.density' },
}));

// ---- import under test ------------------------------------------------------

import { ThemeProvider } from './ThemeProvider';

// ---- helpers ----------------------------------------------------------------

function renderProvider() {
  return render(
    <ThemeProvider>
      <div data-testid="child" />
    </ThemeProvider>,
  );
}

// ---- tests ------------------------------------------------------------------

describe('ThemeProvider — C2 window focus/blur → data-window-focused', () => {
  afterEach(() => {
    cleanup();
    // Reset the attribute between tests so state doesn't bleed.
    delete document.documentElement.dataset.windowFocused;
  });

  it('sets data-window-focused to "false" on window blur', async () => {
    renderProvider();
    await act(async () => {});

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(document.documentElement.dataset.windowFocused).toBe('false');
  });

  it('sets data-window-focused to "true" on window focus', async () => {
    renderProvider();
    await act(async () => {});

    // Blur first so we have a defined state to flip from.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(document.documentElement.dataset.windowFocused).toBe('false');

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.dataset.windowFocused).toBe('true');
  });

  it('stops updating data-window-focused after unmount', async () => {
    const { unmount } = renderProvider();
    await act(async () => {});

    // Set a known state before unmount.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.dataset.windowFocused).toBe('true');

    // Capture the attribute value right before unmount.
    const beforeUnmount = document.documentElement.dataset.windowFocused;

    unmount();

    // Manually set it to a sentinel value so we can detect if the event
    // handler fires and overwrites it.
    document.documentElement.dataset.windowFocused = 'sentinel';

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // If listeners were removed, the value stays at 'sentinel'.
    // If they leaked, one of the events would have overwritten it.
    expect(document.documentElement.dataset.windowFocused).toBe('sentinel');
    expect(beforeUnmount).toBe('true'); // sanity
  });

  it('initialises data-window-focused on mount', async () => {
    renderProvider();
    await act(async () => {});
    // jsdom's document.hasFocus() returns false by default.
    expect(document.documentElement.dataset.windowFocused).toBe('false');
  });
});
