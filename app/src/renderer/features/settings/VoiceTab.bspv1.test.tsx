// @vitest-environment jsdom
// VoiceTab.bspv1.test.tsx — Tests for BSP-V1 multi-provider STT picker in VoiceTab.
//
// Covers:
//   - All 4 provider buttons render
//   - Cloud options are disabled when no API key is set
//   - Cloud options are enabled once an API key is entered
//   - Selecting a provider persists voice.transcriptionMode via rpc.kv.set
//   - Cloud option disabled when no key → cannot select it
//   - API key fields save on blur to the correct KV key
//   - OpenAI and Deepgram key fields have correct data-testids
//   - Hydration: cloud modes load correctly from KV on mount
//
// Run via:
//   npx vitest run src/renderer/features/settings/VoiceTab.bspv1.test.tsx

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockKvGet, mockKvSet } = vi.hoisted(() => ({
  mockKvGet: vi.fn<(key: string) => Promise<string | null>>(async () => null),
  mockKvSet: vi.fn<(key: string, value: string) => Promise<void>>(async () => undefined),
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

vi.mock('@/renderer/lib/platform', () => ({
  IS_WIN32: false,
  getPlatform: () => 'darwin',
}));

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

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

Object.assign(window, {
  sigma: {
    invoke: vi.fn(async () => ({ ok: true, data: null })),
    eventOn: vi.fn(() => () => undefined),
  },
});

// ---------------------------------------------------------------------------
// Import under test (after mocks)
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

describe('VoiceTab — BSP-V1: 4-provider STT picker renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
    mockKvSet.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it('renders all 4 transcription mode buttons', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-transcription-mode-local').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('voice-transcription-mode-gemini-cli').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('voice-transcription-mode-openai-whisper-api').length).toBeGreaterThan(0);
      expect(screen.getAllByTestId('voice-transcription-mode-deepgram').length).toBeGreaterThan(0);
    });
  });

  it('local is selected by default', async () => {
    renderVoiceTab();
    await waitFor(() => {
      const localBtn = screen.getAllByTestId('voice-transcription-mode-local')[0];
      expect(localBtn.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('cloud buttons are disabled when no API key is set', async () => {
    renderVoiceTab();
    await waitFor(() => {
      const openaiBtn = screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0] as HTMLButtonElement;
      const deepgramBtn = screen.getAllByTestId('voice-transcription-mode-deepgram')[0] as HTMLButtonElement;
      // disabled HTML attribute is set on the button element
      expect(openaiBtn.disabled).toBe(true);
      expect(deepgramBtn.disabled).toBe(true);
    });
  });

  it('OpenAI button is enabled when an OpenAI API key is loaded from KV', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.openai-whisper-api.apiKey') return 'sk-test-key';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const openaiBtn = screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0] as HTMLButtonElement;
      expect(openaiBtn.disabled).toBe(false);
    });
  });

  it('Deepgram button is enabled when a Deepgram API key is loaded from KV', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.deepgram.apiKey') return 'dg-key-abc';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const deepgramBtn = screen.getAllByTestId('voice-transcription-mode-deepgram')[0] as HTMLButtonElement;
      expect(deepgramBtn.disabled).toBe(false);
    });
  });

  it('selecting an enabled cloud option persists voice.transcriptionMode to KV', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.openai-whisper-api.apiKey') return 'sk-key';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const openaiBtn = screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0] as HTMLButtonElement;
      expect(openaiBtn.disabled).toBe(false);
    });
    fireEvent.click(screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0]);
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.transcriptionMode', 'openai-whisper-api');
    });
  });

  it('selecting deepgram persists voice.transcriptionMode = deepgram', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.deepgram.apiKey') return 'dg-key';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const deepgramBtn = screen.getAllByTestId('voice-transcription-mode-deepgram')[0] as HTMLButtonElement;
      expect(deepgramBtn.disabled).toBe(false);
    });
    fireEvent.click(screen.getAllByTestId('voice-transcription-mode-deepgram')[0]);
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.transcriptionMode', 'deepgram');
    });
  });

  it('clicking a disabled cloud option does NOT call rpc.kv.set for the mode', async () => {
    // No keys set → both cloud buttons disabled
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-transcription-mode-openai-whisper-api'));
    // Clicking disabled button should be a no-op
    fireEvent.click(screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0]);
    // Give a tick for any async work
    await new Promise((r) => setTimeout(r, 50));
    expect(mockKvSet).not.toHaveBeenCalledWith('voice.transcriptionMode', 'openai-whisper-api');
  });
});

describe('VoiceTab — BSP-V1: API key fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
    mockKvSet.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it('renders the OpenAI STT key field', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-openai-stt-key').length).toBeGreaterThan(0);
    });
  });

  it('renders the Deepgram STT key field', async () => {
    renderVoiceTab();
    await waitFor(() => {
      expect(screen.getAllByTestId('voice-deepgram-stt-key').length).toBeGreaterThan(0);
    });
  });

  it('OpenAI key field saves to voice.stt.openai-whisper-api.apiKey on blur', async () => {
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-openai-stt-key'));
    const input = screen.getAllByTestId('voice-openai-stt-key')[0] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'sk-mykey123' } });
      fireEvent.blur(input);
    });
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.stt.openai-whisper-api.apiKey', 'sk-mykey123');
    });
  });

  it('Deepgram key field saves to voice.stt.deepgram.apiKey on blur', async () => {
    renderVoiceTab();
    await waitFor(() => screen.getAllByTestId('voice-deepgram-stt-key'));
    const input = screen.getAllByTestId('voice-deepgram-stt-key')[0] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'dg-prod-key' } });
      fireEvent.blur(input);
    });
    await waitFor(() => {
      expect(mockKvSet).toHaveBeenCalledWith('voice.stt.deepgram.apiKey', 'dg-prod-key');
    });
  });

  it('hydrates the OpenAI key field from KV on mount', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.openai-whisper-api.apiKey') return 'sk-existing';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const input = screen.getAllByTestId('voice-openai-stt-key')[0] as HTMLInputElement;
      expect(input.value).toBe('sk-existing');
    });
  });

  it('hydrates the Deepgram key field from KV on mount', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.stt.deepgram.apiKey') return 'dg-existing';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const input = screen.getAllByTestId('voice-deepgram-stt-key')[0] as HTMLInputElement;
      expect(input.value).toBe('dg-existing');
    });
  });
});

describe('VoiceTab — BSP-V1: hydration of cloud modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKvGet.mockResolvedValue(null);
    mockKvSet.mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it('hydrates openai-whisper-api mode from KV', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.transcriptionMode') return 'openai-whisper-api';
      if (key === 'voice.stt.openai-whisper-api.apiKey') return 'sk-key';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const btn = screen.getAllByTestId('voice-transcription-mode-openai-whisper-api')[0];
      expect(btn.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('hydrates deepgram mode from KV', async () => {
    mockKvGet.mockImplementation(async (key: string) => {
      if (key === 'voice.transcriptionMode') return 'deepgram';
      if (key === 'voice.stt.deepgram.apiKey') return 'dg-key';
      return null;
    });
    renderVoiceTab();
    await waitFor(() => {
      const btn = screen.getAllByTestId('voice-transcription-mode-deepgram')[0];
      expect(btn.getAttribute('aria-checked')).toBe('true');
    });
  });
});
