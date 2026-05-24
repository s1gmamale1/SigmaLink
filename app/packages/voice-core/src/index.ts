// @sigmalink/voice-core — Public API
//
// Shared voice-capture stack extracted from SigmaLink for use by both
// SigmaLink (app/src/main/core/voice/) and SigmaVoice (apps/sigma-voice/).
//
// Consumers import what they need:
//   import { buildGlobalCaptureController } from '@sigmalink/voice-core';
//   import { routeTranscript }              from '@sigmalink/voice-core';
//   import { getWhisperEngine }             from '@sigmalink/voice-core';
//   import { MODEL_CATALOG, downloadModel } from '@sigmalink/voice-core';

// ── Global capture state machine ───────────────────────────────────────────
export {
  buildGlobalCaptureController,
  resampleTo16k,
  unpackPcmChunk,
  normalizeTranscript,
  NATIVE_PCM_SAMPLE_RATE,
  WHISPER_SAMPLE_RATE,
} from './global-capture.js';

export type {
  CaptureState,
  CaptureMode,
  GlobalCaptureStatus,
  GlobalCaptureDeps,
  GlobalCaptureController,
} from './global-capture.js';

// ── Output router ──────────────────────────────────────────────────────────
export { routeTranscript } from './output-router.js';
export type { OutputTarget, RouteResult, ClipboardApi, RouteOpts } from './output-router.js';

// ── Whisper engine facade ──────────────────────────────────────────────────
export {
  getWhisperEngine,
  isWhisperAvailable,
  _resetWhisperEngineCache,
} from './whisper-engine.js';

export type {
  WhisperEngine,
  TranscribeOpts,
  TranscribeResult,
  TranscribeSegment,
} from './whisper-engine.js';

// ── Model registry ─────────────────────────────────────────────────────────
export {
  MODEL_CATALOG,
  getDefaultModel,
  getModelById,
  isModelDownloaded,
  getDownloadedModelPath,
  downloadModel,
  abortDownload,
  isDownloading,
} from './model-registry.js';

export type {
  ModelEntry,
  DownloadProgress,
  ProgressCallback,
} from './model-registry.js';

// ── WAV encoder (C-10c) ────────────────────────────────────────────────────
export { encodeWav } from './wav-encode.js';

// ── CLI transcription engine (C-10c) ───────────────────────────────────────
export { buildCliTranscribeEngine } from './cli-transcribe-engine.js';
export type { CliTranscribeEngineDeps } from './cli-transcribe-engine.js';

// ── Native mac loader ──────────────────────────────────────────────────────
export {
  loadNative,
  isNativeMacVoiceAvailable,
  _resetNativeCache,
} from './native-mac-loader.js';

export type {
  NativeAuthStatus,
  NativeStartOptions,
  NativeVoiceError,
  NativeVoiceState,
  NativeVoiceModule,
  PcmChunk,
  UnsubscribeFn,
} from './native-mac-loader.js';
