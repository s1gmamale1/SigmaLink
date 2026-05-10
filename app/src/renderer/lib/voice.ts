// V3-W15-001 / W15-002 / W15-003 — BridgeVoice renderer adapter.
//
// Wraps the Web Speech API (`webkitSpeechRecognition` on Chromium / Electron)
// so the rest of the app talks to a single, source-tagged capture. Native OS
// speech bindings (macOS Speech framework, Windows SAPI, PocketSphinx) are out
// of scope for v1 — they'd require Swift / COM / C++ bridges. The Web Speech
// API works inside Electron's renderer on macOS + Windows out of the box;
// Linux returns an unsupported stub that surfaces a sonner toast.
//
// Single-session enforcer:
//   • Only one capture at a time (mission / assistant / palette).
//   • Subsequent `startCapture` calls reject with `VoiceBusyError`.
//   • Both renderer and main agree on busy state via `voice:state`.
//
// State propagation:
//   • Renderer-internal: `window.dispatchEvent(new CustomEvent('voice:state'))`
//     so non-React subscribers (the title-bar pill mounted high in the tree)
//     can react without prop-drilling.
//   • Main: `rpc.voice.start({ source })` / `rpc.voice.stop()` — main echoes
//     on its own `voice:state` IPC event so cross-window state converges.

import { toast } from 'sonner';
import { rpc } from '@/renderer/lib/rpc';

export type VoiceSource = 'mission' | 'assistant' | 'palette';

export interface VoiceCaptureOptions {
  source: VoiceSource;
  /** Live, partial transcript while the user is still speaking. */
  onPartial?: (text: string) => void;
  /** Final transcript once the recognizer commits a result. */
  onFinal?: (text: string) => void;
  /** Recognizer fired an error (no permission, network, etc.). */
  onError?: (message: string) => void;
}

export interface VoiceCaptureHandle {
  /** Idempotent — calling stop after the recognizer already ended is fine. */
  stop: () => void;
}

export class VoiceBusyError extends Error {
  constructor() {
    super('voice-busy');
    this.name = 'VoiceBusyError';
  }
}

interface VoiceStateDetail {
  active: boolean;
  source: VoiceSource | null;
}

// ─── Web Speech API typing ──────────────────────────────────────────────────
// `webkitSpeechRecognition` is not in lib.dom.d.ts. Rather than pull a
// separate `@types/dom-speech-recognition` package we declare just what we
// touch — keeps the diff self-contained.

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string; confidence: number };
    };
  };
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface VoiceWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

function getRecognizer(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as VoiceWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceSupported(): boolean {
  return getRecognizer() !== null;
}

// ─── Single-session state ───────────────────────────────────────────────────
interface ActiveSession {
  source: VoiceSource;
  recognizer: SpeechRecognitionLike;
  sessionId: string | null;
  stopped: boolean;
}

let activeSession: ActiveSession | null = null;

function emitState(detail: VoiceStateDetail): void {
  try {
    window.dispatchEvent(new CustomEvent('voice:state', { detail }));
  } catch {
    /* renderer may be tearing down — drop silently */
  }
}

async function teardown(reason: 'final' | 'error' | 'manual'): Promise<void> {
  const session = activeSession;
  if (!session) return;
  if (session.stopped) return;
  session.stopped = true;
  try {
    if (reason === 'manual') session.recognizer.stop();
    else if (reason === 'error') session.recognizer.abort();
  } catch {
    /* recognizer already ended — ignore */
  }
  activeSession = null;
  emitState({ active: false, source: null });
  try {
    await rpc.voice.stop({ sessionId: session.sessionId ?? '' });
  } catch {
    // Main may have already cleaned up (e.g. on remote stop). Non-fatal.
  }
}

/**
 * Begin a voice capture. Rejects with `VoiceBusyError` when another session
 * is in flight. Returns a handle whose `stop()` is idempotent.
 *
 * Sources are mutually exclusive — switching surfaces (mission → palette)
 * requires the caller to stop the prior handle first.
 */
export async function startCapture(opts: VoiceCaptureOptions): Promise<VoiceCaptureHandle> {
  if (activeSession) {
    throw new VoiceBusyError();
  }
  const Recognizer = getRecognizer();
  if (!Recognizer) {
    toast.error('Voice not supported on this platform', {
      description: 'SigmaVoice needs the Web Speech API (Chrome/Edge/Electron).',
    });
    opts.onError?.('voice-unsupported');
    return { stop: () => undefined };
  }

  // Reserve the slot synchronously so a concurrent caller hits VoiceBusyError
  // even before the async `rpc.voice.start` round-trip resolves.
  const recognizer = new Recognizer();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  const session: ActiveSession = {
    source: opts.source,
    recognizer,
    sessionId: null,
    stopped: false,
  };
  activeSession = session;

  try {
    const { sessionId } = await rpc.voice.start({ source: opts.source });
    session.sessionId = sessionId;
  } catch (err) {
    activeSession = null;
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'voice-busy') {
      throw new VoiceBusyError();
    }
    opts.onError?.(message);
    throw err;
  }

  recognizer.onstart = () => emitState({ active: true, source: opts.source });
  recognizer.onresult = (e: SpeechRecognitionEvent) => {
    let interim = '';
    let finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const result = e.results[i];
      const piece = result?.[0]?.transcript ?? '';
      if (result?.isFinal) finalText += piece;
      else interim += piece;
    }
    if (interim) opts.onPartial?.(interim);
    if (finalText) {
      opts.onFinal?.(finalText.trim());
    }
  };
  recognizer.onerror = (e: SpeechRecognitionErrorEvent) => {
    const code = e.error || 'unknown';
    // 'no-speech' and 'aborted' are routine — the recognizer simply gave up
    // because the user paused. Surface only true failures as toasts.
    if (code !== 'no-speech' && code !== 'aborted') {
      toast.error('Voice capture error', { description: code });
    }
    opts.onError?.(code);
    void teardown('error');
  };
  recognizer.onend = () => {
    void teardown('final');
  };

  try {
    recognizer.start();
    emitState({ active: true, source: opts.source });
  } catch (err) {
    void teardown('error');
    const message = err instanceof Error ? err.message : String(err);
    opts.onError?.(message);
    throw err;
  }

  return {
    stop: () => {
      void teardown('manual');
    },
  };
}

/** True while any source is actively capturing in this renderer. */
export function isVoiceActive(): boolean {
  return activeSession !== null;
}
