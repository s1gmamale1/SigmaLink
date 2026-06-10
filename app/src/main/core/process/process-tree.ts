import { execFileSync } from 'node:child_process';
import { buildCimPsArgs, buildTaskkillArgs, parseCimProcessRows } from './process-list-win32';

export interface ProcessTreeNode {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
  args: string;
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  supported: boolean;
  nodes: ProcessTreeNode[];
  descendantPids: number[];
  rssBytes: number;
}

/**
 * Injection seam. NEVER branch on raw process.platform inside the logic —
 * platform flows in as a parameter (tests force 'win32' on the macOS host).
 */
export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  /** Sync exec returning stdout. Tests fake this; prod uses execFileSync. */
  exec?: (command: string, args: string[]) => string;
}

function defaultExec(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}

function platformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function emptySnapshot(rootPid: number, supported: boolean): ProcessTreeSnapshot {
  return {
    rootPid,
    supported,
    nodes: [],
    descendantPids: [],
    rssBytes: 0,
  };
}

export function parsePsLine(line: string): ProcessTreeNode | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    rssBytes: Number(match[3]) * 1024,
    command: match[4] ?? '',
    args: match[5] ?? '',
  };
}

/**
 * Pure subtree computation over a full process table. Shared by the sync
 * kill-path inspector below and the async TTL-cached path in ps-snapshot.ts.
 */
export function buildSubtree(rows: ProcessTreeNode[], rootPid: number): ProcessTreeSnapshot {
  const byParent = new Map<number, ProcessTreeNode[]>();
  const byPid = new Map<number, ProcessTreeNode>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const nodes: ProcessTreeNode[] = [];
  const stack = byPid.get(rootPid) ? [rootPid] : [];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const node = byPid.get(pid);
    if (!node) continue;
    nodes.push(node);
    for (const child of byParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }

  const descendantPids = nodes.filter((node) => node.pid !== rootPid).map((node) => node.pid);
  const rssBytes = nodes.reduce((sum, node) => sum + node.rssBytes, 0);
  return { rootPid, supported: true, nodes, descendantPids, rssBytes };
}

export interface ProcessListResult {
  supported: boolean;
  rows: ProcessTreeNode[];
}

/**
 * Per-platform raw process listing (SYNC — the kill path needs it inline).
 *
 * COORDINATION (perf-hot-paths / ps-snapshot.ts): the ASYNC, TTL-cached stats
 * path lives in ps-snapshot.ts and has its own per-platform `ProcessLister`
 * registry (the win32 entry was added there too). This sync `listProcessRows`
 * is the kill-path equivalent — keep the `(deps?) => ProcessListResult`
 * signature and add NO caching here.
 *
 * darwin: `ps -axo` (kilobyte rss → bytes). win32: PowerShell CIM
 * (`Get-CimInstance Win32_Process`, byte WorkingSetSize; wmic-free — wmic is
 * deprecated/removed on Win11). Other platforms: unsupported (status quo).
 * Exec failure ⇒ `{ supported: true, rows: [] }` so callers keep their
 * existing pty.kill() fallback (registry.ts stop()).
 */
export function listProcessRows(deps: ProcessTreeDeps = {}): ProcessListResult {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  if (!platformSupported(platform)) return { supported: false, rows: [] };
  try {
    if (platform === 'win32') {
      return { supported: true, rows: parseCimProcessRows(exec('powershell.exe', buildCimPsArgs())) };
    }
    const out = exec('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']);
    return {
      supported: true,
      rows: out
        .split('\n')
        .map(parsePsLine)
        .filter((row): row is ProcessTreeNode => row !== null),
    };
  } catch {
    return { supported: true, rows: [] };
  }
}

export function inspectProcessTree(rootPid: number, deps: ProcessTreeDeps = {}): ProcessTreeSnapshot {
  const platform = deps.platform ?? process.platform;
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, platformSupported(platform));

  const listed = listProcessRows(deps);
  if (!listed.supported) return emptySnapshot(rootPid, false);
  return buildSubtree(listed.rows, rootPid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function stopProcessTree(
  rootPid: number,
  fallbackMs = 5_000,
  deps: ProcessTreeDeps = {},
): ProcessTreeSnapshot {
  const platform = deps.platform ?? process.platform;
  return (
    stopProcessTrees([rootPid], fallbackMs, deps).snapshots[0] ??
    emptySnapshot(rootPid, platformSupported(platform))
  );
}

export function stopProcessTrees(
  rootPids: number[],
  fallbackMs = 5_000,
  deps: ProcessTreeDeps = {},
): { snapshots: ProcessTreeSnapshot[]; stoppedPids: number[] } {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const snapshots = rootPids.map((pid) => inspectProcessTree(pid, deps));

  if (platform === 'win32') {
    // `taskkill /T` walks the parent-child chain itself (takes the detached
    // grandchildren — MCP servers, daemons — that ConPTY close leaves behind);
    // /F is forceful, so no SIGTERM→SIGKILL escalation timer is needed.
    // Already-gone pids make taskkill exit non-zero — swallowed, mirroring the
    // darwin catch blocks.
    const stoppedPids: number[] = [];
    const seen = new Set<number>();
    for (const snapshot of snapshots) {
      for (const node of snapshot.nodes) {
        if (!seen.has(node.pid)) {
          seen.add(node.pid);
          stoppedPids.push(node.pid);
        }
      }
    }
    for (const pid of rootPids) {
      if (!pid || pid <= 0) continue;
      try {
        exec('taskkill', buildTaskkillArgs(pid));
      } catch {
        /* already gone */
      }
    }
    return { snapshots, stoppedPids };
  }

  // darwin: SIGTERM the whole tree leaves-first, SIGKILL stragglers later.
  const nodesByPid = new Map<number, ProcessTreeNode>();
  for (const snapshot of snapshots) {
    if (!snapshot.supported || snapshot.nodes.length === 0) continue;
    for (const node of snapshot.nodes) {
      nodesByPid.set(node.pid, node);
    }
  }
  const ordered = Array.from(nodesByPid.values()).reverse();
  const stoppedPids = ordered.map((node) => node.pid);

  for (const node of ordered) {
    try {
      process.kill(node.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  if (ordered.length > 0) {
    setTimeout(() => {
      for (const node of ordered) {
        try {
          if (pidAlive(node.pid)) process.kill(node.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, fallbackMs).unref();
  }

  return { snapshots, stoppedPids };
}
