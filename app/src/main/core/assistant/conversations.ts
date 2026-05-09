// V3-W13-013 — DAO for assistant conversations + messages.

import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { conversations, messages } from '../db/schema';

export type ConversationKind = 'assistant' | 'swarm_dm';
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Conversation {
  id: string;
  workspaceId: string;
  kind: ConversationKind;
  createdAt: number;
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
  return { id, workspaceId: input.workspaceId, kind: input.kind, createdAt };
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
  };
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
