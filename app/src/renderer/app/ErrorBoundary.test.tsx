// @vitest-environment jsdom
//
// ERR-1 — app-resilience boundary tests.
//
// Asserts:
//   - A child that throws during render shows the boundary fallback (the app
//     subtree is contained, NOT a blank tree).
//   - Clicking "Reload this view" resets the boundary; when the child no longer
//     throws, the real content renders again.
//
// sonner is mocked so toast.* calls (used by "Copy diagnostics") are inert in
// jsdom. Clicks use `fireEvent` from @testing-library/react — this project does
// NOT depend on @testing-library/user-event (see PaneHeader.test.tsx). Per the
// CI-coverage flake lesson, recovery is asserted with `findBy*` (awaiting the
// async re-render) rather than synchronous `getBy*`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PaneErrorBoundary, RootErrorBoundary } from './ErrorBoundary';

// sonner toast is fire-and-forget UI; stub it so the boundary's copy-diagnostics
// handler and any incidental toasts don't touch a real toaster in jsdom.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// A child that throws on render while `shouldThrow` is true.
function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('kaboom in child render');
  }
  return <div data-testid="happy-child">All good</div>;
}

describe('RootErrorBoundary (ERR-1)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the fallback (not a blank tree) when a child throws on render', () => {
    // React logs the caught error to console.error; silence it for a clean run.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <RootErrorBoundary>
          <Boom shouldThrow />
        </RootErrorBoundary>,
      );

      // Fallback chrome is present...
      expect(screen.getByText(/this view ran into a problem/i)).toBeTruthy();
      // ...the error message surfaces...
      expect(screen.getByText(/kaboom in child render/i)).toBeTruthy();
      // ...both recovery actions exist...
      expect(screen.getByRole('button', { name: /reload this view/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /copy diagnostics/i })).toBeTruthy();
      // ...and the crashing child did NOT render (no blank-but-broken tree).
      expect(screen.queryByTestId('happy-child')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('recovers when "Reload this view" is clicked and the child no longer throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // A module-local flag the child reads on each render. Flip it false, then
      // click Reload → the boundary clears its error and re-mounts the subtree,
      // which now renders the healthy content instead of throwing.
      let shouldThrow = true;
      function FlagChild() {
        if (shouldThrow) throw new Error('transient render failure');
        return <div data-testid="recovered">Recovered content</div>;
      }

      render(
        <RootErrorBoundary>
          <FlagChild />
        </RootErrorBoundary>,
      );

      // Fallback is shown; healthy content is absent.
      expect(screen.getByText(/this view ran into a problem/i)).toBeTruthy();
      expect(screen.queryByTestId('recovered')).toBeNull();

      // Clear the failure condition, then reset the boundary.
      shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: /reload this view/i }));

      // findBy* awaits the async re-render — recovered content now renders and
      // the fallback is gone.
      expect(await screen.findByTestId('recovered')).toBeTruthy();
      expect(screen.queryByText(/this view ran into a problem/i)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('PaneErrorBoundary (pane isolation)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('contains a throwing pane and renders the pane fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <PaneErrorBoundary>
          <Boom shouldThrow />
        </PaneErrorBoundary>,
      );
      // The `.` matches the curly apostrophe in "couldn’t".
      expect(screen.getByText(/this pane couldn.t render/i)).toBeTruthy();
      expect(screen.getByText(/kaboom in child render/i)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('isolates the crash: a sibling pane boundary still renders its content', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <div>
          <PaneErrorBoundary>
            <Boom shouldThrow />
          </PaneErrorBoundary>
          <PaneErrorBoundary>
            <div data-testid="healthy-sibling">healthy sibling pane</div>
          </PaneErrorBoundary>
        </div>,
      );
      expect(screen.getByText(/this pane couldn.t render/i)).toBeTruthy();
      expect(screen.getByTestId('healthy-sibling')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
