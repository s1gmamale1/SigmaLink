# Jorvis Persistent Operator — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm) → writing plan
**Author:** Sigma + Claude (Fable 5)
**Grounding:** 2026-07-07 five-lane Jorvis full-subsystem recon (map in Ruflo `patterns/verdict:jorvis-full-map-2026-07-07`; findings in `WISHLIST.md` §"Deep review findings (2026-07-07)").

---

## 0. One-paragraph summary

Evolve Jorvis from an ephemeral, per-turn `claude -p` chat assistant into a **persistent, cross-project
devops-operator agent** that sees and controls multiple sessions across SigmaLink, runs missions on a
kanban board with an autonomous review loop, remembers across sessions, adopts the operator's Sigma-Profile
charter, is fully drivable and reporting-capable over Telegram, and **absorbs SigmaControl** so external
Hermes/OpenClaw agents can hand him natural-language orders that he executes inside SigmaLink and reports
back on. Built as two new bounded-context modules beside the existing (unchanged-role) assistant turn
engine, shipped in four independently-valuable phases: **P0 reliability → P1 mission core → P2 persistent
identity → P3 channels.**

---

## 1. Motivation & current-state truth

**Why now:** the operator's verdict — *"Jorvis itself was never actually developed to its full potential…
nobody is using it, since it's inconsistent, after update it breaks, cli exit errors, tool calling errors,
no ability to spawn a fresh session."* The assistant subsystem is architecturally rich (39 tools, 3-gate
auth, two-hop MCP host, multi-window routing) but operationally untrusted, so its capability is dark.

**Current-state facts (from recon, all `app/src/…`):**
- A turn = a `claude` CLI child: `claude -p <prompt> --output-format stream-json --verbose
  --append-system-prompt <sys> [--resume <sessionId>] [--mcp-config … --strict-mcp-config]`
  (`main/core/assistant/runClaudeCliTurn.args.ts:53-68`). `send()` fires an unawaited async IIFE and
  returns immediately (`controller.ts:422`).
- **No concurrent-turn cap** (`controller.ts:178`) — the only guard is the renderer `busy` flag (per-window).
- 39 in-process tools, single source of truth `tool-catalogue.ts` (contract-tested vs `tools.ts`),
  executed via a two-hop MCP bridge (bundled `mcp-jorvis-host-server.cjs` → unix socket → `McpHostSigma`).
- One shared effect layer `invokeAssistantTool` with three origins: `local` / `telegram` / `external`;
  auth is three additive inline gates (`controller.ts:219-420`): Telegram `DANGEROUS_REMOTE` confirm,
  external `classifyExternal` free/escalate/deny + kill-switch, advisory aidefence.
- System prompt is minimal + static (workspace name + root only; live state via `list_*`/`get_app_state`)
  built by `buildJorvisSystemPrompt` (`system-prompt.ts:147-161`).
- Persistence: `conversations` (+ nullable `claude_session_id` for resume) / `messages` /
  `jorvis_pane_events` / `usage_ledger`.
- SigmaControl is a **separate standalone bridge** (`github:s1gmamale1/Sigma-Control`) talking to the
  external control MCP; the "Hermes runtime/supervisor" was designed then **dropped** — SigmaLink hosts no
  agent brain, external agents are just MCP clients (per the operator's Unity/Blender-MCP framing).

**Sigma-Profile exists and already renders a Hermes target** (`/Users/aisigma/projects/Sigma-Profile`,
`dist/hermes/system-prompt.md`) from one canonical charter in `core/modules/`. We add a `jorvis` target.

---

## 2. Goals / Non-goals

**Goals**
1. Jorvis is **reliable** — usable day-to-day; failures are visible and recoverable; survives CLI updates.
2. Jorvis is **persistent & cross-project** — a global (workspace-less) operator identity that remembers
   across sessions and can act over any workspace.
3. Jorvis runs **autonomous missions** on a kanban board with a self-driving review loop (human commands
   the fleet; Jorvis runs the lanes to completion or a blocker).
4. Jorvis **learns** — durable DB memory + self-written playbooks + postmortems; identity fixed (charter),
   competence grows; self-amendments only behind operator approval.
5. Jorvis is **fully drivable + reporting** over Telegram (command channel AND proactive report channel).
6. Jorvis **absorbs SigmaControl** — external agents submit natural-language missions (two-plane: raw
   deterministic perception stays free/model-less; judgment work goes through the brain).

**Non-goals (this cycle)**
- No always-on hot model process; no PTY-as-API long-lived interactive session (rejected in brainstorm).
- No standalone external Hermes daemon runtime (the dropped supervisor stays dropped).
- No full self-modification (charter is fixed; only approved append-amendments).
- Not rewriting the turn engine, the tool catalogue, or the two-hop MCP host — those are reused as-is.

---

## 3. Runtime model (the core decision)

**Event-driven brain with cross-context memory** (brainstorm: option 1 hybridized to solve
cross-session/cross-project continuity).

- A **deterministic nervous system** (`core/operator/`) is always on, model-free: it subscribes to the
  existing pane-event + notification sinks, judges significance for free, and enqueues **brain wakes**.
- A **brain wake** is just an `assistant.send` turn on a **long-lived global operator conversation**
  (resumed via the existing `--resume` path), with context assembled at wake time (mission board slice +
  top-K memories + portfolio). The model burns tokens **only** on a wake.
- **Cross-context continuity** — the thing option 1 lacked alone — comes from **durable memory + the
  mission board being the shared state**, not from a hot process. Context windows are disposable; the DB
  is the operator's continuous mind. Telegram control naturally spans projects because the operator
  conversation is **global (workspace-less)** and the portfolio is injected.
- One **global brain lock**: wakes serialize (also closes the no-turn-cap gap for the operator conversation).

**Wake policy** (KV-tunable, hard-capped): the model wakes on (a) active-mission pane events (a lane
Jorvis dispatched finishes / errors / idles), (b) agent-attention signals, (c) explicit pings (in-app,
Telegram, external mission), (d) scheduled check-ins (e.g. a morning brief). Ambient noise never wakes
him. Per-day wake budget + quiet hours are hard limits.

---

## 4. Architecture

Two new sibling bounded contexts beside the unchanged-role assistant engine:

```
core/assistant/   existing turn engine + 39 tools + 3-gate auth  (drives the model; role unchanged)
core/missions/    NEW — kanban: missions/tasks/events tables + a pure state machine (zero model calls)
core/operator/    NEW — watchers, wake scheduler (budget/quiet-hours), memory store, charter loader,
                        amendment-proposal queue, portfolio/context assembler
```

- `core/missions/` and `core/operator/` drive the model **only** through `assistant.send` / the existing
  tool layer. No new model-spawning path is introduced.
- Telegram (`core/remote/`) and the external control MCP (`core/control/`) get **thin adapters** onto the
  mission plane; the raw perception tools stay as-is.
- File discipline: each new module split into focused ≤~500-line units (state machine, DAO, scheduler,
  memory DAO, context assembler, charter loader — all separately testable).

---

## 5. Phase P0 — Reliability foundation (ships first, standalone value)

Make Jorvis trustworthy before adding persistence. No mission/memory work here.

**P0.1 Concurrent-turn guard (main-side).** Reject a second `send` for a conversation with a live turn
(defined `busy` result, no second `claude` child); queueing is a later nicety if ever wanted. Closes `controller.ts:178` gap. Tests: two rapid sends →
one child, second gets a defined `busy` result.

**P0.2 Errors are always visible + recoverable.** Every failure path (spawn fail, CLI nonzero exit, tool
timeout, resume failure exhausted) writes a real error message row (with stderr tail) to the transcript
and surfaces a retry affordance. No silent turn death. (Renderer already has an interrupted-turn banner —
extend it to cover CLI-exit/spawn-fail, not just unresolved tool calls.)

**P0.3 Update-proofing.** (a) `parseCliLine`/envelope handling tolerant of unknown `system`/`result`
subtypes (log + continue, never crash the turn). (b) Recorded-fixture contract tests for the stream-json
envelope shape. (c) Boot probe captures `claude --version` into diagnostics + surfaces it, so "broke after
update" is a visible version delta, not a mystery.

**P0.4 Fresh-session control.** In-app "New session" action + Telegram `/new`: clears `claudeSessionId`
(retains transcript history), forcing a clean CLI context on the next turn.

**P0.5 Ride-along wishlist fixes** (grounded 2026-07-07): wire-or-delete orphan `assistant:security`;
add `resumeHint` schema stub; route `refResolve` through `path-guard`; fix stale "13 tools" +
`DANGEROUS_REMOTE` test-title comments; archive/kill the stale `docs/03-plan/WISHLIST.md` twin.

**Exit criteria:** operator can run Jorvis turns repeatedly across a CLI update without a mystery failure;
every failure is legible; a fresh session is one action away.

---

## 6. Phase P1 — Mission core (kanban + autonomous supervisor loop)

**P1.1 Schema** (`core/missions/`, new migrations, forward-only):
- `missions` — `id` · `title` · `goal` · `origin('local'|'telegram'|'external'|'autonomous')` ·
  `client_label` (nullable, external) · `workspace_id` (**nullable = global**) · `status('draft'|'active'|
  'paused'|'done'|'failed'|'cancelled')` · `report` (nullable) · `created_at`/`updated_at`.
- `mission_tasks` — `id` · `mission_id`→missions ON DELETE CASCADE · `title` · `spec` (the dispatch prompt)
  · `status('backlog'|'dispatched'|'working'|'reviewing'|'needs_input'|'done'|'blocked')` ·
  `assignee_session_id` (nullable pane) · `worktree_path` (nullable) · `attempt` (int) · `order_idx` ·
  timestamps. Indexes: `(mission_id, status)`, `(assignee_session_id)` (the wake hot-path).
- `mission_events` — append-only `id` · `mission_id` · `task_id?` · `kind` · `body`(JSON) · `ts`
  (audit + the UI feed).

**P1.2 State machine** (`core/missions/state.ts`, pure, no I/O): legal transitions only, guards, and the
derived rollups (mission status from task statuses). Fully unit-tested.

**P1.3 Mission tools** (added to `tool-catalogue.ts` + `tools.ts`, catalogue-parity extended):
`mission_board` (read board slice), `dispatch_task`, `complete_task`, `block_task`, `update_task`. All
traced; the brain never mutates the board except through these.

**P1.4 Supervisor loop** (`core/operator/supervisor.ts`):
1. **decompose wake** — mission created → brain splits into `mission_tasks`, dispatches first wave via
   `launch_pane` (**worktree isolation**, task `spec` as prompt), links task↔pane.
2. **deterministic watch** — a linked pane finishing/idling/erroring on ANY workspace (existing
   pane-event/notification sink) marks the task `reviewing` and enqueues a wake. Zero tokens.
3. **review wake** — brain reads task `spec` + receipts (`read_pane`, diff via a pane command) → verdict:
   **advance** (re-prompt the same pane), **done** (→ dispatch next `order_idx` task), or **blocked**
   (mark + escalate). "Not full debug" — a bounded review, re-prompt, and escalate-on-blocker, per the
   operator's "human commanding a fleet" framing.
4. loop until mission `done`/`failed` → write `report` → push to origin.

**P1.5 Missions room** (renderer): kanban columns by task status, mission list, per-task detail (linked
pane, worktree, event timeline, report). Bridge/absorb the existing `create_task` TasksManager surface
(decide at plan time). Reuse the existing `assistant:*` event-routing + dispatch-echo plumbing.

**Exit criteria:** in-app, the operator gives a natural-language goal; Jorvis decomposes it onto the board,
dispatches worktree-isolated panes, and drives them to done/blocked **without human involvement per step**,
with the whole run legible on the board.

---

## 7. Phase P2 — Persistent identity (memory · charter · self-evolution)

**P2.1 Global scope.** The operator conversation is workspace-less (migration: allow a reserved global
conversation / nullable `workspace_id` semantics). System prompt v2 injects the **portfolio** (all
workspaces: names + roots) instead of a single workspace.

**P2.2 Charter from Sigma-Profile.** Add a `jorvis` render target to `Sigma-Profile/core/targets.json`;
SigmaLink bundles `dist/jorvis/system-prompt.md` and loads it (KV-overridable path) as the base persona,
replacing the inline `buildJorvisSystemPrompt` persona string. Identity is fixed at the source the operator
already maintains; SigmaProfile judgment/standards/voice come along.

**P2.3 Memory** (`core/operator/memory.ts` + `jorvis_memory` table): `kind('fact'|'playbook'|'preference'|
'postmortem')` · `title` · `body` · `tags` · `workspace_id?` · `confidence` · `last_used_at`, FTS-indexed.
Tools: `remember` / `recall` / `update_memory` / `forget`. **Wake-time assembly**: top-K relevant memories
under a token budget, injected per wake. Ruflo remains the optional semantic layer on top (fail-soft);
sqlite is ground truth.

**P2.4 Learning curve.** Mission/task completion (and blockers) trigger a `postmortem` memory (what worked
/ what failed / project quirk). Competence compounds across sessions — the cross-session continuity the
operator asked for, without a hot process.

**P2.5 Self-amendment behind approval.** `propose_amendment` tool → `jorvis_amendments` proposal row →
operator approves in-app or Telegram `/approve <id>` → amendment text is appended **after** the rendered
charter at wake time (never edits the charter). Denied = logged, never auto-re-proposed verbatim. Enforces
the SigmaProfile "charter fixed, judgment adapts, hook-over-prompt" philosophy.

**Exit criteria:** Jorvis recalls prior work across a full app restart; a repeated task benefits from a
prior postmortem; the charter is the Sigma-Profile render; an amendment only takes effect after approval.

---

## 8. Phase P3 — Channels (Telegram cockpit + external mission plane)

**P3.1 Telegram v2** (`core/remote/`): commands `/mission <goal>`, `/status` (board summary), `/tasks`,
`/new`, `/approve|/deny <id>` (escalations + amendments), `/panes`, `/workspaces` (+ existing
`/lock`/`/unlock`). **Proactive pushes** through the existing scrub/audit pipeline: mission done/blocked,
escalations, amendment proposals, scheduled daily brief. Jorvis's report channel, not just a command pipe.

**P3.2 External mission plane** (two-plane, as locked): add `submit_task(order, context?, workspace?)` →
`{missionId}`, `check_task(missionId)` → status + timeline, `get_report(missionId)` → final report to the
external control surface. Raw perception tools (`get_app_state`, `read_pane`, `list_*`) stay
deterministic/model-free/free. Existing Sigma-Control clients keep working; bump the standalone bridge
(`github:s1gmamale1/Sigma-Control`) protocol + tool set in lockstep (cross-repo follow-up).

**Exit criteria:** the operator runs a multi-project mission entirely from Telegram and gets pushed the
result; an external agent submits a natural-language order, polls, and receives Jorvis's report.

---

## 9. Security & gates

- **New origin `autonomous`** for brain-initiated (unattended) actions. Policy between `local` and
  `external`: DANGEROUS-class + irreversible ops (destructive git, `close_*`, `kill_swarm`, shell
  `send_keys`) **escalate** to Telegram/app rather than auto-run; safe/recoverable work is free. The
  existing kill-switch (`controlFrozen`) also **freezes wakes + dispatches** entirely.
- **Wake budget + quiet hours** (KV) are hard caps enforced in the scheduler, not prompt suggestions.
- **Hook-over-prompt**: escalation sets, path-guard, worktree isolation enforced at the tool boundary; the
  prompt carries judgment only. Charter hard-rules (no secrets in chat/git, no unsigned irreversible/paid
  action, no tag on red gate, no mock-as-shipped) restated in the persona but backed by boundaries where a
  boundary exists.
- **Audit** = `mission_events` + existing tool traces + the remote audit JSONL.
- Ride-along hardening from recon: browser DNS-rebind gap stays behind the default-OFF `browser.agentDriving`
  flag (unchanged); external `get_app_state` redaction/scoping deferred but noted for when the audience
  broadens beyond a single trusted token.

---

## 10. Testing strategy

- **P0**: envelope-fixture contract tests across CLI versions; concurrent-send guard test; error-row
  visibility tests; fresh-session clears session id.
- **P1**: state-machine unit tests (all legal/illegal transitions + rollups); supervisor-loop tests with
  DI'd fake pane events (no real CLI); a **stub-CLI e2e** — a fake `claude` binary emitting scripted
  stream-json drives a whole mission through the board (zero tokens, full loop). Catalogue-parity extended
  to mission tools.
- **P2**: memory DAO + FTS recall tests; wake-time top-K assembly under a token budget; charter-load
  fallback; amendment approve/deny gating.
- **P3**: Telegram command parsing + proactive-push scrub tests; external mission-plane submit/check/report
  contract tests; two-plane (perception stays model-free) assertion.
- Cross-cutting: wake-budget/quiet-hours hard-cap tests; `autonomous`-origin escalation tests.

---

## 11. Units (isolation map)

| Unit | Purpose | Depends on |
|---|---|---|
| `core/missions/schema` (migrations) | kanban tables | db |
| `core/missions/state.ts` | pure lifecycle state machine + rollups | — |
| `core/missions/dao.ts` | mission/task/event reads+writes | db, state |
| `core/operator/supervisor.ts` | decompose/watch/review loop | assistant.send, missions dao, watchers |
| `core/operator/scheduler.ts` | wake queue, budget, quiet hours, global lock | kv, notifications sink |
| `core/operator/memory.ts` + `jorvis_memory` | durable memory + FTS recall | db, ruflo(optional) |
| `core/operator/context.ts` | wake-time assembly (board slice + top-K memory + portfolio) | memory, missions dao |
| `core/operator/charter.ts` | load Sigma-Profile `dist/jorvis` + append approved amendments | fs/kv |
| mission tools (`tools.ts`/`tool-catalogue.ts`) | board manipulation surface | assistant tool layer |
| Missions room (renderer) | kanban UI + timeline | existing assistant event plumbing |
| Telegram v2 adapter (`core/remote/`) | commands + proactive pushes | bridge, missions dao, scheduler |
| external mission plane (`core/control/`) | submit/check/report tools | missions dao, control host |

---

## 12. Rollout

Four PRs, each independently mergeable and valuable:
1. **P0 reliability** — makes Jorvis usable (highest immediate leverage).
2. **P1 mission core** — autonomous in-app dev on a kanban (the headline capability).
3. **P2 identity/memory** — persistence, cross-project, learning, charter.
4. **P3 channels** — Telegram cockpit + external mission plane (absorbs SigmaControl).

Each phase: local gate (tsc + vitest + eslint + build) → sigma-check review loop → merge on green. Releases
gated separately (merge ≠ release). ROADMAP.md carries the sequenced phases; this spec is the reference.

---

## 13. Open questions / deferred

- Exact absorption of the existing `create_task` TasksManager vs a clean bridge → decided at P1 plan time.
- `get_app_state` redaction for a broadened external audience → deferred (single trusted token today).
- Sigma-Profile `jorvis` target wording (voice calibration for an in-app agent vs the operator clone) →
  drafted at P2, reviewed by the operator.
- Whether P2 global-scope reuses the reserved-conversation pattern or a nullable `workspace_id` →
  decided at P2 plan time against the current schema.
