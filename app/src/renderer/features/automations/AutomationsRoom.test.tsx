// @vitest-environment jsdom
//
// BSP-O3 — AutomationsRoom tests.
// Covers:
//   • Both automation rows render
//   • Status badges reflect mocked state
//   • Enable toggle calls the right RPC
//   • The room id is in ROOMS_MENU_ITEMS
//   • The room is NOT disabled when no active workspace (global room)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ── rpc mock ──────────────────────────────────────────────────────────────────

const mockGetStatus = vi.fn();
const mockSetEnabled = vi.fn(async () => undefined);
const mockKvGet = vi.fn();
const mockKvSet = vi.fn(async () => undefined);

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    telegram: {
      getStatus: mockGetStatus,
      setEnabled: mockSetEnabled,
    },
    kv: {
      get: mockKvGet,
      set: mockKvSet,
    },
  },
}));

// ── AppState mock (AutomationsRoom uses useAppDispatch) ───────────────────────

const mockDispatch = vi.fn();

vi.mock('@/renderer/app/state', () => ({
  useAppDispatch: () => mockDispatch,
  useAppStateSelector: vi.fn(),
  useAppState: vi.fn(),
}));

// ── notification-prefs constants (avoid transform issues) ─────────────────────
// The real module is a pure TS file that should import fine; no mock needed.

// ── helpers ───────────────────────────────────────────────────────────────────

import type { TelegramRemoteStatus } from '@/shared/router-shape';

function makeStatus(overrides: Partial<TelegramRemoteStatus> = {}): TelegramRemoteStatus {
  return {
    enabled: false,
    running: false,
    locked: false,
    allowlist: [],
    encryptionAvailable: true,
    tokenSet: true,
    ...overrides,
  };
}

async function loadRoom() {
  const mod = await import('./AutomationsRoom');
  return mod.AutomationsRoom;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AutomationsRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue(makeStatus());
    // Default: digest disabled, time at '18:00'
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'notifications.dailySummaryEnabled') return '0';
      if (key === 'notifications.dailySummaryTime') return '18:00';
      return null;
    });
  });
  afterEach(() => cleanup());

  it('renders both automation rows', async () => {
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    // Telegram row
    expect(screen.getByText(/remote control \(telegram\)/i)).toBeTruthy();
    // Nightly digest row
    expect(screen.getByText(/nightly digest/i)).toBeTruthy();
  });

  it('shows "Off" status badge for Telegram when enabled=false, running=false', async () => {
    mockGetStatus.mockResolvedValue(makeStatus({ enabled: false, running: false }));
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('telegram-status-badge');
    expect(badge.textContent ?? '').toContain('Off');
  });

  it('shows "Running" status badge for Telegram when running=true', async () => {
    mockGetStatus.mockResolvedValue(makeStatus({ enabled: true, running: true }));
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('telegram-status-badge');
    expect(badge.textContent ?? '').toContain('Running');
  });

  it('shows "Locked" status badge for Telegram when locked=true', async () => {
    mockGetStatus.mockResolvedValue(makeStatus({ enabled: true, locked: true }));
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('telegram-status-badge');
    expect(badge.textContent ?? '').toContain('Locked');
  });

  it('shows "Stopped" status badge for Telegram when enabled=true but running=false', async () => {
    mockGetStatus.mockResolvedValue(makeStatus({ enabled: true, running: false }));
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('telegram-status-badge');
    expect(badge.textContent ?? '').toContain('Stopped');
  });

  it('toggling Telegram switch calls rpc.telegram.setEnabled', async () => {
    mockGetStatus.mockResolvedValue(makeStatus({ enabled: false }));
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    // Wait for status to load
    await screen.findByTestId('telegram-status-badge');
    const sw = screen.getByTestId('telegram-card-switch');
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(mockSetEnabled).toHaveBeenCalledWith(true));
  });

  it('digest badge shows "Off" when KV returns 0', async () => {
    mockKvGet.mockResolvedValue('0');
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('digest-status-badge');
    expect(badge.textContent ?? '').toContain('Off');
  });

  it('digest badge shows "Enabled" when KV returns 1', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'notifications.dailySummaryEnabled') return '1';
      if (key === 'notifications.dailySummaryTime') return '09:00';
      return null;
    });
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const badge = await screen.findByTestId('digest-status-badge');
    expect(badge.textContent ?? '').toContain('Enabled');
  });

  it('digest time label is shown when digest is enabled', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'notifications.dailySummaryEnabled') return '1';
      if (key === 'notifications.dailySummaryTime') return '09:00';
      return null;
    });
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const timeLabel = await screen.findByTestId('digest-time-label');
    expect(timeLabel.textContent ?? '').toContain('09:00');
  });

  it('toggling digest switch calls rpc.kv.set with the right key', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'notifications.dailySummaryEnabled') return '0';
      if (key === 'notifications.dailySummaryTime') return '18:00';
      return null;
    });
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    // Wait for ready (switch is enabled after KV hydration)
    await waitFor(() => {
      const sw = screen.getByTestId('digest-card-switch');
      expect((sw as HTMLElement).getAttribute('aria-disabled')).not.toBe('true');
    });
    const sw = screen.getByTestId('digest-card-switch');
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() =>
      expect(mockKvSet).toHaveBeenCalledWith('notifications.dailySummaryEnabled', '1'),
    );
  });

  it('Telegram Configure button dispatches SET_SETTINGS_TAB + SET_ROOM', async () => {
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const btn = screen.getByTestId('telegram-card-configure');
    fireEvent.click(btn);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_SETTINGS_TAB', tab: 'telegram' });
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'settings' });
  });

  it('digest Configure button dispatches SET_SETTINGS_TAB + SET_ROOM', async () => {
    const AutomationsRoom = await loadRoom();
    await act(async () => {
      render(<AutomationsRoom />);
    });
    const btn = screen.getByTestId('digest-card-configure');
    fireEvent.click(btn);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_SETTINGS_TAB', tab: 'notifications' });
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_ROOM', room: 'settings' });
  });
});

// ── ROOMS_MENU_ITEMS and isRoomDisabled checks ────────────────────────────────

describe('automations room nav wiring', () => {
  it('automations is in ROOMS_MENU_ITEMS', async () => {
    const { ROOMS_MENU_ITEMS } = await import(
      '@/renderer/features/top-bar/rooms-menu-items'
    );
    const ids = ROOMS_MENU_ITEMS.map((item) => item.id);
    expect(ids).toContain('automations');
  });

  it('automations room is NOT disabled when no active workspace', async () => {
    const { isRoomDisabled } = await import(
      '@/renderer/features/top-bar/rooms-menu-items'
    );
    expect(isRoomDisabled('automations', false)).toBe(false);
  });

  it('automations room is NOT disabled when a workspace is active', async () => {
    const { isRoomDisabled } = await import(
      '@/renderer/features/top-bar/rooms-menu-items'
    );
    expect(isRoomDisabled('automations', true)).toBe(false);
  });
});
