import type { ProcessTreeNode } from './process-tree';

export function parseLinuxPsLine(line: string): ProcessTreeNode | null {
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

export function parseLinuxPsRows(stdout: string): ProcessTreeNode[] {
  return stdout
    .split('\n')
    .map(parseLinuxPsLine)
    .filter((row): row is ProcessTreeNode => row !== null);
}
