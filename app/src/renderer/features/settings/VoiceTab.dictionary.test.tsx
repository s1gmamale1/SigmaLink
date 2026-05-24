// @vitest-environment jsdom
//
// V4 — VoiceTab dictionary editor + macros + usage dashboard sections.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

// Polyfills for Radix UI in jsdom (mirrors PaneHeader.test.tsx)
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() { /* no-op */ }
      unobserve() { /* no-op */ }
      disconnect() { /* no-op */ }
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) {
    proto.hasPointerCapture = () => false;
  }
  if (!proto.scrollIntoView) {
    proto.scrollIntoView = () => undefined;
  }
});

// KV mock data
const DICT_ENTRIES = [
  { pattern: 'at coordinator', replacement: '@coordinator', type: 'phrase' },
];
const MACRO_ENTRIES = [
  { pattern: 'new line', replacement: '\n', type: 'macro' },
];
const STATS = [
  { words: 100, durationMs: 30_000, wpm: 200 },
  { words: 50, durationMs: 15_000, wpm: 200 },
];

const kvStore: Record<string, string> = {
  'voice.dictionary': JSON.stringify([...DICT_ENTRIES, ...MACRO_ENTRIES]),
  'voice.stats': JSON.stringify(STATS),
};

// Mock rpc and rpcSilent before importing VoiceTab
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    voice: {
      setMode: vi.fn().mockResolvedValue(undefined),
      permissionRequest: vi.fn().mockResolvedValue({ status: 'unsupported' }),
    },
    kv: {
      get: vi.fn((key: string) => Promise.resolve(kvStore[key] ?? null)),
      set: vi.fn((key: string, value: string) => {
        kvStore[key] = value;
        return Promise.resolve();
      }),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn().mockResolvedValue(null) },
  },
}));

function stubPlatform(platform: NodeJS.Platform) {
  (window as unknown as { sigma?: Record<string, unknown> }).sigma = {
    platform,
    invoke: vi.fn().mockRejectedValue(new Error('test')),
    eventOn: vi.fn(() => () => undefined),
    eventSend: vi.fn(),
    getPathForFile: vi.fn(() => ''),
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { sigma?: unknown }).sigma;
});

describe('VoiceTab — dictionary + macros + usage sections', () => {
  it('renders dictionary entries from rpc.kv', async () => {
    stubPlatform('darwin');
    vi.resetModules();
    const { VoiceTab } = await import('./VoiceTab');
    render(<VoiceTab />);
    await waitFor(() => {
      expect(screen.getByTestId('voice-dictionary-section')).toBeTruthy();
    });
    // Should display the phrase entry pattern
    expect(screen.getByTestId('voice-dictionary-section').textContent).toContain('at coordinator');
  });

  it('renders macro entries from rpc.kv', async () => {
    stubPlatform('darwin');
    vi.resetModules();
    const { VoiceTab } = await import('./VoiceTab');
    render(<VoiceTab />);
    await waitFor(() => {
      expect(screen.getByTestId('voice-macros-section')).toBeTruthy();
    });
    expect(screen.getByTestId('voice-macros-section').textContent).toContain('new line');
  });

  it('renders usage stats section with total words', async () => {
    stubPlatform('darwin');
    vi.resetModules();
    const { VoiceTab } = await import('./VoiceTab');
    render(<VoiceTab />);
    await waitFor(() => {
      expect(screen.getByTestId('voice-usage-section')).toBeTruthy();
    });
    // Total words = 100 + 50 = 150
    expect(screen.getByTestId('voice-usage-section').textContent).toContain('150');
  });

  it('adds a new dictionary entry on form submit', async () => {
    const { rpc } = await import('@/renderer/lib/rpc');
    stubPlatform('darwin');
    vi.resetModules();
    const { VoiceTab } = await import('./VoiceTab');
    render(<VoiceTab />);
    await waitFor(() => screen.getByTestId('voice-dictionary-section'));

    // Fill in the add-entry form
    fireEvent.change(screen.getByTestId('voice-dict-pattern-input'), {
      target: { value: 'new pattern' },
    });
    fireEvent.change(screen.getByTestId('voice-dict-replacement-input'), {
      target: { value: 'NEW' },
    });
    fireEvent.click(screen.getByTestId('voice-dict-add-btn'));

    await waitFor(() => {
      expect(rpc.kv.set).toHaveBeenCalledWith(
        'voice.dictionary',
        expect.stringContaining('new pattern'),
      );
    });
  });
});
