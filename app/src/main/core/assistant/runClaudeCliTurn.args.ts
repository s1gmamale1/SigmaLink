// V3-W14-002 / v1.4.5 — CLI-args assembly + session-id helpers extracted from
// runClaudeCliTurn.ts. Keeps the main turn driver focused on spawn + envelope
// routing. Internal-only — callers should import from runClaudeCliTurn.ts.
//
// Extracted: buildCliArgs, applyMcpHostConfig, resolveSystemPrompt,
// getPriorClaudeSessionId, clearPriorClaudeSessionId, appendAssistantMessage.

import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { isClaudeSessionId } from '../pty/claude-resume-bridge';
import { buildJorvisSystemPrompt } from './system-prompt';
import { writeJorvisHostMcpConfig } from './mcp-host-bridge';
import * as conversationsDao from './conversations';
import type { CliTurnDeps } from './runClaudeCliTurn';

// ---------------------------------------------------------------------------
// System-prompt helpers
// ---------------------------------------------------------------------------

function defaultSystemPromptForWorkspace(workspaceId: string): string {
  let workspaceName = 'workspace';
  let workspaceRoot = '';
  try {
    const wsRow = getDb()
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .get();
    if (wsRow) {
      workspaceName = wsRow.name;
      workspaceRoot = wsRow.rootPath;
    }
  } catch {
    /* DB miss is non-fatal — prompt still works with placeholders */
  }
  return buildJorvisSystemPrompt({ workspaceName, workspaceRoot });
}

export function resolveSystemPrompt(
  workspaceId: string | null,
  build?: (id: string) => string,
): string {
  if (build) return build(workspaceId ?? '');
  if (workspaceId) return defaultSystemPromptForWorkspace(workspaceId);
  return buildJorvisSystemPrompt({ workspaceName: 'workspace', workspaceRoot: '' });
}

// ---------------------------------------------------------------------------
// CLI argument assembly
// ---------------------------------------------------------------------------

export function buildCliArgs(
  prompt: string,
  sysPrompt: string,
  resumeSessionId: string | null,
): string[] {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt', sysPrompt,
  ];
  if (resumeSessionId && isClaudeSessionId(resumeSessionId)) {
    args.unshift('--resume', resumeSessionId);
  }
  return args;
}

// BUG-V1.1.2-01 — Write a temp `.mcp.json` and load it when the host bridge
// is wired AND the bundled stdio server exists on disk. Non-fatal: the
// turn still streams text, just without Sigma tools.
export function applyMcpHostConfig(
  args: string[],
  mcpHost: CliTurnDeps['mcpHost'],
  conversationId: string,
  workspaceId: string | null,
): void {
  if (!mcpHost?.serverEntry || !mcpHost?.socketPath) return;
  try {
    const path = writeJorvisHostMcpConfig(mcpHost, conversationId, workspaceId ?? undefined);
    if (path) args.push('--mcp-config', path, '--strict-mcp-config');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[runClaudeCliTurn] failed to write jorvis-host mcp config:', msg);
  }
}

// ---------------------------------------------------------------------------
// Claude session-id helpers (resume bridge)
// ---------------------------------------------------------------------------

type ConversationsRuntimeDao = typeof conversationsDao & {
  getClaudeSessionId?: (conversationId: string) => string | null;
  setClaudeSessionId?: (conversationId: string, claudeSessionId: string | null) => void;
};

export function getPriorClaudeSessionId(
  conv: ReturnType<typeof conversationsDao.getConversation> | null,
): string | null {
  if (!conv) return null;
  const dao = conversationsDao as ConversationsRuntimeDao;
  try {
    const fromDao = dao.getClaudeSessionId?.(conv.id);
    if (typeof fromDao === 'string' || fromDao === null) return fromDao;
  } catch {
    /* DAO is optional until Worker A's data-layer slice lands */
  }
  const withField = conv as typeof conv & { claudeSessionId?: string | null };
  return typeof withField.claudeSessionId === 'string' ? withField.claudeSessionId : null;
}

export function clearPriorClaudeSessionId(conversationId: string): void {
  const dao = conversationsDao as ConversationsRuntimeDao;
  try {
    dao.setClaudeSessionId?.(conversationId, null);
  } catch {
    /* best-effort; a stale id may retry fresh again next turn */
  }
}

// ---------------------------------------------------------------------------
// Message persistence helpers
// ---------------------------------------------------------------------------

// W-6 Cluster B: new writes use 'jorvis-in-flight:' prefix.
// The renderer isInFlightToolCall() accepts both 'jorvis-in-flight:' and
// 'sigma-in-flight:' for backward-compat with persisted pre-rename rows.
export function appendAssistantMessage(conversationId: string, turnId: string): string | null {
  try {
    return conversationsDao.appendMessage({
      conversationId,
      role: 'assistant',
      content: '',
      toolCallId: `jorvis-in-flight:${turnId}`,
    }).id;
  } catch {
    /* persistence is best-effort; renderer still receives delta + final */
    return null;
  }
}
