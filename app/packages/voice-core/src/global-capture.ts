// global-capture.ts — Global voice capture state machine.
//
// Extracted from app/src/main/core/voice/global-capture.ts into @sigmalink/voice-core
// as part of the v1.4.8 Cluster B voice-core extraction.
//
// Changes from the original:
//   1. `routeTranscript` now receives `clipboard` as an extra argument
//      (injected via GlobalCaptureDeps) so this module works in both
//      SigmaLink and SigmaVoice without importing a specific app's electron
//      instance.
//   2. `modelsDir` is injected via `GlobalCaptureDeps.getModelsDir()` so
//      model-registry helpers receive the correct path without importing
//      Electron's `app.getPath('userData')` directly.
//   3. A1 (hardware sample-rate detection): the onPcm callback now accepts
//      either a bare Float32Array (old stub behaviour, rate assumed 48000)
//      or a `{ samples, sampleRate }` payload (v1.4.8+ mac binding). The
//      actual hardware rate is threaded through to `resampleTo16k` instead
//      of always using the hardcoded NATIVE_PCM_SAMPLE_RATE constant.
//
// State machine: idle → recording → transcribing → routing → idle

import { globalShortcut } from 'electron';
import { getWhisperEngine } from './whisper-engine.js';
import { routeTranscript } from './output-router.js';
import {
  getDefaultModel,
  getModelById,
  getDownloadedModelPath,
  MODEL_CATALOG,
} from './model-registry.js';
import { loadNative, type PcmChunk } from './native-mac-loader.js';
import type { ClipboardApi } from './output-router.js';

// ---------------------------------------------------------------------------
// C-10a — Inline dictionary/macro substitution (pure; no external dep)
// ---------------------------------------------------------------------------
//
// voice-core is self-contained and cannot import from app/src/shared/.
// The applyDictionary logic from @/shared/voice-dictionary is replicated here
// as a private helper. It is intentionally small and pure: no regex engine,
// no external dependencies.

interface DictionaryEntry {
  pattern: string;
  replacement: string;
  type: 'phrase' | 'macro';
}

const MAX_PATTERN_LENGTH = 200;
const KV_DICTIONARY = 'voice.dictionary';

/**
 * Replace all case-insensitive literal occurrences of `pattern` in `text`
 * with `replacement`. Uses split/join — no regex, no ReDoS risk.
 */
function replaceLiteral(text: string, pattern: string, replacement: string): string {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  let idx = lowerText.indexOf(lowerPattern, cursor);
  while (idx !== -1) {
    parts.push(text.slice(cursor, idx));
    parts.push(replacement);
    cursor = idx + pattern.length;
    idx = lowerText.indexOf(lowerPattern, cursor);
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Load the dictionary entries from KV and apply them to `text`.
 * Exported for unit-testing the substitution logic in isolation.
 *
 * @param text   Raw transcript text.
 * @param kvGet  KV accessor (reads voice.dictionary JSON).
 * @returns      Text with all dictionary substitutions applied, or the
 *               original text unchanged if no dictionary is stored or the
 *               stored JSON is malformed.
 */
export function normalizeTranscript(
  text: string,
  kvGet: (key: string) => string | null,
): string {
  try {
    const raw = kvGet(KV_DICTIONARY);
    if (!raw) return text;
    const entries = JSON.parse(raw) as DictionaryEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return text;
    // Apply longest-pattern-first to prevent short patterns from clobbering
    // longer matches that share a prefix.
    const sorted = [...entries].sort((a, b) => b.pattern.length - a.pattern.length);
    let result = text;
    for (const entry of sorted) {
      if (!entry.pattern || entry.pattern.length > MAX_PATTERN_LENGTH) continue;
      result = replaceLiteral(result, entry.pattern, entry.replacement);
    }
    return result;
  } catch {
    // Malformed KV data — return original text unchanged.
    return text;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CaptureState = 'idle' | 'recording' | 'transcribing' | 'routing';
export type CaptureMode = 'toggle' | 'push-to-talk';

export interface GlobalCaptureStatus {
  state: CaptureState;
  enabled: boolean;
  mode: CaptureMode;
  modelId: string;
  hotkey: string;
}

export interface GlobalCaptureDeps {
  emit: (event: string, payload: unknown) => void;
  kv: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
  /** Returns the absolute path to the voice-models storage directory. */
  getModelsDir: () => string;
  /** Electron clipboard API — injected for portability. */
  clipboard: ClipboardApi;
  // C-10b — focused-pane routing. All three are optional so existing
  // callers (tests, older main builds) need no changes to compile.
  /** Returns the id of the currently focused PTY pane, or null. */
  getFocusedSessionId?: () => string | null;
  /** Direct pty.write handle. Called only when injectToPane() returns true. */
  ptyWrite?: (sessionId: string, data: string) => void;
  /** Returns true when the "Dictate into the focused pane" KV toggle is on. */
  injectToPane?: () => boolean;
}

// ---------------------------------------------------------------------------
// KV keys
// ---------------------------------------------------------------------------

const KV_ENABLED  = 'voice.globalCapture.enabled';
const KV_HOTKEY   = 'voice.globalCapture.hotkey';
const KV_MODE     = 'voice.globalCapture.mode';
const KV_MODEL_ID = 'voice.globalCapture.modelId';

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+Space';
const DEFAULT_MODE: CaptureMode = 'toggle';
const DEFAULT_MODEL  = getDefaultModel().id;

// ---------------------------------------------------------------------------
// PCM sample-rate constants and resampler (A1 — hardware sample-rate detection)
// ---------------------------------------------------------------------------

/**
 * Fallback native PCM sample rate. Used when the native binding does not
 * report the actual hardware rate (e.g. voice-win stub, older voice-mac builds).
 * Modern Macs typically deliver 48 kHz; some older / external devices use 44.1 kHz.
 */
export const NATIVE_PCM_SAMPLE_RATE = 48000;
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Linearly interpolate `samples` from `inputRate` down to 16 kHz.
 * Returns the original array unchanged when `inputRate` is already 16 kHz.
 *
 * Linear interpolation is intentionally simple: whisper is robust to mild
 * aliasing artifacts and this avoids pulling in a DSP dependency.
 */
export function resampleTo16k(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === WHISPER_SAMPLE_RATE) return samples;
  const ratio = inputRate / WHISPER_SAMPLE_RATE;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcIdx - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * Unpack a PcmChunk into `{ samples, sampleRate }`.
 *
 * A1 — hardware sample-rate detection:
 *   - New mac binding (v1.4.8+): delivers `{ samples: Float32Array, sampleRate: number }`.
 *   - Old stub / Win: delivers a bare Float32Array; fall back to NATIVE_PCM_SAMPLE_RATE.
 */
export function unpackPcmChunk(chunk: PcmChunk): { samples: Float32Array; sampleRate: number } {
  if (chunk instanceof Float32Array) {
    return { samples: chunk, sampleRate: NATIVE_PCM_SAMPLE_RATE };
  }
  // Structured payload from updated native binding
  const sampleRate = typeof chunk.sampleRate === 'number' && chunk.sampleRate > 0
    ? chunk.sampleRate
    : NATIVE_PCM_SAMPLE_RATE;
  return { samples: chunk.samples, sampleRate };
}

// ---------------------------------------------------------------------------
// Audio PCM buffer accumulator
// ---------------------------------------------------------------------------

/**
 * Simple ring buffer that accumulates Float32 PCM chunks and tracks the
 * hardware sample rate reported by the first chunk (all chunks in one
 * recording session share the same rate).
 */
class PcmAccumulator {
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private _sampleRate = NATIVE_PCM_SAMPLE_RATE;

  push(chunk: PcmChunk): void {
    const { samples, sampleRate } = unpackPcmChunk(chunk);
    // Capture the rate from the first chunk; hardware rate is constant per session.
    if (this.chunks.length === 0) {
      this._sampleRate = sampleRate;
    }
    this.chunks.push(samples);
    this.totalSamples += samples.length;
  }

  flush(): { audio: Float32Array; sampleRate: number } {
    const out = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    const sampleRate = this._sampleRate;
    this.reset();
    return { audio: out, sampleRate };
  }

  reset(): void {
    this.chunks = [];
    this.totalSamples = 0;
    this._sampleRate = NATIVE_PCM_SAMPLE_RATE;
  }

  get samples(): number {
    return this.totalSamples;
  }
}

// ---------------------------------------------------------------------------
// Global capture controller factory
// ---------------------------------------------------------------------------

export function buildGlobalCaptureController(deps: GlobalCaptureDeps) {
  let state: CaptureState = 'idle';
  let enabled = false;
  let mode: CaptureMode = DEFAULT_MODE;
  let modelId = DEFAULT_MODEL;
  let hotkey = DEFAULT_HOTKEY;
  const pcm = new PcmAccumulator();
  let currentHotkeyRegistered = false;
  let unsubscribeOnFinal: (() => void) | null = null;
  let unsubscribeOnPcm: (() => void) | null = null;
  let capturedTranscript = '';

  function kvGet(key: string): string | null {
    try { return deps.kv.get(key); } catch { return null; }
  }

  function kvSet(key: string, val: string): void {
    try { deps.kv.set(key, val); } catch { /* non-fatal */ }
  }

  function setState(next: CaptureState): void {
    state = next;
    broadcastStatus();
  }

  function broadcastStatus(): void {
    deps.emit('voice:global-capture-state', getStatus());
  }

  function getStatus(): GlobalCaptureStatus {
    return { state, enabled, mode, modelId, hotkey };
  }

  function toast(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    deps.emit('voice:global-capture-toast', { message, level });
  }

  function loadFromKv(): void {
    const rawEnabled  = kvGet(KV_ENABLED);
    const rawHotkey   = kvGet(KV_HOTKEY);
    const rawMode     = kvGet(KV_MODE);
    const rawModelId  = kvGet(KV_MODEL_ID);

    enabled = rawEnabled === '1';
    hotkey  = rawHotkey ?? DEFAULT_HOTKEY;
    mode    = (rawMode === 'push-to-talk' ? 'push-to-talk' : DEFAULT_MODE);
    modelId = MODEL_CATALOG.find((m) => m.id === rawModelId)?.id ?? DEFAULT_MODEL;
  }

  function registerHotkey(): void {
    if (currentHotkeyRegistered) {
      globalShortcut.unregister(hotkey);
      currentHotkeyRegistered = false;
    }
    if (!enabled) return;

    const ok = globalShortcut.register(hotkey, onHotkeyFired);
    if (!ok) {
      console.warn(`[global-capture] Failed to register hotkey "${hotkey}" — it may be taken by another app.`);
      toast(`Could not register hotkey ${hotkey}. Try rebinding in Settings → Voice.`, 'warn');
      return;
    }
    currentHotkeyRegistered = true;
  }

  function unregisterHotkey(): void {
    if (currentHotkeyRegistered) {
      try { globalShortcut.unregister(hotkey); } catch { /* ignore */ }
      currentHotkeyRegistered = false;
    }
  }

  function onHotkeyFired(): void {
    if (!enabled) return;

    if (mode === 'toggle') {
      if (state === 'idle') {
        void startRecording();
      } else if (state === 'recording') {
        void stopAndTranscribe();
      }
    } else {
      if (state === 'idle') {
        void startRecording();
      } else if (state === 'recording') {
        void stopAndTranscribe();
      }
    }
  }

  async function startRecording(): Promise<void> {
    if (state !== 'idle') return;
    setState('recording');
    pcm.reset();

    const native = loadNative();
    if (!native) {
      setState('idle');
      toast('Voice capture unavailable (native module not loaded)', 'error');
      return;
    }

    try {
      const status = await native.requestPermission();
      if (status !== 'granted') {
        setState('idle');
        toast('Microphone permission denied — grant access in System Settings → Privacy → Microphone', 'warn');
        return;
      }

      if (unsubscribeOnPcm) {
        try { unsubscribeOnPcm(); } catch { /* ignore */ }
        unsubscribeOnPcm = null;
      }
      // A1 — pass the raw PcmChunk (may include sampleRate) to the accumulator
      if (typeof native.onPcm === 'function') {
        const unsub = native.onPcm((chunk: PcmChunk) => {
          pcm.push(chunk);
        });
        unsubscribeOnPcm = typeof unsub === 'function' ? unsub : null;
      }

      await native.start({ locale: 'en-US', onDevice: true, addPunctuation: true });
    } catch (err) {
      setState('idle');
      const message = err instanceof Error ? err.message : String(err);
      toast(`Voice capture start failed: ${message}`, 'error');
      return;
    }

    if (unsubscribeOnFinal) {
      try { unsubscribeOnFinal(); } catch { /* ignore */ }
      unsubscribeOnFinal = null;
    }
    capturedTranscript = '';
    const unsubscribe = native.onFinal((text: string) => {
      capturedTranscript += (capturedTranscript ? ' ' : '') + text;
    });
    unsubscribeOnFinal = typeof unsubscribe === 'function' ? unsubscribe : null;
  }

  async function stopAndTranscribe(): Promise<void> {
    if (state !== 'recording') return;
    setState('transcribing');

    const native = loadNative();

    if (native) {
      try { await native.stop(); } catch { /* ignore */ }
    }

    if (unsubscribeOnPcm) {
      try { unsubscribeOnPcm(); } catch { /* ignore */ }
      unsubscribeOnPcm = null;
    }

    let finalText = capturedTranscript.trim();

    const engine = getWhisperEngine();
    if (engine && pcm.samples > 0) {
      // A1 — use the hardware rate reported by the accumulator (from onPcm payload)
      const { audio, sampleRate: hwRate } = pcm.flush();
      const model = getModelById(modelId) ?? getDefaultModel();
      const modelsDir = deps.getModelsDir();
      const modelPath = getDownloadedModelPath(model, modelsDir);

      if (modelPath) {
        try {
          const audio16k = resampleTo16k(audio, hwRate);
          const result = await engine.transcribe(audio16k, modelPath, { language: 'en', threads: 4 });
          if (result.text.trim()) {
            finalText = result.text.trim();
          }
        } catch (err) {
          console.warn('[global-capture] whisper transcription failed, using SF result:', err);
        }
      } else {
        toast('Whisper model not downloaded — using Apple Speech. Download in Settings → Voice.', 'info');
      }
    }

    pcm.reset();

    if (!finalText) {
      setState('idle');
      return;
    }

    // C-10a — Apply phrase/macro dictionary substitutions before routing.
    finalText = normalizeTranscript(finalText, kvGet);

    // Route the transcript — C-10b: pass focused-pane opts when available.
    setState('routing');
    try {
      const result = routeTranscript(finalText, deps.emit, deps.clipboard, {
        focusedSessionId: deps.getFocusedSessionId?.() ?? null,
        injectToPane: deps.injectToPane?.() ?? false,
        ptyWrite: deps.ptyWrite,
      });
      if (result.toast) {
        toast(result.toast, 'info');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Voice output failed: ${message}`, 'error');
    } finally {
      setState('idle');
    }
  }

  function init(): void {
    loadFromKv();
    if (enabled) {
      registerHotkey();
    }
  }

  init();

  return {
    getStatus,

    setEnabled(value: boolean): void {
      enabled = value;
      kvSet(KV_ENABLED, value ? '1' : '0');
      if (value) {
        registerHotkey();
      } else {
        unregisterHotkey();
        if (state === 'recording') {
          void stopAndTranscribe();
        }
      }
      broadcastStatus();
    },

    setHotkey(newHotkey: string): void {
      unregisterHotkey();
      hotkey = newHotkey;
      kvSet(KV_HOTKEY, newHotkey);
      if (enabled) registerHotkey();
      broadcastStatus();
    },

    setMode(newMode: CaptureMode): void {
      mode = newMode;
      kvSet(KV_MODE, newMode);
      broadcastStatus();
    },

    setModelId(id: string): void {
      const found = MODEL_CATALOG.find((m) => m.id === id);
      if (!found) return;
      modelId = id;
      kvSet(KV_MODEL_ID, id);
      broadcastStatus();
    },

    startRecording(): Promise<void> {
      return startRecording();
    },

    stopAndTranscribe(): Promise<void> {
      return stopAndTranscribe();
    },

    dispose(): void {
      unregisterHotkey();
      if (unsubscribeOnFinal) {
        try { unsubscribeOnFinal(); } catch { /* ignore */ }
        unsubscribeOnFinal = null;
      }
      if (unsubscribeOnPcm) {
        try { unsubscribeOnPcm(); } catch { /* ignore */ }
        unsubscribeOnPcm = null;
      }
      if (state === 'recording') {
        try {
          const native = loadNative();
          if (native) void native.stop();
        } catch { /* ignore */ }
      }
      setState('idle');
    },
  };
}

export type GlobalCaptureController = ReturnType<typeof buildGlobalCaptureController>;
