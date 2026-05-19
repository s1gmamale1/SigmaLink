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

/** Tools whose failure escalates to `critical` per D1. The taxonomy reviewer
 *  reserved `critical` for events that break Sigma's mental model; failures
 *  in these tools mean the operator can no longer trust workspace state. */
const CRITICAL_TOOL_NAMES = new Set<string>(['create_workspace']);

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
