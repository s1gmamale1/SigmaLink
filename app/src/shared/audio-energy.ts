// audio-energy.ts — RMS energy gate for the always-on listening loop (C-11 / K2).
//
// The "Hey Sigma" loop runs continuously while listening mode is on. Spending a
// Whisper pass on silence wastes CPU, so each tick we first compute the RMS of a
// short window (~0.5 s) and only transcribe when it clears a threshold. This is a
// cheap volume gate, NOT a real VAD — it is intentionally conservative so quiet
// speech is not dropped while true silence is suppressed.

/**
 * Default RMS threshold above which a window is considered to contain speech.
 *
 * Float32 PCM is normalised to [-1, 1]. Room-tone / mic self-noise typically
 * sits well under 0.005 RMS; conversational speech at a normal distance is an
 * order of magnitude higher. 0.01 keeps idle CPU near-zero without clipping
 * soft speech. Tunable later if field data warrants.
 */
export const DEFAULT_SPEECH_THRESHOLD = 0.01;

/**
 * Root-mean-square amplitude of `samples`. Returns 0 for an empty buffer.
 */
export function rms(samples: Float32Array): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i += 1) {
    const s = samples[i];
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / n);
}

/**
 * True when the window's RMS energy strictly exceeds `threshold`.
 * An empty buffer is never speech. Strict `>` means a signal sitting exactly at
 * the threshold is treated as non-speech (conservative gate).
 */
export function isSpeech(
  samples: Float32Array,
  threshold: number = DEFAULT_SPEECH_THRESHOLD,
): boolean {
  if (samples.length === 0) return false;
  return rms(samples) > threshold;
}
