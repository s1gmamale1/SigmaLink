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
import { getWhisperEngine, resolveTranscriptionEngine } from './whisper-engine.js';
import { buildCliTranscribeEngine } from './cli-transcribe-engine.js';
import type { CliTranscribeEngineDeps } from './cli-transcribe-engine.js';
import { buildOpenAiSttEngine, buildDeepgramSttEngine } from './cloud-stt-engine.js';
import type { CloudSttEngineDeps } from './cloud-stt-engine.js';
import { routeTranscript } from './output-router.js';
import { computeSessionStats, appendSessionStat } from './voice-stats.js';
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
  /**
   * False when `globalShortcut.register` last failed (hotkey taken by another
   * app / IME). Persistent — late subscribers (VoiceTab mounts long after
   * boot; the boot-time toast is gone by then) can still render a warning.
   */
  hotkeyRegistered: boolean;
}

/**
 * Minimal rolling-PCM-ring contract the listening loop depends on. The concrete
 * implementation (`@/shared/pcm-ring` PcmRing) lives in the SigmaLink app and is
 * injected via `createPcmRing` so voice-core stays free of an app-`src` import.
 */
export interface PcmRingLike {
  push(chunk: Float32Array): void;
  lastSeconds(sec: number, sampleRate: number): Float32Array;
  reset(): void;
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
  /** Override platform — tests force the win32 accelerator default. */
  platform?: NodeJS.Platform;

  // ── C-10b focused-pane routing (used by the package's routeTranscript when
  //    injectToPane() is true; wired by the SigmaLink main process). ──
  getFocusedSessionId?: () => string | null;
  ptyWrite?: (sessionId: string, data: string) => void;
  injectToPane?: () => boolean;

  // ── C-10c — CLI transcription engine (optional; absent = local Whisper) ──
  /**
   * Override deps for the Gemini-CLI transcription engine.  When absent the
   * engine is built with production defaults (spawns `gemini` from PATH).
   * Only used when `kv.get('voice.transcriptionMode') === 'gemini-cli'`.
   */
  cliEngineDeps?: CliTranscribeEngineDeps;

  // ── BSP-V1 — Cloud STT engines (optional; absent = feature unavailable) ──
  /**
   * Override deps for cloud STT engines (OpenAI / Deepgram).  When absent the
   * engine is built with production defaults (reads keys from KV via `kv.get`).
   * Only used when `kv.get('voice.transcriptionMode')` is `'openai-whisper-api'`
   * or `'deepgram'`.
   */
  cloudSttEngineDeps?: Pick<CloudSttEngineDeps, 'fetchFn'>;

  // ── C-11 "Hey Jorvis" listening mode (all optional; absent = feature off) ──
  /** True when `voice.listeningMode` is enabled. */
  getListeningMode?: () => boolean;
  /**
   * Absolute path to the downloaded tiny.en model used for wake detection
   * (independent of the user's main capture model), or null when not present.
   */
  getTinyModelPath?: () => string | null;
  /** Energy gate — injected from `@/shared/audio-energy` isSpeech(). */
  isSpeech?: (samples: Float32Array) => boolean;
  /** Wake-word matcher — injected from `@/shared/wake-word` matchesWakeWord(). */
  matchesWakeWord?: (text: string) => boolean;
  /** Factory for a rolling PCM ring — injected from `@/shared/pcm-ring`. */
  createPcmRing?: (capacity: number) => PcmRingLike;
  /** Timer injection (testability). Defaults to global setInterval/clearInterval. */
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

// ---------------------------------------------------------------------------
// KV keys
// ---------------------------------------------------------------------------

const KV_ENABLED  = 'voice.globalCapture.enabled';
const KV_HOTKEY   = 'voice.globalCapture.hotkey';
const KV_MODE     = 'voice.globalCapture.mode';
const KV_MODEL_ID = 'voice.globalCapture.modelId';

/**
 * Platform-aware default PTT accelerator. On win32, Ctrl+Alt+Space (what
 * CommandOrControl+Alt+Space resolves to there) collides with the IME
 * input-method toggle on several keyboard layouts, so the win32 default is
 * Ctrl+Shift+Space. A user-chosen hotkey stored in KV always wins.
 */
export function defaultGlobalCaptureHotkey(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Control+Shift+Space' : 'CommandOrControl+Alt+Space';
}

const DEFAULT_MODE: CaptureMode = 'toggle';
const DEFAULT_MODEL  = getDefaultModel().id;

// ── C-11 listening-loop tuning ──────────────────────────────────────────────
/** How often the wake loop evaluates the rolling buffer. */
const LISTEN_TICK_MS = 750;
/** Rolling window (seconds) handed to the tiny model on each speech tick. */
const WAKE_WINDOW_SEC = 3;
/** Short window (seconds) used by the energy gate to decide whether to spend a pass. */
const ENERGY_WINDOW_SEC = 0.5;
/** Ring capacity in seconds — must cover the wake window with headroom. */
const RING_CAPACITY_SEC = 3;

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
  const platform = deps.platform ?? process.platform;
  let state: CaptureState = 'idle';
  let enabled = false;
  let mode: CaptureMode = DEFAULT_MODE;
  let modelId = DEFAULT_MODEL;
  let hotkey = defaultGlobalCaptureHotkey(platform);
  const pcm = new PcmAccumulator();
  let currentHotkeyRegistered = false;
  let unsubscribeOnFinal: (() => void) | null = null;
  let unsubscribeOnPcm: (() => void) | null = null;
  let capturedTranscript = '';

  // ── C-11 listening-mode state ─────────────────────────────────────────────
  let listening = false;
  /** Synchronous guard set the instant arming begins, before any await. */
  let listenArming = false;
  let listenTimer: ReturnType<typeof setInterval> | null = null;
  let listenRing: PcmRingLike | null = null;
  let unsubscribeListenPcm: (() => void) | null = null;
  /** Guards re-entrant ticks while an async transcribe pass is in flight. */
  let wakeTickBusy = false;
  let listenSampleRate = NATIVE_PCM_SAMPLE_RATE;

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
    return { state, enabled, mode, modelId, hotkey, hotkeyRegistered: currentHotkeyRegistered };
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
    hotkey  = rawHotkey ?? defaultGlobalCaptureHotkey(platform);
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
      // Persist the failure to status (the boot-time toast is gone by the time
      // VoiceTab / the SigmaVoice HUD mounts — late subscribers need this).
      broadcastStatus();
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

  async function startRecording(seedAudio?: { samples: Float32Array; sampleRate: number }): Promise<void> {
    if (state !== 'idle') return;
    setState('recording');
    pcm.reset();

    // C-11 — when escalating from the wake loop, seed the accumulator with the
    // rolling window that contained "hey jorvis …" so the single spoken utterance
    // is transcribed (by the MAIN model) and routed as one command.
    if (seedAudio && seedAudio.samples.length > 0) {
      pcm.push({ samples: seedAudio.samples, sampleRate: seedAudio.sampleRate });
    }

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

    // C-10c / BSP-V1 — resolve the engine from KV; fall back to local on failure.
    const transcriptionMode = kvGet('voice.transcriptionMode');
    const cliEngine = transcriptionMode === 'gemini-cli'
      ? buildCliTranscribeEngine(deps.cliEngineDeps ?? {})
      : null;
    // BSP-V1 — build cloud engines only when the mode requires them. The
    // getApiKey helper reads straight from deps.kv so no extra KV import is needed.
    const cloudDepsBase: Pick<CloudSttEngineDeps, 'fetchFn'> = deps.cloudSttEngineDeps ?? {};
    const makeCloudDeps = (provider: 'openai-whisper-api' | 'deepgram'): CloudSttEngineDeps => ({
      ...cloudDepsBase,
      getApiKey: () => kvGet(`voice.stt.${provider}.apiKey`),
      getBaseUrl: () => kvGet(`voice.stt.${provider}.baseUrl`),
      getModel: () => kvGet(`voice.stt.${provider}.model`),
    });
    const openaiEngine = transcriptionMode === 'openai-whisper-api'
      ? buildOpenAiSttEngine(makeCloudDeps('openai-whisper-api'))
      : null;
    const deepgramEngine = transcriptionMode === 'deepgram'
      ? buildDeepgramSttEngine(makeCloudDeps('deepgram'))
      : null;
    const engine = resolveTranscriptionEngine(transcriptionMode, cliEngine, openaiEngine, deepgramEngine);

    if (engine && pcm.samples > 0) {
      // A1 — use the hardware rate reported by the accumulator (from onPcm payload)
      const { audio, sampleRate: hwRate } = pcm.flush();
      const model = getModelById(modelId) ?? getDefaultModel();
      const modelsDir = deps.getModelsDir();
      const modelPath = getDownloadedModelPath(model, modelsDir);

      // BSP-V1 — cloud engines (openai-whisper-api, deepgram) do not need a local
      // model file; they POST audio to a remote endpoint. Skip the "model not
      // downloaded" guard for cloud modes.
      const isCloudMode =
        transcriptionMode === 'openai-whisper-api' || transcriptionMode === 'deepgram';

      if (modelPath || isCloudMode) {
        try {
          const audio16k = resampleTo16k(audio, hwRate);
          // Cloud engines ignore modelPath; pass '' so the WhisperEngine interface is satisfied.
          const effectiveModelPath = modelPath ?? '';
          const result = await engine.transcribe(audio16k, effectiveModelPath, { language: 'en', threads: 4 });
          if (result.text.trim()) {
            finalText = result.text.trim();
          }
          // C-10a — capture usage stats (words/WPM) from the whisper segments
          // so the VoiceTab dashboard's `voice.stats` store actually accrues.
          appendSessionStat(deps.kv, computeSessionStats(result.segments ?? []));
        } catch (err) {
          // BSP-V1 — surface a helpful toast for missing cloud API keys.
          const { SttKeyMissingError } = await import('./cloud-stt-engine.js');
          if (err instanceof SttKeyMissingError) {
            toast(err.message, 'warn');
          } else if (transcriptionMode === 'gemini-cli' || transcriptionMode === 'openai-whisper-api') {
            // C-10c / ADR-007 — CLI or remote engine failure: fall back to local Whisper.
            console.warn(`[global-capture] ${transcriptionMode} transcription failed, falling back to local:`, err);
            const localEngine = getWhisperEngine();
            if (localEngine && modelPath) {
              try {
                const audio16k = resampleTo16k(audio, hwRate);
                const result = await localEngine.transcribe(audio16k, modelPath, { language: 'en', threads: 4 });
                if (result.text.trim()) finalText = result.text.trim();
                appendSessionStat(deps.kv, computeSessionStats(result.segments ?? []));
                toast('Remote transcription unreachable — used on-device Whisper.', 'warn');
              } catch (fallbackErr) {
                console.warn('[global-capture] local fallback also failed:', fallbackErr);
              }
            } else if (!localEngine) {
              toast('Remote transcription failed and on-device Whisper is not available.', 'warn');
            } else {
              toast('Remote transcription failed and no local model is downloaded.', 'warn');
            }
          } else {
            console.warn('[global-capture] whisper transcription failed, using SF result:', err);
          }
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
    // C-10c: pass the dispatch provider from KV (defaults to 'claude').
    setState('routing');
    try {
      const result = routeTranscript(finalText, deps.emit, deps.clipboard, {
        focusedSessionId: deps.getFocusedSessionId?.() ?? null,
        injectToPane: deps.injectToPane?.() ?? false,
        ptyWrite: deps.ptyWrite,
        dispatchProvider: kvGet('voice.dispatchProvider') ?? 'claude',
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

  // ── C-11 — "Hey Jorvis" always-on listening loop ──────────────────────────
  //
  // When listening mode is on we open the native mic ONCE, tap its continuous
  // onPcm stream into a rolling ring, and run a low-frequency interval that:
  //   1. reads a short window and applies the energy gate (skip silence — the
  //      key idle-CPU win: no transcribe on a quiet room);
  //   2. on speech, transcribes the ~3 s rolling window with the TINY model
  //      (independent of the user's main capture model);
  //   3. matches "hey jorvis"; on a hit it tears the wake loop down and runs the
  //      existing capture path (startRecording → stopAndTranscribe → route).
  // Every branch is wrapped so the loop never throws and never blocks.

  function isListeningModeOn(): boolean {
    try { return deps.getListeningMode?.() ?? false; } catch { return false; }
  }

  function teardownListenLoop(): void {
    if (listenTimer !== null) {
      try { (deps.clearIntervalFn ?? clearInterval)(listenTimer); } catch { /* ignore */ }
      listenTimer = null;
    }
    if (unsubscribeListenPcm) {
      try { unsubscribeListenPcm(); } catch { /* ignore */ }
      unsubscribeListenPcm = null;
    }
    listenRing?.reset();
    listenRing = null;
    wakeTickBusy = false;
    listening = false;
    listenArming = false;
  }

  /**
   * One wake-loop iteration. Energy-gated, model-gated, error-isolated.
   * Returns a promise so callers/tests can await the transcribe pass.
   */
  async function wakeTick(): Promise<void> {
    if (!listening || wakeTickBusy || !listenRing) return;
    // Energy gate — cheap RMS over a short window; skip silence entirely.
    let speech = true;
    try {
      const energyWindow = listenRing.lastSeconds(ENERGY_WINDOW_SEC, listenSampleRate);
      speech = deps.isSpeech ? deps.isSpeech(energyWindow) : energyWindow.length > 0;
    } catch { speech = false; }
    if (!speech) return;

    const tinyModelPath = (() => {
      try { return deps.getTinyModelPath?.() ?? null; } catch { return null; }
    })();
    if (!tinyModelPath) return; // tiny model not downloaded — cannot wake-detect

    const engine = getWhisperEngine();
    if (!engine) return;

    wakeTickBusy = true;
    try {
      const window = listenRing.lastSeconds(WAKE_WINDOW_SEC, listenSampleRate);
      if (window.length === 0) { wakeTickBusy = false; return; }
      const audio16k = resampleTo16k(window, listenSampleRate);
      const result = await engine.transcribe(audio16k, tinyModelPath, { language: 'en', threads: 4 });
      const text = (result?.text ?? '').trim();
      const matched = text
        ? (deps.matchesWakeWord ? deps.matchesWakeWord(text) : /\bhey\s+jorvis\b/i.test(text))
        : false;
      if (matched) {
        await escalateToCapture();
        return; // escalation tore the loop down
      }
    } catch (err) {
      console.warn('[global-capture] wake-tick failed (non-fatal):', err);
    } finally {
      wakeTickBusy = false;
    }
  }

  /**
   * On a wake-word hit: stop the wake loop and run the normal command capture.
   * The capture path stops + restarts the native mic itself, so we must fully
   * release the listening tap first. We seed the capture with the rolling
   * window that triggered the wake so the single utterance ("hey jorvis open the
   * browser") flows straight into routeTranscript/dispatch via the main model.
   * After the command dispatches, re-arm the loop iff listening mode is still on.
   */
  async function escalateToCapture(): Promise<void> {
    // Snapshot the wake window BEFORE releasing the ring.
    let seed: { samples: Float32Array; sampleRate: number } | undefined;
    try {
      const window = listenRing?.lastSeconds(WAKE_WINDOW_SEC, listenSampleRate);
      if (window && window.length > 0) {
        seed = { samples: window, sampleRate: listenSampleRate };
      }
    } catch { /* ignore — proceed without seed */ }

    teardownListenLoop();
    toast('Hey Jorvis — listening for your command…', 'info');
    try {
      await startRecording(seed);
      // Run start→stop back-to-back: the seeded wake window already holds the
      // command audio, so this transcribes + routes the single utterance.
      await stopAndTranscribe();
    } catch (err) {
      console.warn('[global-capture] wake escalation capture failed (non-fatal):', err);
    } finally {
      // Re-arm only if still in idle and listening mode remains enabled.
      if (state === 'idle' && isListeningModeOn()) {
        void startListening();
      }
    }
  }

  async function startListening(): Promise<void> {
    if (listening || listenArming) return;
    if (!isListeningModeOn()) return;
    // Need the injected primitives; absent them the feature is a no-op.
    if (!deps.createPcmRing) return;

    const native = loadNative();
    if (!native || typeof native.onPcm !== 'function') return;

    // Set the synchronous arming guard BEFORE the first await so a concurrent
    // call (e.g. init auto-arm racing an explicit startListening) is a no-op.
    listenArming = true;
    try {
      const status = await native.requestPermission();
      if (status !== 'granted') {
        toast('Microphone permission denied — grant access in System Settings → Privacy → Microphone', 'warn');
        listenArming = false;
        return;
      }

      listenSampleRate = NATIVE_PCM_SAMPLE_RATE;
      listenRing = deps.createPcmRing(Math.floor(RING_CAPACITY_SEC * NATIVE_PCM_SAMPLE_RATE));

      // Tap the continuous PCM stream into the ring.
      const unsub = native.onPcm((chunk: PcmChunk) => {
        const { samples, sampleRate } = unpackPcmChunk(chunk);
        listenSampleRate = sampleRate;
        listenRing?.push(samples);
      });
      unsubscribeListenPcm = typeof unsub === 'function' ? unsub : null;

      await native.start({ locale: 'en-US', onDevice: true, addPunctuation: false });

      listening = true;
      const schedule = deps.setIntervalFn ?? setInterval;
      listenTimer = schedule(() => { void wakeTick(); }, LISTEN_TICK_MS);
    } catch (err) {
      console.warn('[global-capture] startListening failed (non-fatal):', err);
      teardownListenLoop();
    } finally {
      listenArming = false;
    }
  }

  async function stopListening(): Promise<void> {
    if (!listening && listenTimer === null && !unsubscribeListenPcm) return;
    teardownListenLoop();
    const native = loadNative();
    if (native) {
      try { await native.stop(); } catch { /* ignore */ }
    }
  }

  function init(): void {
    loadFromKv();
    if (enabled) {
      registerHotkey();
    }
    // Note: the wake loop is NOT auto-armed here. The host (electron/main.ts)
    // calls startListening() explicitly after construction when
    // `voice.listeningMode` is on, and on the settings toggle. This keeps the
    // async mic-open out of the synchronous constructor and avoids a self-race.
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

    /**
     * C-11 — begin always-on "Hey Jorvis" listening. No-op when listening mode
     * is off, the native mic is unavailable, or the PCM-ring factory was not
     * injected. Idempotent. Never throws.
     */
    startListening(): Promise<void> {
      return startListening();
    },

    /** C-11 — stop the wake loop and release the native mic. Idempotent. */
    stopListening(): Promise<void> {
      return stopListening();
    },

    /** C-11 — true while the wake loop is armed (introspection / tests). */
    isListening(): boolean {
      return listening;
    },

    dispose(): void {
      teardownListenLoop();
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
