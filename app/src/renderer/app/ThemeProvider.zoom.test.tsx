// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const kvGet = vi.fn<(k: string) => Promise<string | null>>();
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { kv: { get: (k: string) => kvGet(k), set: vi.fn(() => Promise.resolve()) } },
  rpcSilent: { kv: { set: vi.fn(() => Promise.resolve()) } },
}));

import { ThemeProvider } from './ThemeProvider';

const setZoomFactor = vi.fn();

beforeEach(() => {
  kvGet.mockReset();
  setZoomFactor.mockClear();
  (window as unknown as { sigma: { setZoomFactor: typeof setZoomFactor; getZoomFactor: () => number } }).sigma = {
    setZoomFactor,
    getZoomFactor: () => 1,
  };
  document.documentElement.style.fontSize = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ThemeProvider boot restore', () => {
  it('restores persisted fontSize and zoom on mount', async () => {
    kvGet.mockImplementation((k) => {
      if (k === 'app.fontSize') return Promise.resolve('16');
      if (k === 'app.zoomFactor') return Promise.resolve('1.5');
      return Promise.resolve(null);
    });

    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.style.fontSize).toBe('16px');
      expect(setZoomFactor).toHaveBeenCalledWith(1.5);
    });
  });

  it('falls back to default zoom (100%) when nothing is stored', async () => {
    kvGet.mockResolvedValue(null);
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(setZoomFactor).toHaveBeenCalledWith(1);
    });
  });
});
