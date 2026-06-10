// Win32 process enumeration + tree-kill primitives (pure argv/parse logic).
//
// The process-tree subsystem was darwin-only (`ps -axo`). This module supplies
// the win32 backend pieces:
//   - buildCimPsArgs()      — PowerShell argv that emits the process table as
//                             compact JSON via CIM (Win32_Process). wmic is
//                             deprecated/removed on Win11 — never used here.
//   - parseCimProcessRows() — tolerant JSON → ProcessTreeNode[] parser.
//   - buildTaskkillArgs()   — `taskkill /PID <p> /T /F` argv. /T walks the
//                             parent-child chain (kills detached grandchildren
//                             whose ppid links survive), /F is forceful.
//
// Everything here is PURE (no child_process import) so it is unit-tested on
// any host platform. The exec dispatch lives in process-tree.ts (sync kill
// path) and ps-snapshot.ts (async TTL stats path); real win32 behavior is
// device-verified (see plan checklist).

import type { ProcessTreeNode } from './process-tree';

/** PowerShell expression dumping pid/ppid/rss/name/cmdline as compact JSON. */
export const CIM_PROCESS_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine | ConvertTo-Json -Compress -Depth 2';

/** argv for `powershell.exe` (no profile, no prompts — safe for execFileSync). */
export function buildCimPsArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', CIM_PROCESS_QUERY];
}

/** argv for `taskkill` — force-kill the whole tree rooted at `pid`. */
export function buildTaskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

interface CimRow {
  ProcessId?: number | null;
  ParentProcessId?: number | null;
  WorkingSetSize?: number | null;
  Name?: string | null;
  CommandLine?: string | null;
}

/**
 * Parse `ConvertTo-Json` output into ProcessTreeNode rows.
 * Tolerant by design: single object (PowerShell unwraps 1-element arrays),
 * null CommandLine (access denied / system processes), garbage → [].
 * WorkingSetSize is reported in BYTES by CIM (unlike `ps` rss kilobytes).
 */
export function parseCimProcessRows(jsonText: string): ProcessTreeNode[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out: ProcessTreeNode[] = [];
  for (const row of rows) {
    const r = row as CimRow | null;
    if (typeof r?.ProcessId !== 'number' || r.ProcessId <= 0) continue;
    out.push({
      pid: r.ProcessId,
      ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0,
      rssBytes: typeof r.WorkingSetSize === 'number' ? r.WorkingSetSize : 0,
      command: r.Name ?? '',
      args: r.CommandLine ?? '',
    });
  }
  return out;
}
