// @sigmalink/voice-whisper — TypeScript contract.
//
// Thin N-API binding around whisper.cpp. Accepts a Float32Array of 16 kHz
// mono PCM audio and resolves with a transcript + per-segment timing.
// On platforms where the native binary is unavailable the module exports a
// stub whose `transcribe()` rejects with `Error{ code: 'whisper-unavailable' }`.

export interface TranscribeSegment {
  /** Start time in milliseconds. */
  t0: number;
  /** End time in milliseconds. */
  t1: number;
  /** Transcribed text for this segment (may include a leading space). */
  text: string;
}

export interface TranscribeResult {
  /** Full concatenated transcript across all segments. */
  text: string;
  /** Per-segment breakdown with timestamps. */
  segments: TranscribeSegment[];
}

export interface TranscribeOpts {
  /**
   * BCP-47 language code passed to whisper.cpp.
   * Default: `"en"`. Use `"auto"` for language auto-detection.
   */
  language?: string;
  /**
   * When true, translate output to English regardless of source language.
   * Default: false.
   */
  translate?: boolean;
  /**
   * Number of CPU threads for ggml inference.
   * Default: 4. Performance sweet spot is usually `os.cpus().length / 2`.
   */
  threads?: number;
  /**
   * Beam search beam size. -1 (default) uses greedy sampling.
   * Values ≥ 2 switch to beam-search (slower but more accurate).
   */
  beamSize?: number;
  /**
   * Sampling temperature. 0.0 (default) = fully deterministic greedy.
   * Values > 0 introduce stochasticity (useful for debugging).
   */
  temperature?: number;
}

export interface WhisperBridge {
  /**
   * Run offline transcription on 16 kHz mono Float32 PCM audio.
   *
   * @param audio     Float32Array of normalised [-1, 1] PCM samples at 16 kHz.
   * @param modelPath Absolute path to a ggml `.bin` model file.
   * @param opts      Optional inference configuration.
   * @returns         Promise that resolves with `{ text, segments }` or
   *                  rejects with an Error whose `.code` is either
   *                  `'whisper-unavailable'` (stub) or a human-readable
   *                  failure reason from the C++ layer.
   */
  transcribe(
    audio: Float32Array,
    modelPath: string,
    opts?: TranscribeOpts,
  ): Promise<TranscribeResult>;
}

declare const whisperBridge: WhisperBridge;
export default whisperBridge;
