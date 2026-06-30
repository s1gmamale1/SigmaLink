import { describe, expect, it } from 'vitest';
import type { ProcessTreeSnapshot } from '../process/process-tree';
import { ObservedProcessBudgetError, checkObservedProcessBudget } from './process-budget';

function tree(rootPid: number, rssBytes: number, mcpChains: number): ProcessTreeSnapshot {
  // Each chain = one npx node (ppid = rootPid, a non-match parent) so it counts as a distinct server.
  const nodes = [{ pid: rootPid, ppid: 1, rssBytes: 100, command: 'codex.exe', args: 'codex' }];
  for (let i = 0; i < mcpChains; i++) {
    nodes.push({
      pid: rootPid + 1 + i,
      ppid: rootPid,
      rssBytes: 400,
      command: 'node.exe',
      args: 'node C:\\x\\@claude-flow\\cli\\bin\\cli.js mcp start',
    });
  }
  return { rootPid, supported: true, rssBytes, descendantPids: nodes.slice(1).map((n) => n.pid), nodes };
}

const CAPS = { maxWorkspaceRssBytes: 8_000, maxTotalRssBytes: 16_000, maxClaudeFlowStdioPerSession: 1 };

describe('checkObservedProcessBudget', () => {
  it('rejects a session with duplicate claude-flow stdio MCP chains', () => {
    expect(() => checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [{ sessionId: 's1', workspaceId: 'ws-a', snapshot: tree(10, 900, 2) }],
    })).toThrow(ObservedProcessBudgetError);
  });
  it('rejects workspace RSS over cap', () => {
    expect(() => checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [{ sessionId: 's1', workspaceId: 'ws-a', snapshot: tree(10, 9_000, 1) }],
    })).toThrow(/workspace-rss/);
  });
  it('does not reject a healthy single-server session within caps', () => {
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [{ sessionId: 's1', workspaceId: 'ws-a', snapshot: tree(10, 900, 1) }],
    });
    expect(out.violations).toEqual([]);
  });
  it('returns violations without throwing when force is true', () => {
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: true, caps: CAPS,
      sessions: [{ sessionId: 's1', workspaceId: 'ws-a', snapshot: tree(10, 9_000, 2) }],
    });
    expect(out.violations).toContain('workspace-rss');
    expect(out.violations).toContain('duplicate-stdio-mcp');
  });
  it('attributes RSS to the right workspace (other workspaces count only toward total)', () => {
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: true, caps: CAPS,
      sessions: [
        { sessionId: 's1', workspaceId: 'ws-b', snapshot: tree(10, 9_000, 1) },
      ],
    });
    expect(out.current.workspaceRssBytes).toBe(0);
    expect(out.current.totalRssBytes).toBe(9_000);
  });
  it('does not attribute a workspaceId-less session to the launching workspace', () => {
    // A scratch/swarm session with no workspaceId must not consume ws-a's budget:
    // it counts only toward total, so workspace-rss does NOT trip even over the cap.
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [
        { sessionId: 'scratch', workspaceId: undefined, snapshot: tree(10, 9_000, 1) },
      ],
    });
    expect(out.current.workspaceRssBytes).toBe(0);
    expect(out.current.totalRssBytes).toBe(9_000);
    expect(out.violations).not.toContain('workspace-rss');
  });
});
