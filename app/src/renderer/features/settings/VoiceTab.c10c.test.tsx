// @vitest-environment jsdom
// VoiceTab.c10c.test.tsx — Tests for C-10c controls in VoiceTab.
//
// Covers:
//   - "Transcription engine" segmented control (Local Whisper / Gemini CLI)
//     persisting voice.transcriptionMode via rpc.kv.set
//   - "Send commands to" selector (Claude Code / Codex / Gemini)
//     persisting voice.dispatchProvider via rpc.kv.set
//   - Both controls hydrate from rpc.kv.get on mount
//   - The existing local model-size picker still renders
//
// Run via:
//   npx vitest run src/renderer/features/settings/VoiceTab.c10c.test.tsx

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// vi.mock is hoisted so we use vi.hoisted() to create shared mock fns that
// are available inside the factory AND in the test body.
const { mockKvGet, mockKvSet } = vi.hoisted(() => ({
  mockKvGet: vi.fn(async (_key: string) => null as string | null),
  mockKvSet: vi.fn(async (_key: string, _value: string) => undefined),
}));

vi.mock('@/renderer/lib/rpc', () => ({
  rpc: {
    kv: { get: mockKvGet, set: mockKvSet },
    voice: {
      setMode: vi.fn(async () => undefined),
      permissionRequest: vi.fn(async () => ({ status: 'undetermined' })),
    },
  },
  rpcSilent: {
    kv: { get: vi.fn(async () => null) },
  },
}));

// Mock platform helpers — run as macOS so GlobalCaptureSection renders fully.
// IS_MAC is computed as getPlatform() === 'darwin' at module level in VoiceTab.
vi.mock('@/renderer/lib/platform', () => ({
  IS_WIN32: false,
  // IS_MAC would be derived but is not exported; we only need getPlatform.
  getPlatform: () => 'darwin',
}));

// Mock lucide-react icons to avoid SVG rendering issues.
vi.mock('lucide-react', () => ({
  BookOpen: () => React.createElement('span', { 'data-testid': 'icon-book' }),
  Download: () => React.createElement('span', { 'data-testid': 'icon-download' }),
  Keyboard: () => React.createElement('span', { 'data-testid': 'icon-keyboard' }),
  Mic: () => React.createElement('span', { 'data-testid': 'icon-mic' }),
  Radio: () => React.createElement('span', { 'data-testid': 'icon-radio' }),
  RefreshCw: () => React.createElement('span', { 'data-testid': 'icon-refresh' }),
  Settings2: () => React.createElement('span', { 'data-testid': 'icon-settings2' }),
  Terminal: () => React.createElement('span', { 'data-testid': 'icon-terminal' }),
  BarChart2: () => React.createElement('span', { 'data-testid': 'icon-chart' }),
}));

// Mock cn (classnames utility).
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Provide a minimal window.sigma bridge so GlobalCaptureSection doesn't throw.
Object.assign(window, {
  sigma: {
    invoke: vi.fn(async (_ch: string, _payload?: unknown) => ({ ok: true, data: null })),
    eventOn: vi.fn(() => () => undefined),
  },
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are in place)
// ---------------------------------------------------------------------------

import { VoiceTab } from './VoiceTab.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderVoiceTab() {
  return render(React.createElement(VoiceTab));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceTab — C-10c: Transcription engine control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
    mockKvSet.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it('renders the "Transcription engine" segmented control', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-transcription-mode-local').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('voice-transcription-mode-gemini-cli').length).toBeGreaterThan(0);
    });
  });

  it('"Local Whisper" button is selected by default (no KV entry)', async () => {
    renderVoiceTab();
    await waitFor(() => {
      const localBtns = screen.getAllByTestId('voice-transcription-mode-local');
      expect(localBtns[0].getAttribute('aria-checked')).toBe('true');
    });
  });

  it('hydrates "gemini-cli" selection from KV on mount', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.transcriptionMode') return 'gemini-cli';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const geminiBtns = screen.getAllByTestId('voice-transcription-mode-gemini-cli');
      expect(geminiBtns[0].getAttribute('aria-checked')).toBe('true');
    });
  });

  it('clicking "Gemini CLI" calls rpc.kv.set with voice.transcriptionMode = gemini-cli', async () => {
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-transcription-mode-gemini-cli'));
    fireEvent.click(screen.getAllByTestId('voice-transcription-mode-gemini-cli')[0]);
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.transcriptionMode', 'gemini-cli');
    });
  });

  it('clicking "Local Whisper" calls rpc.kv.set with voice.transcriptionMode = local', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.transcriptionMode') return 'gemini-cli';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-transcription-mode-local'));
    fireEvent.click(screen.getAllByTestId('voice-transcription-mode-local')[0]);
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.transcriptionMode', 'local');
    });
  });
});

describe('VoiceTab — C-10c: Dispatch provider control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
    mockKvSet.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it('renders the "Send commands to" selector', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-dispatch-provider-select').length).toBeGreaterThan(0);
    });
  });

  it('defaults to Claude Code when no KV entry', async () => {
    renderVoiceTab();
    await waitFor(() => {
      const selects = screen.getAllByTestId('voice-dispatch-provider-select');
      expect((selects[0] as HTMLSelectElement).value).toBe('claude');
    });
  });

  it('hydrates "codex" from KV on mount', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.dispatchProvider') return 'codex';
      return null;
    });
    renderVoiceTab();
    await waitFor(
      () => {
        const selects = screen.getAllByTestId('voice-dispatch-provider-select');
        expect((selects[0] as HTMLSelectElement).value).toBe('codex');
      },
      { timeout: 3000 },
    );
  });

  it('hydrates "gemini" from KV on mount', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.dispatchProvider') return 'gemini';
      return null;
    });
    renderVoiceTab();
    await waitFor(
      () => {
        const selects = screen.getAllByTestId('voice-dispatch-provider-select');
        expect((selects[0] as HTMLSelectElement).value).toBe('gemini');
      },
      { timeout: 3000 },
    );
  });

  it('changing to Codex calls rpc.kv.set with voice.dispatchProvider = codex', async () => {
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-dispatch-provider-select'));
    fireEvent.change(screen.getAllByTestId('voice-dispatch-provider-select')[0], {
      target: { value: 'codex' },
    });
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.dispatchProvider', 'codex');
    });
  });

  it('changing to Gemini calls rpc.kv.set with voice.dispatchProvider = gemini', async () => {
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-dispatch-provider-select'));
    fireEvent.change(screen.getAllByTestId('voice-dispatch-provider-select')[0], {
      target: { value: 'gemini' },
    });
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.dispatchProvider', 'gemini');
    });
  });
});

describe('VoiceTab — C-10c: Existing controls still render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
  });

  afterEach(() => { cleanup(); });

  it('the local model-size picker (Whisper model section) still renders', async () => {
    renderVoiceTab();
    await waitFor(() => {
      // The model picker renders buttons for each model size.
      expect(screen.getAllByTestId('voice-model-tiny.en-q5_1').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('voice-model-base.en-q5_1').length).toBeGreaterThan(0);
    });
  });

  it('the global capture toggle still renders', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-global-capture-toggle').length).toBeGreaterThan(0);
    });
  });
});
