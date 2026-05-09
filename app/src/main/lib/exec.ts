// Small wrapper around child_process.spawn that captures stdout/stderr,
// enforces a timeout, and never invokes a shell (argument-array form only).

import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxBuffer?: number; // hard cap on combined stdout/stderr in bytes
}

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
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) return;
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) return;
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
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
