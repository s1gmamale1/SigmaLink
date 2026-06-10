import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  buildWindowsSpawnArgs,
  cmdEscapeArg,
  cmdEscapeCommandPath,
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

describe('cmdEscapeArg — single escape (one cmd parse)', () => {
  // [input, expected] — expected strings per the cross-spawn/qntm.org/cmd
  // algorithm: Win32-argv quote+backslash rules first, then caret-escape
  // EVERY cmd metachar including the quotes themselves.
  const cases: Array<[string, string]> = [
    ['hello world', '^"hello^ world^"'],
    ['a&b', '^"a^&b^"'],
    ['p|q', '^"p^|q^"'],
    ['x<y>z', '^"x^<y^>z^"'],
    ['a^b', '^"a^^b^"'],
    ['bang!', '^"bang^!^"'],
    ['100%', '^"100^%^"'],
    ['%USERNAME%', '^"^%USERNAME^%^"'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['C:\\tmp\\', '^"C:\\tmp\\\\^"'],
    ['', '^"^"'],
    // cmd lines are single-line: raw newlines would TERMINATE the line and
    // execute the remainder as a new command — replaced with one space.
    ['one\ntwo', '^"one^ two^"'],
    ['one\r\ntwo', '^"one^ two^"'],
  ];
  it.each(cases)('escapes %j', (input, expected) => {
    expect(cmdEscapeArg(input)).toBe(expected);
  });
});

describe('cmdEscapeArg — double escape (npm .cmd shims re-expand %*)', () => {
  const cases: Array<[string, string]> = [
    ['hello world', '^^^"hello^^^ world^^^"'],
    ['a&b', '^^^"a^^^&b^^^"'],
    ['%USERNAME%', '^^^"^^^%USERNAME^^^%^^^"'],
    ['-p', '^^^"-p^^^"'],
    ['say "hi"', '^^^"say^^^ \\^^^"hi\\^^^"^^^"'],
  ];
  it.each(cases)('double-escapes %j', (input, expected) => {
    expect(cmdEscapeArg(input, true)).toBe(expected);
  });
});

describe('cmdEscapeCommandPath', () => {
  it('caret-escapes spaces in the resolved shim path (usernames with spaces)', () => {
    expect(
      cmdEscapeCommandPath('C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd'),
    ).toBe('C:\\Users\\First^ Last\\AppData\\Roaming\\npm\\claude.cmd');
  });
  it('leaves a metachar-free path untouched', () => {
    expect(cmdEscapeCommandPath('C:\\npm\\tool.CMD')).toBe('C:\\npm\\tool.CMD');
  });
});

describe('buildWindowsSpawnArgs', () => {
  it('wraps .cmd shims: caret-escaped command + double-escaped args, OUTER-quoted, verbatim', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      candidate === 'C:\\npm\\tool.CMD',
    );

    const result = buildWindowsSpawnArgs(
      'tool',
      ['hello world', '%USERNAME%', 'a&b'],
      { PATH: 'C:\\npm', PATHEXT: '.CMD' },
    );

    expect(result.command).toBe('cmd.exe');
    // /s strips the first+last quote; everything between is caret-escaped so
    // cmd.exe NEVER enters in-quotes state on the first parse. Args carry a
    // second escape layer because npm shims re-expand %* (second cmd parse).
    expect(result.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\npm\\tool.CMD ^^^"hello^^^ world^^^" ^^^"^^^%USERNAME^^^%^^^" ^^^"a^^^&b^^^""',
    ]);
    expect(result.windowsVerbatimArguments).toBe(true);
  });

  it('caret-escapes spaces in a .cmd path instead of quoting it', () => {
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
      '"C:\\Program^ Files\\npm\\tool.CMD ^^^"arg^^^ with^^^ space^^^" ^^^"plain^^^""',
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
