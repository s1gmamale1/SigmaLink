import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  buildWindowsSpawnArgs,
  cmdQuoteArg,
  resolveWindowsCommand,
} from './windows-spawn';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveWindowsCommand', () => {
  it('uses case-insensitive Path/PATHEXT keys from the supplied env', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD',
    );

    const resolved = resolveWindowsCommand('claude', {
      Path: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      Pathext: '.CMD;.EXE',
    });

    expect(resolved).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD');
  });
});

describe('cmdQuoteArg', () => {
  it('quotes cmd.exe metacharacters and env expansion markers', () => {
    expect(cmdQuoteArg('say "hi" & %USERNAME% !X! ^ caret')).toBe(
      '"say \\"hi\\" & ^%USERNAME^% ^!X^! ^^ caret"',
    );
  });
});

describe('buildWindowsSpawnArgs', () => {
  it('wraps .cmd shims in an OUTER-quoted, verbatim cmd-safe command string', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\npm\\tool.CMD',
    );

    const result = buildWindowsSpawnArgs(
      'tool',
      ['hello world', '%USERNAME%', 'a&b'],
      { PATH: 'C:\\npm', PATHEXT: '.CMD' },
    );

    expect(result.command).toBe('cmd.exe');
    // The per-token inner quoting is unchanged, but the whole inner line is now
    // wrapped in an OUTER pair of quotes that `cmd /d /s /c` strips verbatim.
    // Regression guard: without the outer pair + verbatim flag, node-pty /
    // child_process re-escape the inner quotes (" -> \") and cmd.exe reports
    // the program path "is not recognized" and exits 1 (broke every Windows pane).
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\npm\\tool.CMD" "hello world" "^%USERNAME^%" "a&b""',
    ]);
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  it('outer-quotes a .cmd path that contains spaces (verbatim-safe)', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\Program Files\\npm\\tool.CMD',
    );

    const result = buildWindowsSpawnArgs(
      'tool',
      ['arg with space', 'plain'],
      { PATH: 'C:\\Program Files\\npm', PATHEXT: '.CMD' },
    );

    expect(result.command).toBe('cmd.exe');
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Program Files\\npm\\tool.CMD" "arg with space" "plain""',
    ]);
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  it('wraps .ps1 scripts with powershell -File and preserves argv array args', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\scripts\\tool.PS1',
    );

    const result = buildWindowsSpawnArgs('tool', ['a&b'], {
      PATH: 'C:\\scripts',
      PATHEXT: '.PS1',
    });

    expect(result).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\scripts\\tool.PS1', 'a&b'],
    });
  });
});
