# Jorvis P3 — Channels Implementation Plan (Phase 22)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator runs multi-project missions entirely from Telegram (commands in, proactive reports out), and external Hermes/OpenClaw agents submit natural-language orders through a mission plane that absorbs SigmaControl — with every dangerous autonomous action escalating to the operator's phone instead of failing silently.

**Architecture:** Five thin adapters over the shipped P1/P2 mission+memory core: (1) a real proactive-push primitive on the Telegram bridge (durable operator chat-id, scrub-pipeline reuse); (2) Telegram v2 command routing; (3) origin threading + mission-event pushes riding the existing watcher/tool-trace sinks; (4) `submit_task`/`check_task`/`get_report` on the control MCP (the two-plane refinement authz-external.ts:51-54 promised); (5) the built-but-unwired escalation seams (ExternalEscalator telegramConfirm + autonomous confirmDangerous) finally wired. Plus a daily-brief scheduler on the existing DailyScheduler pattern.

**Tech Stack:** TypeScript (erasableSyntaxOnly), vitest (fake TelegramClient `_handlers` pattern from bridge.test.ts), zod tool schemas, no new tables (KV only).

## Global Constraints

- Branch: `feat/jorvis-p3-channels`, based on the P2 branch tip (stacked; rebase when the stack merges).
- NEVER print/log the bot token or bearer token (CredentialStore keys `remote.telegram.botToken`, `control.mcp.bearerToken`).
- Every outbound Telegram byte goes through `safety.scrubOutbound` + `chunkText` + audit — no raw `client.sendMessage` outside the bridge's own send helpers.
- Tool changes ride the parity trio + authz-external (same as P2); RPC changes (if any) ride all 4 mirror sites.
- New KV keys seeded by migration 0042 (INSERT OR IGNORE, mirror 0040): `remote.telegram.operatorChatId=''`, `jorvis.brief.enabled='0'`, `jorvis.brief.time='09:00'`.
- Keep files ≤~500 lines. NEVER push/tag/merge.

## Design decisions (locked)

- **D1 Proactive push = durable operator chat-id.** KV `remote.telegram.operatorChatId`, auto-captured on every allowlisted inbound message (last-writer-wins; an allowlisted `/subscribe` sets it explicitly, `/unsubscribe` clears). `TelegramBridge.pushToOperator(text)`: no-op (audited `drop`) when bridge stopped or chat-id unset/not-allowlisted; else scrub→chunk→send + audit kind `push`. Kills the incidental-`activeChatId` hole.
- **D2 submit_task is free for external clients; safety lives in the gates, not the door.** The mission plane is the sanctioned external entry (two-plane, ADR-011): `submit_task` (free) creates a mission `origin:'external'` + `clientLabel` from the hello handshake and enqueues a decompose wake — which the autonomy gates (default-OFF flag, budget, quiet hours, kill-switch) and the DANGEROUS-escalation layer then govern. `check_task`/`get_report` are free reads. The raw board tools (`create_mission` etc.) KEEP their escalate classification for external origin — the plane is the door, not the board.
- **D3 With autonomy disabled, submit_task still works but honestly:** the mission row is created and the decompose wake is dropped by the `disabled` gate; `check_task` shows the mission sitting in `active` with zero tasks. Document in the tool description ("runs only while the operator has autonomy enabled").
- **D4 Escalations go phone-first:** wire `telegramConfirm` (+`audit`) into the existing `new ExternalEscalator(...)` site, and give autonomous wakes a real `confirmDangerous` that rides the same bridge confirm (timeout → deny, fail-closed unchanged). The renderer prompt stays as fallback when the bridge is down.
- **D5 origin threading is additive:** `create_mission`'s handler gains the turn's real `ToolOrigin` (+clientLabel when external) via ToolContext — no DAO signature break (both fields already exist in the schema/DAO).
- **D6 Pushes are event-driven + throttled by design:** mission `done`/`failed` (with report tail), task `blocked`/`task_max_attempts`, amendment proposals, escalation requests, daily brief. No per-task chatter.

---

### Task 1: Migration 0042 + push primitive (`pushToOperator` + operator chat-id capture)

**Files:**
- Create: `src/main/core/db/migrations/0042_jorvis_channels_kv.ts` + test (clone 0040/0041 idiom; seeds per Global Constraints)
- Modify: `src/main/core/db/migrate.ts` (register)
- Modify: `src/main/core/remote/bridge.ts` + `bridge.test.ts`

**Contracts:**
- `KV_TELEGRAM_OPERATOR_CHAT = 'remote.telegram.operatorChatId'` exported from bridge.ts beside the existing KV consts.
- In `handleMessage`, after the allowlist check passes: `kv.set(KV_TELEGRAM_OPERATOR_CHAT, String(chatId))` (before command routing — capture rides every allowlisted contact).
- `pushToOperator(text: string): Promise<boolean>` public method: bridge not running → audit `{kind:'drop', reason:'push-bridge-stopped'}` → false; chat-id unset or not in allowlist → audit drop → false; else scrub→chunk→send with the same escapeHtml/parseMode pipeline `flushRelay` uses (extract a shared private `sendScrubbed(chatId, text)` so relay + push share one choke point) + audit `{kind:'push'}` → true.
- Commands `/subscribe` (reply "reports will land here" + set KV) and `/unsubscribe` (clear KV + reply) added to the command block (allowlist-gated like the rest).
- Tests: capture-on-inbound; push happy path (fake client `_sent` shows scrubbed/chunked text); push with stopped bridge → false + audited; push with allowlist-revoked chat-id → false; subscribe/unsubscribe round-trip.
- Commit: `feat(jorvis): telegram push primitive — durable operator chat + pushToOperator (P3 T1)`

### Task 2: Telegram v2 commands

**Files:** `src/main/core/remote/bridge.ts` + `bridge.test.ts` (+ a small `src/main/core/remote/board-format.ts` + test for the pure text formatting)

**Contracts:**
- `/mission <goal>` → `missionsDao.createMission({title: first 60 chars, goal, origin:'telegram'})` + `setMissionStatus(id,'active')` + `missionScheduler?.enqueue('decompose', id)` (bridge gains optional `missions` deps injected from rpc-router: `{createAndStart(goal): string, enqueueDecompose(id): void}` — keep the bridge decoupled from the DAO via these two thin closures) → reply mission id + "decompose queued" (or "autonomy disabled — mission parked" when the enabled KV is '0').
- `/status` → board-format summary: per active mission title + task-status counts; `/tasks <missionId?>` → per-task lines (title · status · attempt). Pure formatting in board-format.ts (unit-tested; reads via an injected `boardRead()` closure).
- `/approve <id>` / `/deny <id>` → try amendments first (`decideAmendment(id, true/false)`), fall back to the pending-escalations store resolve (inject both as closures); reply the outcome. Unknown id → "nothing pending with that id".
- `/panes` → injected `listPanes()` closure (provider · workspace · status one-liners); `/workspaces` → injected `listWorkspaces()`.
- All commands allowlist-gated exactly like `/lock`; every reply goes through the scrubbed send choke point.
- Tests per command via the `_handlers.onMessage` fake pattern; assert injected closures called + reply text; assert a non-allowlisted sender gets silence.
- Commit: `feat(jorvis): telegram v2 cockpit — /mission /status /tasks /approve /deny /panes /workspaces (P3 T2)`

### Task 3: Origin threading + mission-event pushes

**Files:** `src/main/core/assistant/tools.ts` (create_mission handler + ToolContext), `src/main/rpc-router.ts` (wire origin into ToolContext + the push hooks), `src/main/core/operator/watch.ts` or the rpc-router sinks (blocked/max-attempts push), tests beside each.

**Contracts:**
- ToolContext gains optional `origin?: ToolOrigin` + `clientLabel?: string | null`; the two invoke paths (`dispatchTool` stdout + `invokeToolForConversation` socket) populate them from the live turn. `create_mission` writes `origin: ctx.origin ?? 'local'`, `clientLabel: ctx.clientLabel ?? null`.
- Push hooks in rpc-router (beside the existing create_mission/complete_mission trace hooks): `complete_mission` trace → `bridge?.pushToOperator('✅ mission done: <title>\n<report first 500 chars>')`; a `task_max_attempts`/`blocked` transition (watch the `missions:changed`-adjacent DAO events via a tool-trace on move_mission_task(status blocked) + the supervisor's max-attempts path → simplest: rpc-router subscribes a tiny `onMissionEvent` callback injected into missionsDao.appendEvent? NO — keep it deterministic: the supervisor/watcher paths already run in-process; add an optional `notify?: (kind: string, missionId: string, taskId?: string) => void` dep to createSupervisor (max-attempts + blocked verdicts) wired to pushToOperator in rpc-router). Amendment proposal trace (`propose_amendment`) → push "🔏 amendment proposed: <text first 200> — /approve <id>".
- All pushes fail-soft (bridge null/stopped → nothing throws into the wake path). Tests: fake bridge closure records pushes; supervisor max-attempts test asserts notify called; trace-hook tests mirror the existing decompose-hook test style.
- Commit: `feat(jorvis): origin threading + proactive mission pushes (P3 T3)`

### Task 4: External mission plane — submit_task / check_task / get_report

**Files:** parity trio + authz-external + their tests; `src/main/core/control/control-mcp-host.ts` only if the label plumb needs it (clientLabel already arrives in the hello — check how it's stored per-connection).

**Contracts:**
- `submit_task({order: z.string().min(1), title?: z.string(), workspaceId?: z.string()})` → creates mission (title = provided or first 60 chars of order, goal = order, origin from ctx — 'external' via the socket path, clientLabel from ctx) + `setMissionStatus('active')` + enqueue decompose via the same scheduler closure create_mission's trace hook uses (give ToolContext an optional `enqueueMissionWake?` closure so the tool works identically from ANY origin) → `{missionId, autonomyEnabled: boolean}`.
- `check_task({missionId})` → `{mission, tasks, recentEvents(20)}` (mission_board-shaped read). `get_report({missionId})` → `{status, report}` (report null until done).
- authz-external: all three FREE with the D2 rationale comment. NOT in DANGEROUS_REMOTE.
- Tests: tool handlers + classification (`classifyExternal('submit_task') === 'free'`) + catalogue parity + a socket-path test mirroring the existing mcp-origin test proving origin 'external' + clientLabel land on the mission row.
- Commit: `feat(jorvis): external mission plane — submit_task/check_task/get_report absorb SigmaControl (P3 T4)`

### Task 5: Escalation wiring — phone-first confirms

**Files:** `src/main/rpc-router.ts` (the `new ExternalEscalator(...)` site + the supervisor runTurn deps), `src/main/core/remote/bridge.ts` (+test) if the confirm helper needs exposing, `src/main/core/operator/supervisor.ts` (+test) pass-through, controller autonomous-origin test extension.

**Contracts:**
- Bridge exposes `confirmViaTelegram(summary: string, timeoutMs: number): Promise<boolean>` — sends the summary + inline approve/deny buttons to the operator chat (reuse the existing callback plumbing bridge.ts already has for confirms — READ IT FIRST; if a confirm flow already exists for telegram DANGEROUS_REMOTE, reuse it verbatim), resolves false on timeout/stop. If no operator chat-id → immediate false.
- ExternalEscalator site gains `telegramConfirm: (s) => bridge?.confirmViaTelegram(s, 60_000) ?? Promise.resolve(false)` + the `audit` dep it already supports.
- Supervisor's runTurn call site (rpc-router) passes `confirmDangerous: (summary) => bridge?.confirmViaTelegram(summary, 120_000) ?? Promise.resolve(false)` into `assistantCtl.send` for autonomous wakes — closing recon gap 1 (autonomous DANGEROUS_REMOTE currently denies silently). Fail-closed semantics unchanged: no bridge / timeout / deny → tool denied.
- Tests: escalator prefers telegram then renderer; autonomous send now carries confirmDangerous (controller test: DANGEROUS_REMOTE tool + confirm resolves true → allowed; resolves false → denied); bridge confirm timeout → false.
- Commit: `feat(jorvis): phone-first escalations — telegram confirm for external + autonomous dangerous ops (P3 T5)`

### Task 6: Daily brief

**Files:** `src/main/core/operator/brief.ts` + test (pure digest builder over missionsDao + memory), `src/main/rpc-router.ts` (DailyScheduler arm/re-arm on the two KV keys, mirroring the notifications daily-summary wiring), bridge push reuse.

**Contracts:**
- `buildDailyBrief(): string` — active missions + statuses, yesterday's done/blocked counts (mission_events since-24h), budget spent (`wakesSpentToday`), pending amendments count. Pure, injected reads, capped length.
- rpc-router arms a `DailyScheduler` when `jorvis.brief.enabled==='1'` at `jorvis.brief.time`, firing `pushToOperator(buildDailyBrief())`; re-arm on KV change exactly like KV_DAILY_SUMMARY_TIME (~rpc-router:2564-2574).
- Tests: digest content from a seeded board; scheduler arm/re-arm mirrors the existing daily-summary tests.
- Commit: `feat(jorvis): daily brief — scheduled board digest to the operator's phone (P3 T6)`

---

## Branch-final gate (LEAD)
Full local gate in main tree → opus whole-branch review (unattended-agent bar on push/confirm surfaces: scrub coverage, allowlist bypasses, confirm spoofing, push loops) → PR → sigma-check.

## Exit criteria (ROADMAP Phase 22)
- A multi-project mission run entirely from Telegram: `/mission` → decompose → dispatch → `/status` → blocked escalation lands on the phone → `/approve` → done report pushed.
- An external MCP client (subagent-as-client smoke) submits an order via `submit_task`, polls `check_task`, receives `get_report`.
- Perception tools verified still model-free; kill-switch freezes wakes + pushes; full local gate + CI green.
