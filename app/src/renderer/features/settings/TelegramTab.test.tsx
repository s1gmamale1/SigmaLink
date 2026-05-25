// @vitest-environment jsdom
//
// R-1 Lane B — TelegramTab tests. Covers: renders status, token is write-only
// (state pill + password field, never displays a value), allowlist add/remove.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TelegramRemoteStatus } from '@/shared/router-shape';

const status: { current: TelegramRemoteStatus } = {
  current: {
    enabled: false,
    running: false,
    locked: false,
    allowlist: [123, 456],
    encryptionAvailable: true,
    tokenSet: true,
  },
};

const setToken = vi.fn(async () => undefined);
const setAllowlist = vi.fn(async () => undefined);
const setEnabled = vi.fn(async () => undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    telegram: {
      getStatus: vi.fn(async () => status.current),
      auditTail: vi.fn(async () => [{ ts: Date.now(), kind: 'start', chatId: null, detail: 'ok' }]),
      setToken,
      clearToken: vi.fn(async () => undefined),
      setEnabled,
      setAllowlist,
      setIdleLockMinutes: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
    },
    kv: { get: vi.fn(async () => null) },
  },
}));

async function loadTab() {
  vi.resetModules();
  const mod = await import('./TelegramTab');
  return mod.TelegramTab;
}

describe('TelegramTab', () => {
  beforeEach(() => {
    setToken.mockClear();
    setAllowlist.mockClear();
    setEnabled.mockClear();
    status.current = {
      enabled: false,
      running: false,
      locked: false,
      allowlist: [123, 456],
      encryptionAvailable: true,
      tokenSet: true,
    };
  });
  afterEach(() => cleanup());

  it('renders the status surface and shows "Token set ✓" when a token exists', async () => {
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    const tokenState = await screen.findByTestId('telegram-token-state');
    expect(tokenState.textContent ?? '').toContain('Token set');
  });

  it('token field is write-only: a password input that never shows the value', async () => {
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    const input = (await screen.findByTestId('telegram-token-input')) as HTMLInputElement;
    expect(input.type).toBe('password');
    // No part of the rendered tab leaks a token-looking value.
    const root = screen.getByTestId('telegram-settings-tab');
    expect(root.textContent ?? '').not.toMatch(/\d{6,}:[A-Za-z0-9_-]{10,}/);
  });

  it('saving a token calls setToken with the typed value and then clears the field', async () => {
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    const input = (await screen.findByTestId('telegram-token-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '111:AAA-bbb-ccc' } });
    fireEvent.click(screen.getByTestId('telegram-token-save'));
    await waitFor(() => expect(setToken).toHaveBeenCalledWith('111:AAA-bbb-ccc'));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('shows the encryption warning + hides the token field when encryption is unavailable', async () => {
    status.current = { ...status.current, encryptionAvailable: false };
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    await screen.findByTestId('telegram-settings-tab');
    expect(screen.queryByTestId('telegram-token-input')).toBeNull();
    expect(screen.getByTestId('telegram-settings-tab').textContent ?? '').toContain(
      'At-rest encryption is unavailable',
    );
  });

  it('renders the allowlist and removes an id', async () => {
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    const list = await screen.findByTestId('telegram-allowlist');
    expect(list.textContent ?? '').toContain('123');
    expect(list.textContent ?? '').toContain('456');

    fireEvent.click(screen.getByTestId('telegram-allowlist-remove-123'));
    await waitFor(() => expect(setAllowlist).toHaveBeenCalledWith([456]));
  });

  it('adds a chat id', async () => {
    const TelegramTab = await loadTab();
    render(<TelegramTab />);
    const input = (await screen.findByTestId('telegram-chatid-input')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '789' } });
    fireEvent.click(screen.getByTestId('telegram-chatid-add'));
    await waitFor(() => expect(setAllowlist).toHaveBeenCalledWith([123, 456, 789]));
  });
});
