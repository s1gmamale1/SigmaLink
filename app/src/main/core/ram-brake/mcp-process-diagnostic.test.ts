import { describe, expect, it } from 'vitest';
import type { ProcessTreeSnapshot } from '../process/process-tree';
import { summarizeMcpProcesses } from './mcp-process-diagnostic';

function snapshot(args: string[]): ProcessTreeSnapshot {
  return {
    rootPid: 100,
    supported: true,
    rssBytes: 1000,
    descendantPids: args.map((_, index) => 101 + index),
    nodes: [
      { pid: 100, ppid: 1, rssBytes: 100, command: 'codex.exe', args: 'codex' },
      ...args.map((line, index) => ({
        pid: 101 + index,
        ppid: 100,
        rssBytes: 400,
        command: line.split(' ')[0] ?? '',
        args: line,
      })),
    ],
  };
}

describe('summarizeMcpProcesses', () => {
  it('detects repeated claude-flow stdio MCP starts', () => {
    const out = summarizeMcpProcesses(snapshot([
      'npx -y @claude-flow/cli@latest mcp start',
      'node C:\\x\\@claude-flow\\cli\\bin\\cli.js mcp start',
      'node unrelated.js',
    ]));
    expect(out.claudeFlowStdioCount).toBe(2);
    expect(out.duplicateClaudeFlowStdio).toBe(true);
    expect(out.claudeFlowStdioPids).toEqual([101, 102]);
  });

  it('does not count HTTP daemon processes as stdio starts', () => {
    const out = summarizeMcpProcesses(snapshot([
      'ruflo mcp start -t http -p 4317 --host 127.0.0.1',
    ]));
    expect(out.claudeFlowStdioCount).toBe(0);
    expect(out.duplicateClaudeFlowStdio).toBe(false);
  });

  it('returns an empty summary for a null snapshot', () => {
    const out = summarizeMcpProcesses(null);
    expect(out.claudeFlowStdioCount).toBe(0);
    expect(out.claudeFlowStdioPids).toEqual([]);
    expect(out.topClaudeFlowCommand).toBeNull();
  });
});
