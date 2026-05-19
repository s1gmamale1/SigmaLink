// SigmaVoice native Windows SAPI5 speech recognition module.
//
// All callbacks are invoked on the JS event loop via N-API ThreadSafeFunction;
// callers do not need to worry about thread safety. On non-win32 platforms
// the runtime exports a stub whose `isAvailable()` returns `false` so the
// adapter can transparently fall back to the renderer Web Speech API.

export type AuthStatus =
  | 'granted'
  | 'denied'
  | 'restricted'      // group policy / MDM
  | 'not-determined'; // has not been probed yet

export interface StartOptions {
  /** BCP-47 locale; default: "en-US". */
  locale?: string;
  /** Force on-device recognition. Default: true (SAPI5 is always on-device). */
  onDevice?: boolean;
  /**
   * Add punctuation when supported. Default: true.
   * Silently ignored when the SAPI5 grammar does not emit punctuation.
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
  /** Raw HRESULT surfaced for telemetry; may be undefined. */
  nativeCode?: number;
}

export type UnsubscribeFn = () => void;

export type NativeVoiceState =
  | 'idle'
  | 'listening'
  | 'partial'
  | 'final'
  | 'error';

export interface SigmaVoiceWin {
  /**
   * True when the module loaded a native binary (win32 only) AND
   * the SAPI5 shared recogniser service is available.
   */
  isAvailable(): boolean;

  /**
   * On Windows the microphone privacy prompt is handled inline by
   * ISpRecognizer on first use. Returns a Promise resolving to the
   * current permission status. Never rejects.
   */
  requestPermission(): Promise<AuthStatus>;

  /** Current cached auth status without prompting. */
  getAuthStatus(): AuthStatus;

  /**
   * Start continuous capture via SAPI5 ISpRecognizer. Rejects with
   * `voice-busy` if a session is in flight, or `no-permission` if the
   * Windows microphone privacy setting denies access.
   */
  start(opts?: StartOptions): Promise<void>;

  /** Idempotent. Resolves once the SAPI5 session has fully torn down. */
  stop(): Promise<void>;

  /** Live partial hypothesis while speaking. May fire many times per utterance. */
  onPartial(cb: (text: string) => void): UnsubscribeFn;

  /**
   * Final recognised phrase. SAPI5 fires `final` at each natural utterance
   * boundary; the session continues listening afterwards.
   */
  onFinal(cb: (text: string) => void): UnsubscribeFn;

  /** Recogniser or COM error. After an error, the session is dead. */
  onError(cb: (err: VoiceError) => void): UnsubscribeFn;

  /**
   * Lifecycle state for cross-window UI sync. Mirrors the renderer enum.
   * 'idle' → 'listening' → 'partial' → 'final' → 'idle' (or 'error').
   */
  onState(cb: (state: NativeVoiceState) => void): UnsubscribeFn;
}

declare const voiceWin: SigmaVoiceWin;
export default voiceWin;
