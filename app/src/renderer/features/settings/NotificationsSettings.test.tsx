// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KV_DND,
  KV_QUIET_HOURS,
  KV_OS_PER_SOURCE,
} from '@/shared/notification-prefs';

const { store, sounds } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sounds: {
    getSoundMasterEnabled: vi.fn(async () => true),
    setSoundMasterEnabled: vi.fn(async () => undefined),
    getSoundVolume: vi.fn(async () => 0.6),
    setSoundVolume: vi.fn(async () => undefined),
    getMutedCues: vi.fn(async () => new Set<string>()),
    setCueMuted: vi.fn(async () => undefined),
    previewCue: vi.fn(async () => undefined),
    invalidateSoundPrefsCache: vi.fn(),
  },
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: {
      get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
  },
  rpcSilent: { kv: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) } },
}));

vi.mock('@/renderer/lib/sounds', () => sounds);

import { rpc } from '@/renderer/lib/rpc';
import { NotificationsSettings } from './NotificationsSettings';

const setSpy = rpc.kv.set as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  sounds.getSoundMasterEnabled.mockResolvedValue(true);
  sounds.getSoundVolume.mockResolvedValue(0.6);
  sounds.getMutedCues.mockResolvedValue(new Set<string>());
});

afterEach(() => cleanup());

async function renderPanel() {
  render(<NotificationsSettings />);
  // Wait for both the main panel and the sound subsection to hydrate.
  await screen.findByTestId('notifications-settings');
  await screen.findByTestId('notifications-sound');
}

describe('NotificationsSettings — P3 NTF-1', () => {
  it('toggling Do Not Disturb persists notifications.dnd', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-dnd'));
    expect(setSpy).toHaveBeenCalledWith(KV_DND, '1');
  });

  it('enabling quiet hours persists a JSON window', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-quiet-enabled'));
    const call = setSpy.mock.calls.find((c) => c[0] === KV_QUIET_HOURS);
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1] as string).enabled).toBe(true);
  });

  it('muting a source persists notifications.osPerSource', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-source-pty'));
    const call = setSpy.mock.calls.find((c) => c[0] === KV_OS_PER_SOURCE);
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1] as string)).toContain('pty');
  });
});

describe('NotificationsSettings — P3 SND-1 sound matrix', () => {
  it('changing the volume slider calls setSoundVolume', async () => {
    await renderPanel();
    fireEvent.change(screen.getByTestId('notifications-sound-volume'), { target: { value: '80' } });
    expect(sounds.setSoundVolume).toHaveBeenCalledWith(0.8);
  });

  it('a cue Test button previews that cue', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-sound-test-agent-done'));
    expect(sounds.previewCue).toHaveBeenCalledWith('agent-done');
  });

  it('unchecking a cue mutes it', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-sound-cue-agent-done'));
    expect(sounds.setCueMuted).toHaveBeenCalledWith('agent-done', true);
  });

  it('toggling the master sound switch persists', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('notifications-sound-master'));
    expect(sounds.setSoundMasterEnabled).toHaveBeenCalledWith(false);
  });
});
