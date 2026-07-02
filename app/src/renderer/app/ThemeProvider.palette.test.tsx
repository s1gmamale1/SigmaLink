// @vitest-environment jsdom
// Phase 17 — ThemeProvider pairs every theme apply with the terminal palette
// apply, so chrome tokens and terminal colors can never drift.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: (k: string) => kvGet(k), set: vi.fn(() => Promise.resolve()) } },
  rpcSilent: { kv: { set: vi.fn(() => Promise.resolve()) } },
}));

const applyTerminalPalette = vi.fn();
vi.mock('@/renderer/lib/terminal-cache', () => ({
  applyTerminalPalette: (p: unknown) => applyTerminalPalette(p),
}));

import { ThemeProvider } from './ThemeProvider';
import { AURORA_TERMINAL, DEFAULT_TERMINAL } from '@/renderer/lib/terminal-palette';

beforeEach(() => {
  kvGet.mockReset();
  applyTerminalPalette.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ThemeProvider — terminal palette pairing (Phase 17)', () => {
  it('boot with a stored aurora theme applies AURORA_TERMINAL', async () => {
    kvGet.mockImplementation((k) =>
      Promise.resolve(k === 'app.theme' ? 'aurora' : null),
    );
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(applyTerminalPalette).toHaveBeenCalledWith(AURORA_TERMINAL);
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('aurora');
  });

  it('boot with nothing stored applies the default (glass -> DEFAULT_TERMINAL)', async () => {
    kvGet.mockResolvedValue(null);
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(applyTerminalPalette).toHaveBeenCalledWith(DEFAULT_TERMINAL);
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('glass');
  });
});
