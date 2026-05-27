// @vitest-environment jsdom
//
// SF-7 Lane A — RufloSettings auto-trust opt-out toggle. Covers: the toggle
// renders, reflects the KV (default ON when unset/'1', OFF when '0'), and
// writes '0'/'1' back through rpc.kv.set.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const kvStore = new Map<string, string | null>();
const kvGet = vi.fn(async (key: string) => kvStore.get(key) ?? null);
const kvSet = vi.fn(async (key: string, value: string) => {
  kvStore.set(key, value);
});

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: kvGet, set: kvSet },
    ruflo: {
      restartDaemon: vi.fn(async () => ({ ok: true })),
      ['install.start']: vi.fn(async () => undefined),
    },
  },
  rpcSilent: {
    ruflo: {
      health: vi.fn(async () => ({ state: 'ready' })),
      daemonStatus: vi.fn(async () => []),
    },
  },
  onEvent: vi.fn(() => () => undefined),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

async function loadComponent() {
  vi.resetModules();
  const mod = await import('./RufloSettings');
  return mod.RufloSettings;
}

describe('RufloSettings — auto-trust toggle (SF-7)', () => {
  beforeEach(() => {
    kvStore.clear();
    kvGet.mockClear();
    kvSet.mockClear();
  });
  afterEach(() => cleanup());

  it('renders the toggle checked by default when the KV is unset', async () => {
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);
    const toggle = await screen.findByTestId('ruflo-autotrust-toggle');
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));
  });

  it('reflects KV "0" as unchecked', async () => {
    kvStore.set('ruflo.autoTrustMcp', '0');
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);
    const toggle = await screen.findByTestId('ruflo-autotrust-toggle');
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('unchecked'));
  });

  it('writes "0" when toggled off, "1" when toggled back on', async () => {
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);
    const toggle = await screen.findByTestId('ruflo-autotrust-toggle');
    await waitFor(() => expect(toggle.getAttribute('data-state')).toBe('checked'));

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(kvSet).toHaveBeenCalledWith('ruflo.autoTrustMcp', '0'),
    );

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(kvSet).toHaveBeenCalledWith('ruflo.autoTrustMcp', '1'),
    );
  });

  it('sub-label states only the ruflo server is pre-approved by name', async () => {
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);
    const label = await screen.findByText(/Pre-approves only/i);
    expect(label.textContent ?? '').toMatch(/third-party MCP servers .* still prompt/i);
  });
});
