// @vitest-environment jsdom
//
// Stage-4 a11y — AddressBar accessible names.
// Verifies that Back, Forward, Reload, Stop, and Home buttons carry aria-label
// attributes (not just title) so screen readers announce them correctly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// AddressBar imports DesignOverlayToggle which may need rpc.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: vi.fn().mockResolvedValue(null) },
    design: { overlays: vi.fn().mockResolvedValue([]) },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

// DesignOverlayToggle has complex deps; stub it to avoid noise.
vi.mock('./DesignOverlay', () => ({
  DesignOverlayToggle: () => null,
}));

import { AddressBar } from './AddressBar';

const noop = () => {};

function renderBar() {
  return render(
    <AddressBar
      url="https://example.com"
      onNavigate={noop}
      onBack={noop}
      onForward={noop}
      onReload={noop}
      onStop={noop}
      onHome={noop}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('AddressBar — Stage-4 a11y accessible names', () => {
  it('Back button has aria-label="Back"', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeTruthy();
  });

  it('Forward button has aria-label="Forward"', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^forward$/i })).toBeTruthy();
  });

  it('Reload button has aria-label="Reload"', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^reload$/i })).toBeTruthy();
  });

  it('Stop button has aria-label="Stop"', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeTruthy();
  });

  it('Home button has aria-label="Home"', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /^home$/i })).toBeTruthy();
  });
});
