// V1.1.1 — SigmaVoice diagnostics probe.
//
// Shipped after the first round of "voice not enabled or something" support
// reports. The voice pipeline has four moving pieces (native module, OS
// microphone permission, dispatcher wiring, persisted routing mode) and any of
// them can fail silently. Rather than guess, we expose a single RPC that runs
// each probe behind a try/catch and returns a flat envelope the Settings UI
// can render as four traffic-light dots.
//
// Every probe MUST resolve — never throw — even if its underlying call
// blows up. Callers (Settings → Voice, support tooling, smoke tests) treat
// `lastError !== null` as the global red flag, while the per-field booleans
// pinpoint which stage to inspect.
//
// Source: `docs/plans/download-a-skill-plugin-that-lexical-pinwheel.md` §4.

import { loadNative } from './native-mac';
import type { NativeAuthStatus } from './native-mac';
import { getRawDb } from '../db/client';

export type VoiceDiagnosticsPermission =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unsupported';

export type VoiceDiagnosticsMode = 'off' | 'auto' | 'on';

export interface VoiceDiagnosticsResult {
  /** True iff `loadNative()` returned a usable module *and* `isAvailable()`. */
  nativeLoaded: boolean;
  /** Microphone authorisation surface (mac-only; everywhere else is `unsupported`). */
  permissionStatus: VoiceDiagnosticsPermission;
  /** True when the dispatcher module imports cleanly + the classify helper exists. */
  dispatcherReachable: boolean;
  /** Persisted routing strategy from kv. */
  mode: VoiceDiagnosticsMode;
  /** First failure surfaced by any probe. `null` when every probe succeeded. */
  lastError: string | null;
}

const KV_VOICE_MODE = 'voice.mode';

/** Coerce a raw kv string into the simplified UI-facing trinary mode enum. */
function parseDiagnosticsMode(raw: string | null): VoiceDiagnosticsMode {
  if (raw === 'off') return 'off';
  if (raw === 'on' || raw === 'native-mac' || raw === 'web-speech') return 'on';
  return 'auto';
}

/** Map the native auth-status enum into the simpler UI-facing trinary. */
function mapAuthStatus(status: NativeAuthStatus): VoiceDiagnosticsPermission {
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'undetermined';
}

async function probeNative(): Promise<{
  loaded: boolean;
  authStatus: VoiceDiagnosticsPermission;
  error: string | null;
}> {
  if (process.platform !== 'darwin') {
    return { loaded: false, authStatus: 'unsupported', error: null };
  }
  try {
    const native = loadNative();
    if (!native) {
      return {
        loaded: false,
        authStatus: 'unsupported',
        error: 'native module not loaded',
      };
    }
    const isAvail = (() => {
      try {
        return native.isAvailable();
      } catch {
        return false;
      }
    })();
    if (!isAvail) {
      return {
        loaded: false,
        authStatus: 'unsupported',
        error: 'native module reports isAvailable() = false',
      };
    }
    let authStatus: VoiceDiagnosticsPermission = 'undetermined';
    try {
      authStatus = mapAuthStatus(native.getAuthStatus());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        loaded: true,
        authStatus: 'undetermined',
        error: `getAuthStatus failed: ${message}`,
      };
    }
    return { loaded: true, authStatus, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { loaded: false, authStatus: 'unsupported', error: message };
  }
}

async function probeDispatcher(): Promise<{ ok: boolean; error: string | null }> {
  try {
    // Dynamic import so a hypothetical syntax error in dispatcher.ts can be
    // surfaced as a clean `lastError` rather than crashing the diagnostics
    // call. Returns the module's exported `classify` function which we
    // invoke with an empty string — it must never throw and must return an
    // object with at least an `intent` field.
    const mod = await import('./dispatcher');
    if (typeof mod.classify !== 'function') {
      return { ok: false, error: 'dispatcher.classify is not a function' };
    }
    const out = mod.classify('');
    if (!out || typeof out.intent !== 'string') {
      return { ok: false, error: 'dispatcher.classify returned malformed result' };
    }
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `dispatcher import failed: ${message}` };
  }
}

function probeMode(): { mode: VoiceDiagnosticsMode; error: string | null } {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KV_VOICE_MODE) as { value?: string } | undefined;
    return { mode: parseDiagnosticsMode(row?.value ?? null), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { mode: 'auto', error: `kv probe failed: ${message}` };
  }
}

/**
 * Run every probe in parallel and collapse the outputs into a single
 * envelope. The renderer renders one row per field; `lastError` is the first
 * non-null error message in probe order (native → permission → dispatcher →
 * mode) so support knows which stage to dig into first.
 */
export async function runVoiceDiagnostics(): Promise<VoiceDiagnosticsResult> {
  const [native, dispatcher] = await Promise.all([
    probeNative(),
    probeDispatcher(),
  ]);
  const modeProbe = probeMode();

  const lastError =
    native.error ??
    (native.authStatus === 'denied' ? 'microphone permission denied' : null) ??
    dispatcher.error ??
    modeProbe.error ??
    null;

  return {
    nativeLoaded: native.loaded,
    permissionStatus: native.authStatus,
    dispatcherReachable: dispatcher.ok,
    mode: modeProbe.mode,
    lastError,
  };
}
