// V1.1 — SigmaVoice native macOS adapter.
//
// Thin TypeScript wrapper around the `@sigmalink/voice-mac` Node-API module.
// On non-darwin platforms (or when the prebuild is missing), `loadNative()`
// returns null and the voice adapter transparently falls back to the
// renderer-side Web Speech API.
//
// Why a relative `createRequire` rather than a workspace import? The repo's
// `pnpm-workspace.yaml` does not (yet) register the native package as a
// workspace member; using `createRequire(import.meta.url)` against
// `../../../../native/voice-mac/index.js` keeps the wiring local without
// forcing a workspace migration on the install path.
//
// Lifecycle:
//   1. `loadNative()` is called once at adapter init. Returns either the
//      live native handle or null. Logs a single warning on failure.
//   2. The adapter calls `requestPermission()` lazily on the first
//      `start()` invocation (so we do not spam the user with a prompt on
//      cold app launch).
//   3. `start()` resolves immediately once the audio engine is running;
//      partials/finals/errors arrive via the registered callbacks.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeAuthStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined';

export interface NativeStartOptions {
  locale?: string;
  onDevice?: boolean;
  addPunctuation?: boolean;
}

export interface NativeVoiceError {
  code: string;
  message: string;
  nativeCode?: number;
}

export type NativeVoiceState =
  | 'idle'
  | 'listening'
  | 'partial'
  | 'final'
  | 'error';

export type UnsubscribeFn = () => void;

export interface NativeVoiceModule {
  isAvailable(): boolean;
  requestPermission(): Promise<NativeAuthStatus>;
  getAuthStatus(): NativeAuthStatus;
  start(opts?: NativeStartOptions): Promise<void>;
  stop(): Promise<void>;
  onPartial(cb: (text: string) => void): UnsubscribeFn;
  onFinal(cb: (text: string) => void): UnsubscribeFn;
  onError(cb: (err: NativeVoiceError) => void): UnsubscribeFn;
  onState(cb: (state: NativeVoiceState) => void): UnsubscribeFn;
}

let cached: NativeVoiceModule | null | undefined;
let warned = false;

/**
 * Resolve the path to `app/native/voice-mac/index.js` from this file's
 * compile-time location. The TypeScript source lives at
 * `app/src/main/core/voice/native-mac.ts` and is bundled by Vite to
 * `app/electron-dist/main.js` (single-file CommonJS). Both layouts keep
 * `../../../../native/voice-mac` correct relative to `electron-dist/main.js`
 * (parent: app/electron-dist → app → app/native/voice-mac) and to the
 * source file location during dev (parent: voice → core → main → src → app
 * → native/voice-mac).
 */
function resolveNativePath(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    // Walk up to the `app/` root; the bundled main file sits at
    // `app/electron-dist/main.js`, the source at
    // `app/src/main/core/voice/native-mac.ts`. In both cases the project
    // root containing `native/` is reachable by climbing until we find a
    // sibling `native/voice-mac/index.js`.
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, 'native', 'voice-mac', 'index.js');
      // We probe via require.resolve below; here just hand back the
      // computed candidate so a non-existent path produces a clean error.
      const next = path.dirname(dir);
      if (next === dir) break;
      dir = next;
      if (path.basename(dir) === 'app') {
        return candidate.replace(path.dirname(here), dir);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function loadNative(): NativeVoiceModule | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'darwin') {
    cached = null;
    return cached;
  }
  try {
    const requireCJS = createRequire(import.meta.url);
    // Try the workspace-style alias first (no-op until pnpm-workspace
    // registers it; harmless throw otherwise), then fall back to the
    // relative path.
    let mod: NativeVoiceModule | null = null;
    const tryPaths = [
      '@sigmalink/voice-mac',
      // Relative to compiled main bundle at app/electron-dist/main.js
      '../native/voice-mac/index.js',
      // Relative to source layout at app/src/main/core/voice/native-mac.ts
      '../../../../native/voice-mac/index.js',
    ];
    for (const p of tryPaths) {
      try {
        const loaded = requireCJS(p) as NativeVoiceModule | undefined;
        if (loaded && typeof loaded.isAvailable === 'function') {
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
          mod = requireCJS(computed) as NativeVoiceModule;
        } catch {
          /* swallow — handled below */
        }
      }
    }
    cached = mod;
    if (!cached && !warned) {
      console.warn(
        '[voice-mac] native module not loaded; falling back to renderer Web Speech API.',
      );
      warned = true;
    }
    return cached;
  } catch (err) {
    if (!warned) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[voice-mac] failed to load native module:', message);
      warned = true;
    }
    cached = null;
    return cached;
  }
}

/**
 * Convenience: returns true only when the host is darwin AND the native
 * module successfully loaded AND the recogniser reports at least one
 * supported locale. Cheap to call from hot paths — the underlying
 * `isAvailable()` is a single Objective-C set-cardinality check.
 */
export function isNativeMacVoiceAvailable(): boolean {
  const mod = loadNative();
  return mod !== null && mod.isAvailable();
}
