// cli-transcribe-engine.test.ts — Unit tests for the Gemini-CLI engine (C-10c).
//
// All I/O (spawn, writeTmpFile) is injected so tests never touch the FS or
// launch a real subprocess.
//
// Run via:
//   npx vitest run packages/voice-core/src/cli-transcribe-engine.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCliTranscribeEngine } from './cli-transcribe-engine.js';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Fake subprocess helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake ChildProcess-like object whose stdout/close can be driven
 * from the test.  Returns the process plus driver callbacks.
 */
function makeFakeChild() {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const childEmitter = new EventEmitter();

  const fakeChild = {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    on: childEmitter.on.bind(childEmitter),
  } as unknown as ChildProcess;

  const emitStdout = (data: string) => stdoutEmitter.emit('data', Buffer.from(data));
  const emitStderr = (data: string) => stderrEmitter.emit('data', Buffer.from(data));
  const emitClose = (code: number) => childEmitter.emit('close', code);
  const emitError = (err: Error) => childEmitter.emit('error', err);

  return { fakeChild, emitStdout, emitStderr, emitClose, emitError };
}

/**
 * Build a `spawn` stub that captures calls and lets the test drive the
 * subprocess outcome.
 */
function makeSpawnStub(outcome: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
}) {
  const calls: { cmd: string; args: string[] }[] = [];

  const spawnStub = vi.fn((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const { fakeChild, emitStdout, emitStderr, emitClose, emitError } = makeFakeChild();

    // Drive the fake process asynchronously so listeners are attached before
    // events fire (mirrors real process behaviour).
    Promise.resolve().then(() => {
      if (outcome.spawnError) {
        emitError(outcome.spawnError);
        return;
      }
      if (outcome.stdout) emitStdout(outcome.stdout);
      if (outcome.stderr) emitStderr(outcome.stderr);
      emitClose(outcome.exitCode ?? 0);
    });

    return fakeChild;
  });

  return { spawnStub, calls };
}

// Fixed temp path returned by the stub writeTmpFile.
const FIXED_TMP_PATH = '/tmp/sigma-voice-test-fixture.wav';

function makeTmpFileStub() {
  const unlinked: string[] = [];
  const writeTmpFile = vi.fn(async () => FIXED_TMP_PATH);
  return { writeTmpFile, unlinked };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCliTranscribeEngine — happy path', () => {
  let writeTmpFile: ReturnType<typeof makeTmpFileStub>['writeTmpFile'];

  beforeEach(() => {
    ({ writeTmpFile } = makeTmpFileStub());
  });

  it('resolves with trimmed stdout text', async () => {
    const { spawnStub } = makeSpawnStub({ stdout: '  Hello, world!  \n', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    const result = await engine.transcribe(new Float32Array(16), '/ignored/model.bin');
    expect(result.text).toBe('Hello, world!');
  });

  it('segments array is always empty []', async () => {
    const { spawnStub } = makeSpawnStub({ stdout: 'text', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    const result = await engine.transcribe(new Float32Array(16), '/ignored');
    expect(result.segments).toEqual([]);
  });

  it('argv includes the temp WAV file path', async () => {
    const { spawnStub, calls } = makeSpawnStub({ stdout: 'ok', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await engine.transcribe(new Float32Array(16), '/ignored');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain(FIXED_TMP_PATH);
  });

  it('argv includes the transcription prompt', async () => {
    const { spawnStub, calls } = makeSpawnStub({ stdout: 'ok', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await engine.transcribe(new Float32Array(16), '/ignored');
    const allArgs = calls[0].args.join(' ');
    expect(allArgs.toLowerCase()).toContain('transcribe');
  });

  it('calls writeTmpFile with a Buffer', async () => {
    const { spawnStub } = makeSpawnStub({ stdout: 'ok', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await engine.transcribe(new Float32Array(16), '/ignored');
    expect(writeTmpFile).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf = (writeTmpFile.mock.calls[0] as any)[0] as Buffer;
    expect(buf).toBeInstanceOf(Buffer);
    // Should be a valid WAV: starts with RIFF
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('uses the default cliPath "gemini" when not specified', async () => {
    const { spawnStub, calls } = makeSpawnStub({ stdout: 'ok', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await engine.transcribe(new Float32Array(8), '/ignored');
    expect(calls[0].cmd).toBe('gemini');
  });

  it('uses a custom cliPath when provided', async () => {
    const { spawnStub, calls } = makeSpawnStub({ stdout: 'ok', exitCode: 0 });
    const engine = buildCliTranscribeEngine({
      spawn: spawnStub as never,
      writeTmpFile,
      cliPath: '/usr/local/bin/gemini-custom',
    });
    await engine.transcribe(new Float32Array(8), '/ignored');
    expect(calls[0].cmd).toBe('/usr/local/bin/gemini-custom');
  });
});

describe('buildCliTranscribeEngine — error handling', () => {
  let writeTmpFile: ReturnType<typeof makeTmpFileStub>['writeTmpFile'];

  beforeEach(() => {
    ({ writeTmpFile } = makeTmpFileStub());
  });

  it('rejects when the CLI exits with non-zero code', async () => {
    const { spawnStub } = makeSpawnStub({ exitCode: 1, stderr: 'model not found' });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await expect(engine.transcribe(new Float32Array(8), '/ignored')).rejects.toThrow(/exit/i);
  });

  it('rejects when spawn emits an error event', async () => {
    const { spawnStub } = makeSpawnStub({ spawnError: new Error('ENOENT') });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await expect(engine.transcribe(new Float32Array(8), '/ignored')).rejects.toThrow(/spawn failed/i);
  });

  it('still calls writeTmpFile before failing on non-zero exit', async () => {
    const { spawnStub } = makeSpawnStub({ exitCode: 2 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await expect(engine.transcribe(new Float32Array(8), '/ignored')).rejects.toThrow();
    expect(writeTmpFile).toHaveBeenCalledTimes(1);
  });
});

describe('buildCliTranscribeEngine — modelPath ignored', () => {
  it('accepts any string for modelPath without throwing', async () => {
    const { writeTmpFile } = makeTmpFileStub();
    const { spawnStub } = makeSpawnStub({ stdout: 'transcript', exitCode: 0 });
    const engine = buildCliTranscribeEngine({ spawn: spawnStub as never, writeTmpFile });
    await expect(
      engine.transcribe(new Float32Array(8), 'any/path/does/not/matter'),
    ).resolves.toMatchObject({ text: 'transcript' });
  });
});
