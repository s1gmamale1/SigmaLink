// P2 Task 5 — shared sentinel + KV keys for Jorvis's global/durable
// conversation scope (design decision D1). Single source of truth: before
// this module existed, `'jorvis-missions-global'` was hand-duplicated as a
// private const in supervisor.ts AND as a literal fallback in rpc-router.ts
// (see rpc-router.ts's createSupervisor wiring, pre-P2) — a classic
// plan-base-drift hazard where one copy could silently diverge from the
// other. Both now import from here instead.

/**
 * Sentinel workspaceId used for autonomous/telegram-origin missions and the
 * global operator conversation, which have no real workspace to anchor to.
 * D1 — global scope is KV-marked, not schema-typed: `conversations.
 * workspaceId` stays NOT NULL with no FK (migration `0006_assistant.ts`), so
 * a sentinel string is a safe, real row rather than a schema special case.
 *
 * VALUE MUST STAY IDENTICAL to the pre-P2 literal — existing conversation
 * rows in installed databases already carry this exact string.
 */
export const JORVIS_GLOBAL_WORKSPACE_ID = 'jorvis-missions-global';

/**
 * KV key pinning the always-on global operator conversation id (the
 * portfolio-wide, workspace-less conversation — Telegram/global-scope
 * turns). Durable across restarts: the in-memory-only approach this
 * replaces lost the conversation on every app relaunch.
 */
export const KV_OPERATOR_CONVERSATION = 'jorvis.operator.conversationId';

/**
 * KV key PREFIX pinning a mission's conversation id. The full key is
 * `${KV_MISSION_CONVERSATION_PREFIX}${missionId}`. Replaces supervisor.ts's
 * restart-lossy in-memory `missionId → conversationId` Map as the durable
 * source of truth; the in-memory map remains as a same-process cache.
 */
export const KV_MISSION_CONVERSATION_PREFIX = 'jorvis.mission.conversation.';
