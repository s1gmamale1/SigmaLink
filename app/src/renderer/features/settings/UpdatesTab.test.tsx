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

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    app: {
      getVersion: vi.fn().mockResolvedValue('1.2.3'),
      getPlatform: vi.fn().mockResolvedValue('darwin'),
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
});
