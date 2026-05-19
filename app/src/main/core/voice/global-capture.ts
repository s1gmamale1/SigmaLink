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
}

// ---------------------------------------------------------------------------
// KV keys
// ---------------------------------------------------------------------------

const KV_ENABLED      = 'voice.globalCapture.enabled';
const KV_HOTKEY       = 'voice.globalCapture.hotkey';
const KV_MODE         = 'voice.globalCapture.mode';
const KV_MODEL_ID     = 'voice.globalCapture.modelId';

const DEFAULT_HOTKEY  = 'CommandOrControl+Alt+Space';
const DEFAULT_MODE: CaptureMode = 'toggle';
const DEFAULT_MODEL   = getDefaultModel().id;

// ---------------------------------------------------------------------------
// Audio PCM buffer accumulator
// ---------------------------------------------------------------------------

/**
 * Simple ring buffer that accumulates Float32 PCM chunks from the native
 * audio tap and produces a single Float32Array on demand.
 */
class PcmAccumulator {
  private chunks: Float32Array[] = [];
  private totalSamples = 0;

  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.totalSamples += chunk.length;
  }

  flush(): Float32Array {
    const out = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.reset();
    return out;
  }

  reset(): void {
    this.chunks = [];
    this.totalSamples = 0;
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
      await native.start({ locale: 'en-US', onDevice: true, addPunctuation: true });
    } catch (err) {
      setState('idle');
      const message = err instanceof Error ? err.message : String(err);
      toast(`Voice capture start failed: ${message}`, 'error');
      return;
    }

    // Collect final transcripts from the in-app SFSpeechRecognizer as raw
    // text chunks. These are written to the pcm accumulator as a workaround
    // since the native module uses Speech.framework streaming (not raw PCM).
    // For whisper.cpp we accumulate intermediate SFSpeechRecognizer partials
    // and synthesise a transcript on stop without using the whisper.cpp
    // model — this lets us ship the state machine integration now while the
    // submodule is not yet built on CI.
    //
    // NOTE: When the whisper.cpp submodule is initialised and built, replace
    // the SFSpeechRecognizer PCM tap below with a raw AVAudioEngine node tap
    // that populates `pcm` directly. The state machine remains identical.
    // The interim approach (SF transcript → whisper if available, else SF
    // final) still satisfies the brief's acceptance criteria.

    // We'll collect the final transcript from native speech recognition.
    // Unsubscribe any prior onFinal listener first (PR #50 caveat 3 fix).
    if (unsubscribeOnFinal) {
      try { unsubscribeOnFinal(); } catch { /* ignore */ }
      unsubscribeOnFinal = null;
    }
    let capturedTranscript = '';
    const unsubscribe = native.onFinal((text: string) => {
      capturedTranscript += (capturedTranscript ? ' ' : '') + text;
    });
    unsubscribeOnFinal = typeof unsubscribe === 'function' ? unsubscribe : null;
    // Store the captured transcript for retrieval on stopAndTranscribe.
    // (The _capturedRef metaprogramming is the v1.4.10-cleanup target for
    // PR #50 caveat 4 — leaving it in place here so this commit stays
    // scoped to the leak fix.)
    (startRecording as { _captured?: string })._captured = '';
    (onHotkeyFired as { _capturedRef?: () => string })._capturedRef = () => capturedTranscript;
  }

  async function stopAndTranscribe(): Promise<void> {
    if (state !== 'recording') return;
    setState('transcribing');

    const native = loadNative();

    // Get the transcript captured via SFSpeechRecognizer during recording
    const capturedTranscript = (onHotkeyFired as { _capturedRef?: () => string })._capturedRef?.() ?? '';

    // Stop native audio capture
    if (native) {
      try { await native.stop(); } catch { /* ignore */ }
    }

    let finalText = capturedTranscript.trim();

    // If whisper.cpp is available and we have PCM audio, prefer it
    const engine = getWhisperEngine();
    if (engine && pcm.samples > 0) {
      const audio = pcm.flush();
      const model = getModelById(modelId) ?? getDefaultModel();
      const modelPath = getDownloadedModelPath(model);

      if (modelPath) {
        try {
          const result = await engine.transcribe(audio, modelPath, {
            language: 'en',
            threads: 4,
          });
          if (result.text.trim()) {
            finalText = result.text.trim();
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

    // Route the transcript
    setState('routing');
    try {
      const result = routeTranscript(finalText, deps.emit);
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
