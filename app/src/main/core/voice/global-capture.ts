// global-capture.ts — Global voice capture state machine.
//
// State machine: idle → recording → transcribing → routing → idle
//
// On hotkey activation (Cmd+Option+Space default):
//   - Toggle mode (default): first press starts recording; second press stops.
//   - Push-to-talk mode: hold starts recording; release stops.
//
// Audio capture uses the macOS native voice-mac module's AVAudioEngine
// session (separate from the in-app SigmaVoice session — no mixer conflict).
// On stop, the Float32 PCM buffer is handed to whisper-engine for offline
// transcription. On completion, output-router decides the output target.
//
// KV keys:
//   voice.globalCapture.enabled       '1' | '0'    (default '0' = off)
//   voice.globalCapture.hotkey        Electron accelerator string
//   voice.globalCapture.mode          'toggle' | 'push-to-talk'  (default 'toggle')
//   voice.globalCapture.modelId       one of the MODEL_CATALOG ids
//   voice.globalCapture.outputTarget  'auto' | 'clipboard'  (future: more)
//
// v1.4.9 — macOS only for transcription. The state machine runs on all
// platforms but only macOS has the native audio capture + whisper build.

import { globalShortcut } from 'electron';
import { getWhisperEngine } from './whisper-engine';
import { routeTranscript } from './output-router';
import { getDefaultModel, getModelById, getDownloadedModelPath, MODEL_CATALOG } from './model-registry';
import { loadNative } from './native-mac';
import { applyDictionary, type DictionaryEntry } from '../../../shared/voice-dictionary';
import { computeSessionStats, appendSessionStat, type TranscriptSegment } from './voice-stats';

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

const KV_ENABLED      = 'voice.globalCapture.enabled';
const KV_HOTKEY       = 'voice.globalCapture.hotkey';
const KV_MODE         = 'voice.globalCapture.mode';
const KV_MODEL_ID     = 'voice.globalCapture.modelId';
const KV_DICTIONARY   = 'voice.dictionary';

// ---------------------------------------------------------------------------
// Exported helpers (thin wrappers to enable unit-testing without Electron)
// ---------------------------------------------------------------------------

/**
 * Load the dictionary entries from KV and apply them to `text`.
 * Exported so unit tests can exercise the substitution logic directly.
 */
export function normalizeTranscript(
  text: string,
  kvGet: (key: string) => string | null,
): string {
  try {
    const raw = kvGet(KV_DICTIONARY);
    if (!raw) return text;
    const entries = JSON.parse(raw) as DictionaryEntry[];
    if (!Array.isArray(entries)) return text;
    return applyDictionary(text, entries);
  } catch {
    // Malformed KV data — return original text unchanged.
    return text;
  }
}

const DEFAULT_HOTKEY  = 'CommandOrControl+Alt+Space';
const DEFAULT_MODE: CaptureMode = 'toggle';
const DEFAULT_MODEL   = getDefaultModel().id;

// ---------------------------------------------------------------------------
// PCM sample-rate resampler (v1.5.4-C / A1 hardware sample-rate detection)
// ---------------------------------------------------------------------------

/**
 * Fallback native PCM sample rate used when the native binding does not
 * report the actual hardware rate (older builds, voice-win stub, etc.).
 * Modern Macs typically deliver 48 kHz; some older / external devices use 44.1 kHz.
 *
 * v1.4.8 (A1): the voice-mac binding now reports the actual hardware rate via
 * the onPcm `{ samples, sampleRate }` payload. `NATIVE_PCM_SAMPLE_RATE` is
 * kept as a fallback for Win/other platforms and for the stub.
 */
export const NATIVE_PCM_SAMPLE_RATE = 48000;
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Linearly interpolate `samples` from `inputRate` down to 16 kHz.
 * Returns the original array unchanged when `inputRate` is already 16 kHz.
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
 * A1 — Unpack the onPcm callback payload.
 * - New mac binding (v1.4.8+): delivers `{ samples: Float32Array, sampleRate: number }`.
 * - Old stub / non-darwin: delivers a bare Float32Array; fallback to NATIVE_PCM_SAMPLE_RATE.
 */
type PcmPayload = Float32Array | { samples: Float32Array; sampleRate: number };

function unpackPcm(payload: PcmPayload): { samples: Float32Array; sampleRate: number } {
  if (payload instanceof Float32Array) {
    return { samples: payload, sampleRate: NATIVE_PCM_SAMPLE_RATE };
  }
  const sampleRate = typeof payload.sampleRate === 'number' && payload.sampleRate > 0
    ? payload.sampleRate
    : NATIVE_PCM_SAMPLE_RATE;
  return { samples: payload.samples, sampleRate };
}

// ---------------------------------------------------------------------------
// Audio PCM buffer accumulator
// ---------------------------------------------------------------------------

/**
 * Simple ring buffer that accumulates Float32 PCM chunks from the native
 * audio tap and produces a single Float32Array on demand.
 *
 * A1: also tracks the hardware sample rate reported by the first chunk in
 * each recording session. All chunks in one session share the same rate.
 */
class PcmAccumulator {
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private _sampleRate = NATIVE_PCM_SAMPLE_RATE;

  push(payload: PcmPayload): void {
    const { samples, sampleRate } = unpackPcm(payload);
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
  // ── State ────────────────────────────────────────────────────────────────
  let state: CaptureState = 'idle';
  let enabled = false;
  let mode: CaptureMode = DEFAULT_MODE;
  let modelId = DEFAULT_MODEL;
  let hotkey = DEFAULT_HOTKEY;
  const pcm = new PcmAccumulator();
  let currentHotkeyRegistered = false;
  // Caveat from PR #50 review (caveat 3): native.onFinal returns an
  // unsubscribe function; we must call it before re-registering on each
  // startRecording() or listeners leak (and transcripts may concat across
  // recordings).
  let unsubscribeOnFinal: (() => void) | null = null;
  // PCM tap unsubscribe handle (installed before start(); cleared in dispose()).
  let unsubscribeOnPcm: (() => void) | null = null;
  // Hoisted transcript accumulator (PR #50 caveat 4 — replaces _capturedRef
  // metaprogramming). Written by startRecording(), read by stopAndTranscribe().
  let capturedTranscript = '';

  // ── Helpers ──────────────────────────────────────────────────────────────

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

  // ── Bootstrap from KV ────────────────────────────────────────────────────

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

  // ── Hotkey registration ───────────────────────────────────────────────────

  function registerHotkey(): void {
    if (currentHotkeyRegistered) {
      globalShortcut.unregister(hotkey);
      currentHotkeyRegistered = false;
    }
    if (!enabled) return;

    const ok = globalShortcut.register(hotkey, onHotkeyFired);
    if (!ok) {
      console.warn(
        `[global-capture] Failed to register hotkey "${hotkey}" — it may be taken by another app.`,
      );
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

  // ── Hotkey handler ────────────────────────────────────────────────────────

  function onHotkeyFired(): void {
    if (!enabled) return;

    if (mode === 'toggle') {
      if (state === 'idle') {
        void startRecording();
      } else if (state === 'recording') {
        void stopAndTranscribe();
      }
      // Ignore presses while transcribing / routing
    } else {
      // push-to-talk: same button used for both start and stop
      // The distinction (hold vs press-release) can't be made with Electron's
      // globalShortcut (fires on keydown only). We map it to toggle semantics
      // for v1.4.9 and expose it as a "quick tap = toggle" fallback.
      if (state === 'idle') {
        void startRecording();
      } else if (state === 'recording') {
        void stopAndTranscribe();
      }
    }
  }

  // ── Audio capture ─────────────────────────────────────────────────────────

  async function startRecording(): Promise<void> {
    if (state !== 'idle') return;
    setState('recording');
    pcm.reset();

    const native = loadNative();
    if (!native) {
      // No native audio module — cannot capture on this platform
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

      // Install the PCM tap BEFORE start() so no audio frames are missed.
      // Only available on macOS (voice-mac exposes onPcm; voice-win does not).
      if (unsubscribeOnPcm) {
        try { unsubscribeOnPcm(); } catch { /* ignore */ }
        unsubscribeOnPcm = null;
      }
      if (typeof native.onPcm === 'function') {
        // A1: receive PcmPayload (may be Float32Array for old stubs, or
        // { samples, sampleRate } for updated mac binding).
        const unsub = native.onPcm((payload: PcmPayload) => {
          pcm.push(payload);
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

    // Collect final transcripts from the in-app SFSpeechRecognizer as a
    // fallback text source. When a whisper.cpp model is downloaded and the
    // AVAudioEngine PCM tap is active, `pcm.samples > 0` will be true and
    // stopAndTranscribe() will prefer the whisper.cpp result over this.
    //
    // We'll collect the final transcript from native speech recognition.
    // Unsubscribe any prior onFinal listener first (PR #50 caveat 3 fix).
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

    // Stop native audio capture
    if (native) {
      try { await native.stop(); } catch { /* ignore */ }
    }

    // Tear down the PCM tap subscription now that recording has stopped.
    if (unsubscribeOnPcm) {
      try { unsubscribeOnPcm(); } catch { /* ignore */ }
      unsubscribeOnPcm = null;
    }

    let finalText = capturedTranscript.trim();
    let whisperSegments: TranscriptSegment[] = [];

    // If whisper.cpp is available and we have PCM audio, prefer it
    const engine = getWhisperEngine();
    if (engine && pcm.samples > 0) {
      // A1: use the hardware sample rate captured from the onPcm payload
      const { audio, sampleRate: hwRate } = pcm.flush();
      const model = getModelById(modelId) ?? getDefaultModel();
      const modelPath = getDownloadedModelPath(model);

      if (modelPath) {
        try {
          const audio16k = resampleTo16k(audio, hwRate);
          const result = await engine.transcribe(audio16k, modelPath, {
            language: 'en',
            threads: 4,
          });
          if (result.text.trim()) {
            finalText = result.text.trim();
          }
          // Capture segments for usage stats (previously discarded).
          if (Array.isArray(result.segments)) {
            whisperSegments = result.segments as TranscriptSegment[];
          }
        } catch (err) {
          // Whisper failed — fall through to SFSpeechRecognizer result
          console.warn('[global-capture] whisper transcription failed, using SF result:', err);
        }
      } else {
        // Model not downloaded yet — use SF result
        toast('Whisper model not downloaded — using Apple Speech. Download in Settings → Voice.', 'info');
      }
    }

    pcm.reset();

    if (!finalText) {
      setState('idle');
      return;
    }

    // Apply phrase/macro dictionary substitutions before routing.
    finalText = normalizeTranscript(finalText, kvGet);

    // Route the transcript — C-10b: pass focused-pane opts when available
    setState('routing');
    try {
      const result = routeTranscript(finalText, deps.emit, {
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

    // Persist session stats best-effort (never blocks or throws).
    if (whisperSegments.length > 0) {
      try {
        const stat = computeSessionStats(whisperSegments);
        appendSessionStat(deps.kv, stat);
      } catch {
        // Non-fatal — stats are informational only.
      }
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function init(): void {
    loadFromKv();
    if (enabled) {
      registerHotkey();
    }
  }

  init();

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    getStatus,

    /**
     * Enable or disable global capture.
     * When enabling for the first time, the caller should ensure the model is
     * downloaded before calling this (the Settings UI enforces this via the
     * download flow).
     */
    setEnabled(value: boolean): void {
      enabled = value;
      kvSet(KV_ENABLED, value ? '1' : '0');
      if (value) {
        registerHotkey();
      } else {
        unregisterHotkey();
        // Cancel any in-flight capture
        if (state === 'recording') {
          void stopAndTranscribe();
        }
      }
      broadcastStatus();
    },

    /** Rebind the global hotkey. Applies immediately. */
    setHotkey(newHotkey: string): void {
      unregisterHotkey();
      hotkey = newHotkey;
      kvSet(KV_HOTKEY, newHotkey);
      if (enabled) registerHotkey();
      broadcastStatus();
    },

    /** Switch between 'toggle' and 'push-to-talk'. */
    setMode(newMode: CaptureMode): void {
      mode = newMode;
      kvSet(KV_MODE, newMode);
      broadcastStatus();
    },

    /** Switch the active model (must be downloaded before calling). */
    setModelId(id: string): void {
      const found = MODEL_CATALOG.find((m) => m.id === id);
      if (!found) return;
      modelId = id;
      kvSet(KV_MODEL_ID, id);
      broadcastStatus();
    },

    /**
     * Programmatic start (for testing / accessibility bypass).
     * No-op when already recording.
     */
    startRecording(): Promise<void> {
      return startRecording();
    },

    /**
     * Programmatic stop + transcribe.
     * No-op when idle.
     */
    stopAndTranscribe(): Promise<void> {
      return stopAndTranscribe();
    },

    /**
     * Clean up: unregister hotkey and tear down any active session.
     * Called from `before-quit`.
     */
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
      // PR #50 latent-bug fix: previous code referenced undefined `native_ref`
      // — would have thrown on quit when state === 'recording'. Reload the
      // native module the same way startRecording does.
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
