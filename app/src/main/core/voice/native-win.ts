// V1.5.0-08 — SigmaVoice native Windows adapter.
//
// Thin TypeScript wrapper around the `@sigmalink/voice-win` Node-API module.
// On non-win32 platforms (or when the prebuild is missing), `loadNativeWin()`
// returns null and the voice adapter transparently falls back to the
// renderer-side Web Speech API.
//
// Why a relative `createRequire` rather than a workspace import? Historical —
// when this loader was written the native packages were not yet workspace
// members. `pnpm-workspace.yaml` registers them since v1.4.8, but the relative
// `createRequire(import.meta.url)` against `../../../../native/voice-win/index.js`
// keeps working identically for dev checkouts and packaged (asar-disabled)
// layouts, so it stays.
//
// Lifecycle:
//   1. `loadNativeWin()` is called once at adapter init. Returns either the
//      live native handle or null. Logs a single warning on failure.
//   2. On Windows the OS prompts for mic permission inline on first
//      ISpRecognizer use; `requestPermission()` probes the registry state.
//   3. `start()` dispatches to the dedicated STA thread; partials/finals/
//      errors arrive via the registered callbacks.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Re-export shared types from native-mac so adapter.ts can reference them
// through a single import if needed. The interface is identical.
export type {
  NativeVoiceModule,
  NativeVoiceError,
  NativeVoiceState,
  NativeAuthStatus,
  NativeStartOptions,
  UnsubscribeFn,
} from './native-mac';

let cached: import('./native-mac').NativeVoiceModule | null | undefined;
let warned = false;

/**
 * Resolve the path to `app/native/voice-win/index.js` from this file's
 * compile-time location. Mirrors the strategy in native-mac.ts — walks up
 * the directory tree until it finds the `app/` root, then descends into
 * `native/voice-win/index.js`.
 */
function resolveNativePath(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i += 1) {
      const next = path.dirname(dir);
      if (next === dir) break;
      dir = next;
      if (path.basename(dir) === 'app') {
        return path.join(dir, 'native', 'voice-win', 'index.js');
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function loadNativeWin(): import('./native-mac').NativeVoiceModule | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'win32') {
    cached = null;
    return cached;
  }
  try {
    const requireCJS = createRequire(import.meta.url);
    let mod: import('./native-mac').NativeVoiceModule | null = null;
    const tryPaths = [
      '@sigmalink/voice-win',
      // Relative to compiled main bundle at app/electron-dist/main.js
      '../native/voice-win/index.js',
      // Relative to source layout at app/src/main/core/voice/native-win.ts
      '../../../../native/voice-win/index.js',
    ];
    for (const p of tryPaths) {
      try {
        const loaded = requireCJS(p) as import('./native-mac').NativeVoiceModule | undefined;
        // voice-win isAvailable() is now async (PR #53 caveat 2) — detect
        // the module by checking `start` (always synchronously callable).
        if (loaded && typeof loaded.start === 'function') {
          mod = loaded;
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (!mod) {
      const computed = resolveNativePath();
      if (computed) {
        try {
          mod = requireCJS(computed) as import('./native-mac').NativeVoiceModule;
        } catch {
          /* swallow — handled below */
        }
      }
    }
    cached = mod;
    if (!cached && !warned) {
      console.warn(
        '[voice-win] native module not loaded; falling back to renderer Web Speech API.',
      );
      warned = true;
    }
    return cached;
  } catch (err) {
    if (!warned) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[voice-win] failed to load native module:', message);
      warned = true;
    }
    cached = null;
    return cached;
  }
}

/**
 * Convenience: returns true only when the host is win32 AND the native
 * module successfully loaded. The actual SAPI5 availability check is now
 * async (PR #53 caveat 2) — use `loadNativeWin()?.isAvailable()` directly
 * when you need the Promise.
 */
export function isNativeWinVoiceAvailable(): boolean {
  return loadNativeWin() !== null;
}
