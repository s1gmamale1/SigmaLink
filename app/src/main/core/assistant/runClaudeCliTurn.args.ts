// V3-W14-002 / v1.4.5 — CLI-args assembly + session-id helpers extracted from
// runClaudeCliTurn.ts. Keeps the main turn driver focused on spawn + envelope
// routing. Internal-only — callers should import from runClaudeCliTurn.ts.
//
// Extracted: buildCliArgs, applyMcpHostConfig, resolveSystemPrompt,
// getPriorClaudeSessionId, clearPriorClaudeSessionId, appendAssistantMessage.
//
// P2 Task 5 — defaultSystemPromptForWorkspace now threads the operator's
// charter through every real turn (D2/D3 — charter is default-ON, not a
// safety gate) and switches to a portfolio listing for the
// JORVIS_GLOBAL_WORKSPACE_ID sentinel (D1).
//
// P2 Task 8 — the T5-deferred `amendments` seam is now wired:
// `listAmendments('approved')` (core/operator/amendments.ts) feeds
// buildJorvisSystemPrompt's `amendments` field alongside charter, on BOTH
// the portfolio and single-workspace paths. system-prompt.ts's
// `appendApprovedAmendments` (Task 4) already filters to approved-only and
// appends after the persona block — this call site just supplies the rows.
// Everything below is fail-soft: a throwing charter load, a throwing
// amendments load, or a DB miss degrades to the legacy inline persona /
// placeholder workspace fields / no amendments block, never blocks a turn.

import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { workspaces as workspacesTable } from '../db/schema';
import { isClaudeSessionId } from '../pty/claude-resume-sigma';
import { buildJorvisSystemPrompt } from './system-prompt';
import { writeJorvisHostMcpConfig } from './mcp-host-sigma';
import * as conversationsDao from './conversations';
import { loadJorvisCharter } from '../operator/charter';
import { listAmendments } from '../operator/amendments';
import { JORVIS_GLOBAL_WORKSPACE_ID } from '../operator/global';
import type { CliTurnDeps } from './runClaudeCliTurn';
import type { JorvisAmendment } from '../../../shared/types';

// ---------------------------------------------------------------------------
// System-prompt helpers
// ---------------------------------------------------------------------------

// Inline raw-SQL kv read — mirrors allowedReadRoots' DEV_WORKSPACE_KV_KEY
// read in tools.ts (~:483): its own try/catch swallows any DB error to
// `null` so a broken/absent kv table can never throw past this point.
function kvGetRaw(key: string): string | null {
  try {
    const row = getRawDb()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function loadCharterFailSoft(): string | undefined {
  try {
    return loadJorvisCharter({ kvGet: kvGetRaw });
  } catch {
    // loadJorvisCharter is internally fail-soft for its own readFile step;
    // this is defense-in-depth for anything else that might throw (e.g. a
    // future change to its kvGet contract) — charter undefined means
    // buildJorvisSystemPrompt falls back to the legacy inline persona.
    return undefined;
  }
}

// P2 Task 8 — a broken/missing amendments table must never block a turn;
// undefined means buildJorvisSystemPrompt's appendApprovedAmendments call
// sees an empty list and leaves the persona block unchanged.
function loadApprovedAmendmentsFailSoft(): JorvisAmendment[] | undefined {
  try {
    return listAmendments('approved');
  } catch {
    return undefined;
  }
}

function defaultSystemPromptForWorkspace(workspaceId: string): string {
  const charter = loadCharterFailSoft();
  const amendments = loadApprovedAmendmentsFailSoft();

  if (workspaceId === JORVIS_GLOBAL_WORKSPACE_ID) {
    let portfolio: Array<{ name: string; root: string }> = [];
    try {
      portfolio = getDb()
        .select()
        .from(workspacesTable)
        .all()
        .map((ws) => ({ name: ws.name, root: ws.rootPath }));
    } catch {
      /* DB miss is non-fatal — the portfolio just renders empty */
    }
    return buildJorvisSystemPrompt({
      workspaceName: 'Portfolio',
      workspaceRoot: '',
      charter,
      portfolio,
      amendments,
    });
  }

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
  return buildJorvisSystemPrompt({ workspaceName, workspaceRoot, charter, amendments });
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
