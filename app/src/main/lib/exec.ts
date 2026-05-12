// Small wrapper around child_process.spawn that captures stdout/stderr,
// enforces a timeout, and never invokes a shell (argument-array form only).

import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  /**
   * True when combined stdout/stderr bytes exceeded `maxBuffer` and the child
   * was forcibly terminated. Stdout/stderr will contain the truncated output
   * captured up to the cutoff.
   */
  maxBufferExceeded: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number; // hard cap on combined stdout/stderr in bytes
}

/** Milliseconds between SIGTERM and SIGKILL when a child refuses to exit. */
const KILL_FALLBACK_MS = 5_000;

export function execCmd(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { cwd, env, timeoutMs = 60_000, input, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let maxBufferExceeded = false;
    let killFallback: NodeJS.Timeout | null = null;

    const escalateKill = () => {
      // Schedule a single SIGKILL fallback. The child gets `KILL_FALLBACK_MS`
      // to honour SIGTERM; if it's still resident after that, force it down.
      if (killFallback) return;
      killFallback = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {
          /* ignore — already gone */
        }
      }, KILL_FALLBACK_MS);
      killFallback.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      escalateKill();
    }, timeoutMs);

    const handleOverflow = () => {
      if (maxBufferExceeded) return;
      maxBufferExceeded = true;
      // Stop draining further data so we don't pin RAM unboundedly.
      try {
        child.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      escalateKill();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (maxBufferExceeded) return;
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        handleOverflow();
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (maxBufferExceeded) return;
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        handleOverflow();
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killFallback) clearTimeout(killFallback);
      resolve({
        stdout,
        stderr,
        code: code ?? -1,
        timedOut,
        maxBufferExceeded,
      });
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

export function resolveCommand(cmd: string): string {
  // On Windows, .cmd shims need to be invoked with cmd.exe; node-pty handles
  // this in its own path, but for simple exec we trust PATHEXT to resolve.
  return cmd;
}
