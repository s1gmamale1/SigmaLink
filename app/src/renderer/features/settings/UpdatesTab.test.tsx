// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdatesTab } from './UpdatesTab';

type EventHandler = (payload: unknown) => void;

const mocks = vi.hoisted(() => ({
  eventHandlers: new Map<string, EventHandler>(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  kvGet: vi.fn(async () => null),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

const platformMock = { value: 'darwin' };

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    app: {
      getVersion: vi.fn().mockResolvedValue('1.2.3'),
      getPlatform: vi.fn().mockImplementation(() => Promise.resolve(platformMock.value)),
      checkForUpdates: vi.fn().mockResolvedValue({ ok: true, version: '1.2.4' }),
      quitAndInstall: vi.fn().mockResolvedValue(undefined),
    },
    kv: {
      get: mocks.kvGet,
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  onEvent: vi.fn((name: string, cb: EventHandler) => {
    mocks.eventHandlers.set(name, cb);
    return () => {
      mocks.eventHandlers.delete(name);
    };
  }),
}));

function emit(name: string, payload: unknown): void {
  const handler = mocks.eventHandlers.get(name);
  expect(handler, `missing ${name} handler`).toBeTruthy();
  act(() => {
    handler?.(payload);
  });
}

describe('<UpdatesTab />', () => {
  beforeEach(() => {
    mocks.eventHandlers.clear();
    mocks.toastSuccess.mockClear();
    mocks.toastError.mockClear();
    mocks.kvGet.mockClear();
    platformMock.value = 'darwin';
  });

  afterEach(() => {
    cleanup();
  });

  it('treats update progress events as cumulative snapshots, not deltas', async () => {
    render(<UpdatesTab />);
    await screen.findByText('Check for updates');

    emit('app:update-available', { version: '1.2.4' });
    emit('app:update-mac-dmg-progress', {
      version: '1.2.4',
      downloaded: 10,
      total: 100,
    });
    emit('app:update-mac-dmg-progress', {
      version: '1.2.4',
      downloaded: 25,
      total: 100,
    });

    expect(screen.getByText(/Downloading v1\.2\.4/)).toBeTruthy();
    expect(screen.getByText('25.0 B of 100.0 B')).toBeTruthy();
    expect(screen.queryByText('35.0 B of 100.0 B')).toBeNull();
  });

  it('moves from downloading to ready, then surfaces error state when update work fails', async () => {
    render(<UpdatesTab />);
    await screen.findByText('Check for updates');

    emit('app:update-available', { version: '1.2.4' });
    emit('app:update-mac-dmg-ready', {
      version: '1.2.4',
      path: '/tmp/SigmaLink-1.2.4.dmg',
    });

    expect(screen.getByText('v1.2.4')).toBeTruthy();
    expect(screen.getByText('Open DMG')).toBeTruthy();

    emit('app:update-error', { error: 'download failed' });

    expect(screen.getByText('Update failed')).toBeTruthy();
    expect(screen.getByText('download failed')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('renders "Open latest release" external link when isUacDenied is true', async () => {
    render(<UpdatesTab />);
    await screen.findByText('Check for updates');

    emit('app:update-error', {
      error: 'Admin permission required. Re-run the SigmaLink installer to upgrade: https://github.com/s1gmamale1/SigmaLink/releases/latest',
      isUacDenied: true,
    });

    expect(screen.getByText('Update failed')).toBeTruthy();

    const link = screen.getByRole('link', { name: /open latest release/i });
    expect(link).toBeTruthy();
    expect((link as HTMLAnchorElement).href).toBe(
      'https://github.com/s1gmamale1/SigmaLink/releases/latest',
    );

    // Retry button should NOT be present when isUacDenied
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('shows Linux manual install copy when an update is ready', async () => {
    platformMock.value = 'linux';
    render(<UpdatesTab />);
    await screen.findByRole('button', { name: /check for updates/i });

    emit('app:update-available', { version: '9.9.9' });
    emit('app:update-linux-ready', {
      version: '9.9.9',
      path: '/home/user/Downloads/SigmaLink-9.9.9.AppImage',
    });

    expect(await screen.findByText(/Linux update downloaded/i)).toBeTruthy();
    const openBtn = screen.getByRole('button', { name: /open download/i });
    expect(openBtn).toBeTruthy();
    expect((openBtn as HTMLButtonElement).disabled).toBe(false);
  });
});
