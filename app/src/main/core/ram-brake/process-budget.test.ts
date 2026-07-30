import { describe, expect, it } from 'vitest';
import type { ProcessTreeSnapshot } from '../process/process-tree';
import { ObservedProcessBudgetError, checkObservedProcessBudget } from './process-budget';
import { parseObservedProcessBudgetError } from '../../../shared/ram-brake';

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

  // ── PR #251 review finding 2 — duplicate-stdio must be workspace-scoped ────
  // `workspaceRssBytes` is filtered to the launching workspace, and the
  // `ObservedSessionProcess.workspaceId` doc promises "an unrelated session
  // can't consume the launching workspace's budget". The duplicate-stdio scan
  // was computed over ALL live sessions, so one leaking pane in workspace A
  // hard-blocked every launch in unrelated workspace B.
  it('does not block on a duplicate-stdio session owned by ANOTHER workspace', () => {
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [{ sessionId: 's-other', workspaceId: 'ws-b', snapshot: tree(10, 900, 2) }],
    });
    expect(out.violations).not.toContain('duplicate-stdio-mcp');
    expect(out.current.duplicateStdioMcpSessionIds).toEqual([]);
  });

  it('still blocks on a duplicate-stdio session in the SAME workspace', () => {
    expect(() => checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [
        { sessionId: 's-other', workspaceId: 'ws-b', snapshot: tree(10, 900, 2) },
        { sessionId: 's-mine', workspaceId: 'ws-a', snapshot: tree(20, 900, 2) },
      ],
    })).toThrow(/duplicate-stdio-mcp/);
  });

  it('does not attribute a workspaceId-less duplicate-stdio session to the launching workspace', () => {
    // Same rule as RSS: a scratch/swarm pane with no workspaceId is not this
    // workspace's problem, so it cannot hard-block the launch.
    const out = checkObservedProcessBudget({
      workspaceId: 'ws-a', force: false, caps: CAPS,
      sessions: [{ sessionId: 'scratch', workspaceId: undefined, snapshot: tree(10, 900, 2) }],
    });
    expect(out.violations).toEqual([]);
  });
});

// ── PR #251 review finding 1 — the thrown error must be machine-parseable ────
describe('ObservedProcessBudgetError round-trip', () => {
  it('is parsed back into its details by the shared renderer parser', () => {
    let thrown: unknown;
    try {
      checkObservedProcessBudget({
        workspaceId: 'ws-a', force: false, caps: CAPS,
        sessions: [{ sessionId: 's1', workspaceId: 'ws-a', snapshot: tree(10, 9_000, 2) }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ObservedProcessBudgetError);
    const parsed = parseObservedProcessBudgetError(thrown);
    expect(parsed).toEqual((thrown as ObservedProcessBudgetError).details);
    expect(parsed?.violations).toContain('workspace-rss');
    expect(parsed?.violations).toContain('duplicate-stdio-mcp');
    expect(parsed?.current.duplicateStdioMcpSessionIds).toEqual(['s1']);
  });
});
