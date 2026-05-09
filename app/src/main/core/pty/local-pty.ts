// Thin wrapper around node-pty.spawn with platform-aware shell resolution.

import os from 'node:os';
import path from 'node:path';
import * as nodePty from 'node-pty';

export interface SpawnInput {
  command: string;          // empty string means: open user's default shell
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void;
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const ps = process.env.PSModulePath ? 'powershell.exe' : 'cmd.exe';
    return { command: ps, args: [] };
  }
  const sh = process.env.SHELL ?? '/bin/bash';
  return { command: sh, args: ['-l'] };
}

function windowsExtensionFor(cmd: string): string | null {
  const ext = path.extname(cmd).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  return null;
}

function platformAwareSpawnArgs(input: SpawnInput): { command: string; args: string[] } {
  if (!input.command) return defaultShell();
  if (process.platform !== 'win32') return { command: input.command, args: input.args };
  // Windows: wrap .cmd/.bat through cmd.exe and .ps1 through powershell.exe
  const kind = windowsExtensionFor(input.command);
  if (kind === 'cmd') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', input.command, ...input.args] };
  }
  if (kind === 'ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', input.command, ...input.args],
    };
  }
  return { command: input.command, args: input.args };
}

export function spawnLocalPty(input: SpawnInput): PtyHandle {
  const { command, args } = platformAwareSpawnArgs(input);
  const env: NodeJS.ProcessEnv = {
    ...(input.env ?? process.env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
  };
  const proc = nodePty.spawn(command, args, {
    name: 'xterm-256color',
    cwd: input.cwd || os.homedir(),
    cols: Math.max(20, input.cols | 0),
    rows: Math.max(5, input.rows | 0),
    env: env as { [key: string]: string },
  });
  const dataSubs = new Set<(d: string) => void>();
  const exitSubs = new Set<(i: { exitCode: number; signal?: number }) => void>();
  proc.onData((d) => {
    for (const cb of dataSubs) cb(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    for (const cb of exitSubs) cb({ exitCode, signal });
  });
  return {
    pid: proc.pid,
    write: (d) => proc.write(d),
    resize: (cols, rows) => proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      dataSubs.add(cb);
      return () => dataSubs.delete(cb);
    },
    onExit: (cb) => {
      exitSubs.add(cb);
      return () => exitSubs.delete(cb);
    },
  };
}
