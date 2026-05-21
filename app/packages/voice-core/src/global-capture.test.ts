// global-capture.test.ts — Unit tests for @sigmalink/voice-core.
//
// Covers the state machine, resample helper, A1 hardware-rate detection,
// and model-registry helpers. All native/Electron dependencies are mocked
// so tests run on any platform (Linux CI, macOS dev, Windows).
//
// Run via:
//   pnpm exec vitest run packages/voice-core/src/global-capture.test.ts

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: electron
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => ''),
  },
  app: {
    getPath: vi.fn(() => '/tmp/voice-core-test'),
  },
}));

// Mock native-mac-loader to avoid FS probes
vi.mock('./native-mac-loader.js', () => ({
  loadNative: vi.fn(() => null),
  isNativeMacVoiceAvailable: vi.fn(() => false),
  _resetNativeCache: vi.fn(),
}));

// Mock whisper-engine
vi.mock('./whisper-engine.js', () => ({
  getWhisperEngine: vi.fn(() => null),
  isWhisperAvailable: vi.fn(() => false),
  _resetWhisperEngineCache: vi.fn(),
}));

// Mock output-router
vi.mock('./output-router.js', () => ({
  routeTranscript: vi.fn(() => ({ target: 'clipboard', toast: '' })),
}));

// Mock model-registry
vi.mock('./model-registry.js', () => {
  const catalog = [
    { id: 'tiny.en-q5_1',   sizeMb: 31,  isDefault: false, filename: 'ggml-tiny.en-q5_1.bin',   name: 'Tiny' },
    { id: 'base.en-q5_1',   sizeMb: 57,  isDefault: true,  filename: 'ggml-base.en-q5_1.bin',   name: 'Base' },
    { id: 'small.en-q5_1',  sizeMb: 182, isDefault: false, filename: 'ggml-small.en-q5_1.bin',  name: 'Small' },
    { id: 'medium.en-q5_0', sizeMb: 515, isDefault: false, filename: 'ggml-medium.en-q5_0.bin', name: 'Medium' },
  ];
  return {
    getDefaultModel: vi.fn(() => catalog[1]),
    getModelById: vi.fn((id: string) => catalog.find((m) => m.id === id)),
    getDownloadedModelPath: vi.fn(() => null),
    MODEL_CATALOG: catalog,
    isModelDownloaded: vi.fn(() => false),
    downloadModel: vi.fn(() => Promise.resolve()),
    abortDownload: vi.fn(),
    isDownloading: vi.fn(() => false),
  };
});

import {
  buildGlobalCaptureController,
  resampleTo16k,
  unpackPcmChunk,
  NATIVE_PCM_SAMPLE_RATE,
  WHISPER_SAMPLE_RATE,
} from './global-capture.js';
import { globalShortcut } from 'electron';
import { routeTranscript } from './output-router.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeps() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const kv = new Map<string, string>();
  const clipboard = { writeText: vi.fn() };
  return {
    deps: {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
      kv: {
        get: (key: string) => kv.get(key) ?? null,
        set: (key: string, value: string) => { kv.set(key, value); },
      },
      getModelsDir: () => '/tmp/voice-core-test/voice-models',
      clipboard,
    },
    emitted,
    kv,
    clipboard,
  };
}

// ---------------------------------------------------------------------------
// resampleTo16k tests
// ---------------------------------------------------------------------------

describe('resampleTo16k', () => {
  it('returns the same array when inputRate is already 16 kHz', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const result = resampleTo16k(input, WHISPER_SAMPLE_RATE);
    expect(result).toBe(input);
  });

  it('output length ≈ input_length × (16000 / 48000) for 48 kHz input', () => {
    const inputLen = 48000;
    const input = new Float32Array(inputLen).fill(0.5);
    const output = resampleTo16k(input, 48000);
    const expectedLen = Math.floor(inputLen / (48000 / WHISPER_SAMPLE_RATE));
    expect(output.length).toBe(expectedLen);
  });

  it('output length ≈ input_length × (16000 / 44100) for 44.1 kHz input (A1 non-48k path)', () => {
    const inputLen = 44100;
    const input = new Float32Array(inputLen).fill(0.5);
    const output = resampleTo16k(input, 44100);
    const expectedLen = Math.floor(inputLen / (44100 / WHISPER_SAMPLE_RATE));
    expect(output.length).toBe(expectedLen);
  });

  it('handles 32 kHz input rate (non-standard hardware)', () => {
    const inputLen = 32000;
    const input = new Float32Array(inputLen).fill(0.5);
    const output = resampleTo16k(input, 32000);
    const expectedLen = Math.floor(inputLen / (32000 / WHISPER_SAMPLE_RATE));
    expect(output.length).toBe(expectedLen);
    // 32 kHz → 16 kHz = 2x downsample → 16000 samples
    expect(output.length).toBe(16000);
  });

  it('interpolates sample values correctly (48 kHz → 16 kHz)', () => {
    const inputLen = 96;
    const input = new Float32Array(inputLen);
    for (let i = 0; i < inputLen; i++) input[i] = i * 0.01;

    const output = resampleTo16k(input, 48000);
    const ratio = 48000 / 16000;

    for (let i = 0; i < Math.min(5, output.length); i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, inputLen - 1);
      const frac = srcIdx - i0;
      const expected = input[i0] * (1 - frac) + input[i1] * frac;
      expect(output[i]).toBeCloseTo(expected, 5);
    }
  });

  it('clamps the last interpolation index to input bounds', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(() => resampleTo16k(input, 48000)).not.toThrow();
  });

  it('NATIVE_PCM_SAMPLE_RATE constant is 48000', () => {
    expect(NATIVE_PCM_SAMPLE_RATE).toBe(48000);
  });

  it('WHISPER_SAMPLE_RATE constant is 16000', () => {
    expect(WHISPER_SAMPLE_RATE).toBe(16000);
  });
});

// ---------------------------------------------------------------------------
// A1: unpackPcmChunk tests — hardware sample-rate detection
// ---------------------------------------------------------------------------

describe('unpackPcmChunk — A1 hardware sample-rate detection', () => {
  it('falls back to NATIVE_PCM_SAMPLE_RATE for bare Float32Array (old stub behaviour)', () => {
    const chunk = new Float32Array([0.1, 0.2]);
    const { sampleRate } = unpackPcmChunk(chunk);
    expect(sampleRate).toBe(NATIVE_PCM_SAMPLE_RATE); // 48000
  });

  it('uses reported sampleRate from structured payload (new mac binding)', () => {
    const chunk = { samples: new Float32Array([0.1, 0.2]), sampleRate: 44100 };
    const { sampleRate, samples } = unpackPcmChunk(chunk);
    expect(sampleRate).toBe(44100);
    expect(samples).toBe(chunk.samples);
  });

  it('uses reported sampleRate of 48000 from structured payload', () => {
    const chunk = { samples: new Float32Array([0.5]), sampleRate: 48000 };
    const { sampleRate } = unpackPcmChunk(chunk);
    expect(sampleRate).toBe(48000);
  });

  it('falls back to NATIVE_PCM_SAMPLE_RATE when sampleRate in payload is 0', () => {
    const chunk = { samples: new Float32Array([0.1]), sampleRate: 0 };
    const { sampleRate } = unpackPcmChunk(chunk);
    expect(sampleRate).toBe(NATIVE_PCM_SAMPLE_RATE);
  });

  it('falls back to NATIVE_PCM_SAMPLE_RATE when sampleRate is negative', () => {
    const chunk = { samples: new Float32Array([0.1]), sampleRate: -1 };
    const { sampleRate } = unpackPcmChunk(chunk);
    expect(sampleRate).toBe(NATIVE_PCM_SAMPLE_RATE);
  });
});

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe('GlobalCaptureController — state machine', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('starts in idle state', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    expect(ctrl.getStatus().state).toBe('idle');
  });

  it('is disabled by default (no KV row)', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    expect(ctrl.getStatus().enabled).toBe(false);
  });

  it('respects KV voice.globalCapture.enabled=1 on init', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    expect(ctrl.getStatus().enabled).toBe(true);
  });

  it('registers the hotkey when enabled on init', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    buildGlobalCaptureController(deps);
    expect(globalShortcut.register).toHaveBeenCalledWith(
      expect.stringContaining('Alt'),
      expect.any(Function),
    );
  });

  it('does NOT register hotkey when disabled on init', () => {
    const { deps } = makeDeps();
    buildGlobalCaptureController(deps);
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });

  it('setEnabled(true) registers hotkey and persists KV', () => {
    const { deps, kv } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setEnabled(true);
    expect(kv.get('voice.globalCapture.enabled')).toBe('1');
    expect(globalShortcut.register).toHaveBeenCalled();
  });

  it('setEnabled(false) unregisters hotkey and persists KV', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setEnabled(false);
    expect(kv.get('voice.globalCapture.enabled')).toBe('0');
    expect(globalShortcut.unregister).toHaveBeenCalled();
  });

  it('setHotkey updates KV and re-registers', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    vi.clearAllMocks();
    ctrl.setHotkey('Control+Shift+V');
    expect(kv.get('voice.globalCapture.hotkey')).toBe('Control+Shift+V');
    expect(ctrl.getStatus().hotkey).toBe('Control+Shift+V');
    expect(globalShortcut.unregister).toHaveBeenCalled();
    expect(globalShortcut.register).toHaveBeenCalledWith('Control+Shift+V', expect.any(Function));
  });

  it('setMode persists to KV', () => {
    const { deps, kv } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setMode('push-to-talk');
    expect(kv.get('voice.globalCapture.mode')).toBe('push-to-talk');
    expect(ctrl.getStatus().mode).toBe('push-to-talk');
  });

  it('setModelId validates against catalog', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setModelId('tiny.en-q5_1');
    expect(ctrl.getStatus().modelId).toBe('tiny.en-q5_1');
  });

  it('setModelId ignores unknown ids', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    const before = ctrl.getStatus().modelId;
    ctrl.setModelId('nonexistent-model');
    expect(ctrl.getStatus().modelId).toBe(before);
  });

  it('getStatus reflects mode default = toggle', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    expect(ctrl.getStatus().mode).toBe('toggle');
  });

  it('broadcastStatus emits voice:global-capture-state on setEnabled', () => {
    const { deps, emitted } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setEnabled(true);
    const stateEvents = emitted.filter((e) => e.event === 'voice:global-capture-state');
    expect(stateEvents.length).toBeGreaterThan(0);
    const last = stateEvents[stateEvents.length - 1].payload as { enabled: boolean };
    expect(last.enabled).toBe(true);
  });

  it('dispose unregisters hotkey', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    vi.clearAllMocks();
    ctrl.dispose();
    expect(globalShortcut.unregister).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Output routing integration
// ---------------------------------------------------------------------------

describe('GlobalCaptureController — output routing integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (routeTranscript as Mock).mockReturnValue({ target: 'clipboard', toast: '' });
  });

  it('startRecording resolves gracefully when native = null', async () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    await expect(ctrl.startRecording()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hotkey registration tests
// ---------------------------------------------------------------------------

describe('GlobalCaptureController — hotkey registration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses DEFAULT_HOTKEY when no KV row exists', () => {
    const { deps } = makeDeps();
    const ctrl = buildGlobalCaptureController(deps);
    ctrl.setEnabled(true);
    const calls = (globalShortcut.register as Mock).mock.calls;
    expect(calls.some((c) => typeof c[0] === 'string' && c[0].includes('Alt'))).toBe(true);
  });

  it('uses stored KV hotkey on init', () => {
    const { deps, kv } = makeDeps();
    kv.set('voice.globalCapture.enabled', '1');
    kv.set('voice.globalCapture.hotkey', 'Control+Shift+;');
    buildGlobalCaptureController(deps);
    const calls = (globalShortcut.register as Mock).mock.calls;
    expect(calls.some((c) => c[0] === 'Control+Shift+;')).toBe(true);
  });

  it('handles failed globalShortcut.register gracefully', () => {
    const { deps, kv } = makeDeps();
    (globalShortcut.register as Mock).mockReturnValueOnce(false);
    kv.set('voice.globalCapture.enabled', '1');
    const ctrl = buildGlobalCaptureController(deps);
    expect(ctrl.getStatus().enabled).toBe(true);
  });
});
