// v1.4.9 #07 — Sigma Assistant tool-error notification source.
//
// Wiring contract (per brief §4 item 3): ToolTracer already calls
// `this.emit('assistant:tool-trace', trace)` on every persisted trace. The
// notifications source subscribes to that channel, filters on
// `trace.ok === false`, and forwards a `tool-error` notification.
//
// Severity mapping (D1):
//   - default → `error`
//   - `toolName === 'create_workspace'` OR any DB-touching tool → `critical`
//     (these failures imply Sigma's workspace/state machine is broken).
//
// Dedup key (D3): `tool-error:${toolName}:${conversationId}`. A tool failing
// 5x in one turn collapses; the same tool failing in two different
// conversations does NOT collapse (different operator contexts).

import type { NotificationsManager } from '../manager';
import { getDb } from '../../db/client';
import { conversations } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { ToolTrace } from '../../assistant/tool-tracer';

/**
 * Tools whose failure escalates to `critical` per D1. The taxonomy reviewer
 * reserved `critical` for events that break Sigma's mental model; failures
 * in these tools mean the operator can no longer trust workspace state.
 *
 * Inclusion criterion: any assistant tool that writes to the SQLite DB and
 * whose failure leaves Sigma's internal state in an inconsistent or
 * irrecoverable condition — i.e., the operator can no longer trust workspaces,
 * sessions, swarms, or memories to reflect reality.
 *
 *   create_workspace — workspace creation failure; operator has no workspace.
 *   launch_pane      — PTY session not created; pane grid is out of sync.
 *   create_swarm     — swarm not created; swarm room shows phantom entry.
 *   add_agent        — agent row not created; swarm roster is inconsistent.
 *   create_memory    — memory not persisted; operator's note is silently lost.
 *   monitor_pane     — session not linked to conversation; pane events go dark.
 */
const CRITICAL_TOOL_NAMES = new Set<string>([
  'create_workspace',
  'launch_pane',
  'create_swarm',
  'add_agent',
  'create_memory',
  'monitor_pane',
]);

function resolveWorkspaceForConversation(conversationId: string): string | null {
  try {
    const row = getDb()
      .select({ workspaceId: conversations.workspaceId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    return row?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export function pushToolErrorNotification(
  manager: NotificationsManager,
  trace: ToolTrace,
): void {
  if (trace.ok !== false) return;

  const severity = CRITICAL_TOOL_NAMES.has(trace.name) ? 'critical' : 'error';
  const conversationId = trace.conversationId;
  const workspaceId = conversationId
    ? resolveWorkspaceForConversation(conversationId)
    : null;
  // Without a conversationId we can't deep-link or dedup-per-conversation;
  // fall back to a sentinel so the dedupKey stays deterministic.
  const convForKey = conversationId ?? 'global';

  manager.add({
    workspaceId,
    kind: 'tool-error',
    severity,
    title: `${trace.name} failed`,
    body: trace.error ?? 'tool error',
    payload: {
      conversationId,
      messageId: trace.messageId ?? null,
      toolName: trace.name,
      traceId: trace.id,
    },
    sourceEvent: 'assistant:tool-error',
    dedupKey: `tool-error:${trace.name}:${convForKey}`,
  });
}
