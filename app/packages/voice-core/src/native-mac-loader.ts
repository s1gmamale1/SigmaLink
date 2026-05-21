// native-mac-loader.ts — Thin re-export of the voice-mac loader used by
// global-capture.ts inside @sigmalink/voice-core.
//
// This shim exists so global-capture.ts does not have to embed the path-walking
// logic directly. The real loading logic lives in @sigmalink/voice-mac's index.js
// which node-gyp-build resolves to the native binary or the no-op stub.

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

/**
 * PCM chunk payload. The native binding passes `{ samples, sampleRate }` when
 * the format metadata is available (v1.4.8+ mac binding), or a bare Float32Array
 * on older builds. Callers should check `typeof chunk === 'object' && 'samples' in chunk`.
 */
export type PcmChunk = Float32Array | { samples: Float32Array; sampleRate: number };

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
  /**
   * Register a callback that receives raw Float32 PCM chunks from the
   * AVAudioEngine input-node tap (macOS only).
   *
   * v1.4.8: the payload is `{ samples: Float32Array, sampleRate: number }`.
   * Older stubs deliver a bare Float32Array for backward compatibility.
   */
  onPcm?: (cb: (chunk: PcmChunk) => void) => UnsubscribeFn;
}

let cached: NativeVoiceModule | null | undefined;
let warned = false;

export function loadNative(): NativeVoiceModule | null {
  if (cached !== undefined) return cached;
  if (process.platform !== 'darwin') {
    cached = null;
    return cached;
  }
  try {
    const requireCJS = createRequire(import.meta.url);
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    const extraPaths: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      if (path.basename(dir) === 'app') {
        extraPaths.push(path.join(dir, 'native', 'voice-mac', 'index.js'));
        break;
      }
    }

    const tryPaths = [
      '@sigmalink/voice-mac',
      ...extraPaths,
      '../native/voice-mac/index.js',
    ];

    let mod: NativeVoiceModule | null = null;
    for (const p of tryPaths) {
      try {
        const loaded = requireCJS(p) as NativeVoiceModule | undefined;
        if (loaded && typeof loaded.isAvailable === 'function') {
          mod = loaded;
          break;
        }
      } catch { /* try next */ }
    }
    cached = mod;
    if (!cached && !warned) {
      console.warn('[voice-core/native-mac] native module not loaded; falling back to renderer Web Speech API.');
      warned = true;
    }
    return cached;
  } catch (err) {
    if (!warned) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[voice-core/native-mac] failed to load native module:', message);
      warned = true;
    }
    cached = null;
    return cached;
  }
}

export function isNativeMacVoiceAvailable(): boolean {
  const mod = loadNative();
  return mod !== null && mod.isAvailable();
}

/** Reset cached module (test helper). @internal */
export function _resetNativeCache(): void {
  cached = undefined;
  warned = false;
}
