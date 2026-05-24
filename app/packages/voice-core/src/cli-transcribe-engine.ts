// cli-transcribe-engine.ts — Gemini-CLI transcription backend (C-10c).
//
// Implements the WhisperEngine interface by shelling out to an external CLI
// (default: `gemini`) with the audio encoded as a temporary WAV file.
//
// The `modelPath` argument from the WhisperEngine contract is IGNORED — the
// CLI decides its own model internally. It is accepted to satisfy the interface.
//
// Design goals:
//   - Zero Electron / native dependencies: only node:child_process + node:os.
//   - All I/O paths are injectable (spawn, writeTmpFile) for hermetic tests.
//   - The temp file is always cleaned up in `finally`, even on failure.

import os from 'node:os';
import path from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { encodeWav } from './wav-encode.js';
import type { WhisperEngine } from './whisper-engine.js';
import type {
  TranscribeOpts,
  TranscribeResult,
} from '@sigmalink/voice-whisper';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CliTranscribeEngineDeps {
  /**
   * Override for `node:child_process.spawn`.  The stub in tests captures
   * argv and drives a fake subprocess without touching the file-system.
   */
  spawn?: typeof defaultSpawn;

  /**
   * Write `data` to a temp file and return its absolute path.
   * Defaults to writing `<os.tmpdir()>/<random-name>.wav`.
   */
  writeTmpFile?: (data: Buffer) => Promise<string>;

  /**
   * Absolute path (or bare name) of the CLI executable to invoke.
   * Defaults to `'gemini'`.
   */
  cliPath?: string;
}

// ---------------------------------------------------------------------------
// Default I/O helpers
// ---------------------------------------------------------------------------

async function defaultWriteTmpFile(data: Buffer): Promise<string> {
  const tmpPath = path.join(
    os.tmpdir(),
    `sigma-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  );
  await fs.writeFile(tmpPath, data);
  return tmpPath;
}

async function tryUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Non-fatal — temp file cleanup failure should never surface to the caller.
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `WhisperEngine`-compatible transcription engine that delegates to
 * an external CLI (default: `gemini`) rather than the on-device Whisper binary.
 *
 * @param deps  Injectable I/O dependencies.  All fields are optional; defaults
 *              work in production without any configuration.
 */
export function buildCliTranscribeEngine(
  deps: CliTranscribeEngineDeps = {},
): WhisperEngine {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const writeTmpFileFn = deps.writeTmpFile ?? defaultWriteTmpFile;
  const cliPath = deps.cliPath ?? 'gemini';

  const TRANSCRIBE_PROMPT =
    'Transcribe the attached audio verbatim. Output only the transcript text.';

  return {
    async transcribe(
      audio: Float32Array,
      _modelPath: string,
      _opts?: TranscribeOpts,
    ): Promise<TranscribeResult> {
      // 1. Encode audio to WAV
      const wavBuffer = encodeWav(audio, 16000);

      // 2. Write to a temporary file
      const tmpPath = await writeTmpFileFn(wavBuffer);

      try {
        // 3. Spawn the CLI
        const stdout = await new Promise<string>((resolve, reject) => {
          const args = [tmpPath, '--prompt', TRANSCRIBE_PROMPT];
          const child = spawnFn(cliPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          const stdoutChunks: Buffer[] = [];
          const stderrChunks: Buffer[] = [];

          child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
          child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

          child.on('error', (err) => {
            reject(new Error(`CLI spawn failed: ${err.message}`));
          });

          child.on('close', (code) => {
            if (code !== 0) {
              const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
              reject(
                new Error(
                  `CLI exited with code ${code}${stderr ? ': ' + stderr : ''}`,
                ),
              );
            } else {
              resolve(Buffer.concat(stdoutChunks).toString('utf8'));
            }
          });
        });

        // 4. Return trimmed transcript
        return {
          text: stdout.trim(),
          segments: [],
        };
      } finally {
        // 5. Always clean up the temp file
        await tryUnlink(tmpPath);
      }
    },
  };
}
