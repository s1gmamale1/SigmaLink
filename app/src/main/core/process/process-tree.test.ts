// Platform-dispatch tests for the process-tree subsystem. Win32 behavior is
// exercised via INJECTED platform + exec (real powershell/taskkill calls are
// device-verified — see the win32-platform-services plan checklist).
import { describe, it, expect, vi } from 'vitest';
import { inspectProcessTree, listProcessRows, stopProcessTrees } from './process-tree';
import { buildCimPsArgs, buildTaskkillArgs } from './process-list-win32';

const CIM_TABLE = JSON.stringify([
  { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 1000, Name: 'conhost.exe', CommandLine: '' },
  { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 2000, Name: 'claude.exe', CommandLine: 'claude' },
  { ProcessId: 300, ParentProcessId: 200, WorkingSetSize: 4000, Name: 'mcp.exe', CommandLine: 'mcp --stdio' },
  { ProcessId: 999, ParentProcessId: 1, WorkingSetSize: 8, Name: 'unrelated.exe', CommandLine: '' },
]);

describe('listProcessRows (the per-platform list fn — perf-hot-paths wraps this)', () => {
  it('win32: shells out to powershell.exe with the CIM argv', () => {
    const exec = vi.fn(() => CIM_TABLE);
    const res = listProcessRows({ platform: 'win32', exec });
    expect(exec).toHaveBeenCalledWith('powershell.exe', buildCimPsArgs());
    expect(res.supported).toBe(true);
    expect(res.rows).toHaveLength(4);
  });

  it('linux: shells out to ps with posix argv (linux support added)', () => {
    const psOut = [
      '  10     1  1000 /usr/bin/bash bash',
      '  11    10  2000 /usr/bin/node node cli.js',
    ].join('\n');
    const exec = vi.fn(() => psOut);
    const res = listProcessRows({ platform: 'linux', exec });
    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']);
    expect(res.supported).toBe(true);
    expect(res.rows).toHaveLength(2);
  });

  it('win32 exec failure: supported stays true, rows empty (registry falls back to pty.kill)', () => {
    const exec = vi.fn(() => {
      throw new Error('powershell missing');
    });
    expect(listProcessRows({ platform: 'win32', exec })).toEqual({ supported: true, rows: [] });
  });
});

describe('inspectProcessTree on win32', () => {
  it('walks descendants and sums rss from the CIM table', () => {
    const exec = vi.fn(() => CIM_TABLE);
    const snap = inspectProcessTree(100, { platform: 'win32', exec });
    expect(snap.supported).toBe(true);
    expect([...snap.descendantPids].sort((a, b) => a - b)).toEqual([200, 300]);
    expect(snap.rssBytes).toBe(7000);
    expect(snap.nodes.map((n) => n.pid).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('invalid root pid: empty snapshot but supported=true on win32', () => {
    const exec = vi.fn();
    const snap = inspectProcessTree(0, { platform: 'win32', exec });
    expect(snap.supported).toBe(true);
    expect(snap.nodes).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('stopProcessTrees on win32', () => {
  it('issues one `taskkill /PID <root> /T /F` per root and reports every tree pid stopped', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return cmd === 'powershell.exe' ? CIM_TABLE : '';
    });
    const { snapshots, stoppedPids } = stopProcessTrees([100], 5_000, { platform: 'win32', exec });
    const kills = calls.filter((c) => c.cmd === 'taskkill');
    expect(kills).toEqual([{ cmd: 'taskkill', args: buildTaskkillArgs(100) }]);
    expect([...stoppedPids].sort((a, b) => a - b)).toEqual([100, 200, 300]);
    expect(snapshots[0]!.supported).toBe(true);
  });

  it('an already-dead root (taskkill throws) is swallowed — parity with darwin catch blocks', () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd === 'taskkill') throw new Error('ERROR: process not found');
      return CIM_TABLE;
    });
    expect(() => stopProcessTrees([100], 5_000, { platform: 'win32', exec })).not.toThrow();
  });
});

describe('process-tree on linux', () => {
  const psOut = [
    '  10     1  1000 /usr/bin/bash bash',
    '  11    10  2000 /usr/bin/node node cli.js',
    '  12    11  3000 /usr/bin/node node mcp-memory-server.cjs',
  ].join('\n');

  it('linux: lists ps rows and computes descendants', () => {
    const exec = vi.fn(() => psOut);
    const snap = inspectProcessTree(10, { platform: 'linux', exec });

    expect(exec).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']);
    expect(snap.supported).toBe(true);
    expect(snap.descendantPids).toEqual([11, 12]);
    expect(snap.rssBytes).toBe((1000 + 2000 + 3000) * 1024);
  });

  it('linux: stopProcessTrees sends signals through the POSIX path', () => {
    const exec = vi.fn(() => psOut);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const res = stopProcessTrees([10], 0, { platform: 'linux', exec });

    expect(res.stoppedPids).toEqual([12, 11, 10]);
    expect(kill).toHaveBeenCalledWith(12, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(11, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(10, 'SIGTERM');
    kill.mockRestore();
  });
});
