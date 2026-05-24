// @vitest-environment jsdom
//
// C-11 / K6 — VoiceTab "Hey Sigma wake word" listening-mode toggle.
//
// The toggle lives in the macOS-only GlobalCaptureSection. It hydrates from
// KV (`voice.listeningMode`) on mount and persists via the side-band IPC
// `voice.globalCapture.setListeningMode` (so the main process arms/disarms the
// wake loop), and shows a note that it uses the tiny model and listens
// continuously on macOS.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

const kvStore: Record<string, string> = {};

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    voice: {
      setMode: vi.fn().mockResolvedValue(undefined),
      permissionRequest: vi.fn().mockResolvedValue({ status: 'unsupported' }),
    },
    kv: {
      get: vi.fn((key: string) => Promise.resolve(kvStore[key] ?? null)),
      set: vi.fn((key: string, value: string) => { kvStore[key] = value; return Promise.resolve(); }),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

/** Records side-band invoke calls so the test can assert on setListeningMode. */
let invokeCalls: Array<{ channel: string; payload: unknown }> = [];

function stubPlatform(platform: NodeJS.Platform, listeningModeKv?: string) {
  invokeCalls = [];
  if (listeningModeKv !== undefined) kvStore['voice.listeningMode'] = listeningModeKv;
  (window as unknown as { sigma?: Record<string, unknown> }).sigma = {
    platform,
    invoke: vi.fn((channel: string, payload?: unknown) => {
      invokeCalls.push({ channel, payload });
      if (channel === 'voice.globalCapture.getStatus') {
        return Promise.resolve({
          ok: true,
          data: { state: 'idle', enabled: false, mode: 'toggle', modelId: 'base.en-q5_1', hotkey: 'Cmd+Option+Space' },
        });
      }
      if (channel === 'voice.globalCapture.setListeningMode') {
        return Promise.resolve({ ok: true, data: { listeningMode: !!(payload as { value?: boolean })?.value } });
      }
      // diagnostics + anything else: reject so the catch paths run quietly.
      return Promise.reject(new Error('test'));
    }),
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    getPathForFile: vi.fn(() => ''),
  };
}

async function loadVoiceTab() {
  vi.resetModules();
  const mod = await import('./VoiceTab');
  return mod.VoiceTab;
}

describe('VoiceTab — "Hey Sigma" wake-word toggle (C-11)', () => {
  beforeEach(() => {
    delete (window as unknown as { sigma?: unknown }).sigma;
    for (const k of Object.keys(kvStore)) delete kvStore[k];
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  it('renders the wake-word toggle + a tiny-model / continuous-listening note on macOS', async () => {
    stubPlatform('darwin', '0');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    const toggle = await screen.findByTestId('voice-listening-mode-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    const section = screen.getByTestId('voice-global-capture-section');
    const text = section.textContent ?? '';
    expect(text).toContain('Hey Sigma');
    expect(text.toLowerCase()).toContain('tiny');
    expect(text.toLowerCase()).toContain('continuously');
  });

  it('hydrates the toggle ON when voice.listeningMode is "1"', async () => {
    stubPlatform('darwin', '1');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    await waitFor(() => {
      const toggle = screen.getByTestId('voice-listening-mode-toggle');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('persists voice.listeningMode via setListeningMode IPC on toggle', async () => {
    stubPlatform('darwin', '0');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    const toggle = await screen.findByTestId('voice-listening-mode-toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.channel === 'voice.globalCapture.setListeningMode');
      expect(call).toBeTruthy();
      expect((call?.payload as { value?: boolean })?.value).toBe(true);
    });
  });

  it('does NOT render the wake-word toggle on non-macOS platforms', async () => {
    stubPlatform('win32', '0');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    // The Windows GlobalCaptureSection short-circuits to the "macOS feature"
    // note and renders no listening toggle.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('voice-listening-mode-toggle')).toBeNull();
  });
});
