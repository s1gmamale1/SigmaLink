import type { ProcessTreeNode, ProcessTreeSnapshot } from '../process/process-tree';

export interface McpProcessSummary {
  claudeFlowStdioCount: number;
  claudeFlowStdioPids: number[];
  claudeFlowStdioRssBytes: number;
  duplicateClaudeFlowStdio: boolean;
  topClaudeFlowCommand: string | null;
}

export function summarizeMcpProcesses(snapshot: ProcessTreeSnapshot | null): McpProcessSummary {
  const matches = (snapshot?.nodes ?? []).filter(isClaudeFlowStdioMcpStart);
  return {
    claudeFlowStdioCount: matches.length,
    claudeFlowStdioPids: matches.map((node) => node.pid),
    claudeFlowStdioRssBytes: matches.reduce((sum, node) => sum + node.rssBytes, 0),
    duplicateClaudeFlowStdio: matches.length > 1,
    topClaudeFlowCommand: matches[0] ? commandLine(matches[0]) : null,
  };
}

export function isClaudeFlowStdioMcpStart(node: ProcessTreeNode): boolean {
  const text = commandLine(node).toLowerCase();
  if (!text.includes('mcp') || !text.includes('start')) return false;
  if (text.includes('-t http') || text.includes('--transport http')) return false;
  return text.includes('@claude-flow/cli') || text.includes('@claude-flow\\cli');
}

function commandLine(node: ProcessTreeNode): string {
  return `${node.command} ${node.args}`.trim();
}
