// whisper-engine.ts — Thin TypeScript facade over the voice-whisper N-API binding.
//
// Responsibilities:
//   - Lazy-load the native `@sigmalink/voice-whisper` module (only when first called)
//   - Return `null` on platforms where the native build is absent (win/linux
//     without a rebuild, or the submodule has not been initialised yet)
//   - Re-export the `TranscribeOpts` / `TranscribeResult` types so callers
//     don't have to import directly from the native package
//
// v1.4.9 — macOS only. The caller (`global-capture.ts`) guards all invocations
// behind a `getWhisperEngine() !== null` check. No whisper inference happens
// on win/linux in this release.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type { TranscribeOpts, TranscribeResult, TranscribeSegment } from '../../../../native/voice-whisper/index.d.ts';

export interface WhisperEngine {
  transcribe(
    audio: Float32Array,
    modelPath: string,
    opts?: import('../../../../native/voice-whisper/index.d.ts').TranscribeOpts,
  ): Promise<import('../../../../native/voice-whisper/index.d.ts').TranscribeResult>;
}

// Memoised after first load attempt.
let cachedEngine: WhisperEngine | null | undefined;
let warned = false;

/**
 * Resolve the path to `app/native/voice-whisper/index.js`. Handles two
 * filesystem layouts:
 *   - Source: `app/src/main/core/voice/whisper-engine.ts`
 *   - Bundled: `app/electron-dist/main.js` (single-file CJS via Vite)
 * In both cases `../../../../native/voice-whisper` reaches the native pkg.
 */
function resolveNativePath(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    // Walk up looking for the `app` directory containing `native/`
    for (let i = 0; i < 8; i += 1) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      if (path.basename(dir) === 'app') {
        return path.join(dir, 'native', 'voice-whisper', 'index.js');
      }
    }
  } catch {
    // fall through
  }
  // Fallback: relative to this file's location (works during dev)
  return path.resolve(__dirname, '../../../../native/voice-whisper/index.js');
}

/**
 * Return the whisper engine if the native binary is available, or `null`
 * when the platform build is missing. Safe to call from hot paths — the
 * result is memoised after the first load attempt.
 */
export function getWhisperEngine(): WhisperEngine | null {
  if (cachedEngine !== undefined) return cachedEngine;

  const requireCJS = createRequire(import.meta.url);
  const tryPaths = [
    '@sigmalink/voice-whisper',
    resolveNativePath(),
    '../../../native/voice-whisper/index.js', // electron-dist layout fallback
  ];

  for (const p of tryPaths) {
    try {
      const mod = requireCJS(p) as { transcribe?: unknown } | undefined;
      if (mod && typeof mod.transcribe === 'function') {
        cachedEngine = mod as WhisperEngine;
        return cachedEngine;
      }
    } catch {
      // try next candidate
    }
  }

  if (!warned) {
    console.warn(
      '[whisper-engine] native binary not found; global voice capture will use' +
        ' Apple Speech.framework fallback on macOS or remain disabled.',
    );
    warned = true;
  }
  cachedEngine = null;
  return null;
}

/**
 * True when the engine loaded and can accept transcribe() calls.
 * Convenience wrapper to keep callers from importing getWhisperEngine().
 */
export function isWhisperAvailable(): boolean {
  return getWhisperEngine() !== null;
}
