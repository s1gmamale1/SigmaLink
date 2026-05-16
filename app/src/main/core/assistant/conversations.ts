// V3-W13-013 — DAO for assistant conversations + messages.
// P3-S7 — Adds list summaries (title + count + last-message ts) and a
// delete helper so the BridgeRoom Conversations panel can render and prune
// past sessions without pulling every message body into memory first.

import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../db/client';
import { conversations, messages } from '../db/schema';

export type ConversationKind = 'assistant' | 'swarm_dm';
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Conversation {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  createdAt: number;
  claudeSessionId: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCallId: string | null;
  createdAt: number;
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
}

/** P3-S7 — Lightweight summary row used by the Conversations panel. The
 *  panel only needs the headline metadata (title, count, last-touched ts);
 *  full message hydration happens lazily through `messagesFor` once the
 *  user opens a conversation. */
export interface ConversationSummary {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  createdAt: number;
  title: string;
  lastMessageAt: number;
  messageCount: number;
  claudeSessionId: string | null;
}

export function createConversation(input: {
  workspaceId: string;
  kind: ConversationKind;
}): Conversation {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .insert(conversations)
    .values({ id, workspaceId: input.workspaceId, kind: input.kind, createdAt })
    .run();
  return {
    id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    createdAt,
    claudeSessionId: null,
  };
}

export function getConversation(id: string): Conversation | null {
  const row = getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as ConversationKind,
    createdAt: row.createdAt,
    claudeSessionId: row.claudeSessionId,
  };
}

export function setClaudeSessionId(
  conversationId: string,
  claudeSessionId: string | null,
): void {
  getDb()
    .update(conversations)
    .set({ claudeSessionId })
    .where(eq(conversations.id, conversationId))
    .run();
}

export function getClaudeSessionId(conversationId: string): string | null {
  const row = getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.claudeSessionId ?? null;
}

export function appendMessage(input: {
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCallId?: string | null;
}): Message {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      createdAt,
    })
    .run();
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    toolCallId: input.toolCallId ?? null,
    createdAt,
  };
}

export function listConversations(input: {
  workspaceId: string;
  kind?: ConversationKind;
}): ConversationWithMessages[] {
  const where = input.kind
    ? and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.kind, input.kind),
      )
    : eq(conversations.workspaceId, input.workspaceId);
  const rows = getDb().select().from(conversations).where(where).all();
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows.map((c) => ({
    id: c.id,
    workspaceId: c.workspaceId,
    kind: c.kind as ConversationKind,
    createdAt: c.createdAt,
    claudeSessionId: c.claudeSessionId,
    messages: messagesFor(c.id),
  }));
}

export function messagesFor(conversationId: string): Message[] {
  const rows = getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    role: r.role as MessageRole,
    content: r.content,
    toolCallId: r.toolCallId,
    createdAt: r.createdAt,
  }));
}

/**
 * P3-S7 — Summary listing for the Conversations panel. Two prepared
 * queries (one for conversations, one aggregating messages.count +
 * MAX(createdAt)) plus a single targeted lookup for the first-user-message
 * title; avoids the N+1 a per-conversation SELECT would cause. The title
 * falls back to a date-stamped placeholder when no user message exists yet
 * so empty threads still read sensibly.
 */
export function listConversationSummaries(input: {
  workspaceId: string;
  kind?: ConversationKind;
}): ConversationSummary[] {
  const where = input.kind
    ? and(
        eq(conversations.workspaceId, input.workspaceId),
        eq(conversations.kind, input.kind),
      )
    : eq(conversations.workspaceId, input.workspaceId);
  const convs = getDb().select().from(conversations).where(where).all();
  if (convs.length === 0) return [];
  const ids = convs.map((c) => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const raw = getRawDb();
  // One row per conversation: count + max(created_at) of its messages.
  const aggRows = raw
    .prepare(
      `SELECT conversation_id AS id,
              COUNT(*) AS cnt,
              MAX(created_at) AS lastAt
         FROM messages
        WHERE conversation_id IN (${placeholders})
        GROUP BY conversation_id`,
    )
    .all(...ids) as Array<{ id: string; cnt: number; lastAt: number }>;
  const aggByConv = new Map<string, { count: number; lastAt: number }>(
    aggRows.map((r) => [r.id, { count: r.cnt, lastAt: r.lastAt }]),
  );
  // First user message per conversation — one row per conversation via the
  // conversation_id GROUP + MIN(created_at) sub-pattern. Using a window
  // function keeps the query O(messages) regardless of conversation count.
  const titleRows = raw
    .prepare(
      `SELECT conversation_id AS id, content
         FROM messages
        WHERE role = 'user'
          AND conversation_id IN (${placeholders})
          AND created_at = (
            SELECT MIN(created_at) FROM messages m2
              WHERE m2.conversation_id = messages.conversation_id
                AND m2.role = 'user'
          )`,
    )
    .all(...ids) as Array<{ id: string; content: string }>;
  const titleByConv = new Map<string, string>(
    titleRows.map((r) => [r.id, r.content]),
  );

  const out: ConversationSummary[] = convs.map((c) => {
    const agg = aggByConv.get(c.id);
    const titleSrc = (titleByConv.get(c.id) ?? '').trim();
    const title =
      titleSrc.length > 0
        ? titleSrc.slice(0, 60) + (titleSrc.length > 60 ? '…' : '')
        : `Conversation ${new Date(c.createdAt).toISOString().slice(0, 10)}`;
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      kind: c.kind as ConversationKind,
      createdAt: c.createdAt,
      title,
      lastMessageAt: agg?.lastAt ?? c.createdAt,
      messageCount: agg?.count ?? 0,
      claudeSessionId: c.claudeSessionId,
    };
  });
  // Most recent on top — sort by lastMessageAt so reopened threads bubble.
  out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return out;
}

/** P3-S7 — Drop a conversation + every message it owns. Migration 0006's
 *  CASCADE on `messages.conversation_id` handles the message wipe; we
 *  delete the parent row only. Swarm-origins (migration 0009) cascade on
 *  the conversation drop too, so back-links from the Operator Console
 *  resolve to `null` cleanly after a delete. */
export function deleteConversation(conversationId: string): void {
  getDb().delete(conversations).where(eq(conversations.id, conversationId)).run();
}
