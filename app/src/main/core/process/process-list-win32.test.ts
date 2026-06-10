// Pure-logic tests for the win32 process backend (argv construction + CIM JSON
// parsing). Runs on any host platform — no child_process, no Windows needed.
import { describe, it, expect } from 'vitest';
import {
  buildCimPsArgs,
  buildTaskkillArgs,
  parseCimProcessRows,
  CIM_PROCESS_QUERY,
} from './process-list-win32';

describe('buildCimPsArgs', () => {
  it('builds a non-interactive powershell argv around the CIM query', () => {
    expect(buildCimPsArgs()).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      CIM_PROCESS_QUERY,
    ]);
  });

  it('uses CIM, never the deprecated wmic', () => {
    expect(CIM_PROCESS_QUERY).toContain('Get-CimInstance Win32_Process');
    expect(CIM_PROCESS_QUERY).not.toMatch(/wmic/i);
  });
});

describe('buildTaskkillArgs', () => {
  it('kills the FULL tree forcefully: /PID <p> /T /F', () => {
    expect(buildTaskkillArgs(1234)).toEqual(['/PID', '1234', '/T', '/F']);
  });
});

describe('parseCimProcessRows', () => {
  it('parses a JSON array of CIM rows (WorkingSetSize is already bytes)', () => {
    const rows = parseCimProcessRows(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 1048576, Name: 'node.exe', CommandLine: 'node server.js' },
        { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 2048, Name: 'claude.exe', CommandLine: null },
      ]),
    );
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssBytes: 1048576, command: 'node.exe', args: 'node server.js' },
      { pid: 200, ppid: 100, rssBytes: 2048, command: 'claude.exe', args: '' },
    ]);
  });

  it('tolerates the single-object form (PowerShell unwraps 1-element arrays)', () => {
    const rows = parseCimProcessRows(
      JSON.stringify({ ProcessId: 7, ParentProcessId: 4, WorkingSetSize: 512, Name: 'x.exe', CommandLine: 'x' }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(7);
  });

  it('drops rows without a numeric ProcessId and survives garbage input', () => {
    expect(parseCimProcessRows('not json at all')).toEqual([]);
    expect(parseCimProcessRows(JSON.stringify([{ Name: 'ghost.exe' }, null]))).toEqual([]);
  });
});
