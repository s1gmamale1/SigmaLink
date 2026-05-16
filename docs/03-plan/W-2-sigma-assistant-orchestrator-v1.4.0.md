# W-2 — Sigma Assistant as orchestrator + session resume (target v1.4.0)

## Context

W-2 was added to the wishlist on 2026-05-15. Investigation under plan-mode (2026-05-16) confirmed:

Sigma Assistant currently has:
- A controller at `app/src/main/core/assistant/controller.ts` exposing `send`, `list`, `cancel`, `dispatchPane` RPCs.
- A streaming-JSON Claude CLI driver `runClaudeCliTurn.ts` that spawns a fresh `claude` process per `send()`.
- A 10-tool registry (`tools.ts`) including `launch_pane`, `create_swarm`, `read_files`, `write_files`, etc.
- Conversation persistence in SQLite (`conversations` + `messages` tables, no JSONL).
- Working multi-pane dispatch (`dispatchPane` RPC + `launch_pane` tool) with `assistant:dispatch-echo` events.
- A right-rail UI `BridgeRoom.tsx` that restores active conversation from `kv['bridge.activeConversationId']`.

What's missing for W-2:
- **Multi-turn context.** Every `send()` is a fresh Claude CLI invocation with no `--resume` chaining. After the first turn the Claude session id is lost and context drops on the floor.
- **Resume UI.** The history list lives in `ConversationsPanel.tsx` but there's no "Resumable" badge or right-rail dropdown. Users can't easily pick up an older conversation from the orb.
- **Cross-restart memory of orchestration intent.** If SigmaLink quits mid-dispatch, the user re-opens to find a "complete" conversation row with no indication that work was in flight.

The pane → Sigma mailbox back-channel (so Sigma can monitor + retry CLI panes) is explicitly deferred to v1.4.1 per user decision (2026-05-16).

## Strategy

Five-phase build, ~4.5 days. All changes are backwards-compatible: existing conversations without `claude_session_id` continue to load and create fresh turns; only NEW behavior is layered on top.

### Phase 1 — Data layer (0.5 day)

**Migration `0013_conversations_claude_session_id.ts`** (NEW) — idempotent column-add following the exact pattern of `0011_agent_session_external_id.ts` and `0012_agent_session_pane_index.ts`:

```ts
export const name = '0013_conversations_claude_session_id';
export function up(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    if (!hasColumn(db, 'conversations', 'claude_session_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN claude_session_id TEXT');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

No index — lookup is by primary key (conversationId).

**Design decision:** single nullable column on `conversations` (not a parallel table). Rationale: resume semantics are 1:1 — once a Claude session exists for a conversation, every subsequent turn extends it. If resume falls through to fresh, the controller overwrites the column. The JSONL on disk holds full provenance; we don't need historical chain in the DB.

**Schema update** at `app/src/main/core/db/schema.ts` around line 406:

```ts
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  kind: text('kind', { enum: ['assistant', 'swarm_dm'] }).notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  // v1.4.0 — Claude CLI session-id captured from `system.init` envelope.
  claudeSessionId: text('claude_session_id'),
}, ...);
```

**Migration registration** at `app/src/main/core/db/migrate.ts` — append to `ALL_MIGRATIONS`.

### Phase 2 — Capture (0.5 day)

**Tighten `cli-envelope.ts`** with a type guard:

```ts
export interface CliSystemEnvelope {
  type: 'system';
  subtype?: string;
  session_id?: string;
  [k: string]: unknown;
}
export function isSystemInitEnvelope(env: CliEnvelope): env is CliSystemEnvelope & {
  subtype: 'init';
  session_id: string;
} {
  return env.type === 'system'
    && (env as CliSystemEnvelope).subtype === 'init'
    && typeof (env as CliSystemEnvelope).session_id === 'string';
}
```

Claude CLI's first stdout line is `{"type":"system","subtype":"init","session_id":"<uuid>",...}` — verified during exploration.

**DAO functions** at `app/src/main/core/assistant/conversations.ts`:

```ts
export function setClaudeSessionId(conversationId: string, claudeSessionId: string | null): void {
  getDb().update(conversations)
    .set({ claudeSessionId })
    .where(eq(conversations.id, conversationId))
    .run();
}
export function getClaudeSessionId(conversationId: string): string | null {
  const row = getDb().select({ claudeSessionId: conversations.claudeSessionId })
    .from(conversations).where(eq(conversations.id, conversationId)).get();
  return row?.claudeSessionId ?? null;
}
```

Extend `Conversation` interface to carry the optional field; update `getConversation` and `listConversationSummaries` projections.

**Capture point** at `app/src/main/core/assistant/runClaudeCliTurn.trajectory.ts` `handleParsedEnvelope`:

```ts
if (isSystemInitEnvelope(env) && !state.capturedSessionId) {
  state.capturedSessionId = env.session_id;
  try {
    setClaudeSessionId(ctx.turn.conversationId, env.session_id);
  } catch {
    /* persistence is best-effort; resume falls through to fresh on miss */
  }
}
```

Add `capturedSessionId?: string` to `TurnLoopState`.

### Phase 3 — Resume + fallback (1.5 days, hardest phase)

**Args extension** at `app/src/main/core/assistant/runClaudeCliTurn.ts`:

```ts
import { isClaudeSessionId } from '../pty/claude-resume-bridge';

function buildCliArgs(prompt: string, sysPrompt: string, resumeSessionId: string | null): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', sysPrompt];
  if (resumeSessionId && isClaudeSessionId(resumeSessionId)) {
    args.unshift('--resume', resumeSessionId);
  }
  return args;
}
```

Reuse `isClaudeSessionId` UUID guard from `claude-resume-bridge.ts` (v1.3.2) — same shape rule.

**Resume read** in `runClaudeCliTurn` after the `conv` lookup (line ~234):

```ts
const priorClaudeSessionId = conv ? getClaudeSessionId(conv.id) : null;
```

**Retry-once-without-resume loop** wrapping the spawn:

```ts
let retryWithoutResume = false;
do {
  state.resumeLikelyFailed = false;
  const args = buildCliArgs(prompt, sysPrompt, retryWithoutResume ? null : priorClaudeSessionId);
  // ... existing spawn + drive loop ...
  if (priorClaudeSessionId && !retryWithoutResume && state.resumeLikelyFailed) {
    setClaudeSessionId(turn.conversationId, null);
    retryWithoutResume = true;
    continue;
  }
  break;
} while (true);
```

**Detection** of resume failure in `trajectory.ts`: set `state.resumeLikelyFailed = true` when:
- A `result` envelope arrives with subtype `error_during_execution`, OR
- The child closes with no `result` envelope AND stderr matches `/no such session/i` or `/cannot find session/i`.

Cap at one retry to avoid infinite loop on a genuinely-broken CLI.

**Risk to verify during implementation:** the exact stderr text Claude 2.1.143 emits on stale `--resume <id>`. Probe with `claude --resume 00000000-0000-0000-0000-000000000000 -p hi --output-format stream-json --verbose` and grep the output. Adjust regex accordingly.

### Phase 4 — UI surface (0.75 day)

Three additions to `app/src/renderer/features/bridge-agent/BridgeRoom.tsx`:

**1. Right-rail compact dropdown.** The `variant === 'rail'` branch currently skips the conversations panel entirely. Add a Radix `DropdownMenu` (already in `app/package.json`) in the rail header:

- Trigger: active conversation title + chevron.
- Content: list of `assistant.conversations.list` rows, each row showing title + `claudeSessionId !== null ? "Resumable" : null` pill.
- onSelect: dispatch `onPickConversation(row.id)` (already defined).

**2. "Resuming chat from `<relative-time>`" banner.** When a conversation hydrates and `claudeSessionId !== null`, show a single-line banner above the message list. Auto-dismiss on the next `send()` call.

**3. Interrupted-turn banner.** See Phase 5.

**Resume hint RPC** at `app/src/main/core/assistant/conversations-controller.ts`:

```ts
resumeHint: async (input: unknown): Promise<{ available: boolean; sessionId: string | null }> => {
  const { conversationId } = ResumeHintInput.parse(input);
  const conv = getConversation(conversationId);
  if (!conv?.claudeSessionId) return { available: false, sessionId: null };
  const slug = claudeSlugForCwd(conv.workspaceRootPath);  // import from claude-resume-bridge
  const jsonlPath = path.join(os.homedir(), '.claude', 'projects', slug, `${conv.claudeSessionId}.jsonl`);
  return {
    available: existsSync(jsonlPath),
    sessionId: conv.claudeSessionId,
  };
},
```

The renderer can call this BEFORE the user types their next message to warn "this conversation's history file is missing — your next turn will be fresh".

**Resumable pill** in `ConversationsPanel.tsx` — small badge next to title when row's `claudeSessionId !== null`.

**Router shape** at `app/src/shared/router-shape.ts` — add `resumeHint` to the `assistant.conversations` namespace. Extend `ConversationListItem` shape to include `claudeSessionId: string | null`.

### Phase 5 — In-flight tool-call sentinel (0.5 day)

When `send()` starts a turn, write the assistant message row with a sentinel `toolCallId: 'sigma-in-flight:<turnId>'`. Clear it on successful completion.

**`appendAssistantMessage`** at `app/src/main/core/assistant/runClaudeCliTurn.ts`:

```ts
function appendAssistantMessage(conversationId: string, turnId: string): string | null {
  try {
    return appendMessage({
      conversationId,
      role: 'assistant',
      content: '',
      toolCallId: `sigma-in-flight:${turnId}`,
    }).id;
  } catch {
    return null;
  }
}
```

**`persistFinal`** at `runClaudeCliTurn.emit.ts` clears the sentinel:

```ts
export function persistFinal(turn, messageId, text): void {
  getDb().update(messagesTable)
    .set({ content: text, toolCallId: null })
    .where(eq(messagesTable.id, messageId))
    .run();
}
```

**Interrupted-turn banner** in `BridgeRoom.tsx` hydration path: detect messages where `toolCallId?.startsWith('sigma-in-flight:')` AND no result row follows. Render banner with "Dismiss" / "Retry" actions. Retry re-sends the previous user message — the Phase 3 resume path picks up from the captured session id.

## Critical files

| File | Change |
|---|---|
| `app/src/main/core/db/migrations/0013_conversations_claude_session_id.ts` | NEW |
| `app/src/main/core/db/migrate.ts` | Register migration |
| `app/src/main/core/db/schema.ts` | Add `claudeSessionId` to `conversations` |
| `app/src/main/core/assistant/conversations.ts` | `setClaudeSessionId` + `getClaudeSessionId` DAO; extend `Conversation` interface; `listConversationSummaries` projects column |
| `app/src/main/core/assistant/cli-envelope.ts` | Tighten `CliSystemEnvelope`; add `isSystemInitEnvelope` guard |
| `app/src/main/core/assistant/runClaudeCliTurn.trajectory.ts` | Capture branch + `state.resumeLikelyFailed` flag |
| `app/src/main/core/assistant/runClaudeCliTurn.ts` | `buildCliArgs` resume arg; retry-once loop; `TurnLoopState.capturedSessionId`; sentinel write |
| `app/src/main/core/assistant/runClaudeCliTurn.emit.ts` | `persistFinal` clears sentinel |
| `app/src/main/core/assistant/conversations-controller.ts` | New `resumeHint` handler; extend list/get projections |
| `app/src/main/rpc-router.ts` | Register `resumeHint` |
| `app/src/shared/router-shape.ts` | Additive types — `resumeHint`, `claudeSessionId` on list items |
| `app/src/renderer/features/bridge-agent/BridgeRoom.tsx` | Right-rail dropdown, hint banner, interrupt banner |
| `app/src/renderer/features/bridge-agent/ConversationsPanel.tsx` | Resumable pill |

## Reuse callouts — DO NOT reinvent

- `isClaudeSessionId` UUID guard from `app/src/main/core/pty/claude-resume-bridge.ts` (v1.3.2)
- `claudeSlugForCwd` from same file — used by `resumeHint` to check JSONL existence
- `agent_sessions` table — DON'T touch; Sigma's session model lives on `conversations`
- `swarms/mailbox.ts` — leave alone (mailbox back-channel deferred to v1.4.1)
- Radix `DropdownMenu` from `@radix-ui/react-dropdown-menu` already in bundle
- Migration scaffold from `0011_agent_session_external_id.ts` / `0012_agent_session_pane_index.ts`
- `sonner` for toast notifications (already used by BridgeRoom)

## Test plan

| File | New tests |
|---|---|
| `src/main/core/db/__tests__/migrations.test.ts` (extend) | `0013` adds column idempotently; double-run is a no-op |
| `src/main/core/assistant/conversations.test.ts` (new or extend) | `setClaudeSessionId` round-trip; null persist clears; `getConversation` returns the field |
| `src/main/core/assistant/cli-envelope.test.ts` (new or extend) | `isSystemInitEnvelope` true on full envelope; false on missing `subtype`/`session_id` |
| `src/main/core/assistant/runClaudeCliTurn.test.ts` (extend) | Captures session_id on system.init; `buildCliArgs` includes `--resume` when prior id exists; invalid UUID is NOT passed; resume-failure fall-through retries once and nulls the column |
| `src/main/core/assistant/runClaudeCliTurn.emit.test.ts` (extend) | `appendAssistantMessage` writes sentinel; `persistFinal` clears it |
| `src/main/core/assistant/runClaudeCliTurn.resume.integration.test.ts` (new) | FakeChild harness: turn 1 captures id, turn 2 spawn argv includes `--resume <captured-id>` |

Expected delta: ~12 new test cases, taking 323 → ~335 baseline.

## Verification gate

```bash
cd /Users/aisigma/projects/SigmaLink/app
npm run lint                                                      # clean
npx tsc -b --noEmit                                               # clean
npx vitest run src/main/core/assistant src/main/core/db           # focused
npx vitest run                                                    # full suite ~335 expected
npm run build                                                     # vite + tsc
npm run electron:compile                                          # main bundle
npm run product:check                                             # gate
```

### Manual smoke (electron:dev)

1. **Fresh conversation:** Open Sigma orb, type "my name is Alex". Turn 2: "what's my name?" → must answer "Alex" (proves multi-turn context works).
2. **Restart mid-conversation:** Quit SigmaLink between turns 1 and 2. Re-open. Conversation hydrates with "Resuming chat from <relative-time>" banner. Turn 2 sends with `--resume` and gets context.
3. **Stale session ID:** Manually `rm ~/.claude/projects/<slug>/<id>.jsonl` between turns. Trigger turn 2. Verify retry-once-without-resume fires and turn produces a fresh result (no blank orb, no infinite loop).
4. **Right-rail dropdown:** Open Sigma in compact-rail mode. Click dropdown. Pick an older conversation. Verify hydrate. Verify Resumable pill on rows with prior `claudeSessionId`.
5. **Interrupted turn:** Click Cancel mid-stream. Reopen the conversation. Verify "Interrupted turn" banner with Dismiss / Retry. Retry re-sends the previous user message.

## Risk register

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Claude CLI version variance — `session_id` field may move in a future release. | `isSystemInitEnvelope` is defensive; if the field disappears, capture is silently skipped, resume falls through to fresh turns. No regression. |
| R2 | `--resume <id>` semantics differ between Claude CLI versions. | Retry-once-without-resume loop is the safety net. Worst case: turn is fresh (no context), not blank/broken. |
| R3 | Race: two `send()` calls fire before the first turn's `system.init` lands. | `getClaudeSessionId` reads at `send()` start; the column is null until first turn finishes. Second send opens fresh session; whichever id arrives last wins. No data loss. |
| R4 | Schema migration on heavily-populated production DB. | `ALTER TABLE … ADD COLUMN` is O(1) on SQLite for NULLable columns. Single transaction with rollback. |
| R5 | Sentinel `toolCallId` collides with legitimate values. | Real `toolCallId`s are ULIDs/UUIDs; the sentinel prefix `sigma-in-flight:` cannot collide. |
| R6 | Right-rail dropdown adds UI complexity inside narrow rail. | Use portal-based popover (Radix already does this) so dropdown escapes the rail clip rect. |
| R7 | Stale-resume detection heuristic relies on stderr substring match — may break with a Claude wording change. | Document the regex; add a unit test that pins the current behavior. If wording changes, the test fails loudly and we update one line. |

## Effort

| Phase | Estimate |
|---|---|
| Phase 1 — migration + schema | 0.5 d |
| Phase 2 — capture | 0.5 d |
| Phase 3 — resume + retry-once fallback | 1.5 d |
| Phase 4 — UI (dropdown + hint banner + resumeHint RPC) | 0.75 d |
| Phase 5 — in-flight sentinel | 0.5 d |
| Verification + manual smoke (5 scenarios) | 0.5 d |
| Buffer + lint/typecheck cleanup | 0.25 d |
| **Total** | **~4.5 d** |

## Version bump

1.3.x → **1.4.0** (minor — new user-visible feature with backwards-compatible additive types).

Coordination note (Codex, 2026-05-16): v1.3.5 is already in development on a separate lane. Do not hard-code assumptions about that branch's final package version or docs shape while implementing W-2. Rebase before PR, resolve any release-note/changelog ordering then, and keep W-2 source changes scoped to the Sigma Assistant files listed above.

CHANGELOG header: `## [1.4.0] - 2026-05-XX`
Themes for release notes:
- "Sigma remembers" — multi-turn context within a conversation
- "Sigma persists" — conversations resume across app restart
- "Sigma recovers" — interrupted turns surfaced on reopen

## Out of scope (v1.4.1 candidates)

- **Pane → Sigma mailbox back-channel.** Requires new `sigma_pane_events` table (avoid overloading `swarm_messages`). Hook into `PtyRegistry` session-exit emitter. New `monitor_pane(sessionId, sigma_conv_id)` tool. ~2-3 days.
- **Per-Sigma-conversation worktree.** Today Sigma always spawns Claude in the workspace's `rootPath` cwd; if the orchestrator should run inside its own per-conversation worktree (for isolation), that needs a new bridge invocation. Defer.
- **Sigma session export / import.** Cross-machine sync of Sigma conversation history. Defer — same scope as v1.3's "Cross-machine session sync" wishlist.

## Hand-off note

This plan is being implemented by a separate agent dispatch path (not in the W-3 execution lane). The W-3 worktree at `/Users/aisigma/projects/SigmaLink-feat-w3-ruflo-mcp-autobind` shares zero source files with this plan — no merge conflicts expected when both ship.

## Codex execution split (added 2026-05-16)

Use one shared worktree: `/Users/aisigma/projects/SigmaLink-v140-sigma-assistant-orchestrator`. Each worker must commit only its owned files after finishing its slice.

1. **Backend data/RPC worker** owns migrations, schema, conversation DAO/controller, router shape/channels, and backend tests.
2. **Runtime worker** owns `runClaudeCliTurn*`, `cli-envelope`, assistant resume/retry/sentinel behavior, and runtime tests.
3. **Frontend worker** owns `BridgeRoom.tsx`, `ConversationsPanel.tsx`, bridge-agent UI tests, and only additive UI types needed for resumable/interrupted state.
4. Orchestrator owns plan/doc/release notes, conflict integration, final verification, Ruflo memory storage, push, and PR.
