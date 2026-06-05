// whisper-engine.ts — Thin TypeScript facade over the voice-whisper N-API binding.
//
// Extracted from app/src/main/core/voice/whisper-engine.ts into @sigmalink/voice-core.
//
// The only change from the original: the native module resolution no longer
// uses `import.meta.url` path-walking tied to SigmaLink's source layout.
// Instead, callers pass an optional `getWhisperNativePath` function that
// returns the absolute path to `voice-whisper/index.js`. When absent, the
// module tries `@sigmalink/voice-whisper` via require (works once pnpm has
// linked the workspace package).

import { createRequire } from 'node:module';

export type { TranscribeOpts, TranscribeResult, TranscribeSegment } from '@sigmalink/voice-whisper';

export interface WhisperEngine {
  transcribe(
    audio: Float32Array,
    modelPath: string,
    opts?: import('@sigmalink/voice-whisper').TranscribeOpts,
  ): Promise<import('@sigmalink/voice-whisper').TranscribeResult>;
}

let cachedEngine: WhisperEngine | null | undefined;
let warned = false;

/**
 * Return the whisper engine if the native binary is available, or `null`
 * when the platform build is missing. Safe to call from hot paths — the
 * result is memoised after the first load attempt.
 *
 * @param getNativePath  Optional override that returns the absolute path to
 *                       the voice-whisper index.js. Useful in packaged builds
 *                       where the workspace symlink is not present.
 */
export function getWhisperEngine(getNativePath?: () => string): WhisperEngine | null {
  if (cachedEngine !== undefined) return cachedEngine;

  const requireCJS = createRequire(import.meta.url);
  const tryPaths: string[] = ['@sigmalink/voice-whisper'];
  if (getNativePath) {
    try { tryPaths.push(getNativePath()); } catch { /* ignore */ }
  }

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
 */
export function isWhisperAvailable(getNativePath?: () => string): boolean {
  return getWhisperEngine(getNativePath) !== null;
}

/**
 * Reset the cached engine (test helper — allows re-loading after mocking).
 * @internal
 */
export function _resetWhisperEngineCache(): void {
  cachedEngine = undefined;
  warned = false;
}

// ---------------------------------------------------------------------------
// C-10c — Engine resolver
// ---------------------------------------------------------------------------

/**
 * Transcription mode.
 *
 * - `'local'`               → use the on-device Whisper N-API engine (default).
 * - `'gemini-cli'`          → use the injected CLI engine (never falls back to
 *                             Whisper internally; the CALLER wraps in try/catch → local).
 * - `'openai-whisper-api'`  → POST audio to OpenAI /v1/audio/transcriptions (BSP-V1).
 * - `'deepgram'`            → POST audio to Deepgram /v1/listen (BSP-V1).
 */
export type TranscriptionMode = 'local' | 'gemini-cli' | 'openai-whisper-api' | 'deepgram';

/**
 * Resolve the appropriate `WhisperEngine` implementation for the given mode.
 *
 * @param mode              From `kv.get('voice.transcriptionMode')`.  Defaults
 *                          to `'local'` for any unrecognised or null value.
 * @param cliEngine         A pre-built CLI engine to use when mode is
 *                          `'gemini-cli'`.  Optional so callers that don't
 *                          supply it gracefully fall through to local.
 * @param openaiEngine      A pre-built cloud engine to use when mode is
 *                          `'openai-whisper-api'` (BSP-V1).
 * @param deepgramEngine    A pre-built cloud engine to use when mode is
 *                          `'deepgram'` (BSP-V1).
 * @param getNativePath     Optional path resolver forwarded to `getWhisperEngine`.
 */
export function resolveTranscriptionEngine(
  mode: string | null | undefined,
  cliEngine?: WhisperEngine | null,
  openaiEngine?: WhisperEngine | null,
  deepgramEngine?: WhisperEngine | null,
  getNativePath?: () => string,
): WhisperEngine | null {
  if (mode === 'gemini-cli' && cliEngine) {
    return cliEngine;
  }
  if (mode === 'openai-whisper-api' && openaiEngine) {
    return openaiEngine;
  }
  if (mode === 'deepgram' && deepgramEngine) {
    return deepgramEngine;
  }
  // Default / 'local' / anything else → native whisper
  return getWhisperEngine(getNativePath);
}
