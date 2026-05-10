// V3-W15-001 / V1.1 — BridgeVoice main-process adapter.
//
// Source: docs/02-research/v3-protocol-delta.md §6 + docs/04-design/sigmavoice-
// native-mac.md §6 + §7. The renderer continues to drive Web Speech API
// capture in-process on Windows / Linux (Electron renderer fully supports
// `webkitSpeechRecognition` on those platforms). On macOS, when the native
// `@sigmalink/voice-mac` module loads, this adapter switches to the on-device
// `SFSpeechRecognizer` pipeline — continuous capture beyond the 60s server cap
// + tighter integration with the dispatcher.
//
// Single-session enforcer is preserved: concurrent `start` calls (regardless
// of source) reject with `voice-busy`. The state machine grew a `dispatching`
// state between final-transcript and controller-resolution so the title-bar
// pill / orb can show a distinct "routing" frame.

import { randomUUID } from 'node:crypto';
import { defineController } from '../../../shared/rpc';
import { dispatch as dispatchIntent, type DispatchDeps, type DispatchResult } from './dispatcher';
import {
  loadNative,
  isNativeMacVoiceAvailable,
  type NativeVoiceModule,
  type NativeStartOptions,
} from './native-mac';

export type VoiceSource = 'mission' | 'assistant' | 'palette';

/**
 * Routing mode. `auto` picks the best handler for the host platform:
 *   - darwin + native loaded → native-mac
 *   - everything else        → web-speech (renderer)
 * Manual modes let power users force a specific path (debugging, A/B).
 * `off` short-circuits both — every `start` rejects with `voice-disabled`.
 */
export type VoiceMode = 'auto' | 'web-speech' | 'native-mac' | 'off';

export type VoicePhase =
  | 'idle'
  | 'listening'
  | 'partial'
  | 'final'
  | 'dispatching'
  | 'error';

export interface VoiceControllerDeps {
  emit: (event: string, payload: unknown) => void;
  /**
   * Optional dispatcher hooks. When omitted, dispatched intents that need
   * a handler (broadcast / roll-call / assistant.freeform) report
   * `notRouted` and the renderer simply shows a soft toast.
   */
  dispatcher?: Omit<DispatchDeps, 'emit'>;
  /**
   * V1.1.1 — Optional kv hooks for the first-launch auto-enable path.
   *
   * On macOS, when the native module loads successfully and `voice.firstLaunch`
   * is unset, the controller flips `mode` from `'off'` to `'auto'` and stamps
   * `voice.firstLaunch=1` so the user never sees a "voice not enabled" state
   * out of the box. When the platform can't host SigmaVoice (non-darwin or
   * native module missing) we emit `voice:unavailable` instead so the
   * renderer can show an explanatory tooltip rather than disabling silently.
   *
   * Both hooks are optional — if absent we skip the bootstrap (e.g. unit
   * tests, headless smokes) and rely on whatever default mode the test set.
   */
  kv?: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
}

const KV_VOICE_MODE = 'voice.mode';
const KV_VOICE_FIRST_LAUNCH = 'voice.firstLaunch';

interface ActiveSession {
  id: string;
  source: VoiceSource;
  startedAt: number;
  /** True when this session was started against the native-mac engine. */
  native: boolean;
  /** Most recent partial transcript; surfaced via `voice:state`. */
  lastPartial: string;
}

const VALID_SOURCES: ReadonlySet<VoiceSource> = new Set([
  'mission',
  'assistant',
  'palette',
]);

const VALID_MODES: ReadonlySet<VoiceMode> = new Set([
  'auto',
  'web-speech',
  'native-mac',
  'off',
]);

export function buildVoiceController(deps: VoiceControllerDeps) {
  let active: ActiveSession | null = null;
  // V1.1.1 — bootstrap mode from kv (if available) so a user's previous
  // choice survives restarts. The first-launch path below flips an `'off'`
  // back to `'auto'` exactly once on darwin so the out-of-box experience
  // never lands in a "voice not enabled" state without an explicit user
  // action. Falls back to `'auto'` when kv hooks are missing or the row is
  // unreadable — mirrors the v1.1 default.
  let mode: VoiceMode = 'auto';
  if (deps.kv) {
    try {
      const raw = deps.kv.get(KV_VOICE_MODE);
      if (raw && (VALID_MODES as ReadonlySet<string>).has(raw)) {
        mode = raw as VoiceMode;
      }
    } catch {
      /* keep default */
    }
  }
  // First-launch auto-enable. The check is gated on:
  //   1. Hook availability (kv present),
  //   2. mode === 'off' — only restore the default when the user has not
  //      explicitly opted into another mode,
  //   3. firstLaunch flag is unset — never overwrite a deliberate later
  //      "off" toggle (we'd be re-enabling against the user's wish),
  //   4. platform is darwin AND the native module loads — non-darwin keeps
  //      mode='off' and the renderer surfaces `voice:unavailable` so the
  //      Composer can hide the mic without bouncing through a toast.
  if (deps.kv) {
    try {
      const firstLaunch = deps.kv.get(KV_VOICE_FIRST_LAUNCH);
      if (firstLaunch !== '1') {
        if (process.platform === 'darwin' && isNativeMacVoiceAvailable()) {
          if (mode === 'off') {
            mode = 'auto';
            try {
              deps.kv.set(KV_VOICE_MODE, mode);
            } catch {
              /* persistence failure is non-fatal */
            }
            console.log(
              '[voice] auto-enabled on first launch (macOS native available)',
            );
          }
          try {
            deps.kv.set(KV_VOICE_FIRST_LAUNCH, '1');
          } catch {
            /* swallow */
          }
        } else {
          // No native engine — emit a one-shot reason so the renderer can
          // render an explanatory tooltip instead of silently disabling.
          // We still stamp `firstLaunch=1` so we don't re-broadcast the
          // event on every adapter rebuild.
          const reason: 'platform' | 'no-native' =
            process.platform === 'darwin' ? 'no-native' : 'platform';
          try {
            deps.emit('voice:unavailable', { reason });
          } catch {
            /* fire-and-forget */
          }
          try {
            deps.kv.set(KV_VOICE_FIRST_LAUNCH, '1');
          } catch {
            /* swallow */
          }
        }
      }
    } catch {
      /* fall through with current mode */
    }
  }
  let phase: VoicePhase = 'idle';

  function broadcast(): void {
    deps.emit('voice:state', {
      active: active !== null,
      source: active?.source ?? null,
      sessionId: active?.id ?? null,
      mode,
      phase,
      partial: active?.lastPartial ?? null,
    });
  }

  function setPhase(next: VoicePhase): void {
    phase = next;
    broadcast();
  }

  /**
   * Resolve the live engine for the current mode. Returns the native module
   * when the mode + platform allows it, or `null` when the renderer should
   * own the capture loop (Web Speech path).
   */
  function selectEngine(): NativeVoiceModule | null {
    if (mode === 'off') return null;
    if (mode === 'web-speech') return null;
    if (process.platform !== 'darwin') return null;
    if (mode === 'native-mac') return loadNative();
    // mode === 'auto'
    return isNativeMacVoiceAvailable() ? loadNative() : null;
  }

  // Wire native callbacks once per process. Subsequent rebinds replace the
  // closure but the native side keeps a single subscriber per channel.
  function bindNativeCallbacks(native: NativeVoiceModule): void {
    native.onPartial((text) => {
      if (!active || !active.native) return;
      active.lastPartial = text;
      setPhase('partial');
    });
    native.onFinal((text) => {
      if (!active || !active.native) return;
      setPhase('final');
      void runDispatch(text).finally(() => {
        // Stay in idle once dispatching wraps. The native session keeps the
        // audio engine running, so the next utterance arrives organically;
        // we only fully release the slot when the operator hits stop.
        if (active && active.native) {
          active.lastPartial = '';
          setPhase('listening');
        } else {
          setPhase('idle');
        }
      });
    });
    native.onError((err) => {
      // Native errors mean the session is dead — release the slot and let
      // the renderer subscribe to the next state transition for UI cleanup.
      if (active && active.native) {
        active = null;
      }
      setPhase('error');
      deps.emit('voice:error', err);
      // Auto-recover to idle so the title-bar pill fades out.
      setTimeout(() => {
        if (phase === 'error') setPhase('idle');
      }, 300);
    });
    native.onState((s) => {
      // Native state mirrors our phase enum 1:1 for listening / partial /
      // final / idle. We let the explicit emitters above handle transitions
      // so we don't double-broadcast; this hook stays as a safety net for
      // future native-side states we haven't modelled yet.
      if (s === 'idle' && active?.native) {
        active = null;
        setPhase('idle');
      }
    });
  }

  /**
   * Run the classifier + controller routing for a finalised transcript.
   * Always resolves; the result envelope feeds telemetry and the
   * `voice:dispatch-echo` event.
   */
  async function runDispatch(transcript: string): Promise<DispatchResult> {
    setPhase('dispatching');
    const result = await dispatchIntent(transcript, {
      emit: (event, payload) => deps.emit(event, payload),
      resolveWorkspaceId: deps.dispatcher?.resolveWorkspaceId,
      resolveSwarmId: deps.dispatcher?.resolveSwarmId,
      controllers: deps.dispatcher?.controllers ?? {},
    });
    deps.emit('voice:dispatch-result', result);
    return result;
  }

  return defineController({
    /**
     * Begin a voice session. Rejects with `voice-busy` while another session
     * is active. On macOS-native mode this also kicks the audio engine into
     * `listening` state; on Web Speech mode the renderer is responsible for
     * driving recognition while main only tracks the slot.
     */
    start: async (input: { source: VoiceSource }): Promise<{ sessionId: string }> => {
      const source = input?.source;
      if (!VALID_SOURCES.has(source)) {
        throw new Error(`voice.start: invalid source "${String(source)}"`);
      }
      if (active) {
        throw new Error('voice-busy');
      }
      if (mode === 'off') {
        throw new Error('voice-disabled');
      }
      const native = selectEngine();
      const id = randomUUID();
      active = {
        id,
        source,
        startedAt: Date.now(),
        native: native !== null,
        lastPartial: '',
      };
      if (native) {
        bindNativeCallbacks(native);
        // requestPermission is idempotent after the first prompt; still cheap.
        try {
          const status = await native.requestPermission();
          if (status !== 'granted') {
            active = null;
            setPhase('idle');
            throw new Error('no-permission');
          }
        } catch (err) {
          active = null;
          setPhase('idle');
          throw err;
        }
        const opts: NativeStartOptions = {
          locale: 'en-US',
          onDevice: true,
          addPunctuation: true,
        };
        try {
          await native.start(opts);
          setPhase('listening');
        } catch (err) {
          active = null;
          setPhase('idle');
          throw err;
        }
      } else {
        // Renderer Web Speech drives recognition; we just record the slot.
        setPhase('listening');
      }
      return { sessionId: id };
    },
    /**
     * Stop the active session. Idempotent — a stop with no active session is
     * a no-op (the renderer may double-fire on cleanup paths). When the
     * provided `sessionId` doesn't match the live one we leave it alone so a
     * stale teardown can't kill a fresh session. Empty string is permitted as
     * a "stop whatever's active" hatch for the renderer's error paths where
     * the original id was never captured.
     */
    stop: async (input: { sessionId: string }): Promise<void> => {
      if (!active) {
        setPhase('idle');
        return;
      }
      const sessionId = input?.sessionId ?? '';
      if (sessionId && active.id !== sessionId) {
        return;
      }
      const wasNative = active.native;
      active = null;
      if (wasNative) {
        const native = loadNative();
        if (native) {
          try {
            await native.stop();
          } catch {
            /* native side already torn down */
          }
        }
      }
      setPhase('idle');
    },
    /**
     * V1.1 — main-side intent dispatch. Lets the renderer test the classifier
     * + controller fan-out without going through the recogniser (handy for
     * unit tests and accessibility flows that bypass the mic). Returns the
     * raw `DispatchResult` envelope.
     */
    dispatch: async (input: { transcript: string }): Promise<DispatchResult> => {
      const text = typeof input?.transcript === 'string' ? input.transcript : '';
      const wasIdle = phase === 'idle';
      const result = await runDispatch(text);
      if (wasIdle && !active) setPhase('idle');
      return result;
    },
    /**
     * V1.1 — pick the routing mode at runtime. Renderer-driven test surface
     * + future Settings → Voice toggle. Switching modes mid-session does not
     * tear down the active session; new mode applies on the next `start`.
     */
    setMode: async (input: { mode: VoiceMode }): Promise<{ mode: VoiceMode }> => {
      const m = input?.mode;
      if (!VALID_MODES.has(m)) {
        throw new Error(`voice.setMode: invalid mode "${String(m)}"`);
      }
      mode = m;
      // V1.1.1 — persist the user's choice so it survives the next restart.
      // We also stamp firstLaunch=1 here so a deliberate `off` cannot be
      // unwound by the bootstrap auto-enable on the next boot.
      if (deps.kv) {
        try {
          deps.kv.set(KV_VOICE_MODE, m);
          deps.kv.set(KV_VOICE_FIRST_LAUNCH, '1');
        } catch {
          /* persistence failure is non-fatal */
        }
      }
      broadcast();
      return { mode };
    },
    /**
     * V1.1.1 — Re-prompt the OS microphone permission dialog. The native
     * adapter already invokes `requestPermission()` lazily on the first
     * `start()`, but the Settings → Voice surface needs to surface a
     * dedicated CTA so users who previously denied can re-grant without
     * triggering a fake capture. Resolves with the resulting auth status.
     * On non-darwin platforms (or when the native module is missing) the
     * call resolves with `{ status: 'unsupported' }` instead of throwing
     * so the renderer can render a steady-state "Microphone unsupported"
     * row without special-casing.
     */
    permissionRequest: async (): Promise<{
      status: 'granted' | 'denied' | 'undetermined' | 'unsupported';
    }> => {
      if (process.platform !== 'darwin') {
        return { status: 'unsupported' };
      }
      const native = loadNative();
      if (!native) {
        return { status: 'unsupported' };
      }
      try {
        const raw = await native.requestPermission();
        if (raw === 'granted') return { status: 'granted' };
        if (raw === 'denied' || raw === 'restricted') return { status: 'denied' };
        return { status: 'undetermined' };
      } catch {
        return { status: 'undetermined' };
      }
    },
  });
}

/**
 * Convenience export for non-controller callers (the rpc-router uses this
 * to feed dispatcher hooks at boot before the assistant / swarm controllers
 * are constructed). Keeps adapter.ts free of wiring concerns.
 */
export type VoiceController = ReturnType<typeof buildVoiceController>;
