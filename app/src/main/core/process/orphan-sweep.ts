// win32-db-lifecycle (2026-06-11) — boot-time orphan sweep + quit-time exit wait.
//
// Root cause (operator-confirmed on the W-4 device): every agent CLI spawns its
// own `mcp-memory-server.cjs`, a persistent better-sqlite3 WRITER on
// sigmalink.db. On Windows the quit tree-kill (`taskkill /T`) only walks
// SURVIVING ppid links — the `.cmd`-shim chain exits early and reparents those
// grandchildren, so they outlive the app holding the db/-shm. Next boot:
// `journal_mode = WAL` hit the orphan's lock → SQLITE_BUSY → uncaught → the
// "JavaScript error in the main process" dialog; and the quit
// `wal_checkpoint(TRUNCATE)` always failed → unbounded -wal growth.
//
// Two cooperating primitives, both dependency-injected so they unit-test on
// any host (and run for real on the windows-latest vitest CI leg):
//   • sweepWin32DbOrphans() — boot, BEFORE initializeDatabase: enumerate
//     processes via CIM, find rows whose CommandLine references our unique
//     server filename, taskkill them, give handles a beat to release.
//     Reparenting-proof: matches by COMMAND LINE, not by tree walk.
//   • waitForPidsExit()    — quit, AFTER killAll(), BEFORE closeDatabase():
//     bounded poll until the PTY roots are gone so taskkill-initiated
//     terminations release file handles and the quit checkpoint can TRUNCATE.

import { execFileSync } from 'node:child_process';
import {
  buildCimPsArgs,
  buildTaskkillArgs,
  parseCimProcessRows,
} from './process-list-win32';
import type { ProcessTreeNode } from './process-tree';

/** The SigmaLink-owned stdio server filename — unique enough to match on. */
export const DB_ORPHAN_MARKER = 'mcp-memory-server.cjs';

/**
 * Pure: pids of rows whose CommandLine (CIM `args`) references `marker`,
 * excluding ourselves. `command` (the exe Name, e.g. `node.exe`) is ignored —
 * the marker lives in the argv, and matching the filename keeps this correct
 * across `node` / Electron-as-node / old-install spawn variants.
 */
export function findDbOrphanPids(
  nodes: ProcessTreeNode[],
  opts: { marker?: string; selfPid: number },
): number[] {
  const marker = opts.marker ?? DB_ORPHAN_MARKER;
  const out: number[] = [];
  for (const node of nodes) {
    if (node.pid <= 0 || node.pid === opts.selfPid) continue;
    if (node.args.includes(marker)) out.push(node.pid);
  }
  return out;
}

export interface SweepDeps {
  platform?: NodeJS.Platform;
  /** Sync exec returning stdout — prod uses execFileSync (mirrors process-tree). */
  exec?: (command: string, args: string[]) => string;
  selfPid?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Post-kill grace for the OS to release file handles. */
  settleMs?: number;
}

const defaultExec = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Boot-time, win32-only, best-effort, NEVER throws. Returns the pids it
 * tried to kill (empty on non-win32 / no orphans / enumeration failure).
 */
export async function sweepWin32DbOrphans(deps: SweepDeps = {}): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return [];
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const sleep = deps.sleep ?? defaultSleep;
  let pids: number[] = [];
  try {
    const stdout = exec('powershell.exe', buildCimPsArgs());
    pids = findDbOrphanPids(parseCimProcessRows(stdout), {
      selfPid: deps.selfPid ?? process.pid,
    });
  } catch (err) {
    log(`[boot] win32 db-orphan enumeration failed (non-fatal): ${String(err)}`);
    return [];
  }
  if (pids.length === 0) return [];
  log(`[boot] win32 db-orphan sweep: killing ${pids.length} stale ${DB_ORPHAN_MARKER} process(es): ${pids.join(', ')}`);
  for (const pid of pids) {
    try {
      exec('taskkill', buildTaskkillArgs(pid));
    } catch {
      /* already gone — fine */
    }
  }
  // TerminateProcess is "initiated", not "handles released" — give the OS a
  // beat before the caller opens the database.
  await sleep(deps.settleMs ?? 300);
  return pids;
}

export interface WaitDeps {
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, cross-platform
    return true;
  } catch {
    return false;
  }
};

/**
 * Quit-time: bounded poll until every pid is gone (or timeout). Returns the
 * survivors (empty = all dead). Never throws; cannot hang quit — the loop is
 * capped at `timeoutMs` (default 2.5 s, well inside before-quit's own bound).
 */
export async function waitForPidsExit(
  pids: number[],
  deps: WaitDeps = {},
): Promise<number[]> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? 2500;
  const intervalMs = deps.intervalMs ?? 100;
  let remaining = pids.filter((pid) => pid > 0 && isAlive(pid));
  let waited = 0;
  while (remaining.length > 0 && waited < timeoutMs) {
    await sleep(intervalMs);
    waited += intervalMs;
    remaining = remaining.filter((pid) => isAlive(pid));
  }
  return remaining;
}
