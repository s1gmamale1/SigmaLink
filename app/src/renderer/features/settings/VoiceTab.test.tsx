// @vitest-environment jsdom
//
// v1.2.0 Windows port — verifies the VoiceTab radio copy and diagnostics row
// adapt to the host platform so a Windows user does not see "macOS native
// engine" wording or a red error on the native dot.
//
// `IS_WIN32` / `NATIVE_ENGINE_AVAILABLE` are captured at module-load time
// inside the VoiceTab module, so we must stub `window.sigma` BEFORE the
// component module is imported. `vi.resetModules()` between cases ensures a
// fresh evaluation per platform.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// rpc / rpcSilent are imported at module top of VoiceTab. Stub them so the
// `useEffect` hydrate does not throw or block.
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    voice: {
      setMode: vi.fn().mockResolvedValue(undefined),
      permissionRequest: vi.fn().mockResolvedValue({ status: 'unsupported' }),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

function stubPlatform(platform: NodeJS.Platform) {
  (window as unknown as { sigma?: { platform: NodeJS.Platform } & Record<string, unknown> }).sigma =
    {
      platform,
      // `invokeVoiceDiagnostics()` calls window.sigma.invoke — make it reject
      // so the catch path runs and the component renders without diagnostics.
      invoke: vi.fn().mockRejectedValue(new Error('test')),
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

describe('VoiceTab — platform-aware copy', () => {
  beforeEach(() => {
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  it('shows "Web Speech API" copy on win32 and does not mention "macOS native engine"', async () => {
    stubPlatform('win32');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    const root = screen.getByTestId('voice-settings-tab');
    expect(root.textContent ?? '').toContain('Web Speech API');
    expect(root.textContent ?? '').not.toContain('macOS native engine');
  });

  it('shows "macOS native engine" copy on darwin and does not mention "Web Speech API"', async () => {
    stubPlatform('darwin');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    const root = screen.getByTestId('voice-settings-tab');
    expect(root.textContent ?? '').toContain('macOS native engine');
    // The auto-mode description on darwin reads "fall back to Web Speech",
    // so we only assert the Windows-only label is absent.
    expect(root.textContent ?? '').not.toContain('Web Speech API (Chromium');
  });

  it('shows "Web Speech API" copy on linux and does not mention "macOS native engine"', async () => {
    stubPlatform('linux');
    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    const root = screen.getByTestId('voice-settings-tab');
    expect(root.textContent ?? '').toContain('Web Speech API');
    expect(root.textContent ?? '').not.toContain('macOS native engine');
  });
});

describe('VoiceTab — native diagnostics dot is gated by platform', () => {
  beforeEach(() => {
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { sigma?: unknown }).sigma;
  });

  it('renders the neutral "Native: unavailable" placeholder on win32 after a diagnostics run', async () => {
    stubPlatform('win32');
    // Override the invoke mock so the diagnostics succeed and the
    // diagnostics block renders.
    (window as unknown as { sigma: { invoke: ReturnType<typeof vi.fn> } }).sigma.invoke = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        data: {
          nativeLoaded: false,
          permissionStatus: 'unsupported',
          dispatcherReachable: true,
          mode: 'auto',
          lastError: null,
        },
      });

    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    // The diagnostics hydrate runs in a useEffect → wait one microtask tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByTestId('voice-diagnostics-dot-native-unavailable')).toBeTruthy();
    // The red "Native" dot must NOT be present on Windows.
    expect(screen.queryByTestId('voice-diagnostics-dot-native')).toBeNull();
  });

  it('renders the regular "Native" diagnostics dot on darwin', async () => {
    stubPlatform('darwin');
    (window as unknown as { sigma: { invoke: ReturnType<typeof vi.fn> } }).sigma.invoke = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        data: {
          nativeLoaded: true,
          permissionStatus: 'granted',
          dispatcherReachable: true,
          mode: 'auto',
          lastError: null,
        },
      });

    const VoiceTab = await loadVoiceTab();
    render(<VoiceTab />);

    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByTestId('voice-diagnostics-dot-native')).toBeTruthy();
    expect(screen.queryByTestId('voice-diagnostics-dot-native-unavailable')).toBeNull();
  });
});
