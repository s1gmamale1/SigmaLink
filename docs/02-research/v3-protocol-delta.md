# V3 Protocol Delta — mailbox verbs / RPC channels / agent-driving signals

What V3 adds on top of SigmaLink's `SIGMA::SAY/ACK/STATUS/DONE/OPERATOR/ROLLCALL/
ROLLCALL_REPLY` line-prefix protocol (Wave 6a; PRODUCT_SPEC §5.4). Sources:
`v3-frame-by-frame.md` Chapter B (0250-0325); A:L31-35 / L57; C:C-1, C-2.

## 1. New mailbox envelope kinds

Add to `MailboxEnvelope.kind` in `src/main/core/swarms/types.ts`. Per-kind `payload`:

| Kind | `payload` | Source |
|---|---|---|
| `escalation` (promote to first-class counter) | `{ taskId, blockedOn, attempts, askingOf }` | 0295 `ESCALATIONS` |
| `review_request` | `{ taskId, branch, files, summary }` | 0295 `REVIEW 9` |
| `quiet_tick` (idle > N s) | `{ since, lastActivityKind }` | 0295 `QUIET` |
| `error_report` (crash / non-zero / build fail) | `{ kind: 'spawn'\|'runtime'\|'validate', message, stderrTail? }` | 0295 `ERRORS` |
| `task_brief` (coordinator → worker) | `{ taskId, urgency, headings: { title, bullets, links }[] }` | 0265 |
| `board_post` (agent → its board namespace) | `{ boardId, title, bodyMd, attachments? }` | 0280; L247 |
| `bridge_dispatch` (Bridge → pane; see §3) | see §3 | 0150 |
| `design_dispatch` (Design Mode → agent; §4) | see §4 | 0380 |
| `skill_toggle` (Swarm Skills → coord prompt) | `{ skillKey, on, group: 'workflow'\|'quality'\|'ops'\|'analysis' }` | 0220 |

`operator_dm` is not a new kind — `directive` with a new `echo: 'pane'` flag (0325). When
set, target agent's PTY echoes `[Operator → Role N] <text>` via stdin.

**Counter rule.** The four console badges = `count(envelopes WHERE kind ∈ {…} AND resolvedAt
IS NULL)`. Add `resolvedAt INTEGER NULL` to `swarm_messages`.

## 2. Addressing primitives

| Primitive | Today | V3 | Source |
|---|---|---|---|
| Recipient `to` | id or `'*'` | adds `'@all'`, `'@coordinators'`, `'@builders'`, `'@scouts'`, `'@reviewers'` | 0250, 0295 |
| Mention syntax in mission textarea | n/a | `@<workspaceSlug>` resolves at submit time | 0210, 0235 |
| Per-agent **board** namespace | n/a | `<userData>/swarms/<id>/boards/<agentId>/<postId>.md`; new `boards` table | 0280 |
| Operator → pane echo | mailbox only | `directive.echo='pane'` writes to PTY stdin | 0325 |

## 3. Bridge assistant RPC (NEW namespace `assistant.*`)

Distinct from the swarm mailbox: a Bridge dispatch lands in the target pane's PTY stdin (or
as `agent_sessions.pendingPrompt`), not in `swarm_messages`. Audit via
`assistant:tool-trace` → `messages.toolCallId`. Sources 0080, 0090, 0150, 0160; L86-96,
L147-158.

`assistant:listen { workspaceId } → { conversationId }`,
`assistant:state` (event) `{ orb: 'standby'|'listening'|'receiving'|'thinking' }`,
`assistant:dispatch-pane { workspaceId, targetSessionId, prompt, attachments? }`,
`assistant:dispatch-bulk { workspaceId, spec: { provider, count, initialPrompt? }[] }`,
`assistant:ref-resolve { workspaceId, atRef } → { absPath, snippet }`,
`assistant:turn-cancel { conversationId, turnId }`,
`assistant:tool-trace` (event, tool-call stream).

## 4. Design-Mode RPC (NEW namespace `design.*`; sources 0368, 0380, 0398, 0405)

`design:start-pick { tabId } → { pickerToken }`,
`design:pick-result` (event) `{ pickerToken, selector, outerHTML, computedStyles, screenshotPng }`,
`design:dispatch { pickerToken, prompt, providers, modifiers: { shift?, alt? }, attachments? }`,
`design:attach-file { pickerToken, path } → { stagingPath }`,
`design:patch-applied` (event) `{ tabId, file, range }` (HMR poke).
Staging dir `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`.

## 5. Operator Console RPC additions (sources 0250, 0265, 0295)

`swarm:console-tab { swarmId, tab: 'terminals'|'chat'|'activity' }`,
`swarm:stop-all { swarmId, reason } → { stopped }`,
`swarm:counters` (event) `{ escalations, review, quiet, errors }`,
`swarm:constellation-layout { swarmId, nodePositions }`,
`swarm:agent-filter { swarmId, filter: 'all'|'coordinators'|'builders'|'scouts'|'reviewers' }`,
`swarm:ledger` (event) `{ agentsTotal, messagesTotal, elapsedMs }`,
`swarm:mission-rename { swarmId, mission }`.

## 6. SigmaVoice signal

Voice capture anywhere in the app shows a centred title-bar **`SigmaVoice`** pill (0220).
Global event `voice:state` `{ active, source: 'mission'\|'assistant'\|'palette' }`. One OS
speech adapter; no second capture session.

## 7. Compat + 8. Wave routing

PTY-side `SIGMA::*` wire format unchanged. New envelope kinds ride the existing JSONL +
`swarm_messages` mirror. `assistant.*` / `design.*` / `voice:state` / new `swarm:*` go in
fresh allowlist groups in `src/shared/rpc-channels.ts`. New tables `boards`, `swarm_skills`;
existing tables untouched except for `swarm_messages.resolvedAt INTEGER NULL`.

**W12** envelope kinds + zod, `resolvedAt` migration + counter projector, Operator Console
RPCs (`stop-all`/`counters`/`constellation-layout`/`ledger`). **W13** `assistant.*` + tool
tracer, board namespace + `boards` table. **W14** `design.*` + drag-drop staging.
**W15** `voice:state` + SigmaVoice pill.
