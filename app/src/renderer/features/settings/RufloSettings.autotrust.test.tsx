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

  it('round-trips the visible-pane scrollback depth through KV on commit', async () => {
    kvStore.set('pty.scrollbackRows', '2500');
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);

    const input = (await screen.findByLabelText(
      'Scrollback rows (visible pane)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('2500'));

    fireEvent.change(input, { target: { value: '4096' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(kvSet).toHaveBeenCalledWith('pty.scrollbackRows', '4096'),
    );
  });

  it('keeps a mid-edit empty field empty instead of re-filling the default', async () => {
    kvStore.set('pty.scrollbackRows', '8000');
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);

    const input = (await screen.findByLabelText(
      'Scrollback rows (visible pane)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('8000'));

    // Select-all + delete. The field must go EMPTY. Resolving every keystroke
    // snapped it straight back to 8000, so the next digits appended to the
    // re-filled default and `80003000` got persisted.
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(kvSet).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '3000' } });
    expect(input.value).toBe('3000');
    expect(kvSet).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() => expect(kvSet).toHaveBeenCalledWith('pty.scrollbackRows', '3000'));
  });

  it('commits on Enter without a blur, persisting the normalized value', async () => {
    // The Enter path is a SECOND commit trigger alongside blur. Untested, a
    // wrapper around shadcn's Input that swallowed onKeyDown would silently
    // stop persisting and the operator's edit would die on the next room
    // switch — with the whole suite still green.
    kvStore.set('pty.scrollbackRows', '8000');
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);

    const input = (await screen.findByLabelText(
      'Scrollback rows (visible pane)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('8000'));

    fireEvent.change(input, { target: { value: '250000' } });
    expect(kvSet).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(kvSet).toHaveBeenCalledWith('pty.scrollbackRows', '100000'),
    );
    expect(input.value).toBe('100000');
  });

  it('clamps a committed value to the max and falls back to the default when blank', async () => {
    const RufloSettings = await loadComponent();
    render(<RufloSettings />);

    const input = (await screen.findByLabelText(
      'Scrollback rows (visible pane)',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('8000'));

    fireEvent.change(input, { target: { value: '80003000' } });
    fireEvent.blur(input);
    await waitFor(() => expect(kvSet).toHaveBeenCalledWith('pty.scrollbackRows', '100000'));
    expect(input.value).toBe('100000');

    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(kvSet).toHaveBeenCalledWith('pty.scrollbackRows', '8000'));
    expect(input.value).toBe('8000');
  });
});
