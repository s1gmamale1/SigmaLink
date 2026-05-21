// SigmaVoice native macOS speech recognition module.
//
// All callbacks are invoked on the JS event loop via N-API ThreadSafeFunction;
// callers do not need to worry about thread safety. On non-darwin platforms
// the runtime exports a stub whose `isAvailable()` returns `false` so the
// adapter can transparently fall back to the renderer Web Speech API.

export type AuthStatus =
  | 'granted'
  | 'denied'
  | 'restricted'      // parental controls / MDM
  | 'not-determined'; // prompt has not been shown yet

export interface StartOptions {
  /** BCP-47 locale; default: navigator.language fallback "en-US". */
  locale?: string;
  /** Force on-device recognition (required for continuous > 60s). Default: true. */
  onDevice?: boolean;
  /**
   * Add punctuation when supported (macOS 13+). Default: true.
   * Silently ignored on older OS versions.
   */
  addPunctuation?: boolean;
}

export interface VoiceError {
  /**
   * Stable, ASCII-kebab-case code:
   * 'no-permission' | 'unsupported-locale' | 'audio-engine-failure' |
   * 'recognizer-cancelled' | 'voice-busy' | 'unknown'.
   */
  code: string;
  /** Human-readable detail; safe to surface in toasts. */
  message: string;
  /** Raw NSError code surfaced for telemetry; may be undefined. */
  nativeCode?: number;
}

export type UnsubscribeFn = () => void;

export type NativeVoiceState =
  | 'idle'
  | 'listening'
  | 'partial'
  | 'final'
  | 'error';

/**
 * PCM chunk payload delivered by `onPcm`.
 *
 * A1 (v1.4.8): the binding now wraps each PCM buffer in an object that also
 * carries the actual hardware sample rate from `AVAudioFormat.sampleRate`.
 * Callers must resample to 16 kHz using this rate rather than assuming 48 kHz.
 */
export interface PcmChunkPayload {
  /** Mono Float32 PCM samples at `sampleRate` Hz. */
  samples: Float32Array;
  /**
   * Hardware sample rate in Hz (e.g. 48000, 44100).
   * Sourced from `[AVAudioInputNode outputFormatForBus:0].sampleRate`.
   */
  sampleRate: number;
}

export interface SigmaVoiceMac {
  /**
   * True when the module loaded a native binary (darwin only) AND
   * `[SFSpeechRecognizer supportedLocales]` is non-empty.
   */
  isAvailable(): boolean;

  // ── v1.4.9 global-capture helpers ─────────────────────────────────────────

  /**
   * Returns the bundle identifier of the frontmost application via
   * `[NSWorkspace sharedWorkspace].frontmostApplication.bundleIdentifier`.
   * Returns an empty string when unavailable (non-darwin builds use the stub
   * which always returns '').
   */
  getFrontmostAppBundleId(): string;

  /**
   * Checks (and optionally triggers) the system Accessibility permission
   * dialog via `AXIsProcessTrustedWithOptions`.
   * @param prompt When true, triggers the system dialog if not yet trusted.
   * @returns true when Accessibility is granted.
   */
  isTrustedAccessibility(prompt: boolean): boolean;

  /**
   * Posts a Cmd+V key event pair to the system input stream via CGEvent.
   * Requires Accessibility permission; silently no-ops when not trusted.
   * Used by the global-capture output router to paste transcripts into the
   * focused (non-SigmaLink) application.
   */
  sendPasteKeystroke(): void;

  /**
   * Triggers the macOS authorization prompt the first time. Subsequent calls
   * resolve immediately with the cached status.
   */
  requestPermission(): Promise<AuthStatus>;

  /** Current cached auth status without prompting. */
  getAuthStatus(): AuthStatus;

  /**
   * Start continuous capture. Rejects with `voice-busy` if a session is in
   * flight, `no-permission` if auth was denied, or `unsupported-locale` if
   * the requested locale is not in `supportedLocales`.
   */
  start(opts?: StartOptions): Promise<void>;

  /** Idempotent. Resolves once the audio engine has fully torn down. */
  stop(): Promise<void>;

  /** Live partial transcript while speaking. May fire many times per utterance. */
  onPartial(cb: (text: string) => void): UnsubscribeFn;

  /**
   * Final transcript at end-of-utterance. In on-device continuous mode the
   * recognizer fires `final` for each natural pause segment, then keeps going.
   */
  onFinal(cb: (text: string) => void): UnsubscribeFn;

  /** Recognizer or audio-engine error. After an error, the session is dead. */
  onError(cb: (err: VoiceError) => void): UnsubscribeFn;

  /**
   * Lifecycle state for cross-window UI sync. Mirrors the renderer enum.
   * 'idle' → 'listening' → 'partial' → 'final' → 'idle' (or 'error').
   */
  onState(cb: (state: NativeVoiceState) => void): UnsubscribeFn;

  /**
   * Register a callback that receives raw Float32 PCM chunks from the
   * AVAudioEngine input-node tap (macOS only). Call this BEFORE start().
   *
   * A1 (v1.4.8): the payload is `{ samples: Float32Array, sampleRate: number }`
   * where `sampleRate` is the actual hardware rate from AVAudioFormat.
   * Callers must resample to 16 kHz using this rate rather than assuming 48 kHz.
   *
   * Returns an unsubscribe stub (rebind to clear).
   */
  onPcm(cb: (chunk: PcmChunkPayload) => void): UnsubscribeFn;
}

declare const voiceMac: SigmaVoiceMac;
export default voiceMac;
