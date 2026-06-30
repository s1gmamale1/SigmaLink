import { describe, expect, it } from 'vitest';
import type { ProcessTreeNode, ProcessTreeSnapshot } from '../process/process-tree';
import { summarizeMcpProcesses } from './mcp-process-diagnostic';

interface NodeSpec {
  pid: number;
  ppid: number;
  command: string;
  args: string;
  rssBytes?: number;
}

// Build a snapshot from explicit pid/ppid topology so the tests model the real
// parent→child process chains Windows reports: the `npx` launcher node and its
// resolved `node .../cli.js` child both carry the @claude-flow/cli command line.
function buildSnapshot(specs: NodeSpec[]): ProcessTreeSnapshot {
  const nodes: ProcessTreeNode[] = specs.map((spec) => ({
    pid: spec.pid,
    ppid: spec.ppid,
    rssBytes: spec.rssBytes ?? 100,
    command: spec.command,
    args: spec.args,
  }));
  const rootPid = specs[0]?.pid ?? 0;
  return {
    rootPid,
    supported: true,
    rssBytes: nodes.reduce((sum, node) => sum + node.rssBytes, 0),
    descendantPids: nodes.filter((node) => node.pid !== rootPid).map((node) => node.pid),
    nodes,
  };
}

// command = executable, args = full command line (matches ProcessTreeNode shape).
const NPX_ARGS = 'npx -y @claude-flow/cli@latest mcp start';
const CLI_ARGS = 'node C:\\x\\@claude-flow\\cli\\bin\\cli.js mcp start';

describe('summarizeMcpProcesses', () => {
  it('counts one healthy server chain (npx launcher → resolved cli) as a single stdio server', () => {
    const out = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      { pid: 101, ppid: 100, command: 'npx.cmd', args: NPX_ARGS },
      { pid: 102, ppid: 101, command: 'node.exe', args: CLI_ARGS },
      { pid: 103, ppid: 100, command: 'node.exe', args: 'node app.js' },
    ]));
    expect(out.claudeFlowStdioCount).toBe(1);
    expect(out.duplicateClaudeFlowStdio).toBe(false);
    expect(out.claudeFlowStdioPids).toEqual([101]);
  });

  it('counts two independent server chains as a duplicate', () => {
    const out = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      { pid: 101, ppid: 100, command: 'npx.cmd', args: NPX_ARGS },
      { pid: 102, ppid: 101, command: 'node.exe', args: CLI_ARGS },
      { pid: 103, ppid: 100, command: 'npx.cmd', args: NPX_ARGS },
      { pid: 104, ppid: 103, command: 'node.exe', args: CLI_ARGS },
    ]));
    expect(out.claudeFlowStdioCount).toBe(2);
    expect(out.duplicateClaudeFlowStdio).toBe(true);
    expect(out.claudeFlowStdioPids).toEqual([101, 103]);
  });

  it('does not count an HTTP-transport daemon (-t http) as a stdio start', () => {
    const out = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      {
        pid: 101,
        ppid: 100,
        command: 'npx.cmd',
        args: 'npx -y @claude-flow/cli@latest mcp start -t http -p 4317',
      },
    ]));
    expect(out.claudeFlowStdioCount).toBe(0);
    expect(out.duplicateClaudeFlowStdio).toBe(false);
  });

  it('does not count an HTTP-transport daemon (--transport http) as a stdio start', () => {
    const out = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      {
        pid: 101,
        ppid: 100,
        command: 'npx.cmd',
        args: 'npx -y @claude-flow/cli@latest mcp start --transport http -p 4317',
      },
    ]));
    expect(out.claudeFlowStdioCount).toBe(0);
  });

  it('does not count equals-form HTTP transport flags (-t=http / --transport=http)', () => {
    const dashT = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      { pid: 101, ppid: 100, command: 'npx.cmd', args: 'npx -y @claude-flow/cli@latest mcp start -t=http -p 4317' },
    ]));
    expect(dashT.claudeFlowStdioCount).toBe(0);
    const longForm = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      { pid: 101, ppid: 100, command: 'npx.cmd', args: 'npx -y @claude-flow/cli@latest mcp start --transport=http -p 4317' },
    ]));
    expect(longForm.claudeFlowStdioCount).toBe(0);
  });

  it('returns an empty summary for a null snapshot', () => {
    const out = summarizeMcpProcesses(null);
    expect(out.claudeFlowStdioCount).toBe(0);
    expect(out.claudeFlowStdioPids).toEqual([]);
    expect(out.topClaudeFlowCommand).toBeNull();
  });

  it('reports the highest-RSS matching node as the top command', () => {
    const out = summarizeMcpProcesses(buildSnapshot([
      { pid: 100, ppid: 1, command: 'codex.exe', args: 'codex' },
      { pid: 101, ppid: 100, command: 'npx.cmd', args: NPX_ARGS, rssBytes: 50 },
      { pid: 102, ppid: 101, command: 'node.exe', args: CLI_ARGS, rssBytes: 800 },
    ]));
    expect(out.topClaudeFlowCommand).toBe(`node.exe ${CLI_ARGS}`);
    expect(out.claudeFlowStdioRssBytes).toBe(850);
  });
});
