// win32-db-lifecycle (2026-06-11) — boot orphan sweep + quit exit-wait.
//
// All deps injected; no child_process, no timers. These run on every CI leg
// including windows-latest (ADR-006), so the win32 branch executes for real.

import { describe, it, expect, vi } from 'vitest';
import {
  DB_ORPHAN_MARKER,
  findDbOrphanPids,
  sweepWin32DbOrphans,
  waitForPidsExit,
} from './orphan-sweep';
import type { ProcessTreeNode } from './process-tree';

function node(pid: number, args: string, command = 'node.exe'): ProcessTreeNode {
  return { pid, ppid: 1, rssBytes: 0, command, args };
}

// PowerShell ConvertTo-Json shape consumed via parseCimProcessRows in the sweep.
function cimJson(rows: Array<{ pid: number; cmdline: string | null }>): string {
  return JSON.stringify(
    rows.map((r) => ({
      ProcessId: r.pid,
      ParentProcessId: 1,
      WorkingSetSize: 1024,
      Name: 'node.exe',
      CommandLine: r.cmdline,
    })),
  );
}

describe('findDbOrphanPids', () => {
  it('matches rows whose CommandLine references the marker', () => {
    const rows = [
      node(100, `C:\\node.exe C:\\app\\resources\\${DB_ORPHAN_MARKER}`),
      node(200, 'C:\\node.exe C:\\somewhere\\else.js'),
      node(300, `"C:\\Program Files\\SigmaLink\\SigmaLink.exe" ${DB_ORPHAN_MARKER}`),
    ];
    expect(findDbOrphanPids(rows, { selfPid: 1 })).toEqual([100, 300]);
  });

  it('excludes our own pid and non-positive pids', () => {
    const rows = [
      node(42, DB_ORPHAN_MARKER),
      node(0, DB_ORPHAN_MARKER),
      node(-1, DB_ORPHAN_MARKER),
    ];
    expect(findDbOrphanPids(rows, { selfPid: 42 })).toEqual([]);
  });

  it('honors a custom marker', () => {
    const rows = [node(7, 'node custom-server.cjs')];
    expect(findDbOrphanPids(rows, { selfPid: 1, marker: 'custom-server.cjs' })).toEqual([7]);
    expect(findDbOrphanPids(rows, { selfPid: 1 })).toEqual([]);
  });
});

describe('sweepWin32DbOrphans', () => {
  it('is a no-op off win32', async () => {
    const exec = vi.fn();
    const killed = await sweepWin32DbOrphans({ platform: 'darwin', exec, selfPid: 1 });
    expect(killed).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('enumerates via CIM and taskkills each marker match, then settles', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'powershell.exe') {
        return cimJson([
          { pid: 901, cmdline: `node C:\\x\\${DB_ORPHAN_MARKER}` },
          { pid: 902, cmdline: 'node unrelated.js' },
          { pid: 903, cmdline: `node D:\\y\\${DB_ORPHAN_MARKER}` },
        ]);
      }
      return '';
    });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const killed = await sweepWin32DbOrphans({
      platform: 'win32',
      exec,
      selfPid: 1,
      sleep,
      log,
    });
    expect(killed).toEqual([901, 903]);
    const taskkills = calls.filter((c) => c.command === 'taskkill');
    expect(taskkills.map((c) => c.args)).toEqual([
      ['/PID', '901', '/T', '/F'],
      ['/PID', '903', '/T', '/F'],
    ]);
    expect(sleep).toHaveBeenCalledTimes(1); // handle-release settle
  });

  it('fail-open: enumeration throw → [] and no throw', async () => {
    const exec = vi.fn(() => {
      throw new Error('powershell missing');
    });
    const log = vi.fn();
    await expect(
      sweepWin32DbOrphans({ platform: 'win32', exec, selfPid: 1, log }),
    ).resolves.toEqual([]);
    expect(log).toHaveBeenCalledOnce();
  });

  it('no matches → no taskkill, no settle sleep', async () => {
    const exec = vi.fn(() => cimJson([{ pid: 5, cmdline: 'node other.js' }]));
    const sleep = vi.fn(async () => {});
    const killed = await sweepWin32DbOrphans({ platform: 'win32', exec, selfPid: 1, sleep });
    expect(killed).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1); // CIM only
  });

  it('tolerates a taskkill throw (already-gone pid)', async () => {
    const exec = vi.fn((command: string) => {
      if (command === 'powershell.exe') {
        return cimJson([{ pid: 11, cmdline: DB_ORPHAN_MARKER }]);
      }
      throw new Error('not found');
    });
    const sleep = vi.fn(async () => {});
    await expect(
      sweepWin32DbOrphans({ platform: 'win32', exec, selfPid: 1, sleep, log: vi.fn() }),
    ).resolves.toEqual([11]);
  });
});

describe('waitForPidsExit', () => {
  it('returns immediately (no sleeps) when everything is already dead', async () => {
    const sleep = vi.fn(async () => {});
    const survivors = await waitForPidsExit([1, 2, 3], {
      isAlive: () => false,
      sleep,
    });
    expect(survivors).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until pids die', async () => {
    let polls = 0;
    const isAlive = vi.fn(() => {
      polls += 1;
      return polls <= 3; // dies after a few polls
    });
    const sleep = vi.fn(async () => {});
    const survivors = await waitForPidsExit([77], {
      isAlive,
      sleep,
      timeoutMs: 1000,
      intervalMs: 100,
    });
    expect(survivors).toEqual([]);
    expect(sleep.mock.calls.length).toBeGreaterThan(0);
  });

  it('returns survivors at timeout (bounded — cannot hang quit)', async () => {
    const sleep = vi.fn(async () => {});
    const survivors = await waitForPidsExit([5, 6], {
      isAlive: (pid) => pid === 6, // 6 never dies
      sleep,
      timeoutMs: 300,
      intervalMs: 100,
    });
    expect(survivors).toEqual([6]);
    expect(sleep).toHaveBeenCalledTimes(3); // 300/100 — hard bound
  });

  it('filters non-positive pids up front', async () => {
    const isAlive = vi.fn(() => true);
    const survivors = await waitForPidsExit([0, -4], { isAlive, sleep: async () => {} });
    expect(survivors).toEqual([]);
    expect(isAlive).not.toHaveBeenCalled();
  });
});
