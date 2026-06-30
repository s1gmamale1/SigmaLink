import type { ProcessTreeNode, ProcessTreeSnapshot } from '../process/process-tree';

export interface McpProcessSummary {
  claudeFlowStdioCount: number;
  claudeFlowStdioPids: number[];
  claudeFlowStdioRssBytes: number;
  duplicateClaudeFlowStdio: boolean;
  topClaudeFlowCommand: string | null;
}

export function summarizeMcpProcesses(snapshot: ProcessTreeSnapshot | null): McpProcessSummary {
  const nodes = snapshot?.nodes ?? [];
  const matches = nodes.filter(isClaudeFlowStdioMcpStart);
  const matchPids = new Set(matches.map((node) => node.pid));
  // Collapse parent→child match chains: the canonical `npx -y @claude-flow/cli@latest mcp start`
  // spawn shows up on Windows as several matching nodes in one chain (the npx launcher node
  // carries the @claude-flow/cli args; its resolved `node .../@claude-flow/cli/bin/cli.js` child
  // carries them too). Count one server per chain by keeping only matches whose parent is NOT
  // itself a match. This never merges independent sibling servers, so real leaks still count.
  const roots = matches.filter((node) => !matchPids.has(node.ppid));
  const heaviest = matches.reduce<ProcessTreeNode | null>(
    (best, node) => (best === null || node.rssBytes > best.rssBytes ? node : best),
    null,
  );
  return {
    claudeFlowStdioCount: roots.length,
    claudeFlowStdioPids: roots.map((node) => node.pid),
    // Full footprint of the chain(s): sum every matching node, not just the roots.
    claudeFlowStdioRssBytes: matches.reduce((sum, node) => sum + node.rssBytes, 0),
    duplicateClaudeFlowStdio: roots.length > 1,
    // Honest "top": the highest-RSS matching node's command line.
    topClaudeFlowCommand: heaviest ? commandLine(heaviest) : null,
  };
}

export function isClaudeFlowStdioMcpStart(node: ProcessTreeNode): boolean {
  const text = commandLine(node).toLowerCase();
  // Require BOTH `mcp` and `start` tokens so we only match an MCP server launch
  // (`... mcp start`), not unrelated claude-flow invocations that merely mention mcp.
  if (!text.includes('mcp') || !text.includes('start')) return false;
  // Exclude HTTP-transport launches: claude-flow's `-t http` / `--transport http` daemon is a
  // separate long-lived HTTP server, NOT a per-session stdio descendant, so it must not count
  // toward stdio-MCP leak detection.
  if (text.includes('-t http') || text.includes('--transport http')) return false;
  return text.includes('@claude-flow/cli') || text.includes('@claude-flow\\cli');
}

function commandLine(node: ProcessTreeNode): string {
  return `${node.command} ${node.args}`.trim();
}
