import { execFileSync } from 'node:child_process';

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

function emptySnapshot(rootPid: number, supported: boolean): ProcessTreeSnapshot {
  return {
    rootPid,
    supported,
    nodes: [],
    descendantPids: [],
    rssBytes: 0,
  };
}

function parsePsLine(line: string): ProcessTreeNode | null {
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

export function inspectProcessTree(rootPid: number): ProcessTreeSnapshot {
  if (!rootPid || rootPid <= 0) return emptySnapshot(rootPid, process.platform === 'darwin');
  if (process.platform !== 'darwin') return emptySnapshot(rootPid, false);

  let rows: ProcessTreeNode[];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm=,args='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    rows = out
      .split('\n')
      .map(parsePsLine)
      .filter((row): row is ProcessTreeNode => row !== null);
  } catch {
    return emptySnapshot(rootPid, true);
  }

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
  return {
    rootPid,
    supported: true,
    nodes,
    descendantPids,
    rssBytes,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function stopProcessTree(rootPid: number, fallbackMs = 5_000): ProcessTreeSnapshot {
  const snapshot = inspectProcessTree(rootPid);
  if (!snapshot.supported || snapshot.nodes.length === 0) return snapshot;

  const ordered = [...snapshot.nodes].reverse();
  for (const node of ordered) {
    try {
      process.kill(node.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  setTimeout(() => {
    for (const node of ordered) {
      try {
        if (pidAlive(node.pid)) process.kill(node.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, fallbackMs).unref();

  return snapshot;
}
