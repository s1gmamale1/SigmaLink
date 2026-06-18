// @vitest-environment jsdom
//
// ONB-1 — SettingsRoom search + controlled tabs + pendingSettingsTab consume.
//
// Tests:
//   - all 13 tab triggers render by default
//   - the search box filters triggers by label AND keyword
//   - clearing the search restores all triggers
//   - a query that matches nothing shows the empty hint
//   - an externally-staged `pendingSettingsTab` selects that tab on mount and
//     dispatches SET_SETTINGS_TAB:undefined to clear the staging slot

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Stub every heavy tab subcomponent — they run their own lazy RPC fetches that
// we don't want in this UI test. Each renders a tiny marker. Factories are
// inlined (vi.mock is hoisted, so no shared top-level helper can be referenced).
vi.mock('./AppearanceTab', () => ({ AppearanceTab: () => <div data-testid="tab-body-AppearanceTab" /> }));
vi.mock('./ProvidersTab', () => ({ ProvidersTab: () => <div data-testid="tab-body-ProvidersTab" /> }));
vi.mock('./McpServersTab', () => ({ McpServersTab: () => <div data-testid="tab-body-McpServersTab" /> }));
vi.mock('./DiagnosticsTab', () => ({ DiagnosticsTab: () => <div data-testid="tab-body-DiagnosticsTab" /> }));
vi.mock('./UpdatesTab', () => ({ UpdatesTab: () => <div data-testid="tab-body-UpdatesTab" /> }));
vi.mock('./RufloSettings', () => ({ RufloSettings: () => <div data-testid="tab-body-RufloSettings" /> }));
vi.mock('./VoiceTab', () => ({ VoiceTab: () => <div data-testid="tab-body-VoiceTab" /> }));
vi.mock('./StorageTab', () => ({ StorageTab: () => <div data-testid="tab-body-StorageTab" /> }));
vi.mock('./NotificationsSettings', () => ({ NotificationsSettings: () => <div data-testid="tab-body-NotificationsSettings" /> }));
vi.mock('./SyncTab', () => ({ SyncTab: () => <div data-testid="tab-body-SyncTab" /> }));
vi.mock('./TelegramTab', () => ({ TelegramTab: () => <div data-testid="tab-body-TelegramTab" /> }));
vi.mock('./MaintenanceTab', () => ({ MaintenanceTab: () => <div data-testid="tab-body-MaintenanceTab" /> }));
vi.mock('./ExternalControlSettings', () => ({ ExternalControlSettings: () => <div data-testid="tab-body-ExternalControlSettings" /> }));

// Controllable app-state mock.
const dispatch = vi.fn();
let mockState: { pendingSettingsTab?: string } = {};
vi.mock('@/renderer/app/state', () => ({
  useAppState: () => ({ state: mockState, dispatch }),
}));

import { SettingsRoom } from './SettingsRoom';

const ALL_TAB_LABELS = [
  'Appearance',
  'Providers',
  'MCP servers',
  'Voice',
  'Notifications',
  'Ruflo',
  'Updates',
  'Sync',
  'Telegram',
  'Storage',
  'Maintenance',
  'Diagnostics',
  'External Control',
];

function tabs(): HTMLElement[] {
  return screen.queryAllByRole('tab');
}

describe('SettingsRoom — ONB-1 search + controlled tabs', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState = {};
  });
  afterEach(() => cleanup());

  it('renders all 13 tab triggers by default', () => {
    render(<SettingsRoom />);
    expect(tabs()).toHaveLength(13);
    for (const label of ALL_TAB_LABELS) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  it('filters triggers by visible label', () => {
    render(<SettingsRoom />);
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    fireEvent.change(search, { target: { value: 'voice' } });
    const names = tabs().map((t) => t.textContent);
    expect(names).toEqual(['Voice']);
  });

  it('filters triggers by keyword (not just the label)', () => {
    render(<SettingsRoom />);
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    // "theme" is a keyword on Appearance, not its label.
    fireEvent.change(search, { target: { value: 'theme' } });
    const names = tabs().map((t) => t.textContent);
    expect(names).toContain('Appearance');
    expect(names).not.toContain('Diagnostics');
  });

  it('clearing the search restores all triggers', () => {
    render(<SettingsRoom />);
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    fireEvent.change(search, { target: { value: 'voice' } });
    expect(tabs()).toHaveLength(1);
    fireEvent.change(search, { target: { value: '' } });
    expect(tabs()).toHaveLength(13);
  });

  it('shows an empty hint when nothing matches', () => {
    render(<SettingsRoom />);
    const search = screen.getByRole('searchbox', { name: /search settings/i });
    fireEvent.change(search, { target: { value: 'zzzznomatch' } });
    expect(tabs()).toHaveLength(0);
    expect(screen.getByText(/no settings match/i)).toBeTruthy();
  });

  it('consumes pendingSettingsTab on mount and clears the staging slot', async () => {
    mockState = { pendingSettingsTab: 'voice' };
    render(<SettingsRoom />);
    // The consume is deferred via queueMicrotask (lint: no sync setState in
    // effect), so flush the microtask queue before asserting.
    await act(async () => {
      await Promise.resolve();
    });
    // The active tab is now Voice (its panel is selected / visible).
    const voiceTab = screen.getByRole('tab', { name: 'Voice' });
    expect(voiceTab.getAttribute('aria-selected')).toBe('true');
    // And the staging slot was cleared.
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SETTINGS_TAB', tab: undefined });
  });

  it('switching tabs selects the body (controlled)', () => {
    render(<SettingsRoom />);
    const storageTab = screen.getByRole('tab', { name: 'Storage' });
    // Radix Tabs use automatic activation: focusing a trigger (here via a
    // pointerdown that moves roving focus + a click) selects it. Wrapping in
    // act() flushes the controlled `onValueChange` → setActiveTab update.
    act(() => {
      fireEvent.pointerDown(
        storageTab,
        new MouseEvent('pointerdown', { bubbles: true, ctrlKey: false, button: 0 }),
      );
      fireEvent.mouseDown(storageTab);
      fireEvent.focus(storageTab);
      fireEvent.click(storageTab);
    });
    expect(storageTab.getAttribute('aria-selected')).toBe('true');
    // The visible panel hosts the Storage stub.
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByTestId('tab-body-StorageTab')).toBeTruthy();
  });
});
