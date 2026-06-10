// perf-hot-paths Task 1 — shared async process-table snapshot + TTL cache.
//
// WHY: `inspectProcessTree` shells out to `ps -axo …` SYNCHRONOUSLY (~23 ms of
// blocked main loop per call) and the renderer polls `pty.processStats` every
// 3 s PER running pane — 12 panes ≈ 280 ms of main-loop stalls per 3 s window,
// which stalls pty.write echo + the 12 ms pty:data coalescer flush. ONE `ps`
// output already contains EVERY pane's tree, so this module fetches the table
// at most once per TTL window with ASYNC execFile (zero event-loop blocking)
// and each pane computes its subtree locally from the shared rows.
//
// Backend-agnostic seam: the per-platform "list all processes" function is a
// `ProcessLister`. darwin's lives here; the win32-platform-services plan adds
// a `win32:` entry to LISTERS WITHOUT touching the TTL/cache layer.

import { execFile } from 'node:child_process';
import {
  buildSubtree,
  emptySnapshot,
  parsePsLine,
  type ProcessTreeNode,
  type ProcessTreeSnapshot,
} from './process-tree';
import { buildCimPsArgs, parseCimProcessRows } from './process-list-win32';

export type ProcessLister = () => Promise<ProcessTreeNode[]>;

/** One process-table fetch covers all panes polling within this window. */
export const PROCESS_TABLE_TTL_MS = 2_500;

export function parsePsOutput(out: string): ProcessTreeNode[] {
  return out
    .split('\n')
    .map(parsePsLine)
    .filter((row): row is ProcessTreeNode => row !== null);
}

const darwinLister: ProcessLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,comm=,args='],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parsePsOutput(stdout));
      },
    );
  });

// win32-platform-services: PowerShell CIM (Win32_Process) is the win32
// equivalent of darwin's `ps`. ASYNC execFile (no shell) keeps the TTL/cache
// layer non-blocking; the CIM argv + tolerant JSON parse are the same pure
// primitives the sync kill path uses (process-list-win32.ts). wmic-free —
// wmic is deprecated/removed on Win11. Real behavior is device-verified.
const win32Lister: ProcessLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      buildCimPsArgs(),
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(parseCimProcessRows(stdout));
      },
    );
  });

// Per-platform backends. The win32-platform-services plan added `win32:` here
// WITHOUT touching the TTL/cache layer below.
const LISTERS: Partial<Record<NodeJS.Platform, ProcessLister>> = {
  darwin: darwinLister,
  win32: win32Lister,
};

let testLister: ProcessLister | null = null;
let cachedRows: ProcessTreeNode[] | null = null;
let cachedAt = 0;
let inFlight: Promise<ProcessTreeNode[]> | null = null;

function activeLister(platform: NodeJS.Platform): ProcessLister | null {
  return testLister ?? LISTERS[platform] ?? null;
}

function getProcessTable(lister: ProcessLister): Promise<ProcessTreeNode[]> {
  const now = Date.now();
  if (cachedRows && now - cachedAt < PROCESS_TABLE_TTL_MS) {
    return Promise.resolve(cachedRows);
  }
  if (inFlight) return inFlight;
  inFlight = lister().then(
    (rows) => {
      cachedRows = rows;
      cachedAt = Date.now();
      inFlight = null;
      return rows;
    },
    () => {
      // Lister failure: degrade to the last table (or empty) without throwing
      // — a transient ps failure must never break the stats badge. Stamp
      // cachedAt so we back off for one TTL window instead of hammering.
      inFlight = null;
      cachedAt = Date.now();
      return cachedRows ?? [];
    },
  );
  return inFlight;
}

/**
 * Async, TTL-cached equivalent of `inspectProcessTree`. NEVER blocks the main
 * event loop and NEVER throws. N panes polling within one TTL window share
 * ONE `ps` exec.
 */
export async function inspectProcessTreeCached(
  rootPid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessTreeSnapshot> {
  const lister = activeLister(platform);
  if (!lister) return emptySnapshot(rootPid, false);
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, true);
  const rows = await getProcessTable(lister);
  return buildSubtree(rows, rootPid);
}

/** Test-only: override the platform lister (null = simulate no backend). */
export function __setProcessListerForTests(lister: ProcessLister | null): void {
  testLister = lister;
}

/** Test-only: drop the cached table + in-flight state between tests. */
export function __resetProcessTableForTests(): void {
  testLister = null;
  cachedRows = null;
  cachedAt = 0;
  inFlight = null;
}
