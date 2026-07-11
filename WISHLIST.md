# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.
>
> **Cleared 2026-07-07** at the start of the Jorvis-evolution cycle. The full previous inbox
> (v2.9.x era: pane hibernate, theme follow-ups, notification lows/design-gaps, Phase 2.5 residue,
> multi-window residue, …) is preserved verbatim in
> [docs/03-plan/archive/WISHLIST-pre-jorvis-cycle-2026-07-07.md](docs/03-plan/archive/WISHLIST-pre-jorvis-cycle-2026-07-07.md)
> — still-alive items get re-promoted from there when they come up.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

- **[panes] harden the click⇒focus interactive-element guard** — `PaneShell.tsx` `handlePaneClick`
  guard misses span-based FlowView links + `role="dialog"` chrome; harmless today (the handler never
  cancels the event, worst case = an extra idempotent focus dispatch) but add `[role="dialog"]`,
  `label`, `[data-link]` if a focus-leak-under-modal ever surfaces. Effort: S. (PR #226 review M2.)
- **[perf][state] CLEAR_SESSION_ATTENTION always allocates fresh state** — `state.reducer.ts`
  returns a new top-level object even when the attention map is unchanged, so every pane click
  re-renders CommandRoom. Negligible at human click rate; return `state` unchanged when the key is
  absent. Effort: S. (PR #226 review M3, pre-existing pattern.)
- **[panes] tab-switch should move keyboard focus too** — the click⇒focus invariant
  (fix/pane-first-click-focus, 2026-07-10) deliberately skips interactive controls, so clicking a
  scratch TAB switches the view but keyboard focus stays in the previous tab's terminal; same for
  Cmd+T spawn. Fix: dispatch `sigma:pty-focus` for the new `activeTabId` on tab change (skip the
  mount run) in `app/src/renderer/features/command-room/PaneShell.tsx`. Effort: S. Build when the
  first "typed into the wrong tab" report lands.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

### Jorvis P1b → P1c PREREQUISITE (2026-07-09, opus whole-branch review)

- 🐞 **[IMPORTANT][missions] the "needs another pass" retry loop is non-functional → a task marked for rework STALLS permanently. MUST be wired before autonomy is enabled for real users.** The review directive used to tell the brain "move_mission_task(working) — the supervisor will re-dispatch it", but (a) the supervisor's `runReview` has no re-dispatch code and (b) `state.ts` `TASK_TRANSITIONS` has no `working|reviewing → dispatched` edge, so `dispatch_task` can't re-run it either — the task sits `working`, no new pane, no wake, no completion, no block (fails SAFE = stall, not drain). Also leaves the MAX_ATTEMPTS backstop dormant (attempt never climbs past 1 in the live loop). **Interim fix SHIPPED in this branch** (`directive.ts`): the directive now steers an incomplete task to `blocked` and explicitly says automatic retry isn't available — no more false promise. **P1c must**: add a `reviewing→dispatched`(+`needs_input→dispatched`) transition + supervisor re-dispatch (incrementAttempt) so the retry loop + MAX_ATTEMPTS actually engage; tie the "auto-decompose fires on CREATION not activation" gap (below) to the same work. Effort: M. (b-rev-final.)
- ℹ️ **[missions] bad-provider `dispatch_task` compounds with autonomy** — a synthetic `error-*` session fires no pane events, so that task sits at `dispatched` and the watcher never advances it (another benign stall). Fold into the retry-wiring fix: on `session.status==='error'` don't move to `dispatched`. Effort: S. (b-rev-final, extends the earlier b-rev-t1 note.)

### Jorvis P1b mission autonomy — parked review notes (2026-07-08)

- 🐞 **[med][missions] no mission ever reaches `active` status — no "activate"/"start" tool exists** — `create_mission` hardcodes `draft`; the only `setMissionStatus` writers are `complete_mission`(→done) and the rollup (which only ever yields `done`). So a mission sits at `draft` through all its work, `listActiveMissions()` is dead code, and `rollupMissionStatus`'s `active→done` auto-promotion branch is unreachable in production (loop still terminates via `complete_mission`'s explicit `done` write — proven by the e2e). Also: with autonomy ON, the decompose wake fires on mission CREATION (not activation), so a human who means to fill in a draft first gets auto-decomposed immediately. Fix: add a `start_mission` tool (or a `create_mission({autostart})` flag) that sets `active` + is the decompose trigger; gate auto-decompose on active, not created. Effort: M. (b-rev-t5 + b-impl-t5.)
- 🧹 **[test][missions] the rpc-router autonomy glue is untested** — the e2e drives watch/scheduler/supervisor directly; the literal wiring in `rpc-router.ts` (the `create_mission` tool-trace → decompose-enqueue hook + the two pane-event sink `missionWatcher.onPaneEvent` call-sites) has zero direct coverage. A typo in the loose payload casts would compile + pass the full suite + silently break decompose-enqueue in prod (fails SILENT — autonomy inert, not a crash; capped by the try/catch guards + default-OFF). Fix: a focused rpc-router smoke test that a `create_mission` trace enqueues a decompose wake and a pane exit reaches the watcher. Effort: M. (b-rev-t5.)

- 🐞 **[low][security] MCP-socket tool path does not forward the per-turn `cdpCallCounter`** — the origin-threading fix (`invokeToolForConversation`, controller.ts) resolves origin+confirmDangerous off the live turn but doesn't thread the per-turn CDP rate-limit counter the stdout `dispatchTool` path carries. Pre-existing (the socket path never had it); means browser-tool CDP rate limits aren't enforced for MCP-executed calls. Low today (browser agent-driving is default-OFF). Fix: resolve+pass the turn's cdpCallCounter in `invokeToolForConversation` too. Effort: S. (b-impl-t4b.)
- 🐞 **[low][security] `invokeToolForConversation` with a conversationId but no live turn falls back to `origin:'local'` (full trust)** — matches pre-fix behavior for the direct-RPC path, but a socket call arriving AFTER its turn finished would run ungated. Narrow window (P0.1 guard + turn lifetime). Fix: when a conversationId is supplied but no live turn exists, treat as untrusted (escalate/deny) rather than local. Effort: S. (b-impl-t4b.)
- ℹ️ **[missions] supervisor mission→conversation map is process-lifetime only** — an app restart mid-mission starts a fresh conversation for that mission's next wake (board state is DB-safe; only in-conversation model context is lost). Fix: add a `conversationId` column to `missions` + a migration to persist the link. Effort: M. (b-impl-t4.)
- ℹ️ **[missions] no `confirmDangerous` path for an autonomous wake's dangerous op** — post-4b, an autonomous DANGEROUS_REMOTE call escalates but the supervisor's `runTurn` carries no confirmDangerous, so it fails closed (safe). Task 5/P3 must decide HOW an autonomous wake's dangerous op gets operator approval (telegram round-trip / pending-escalation). Effort: M. (b-rev-t4.)

- 🐞 **[low][missions] a bad-provider `dispatch_task` still moves the task to `dispatched` with a dead session id** — `executeLaunchPlan` returns a synthetic `error-*` session (no throw) for an unknown provider; `dispatch_task` then links + moves to `dispatched` exactly like a real launch, distinguishable only via the best-effort echo's `ok:false`. Mirrors `launch_pane`'s pre-existing pattern (`tools.ts` `session.status!=='error'`), but `dispatch_task` is the first to drive persistent board-state off it — a supervisor could mark a task in-flight against a dead pane. Fix: on `session.status==='error'`, don't move the task to `dispatched` (leave it `backlog`/`blocked`) + append an error event. Effort: S. (b-rev-t1, P1b T1 review.)

### Jorvis P1a mission board — parked final-review minors (2026-07-08, Phase 20 first slice)

_Opus whole-branch review: READY, all findings Minor/OK-TO-PARK. The two it recommended logging:_

- **[missions/perf] `refreshMissions` has no monotonic-token guard / debounce** — `app/src/renderer/features/missions/use-missions.ts` list refetches on every `missions:changed` unguarded (board hydrate IS token-guarded). Bounded by real mutation count (reads never emit — no feedback loop), so safe today; a P1b supervisor emitting bursts should add a debounce or token. Effort: S. (m-rev-final.)
- **[missions/security] `mission_board` is a FREE external read** — an external MCP client can read every mission goal/report (conscious call: perception like `get_app_state`; worktreePath always null in P1a). Revisit at P3 when the mediated external mission plane lands — likely scope reads to the client's own submitted missions. Effort: S–M. (m-rev-final.)
- 🧹 **[nit][test] `RoomsMenuButton` test title says "13-room" but asserts 14** — stale title string, assertion correct. Effort: XS.
- 🧹 **[nit][test] P1a component coverage thin** — `MissionList`/`MissionDetail`/`MissionsRoom` are untested presentational components (hook + board are covered); add cases in P1b when they gain behavior. Effort: S.

### Jorvis tool-arg coercion #223 — parked gate minors (2026-07-08)

_Operator live smoke on merged P0 caught strict-zod rejecting LLM quoted primitives (`count:"2"`, `allWorkspaces:"true"`); fixed at the `T()` parse choke point in PR #223 `9603893` (gate GREEN 95). Three XS follow-ups parked by the gate reviewer:_

- **[nit] `Number()` coerces broader than strict decimal** — `"0x10"`→16, `"1e3"`→1000 pass the finite check; harmless (schema bounds/`.int()` catch downstream, worst case = original throw) but a `/^-?\d+(\.\d+)?$/` guard would make coercion exactly-decimal. `app/src/main/core/assistant/tools.ts` `coerceStringPrimitives`. Effort: XS.
- **[test] pin the float-string-for-int case** — `count:"5.5"` → coerces to 5.5 → `.int()` fails → original error re-thrown; correct by reasoning, untested. Effort: XS.
- **[watch] flat-only coercion guard** — `issue.path.length!==1` skips nested/array paths; zero tool schema today has numeric/boolean arrays (grep-verified by the gate), but if one ever lands, elements throw instead of coercing — relax + test then. Effort: XS.

### Jorvis P0 execution — parked review findings (2026-07-07, Phase 19 branch)

_Non-blocking findings from the subagent review loop during P0 implementation. Both Important-but-edge; deferred out of P0.2 by lead + reviewer agreement._

- 🐞 **[med][jorvis] Retry button re-sends the CURRENT `lastSentPromptRef`, not the failed turn's prompt** — `app/src/renderer/features/jorvis-assistant/JorvisRoom.tsx` `onRetryError` reads a shared mutable ref at click time. Repro: turn A fails → Retry shows on error row A → click Retry, A succeeds (no new error row, so row A's Retry persists) → send unrelated prompt C → `lastSentPromptRef='C'` → clicking row A's still-live Retry silently sends **C**, not A. Wrong-action-on-click, no visual cue. Fix: capture the failed prompt ONTO the error row (thread a `retryPrompt` onto the committed error `ChatMessageView`) and have Retry send that, not the shared ref; or clear/hide Retry once its row is no longer the active failure. Effort: S–M. (rev-t2, P0.2 review.)
- 🐞 **[low][jorvis] Ruflo pattern-store records a FAILED turn's prompt as a `task-completion` pattern** — the `standby` branch's fire-and-forget `ruflo.patterns.store` fires on any standby, including the error path's trailing standby. PRE-EXISTING (predates P0.2; before it, `kind:'error'` was unhandled so every failed turn hit this deterministically — P0.2 actually NARROWS the window to the rare adoption race). Fix: gate the pattern-store on a real success signal, not bare standby. Effort: S. (rev-t2 + impl-t2, P0.2 review.)
- 🐞 **[low][jorvis] `sendPrompt` ignores `res.busy` — a programmatic re-send in the sub-tick window after `kind:'error'` unlocks the renderer can attach to a retired turn** — main frees `liveTurnByConversation` in the IIFE finally, a tick AFTER the synchronous delta→error→standby emits; a re-send inside that window gets `{busy:true, turnId:<retired>}` and `JorvisRoom.sendPrompt` latches the dead turnId → orphaned optimistic row + composer locked until the watchdog. NOT reachable by a human click (>100ms). Clean fix is nuanced — the same path intentionally gives multi-window attach-to-live-turn. Effort: S–M. (rev-final, P0 whole-branch review.)
- 🐞 **[low][telegram] a prompt sent while a turn is live is silently dropped** — the P0.1 busy guard returns before `appendMessage`, so a second Telegram prompt during a live turn persists nothing, spawns nothing, and the remote user gets NO reply (invisible drop; strictly better than the old double-spawn but still silent). Fix: on `res.busy` reply "Jorvis is still working — resend in a moment." Effort: S. (rev-final, P0 whole-branch review.)
- 🧹 **[nit][test] no named render-count regression test pins the error-row + Retry memo contract** — the existing `ChatTranscript.render-count.test.tsx` stays green but nothing explicitly guards that an error row + its Retry button don't re-invoke `useJorvisStreamReveal` or break `memo(ChatRow)` skipping. Add a named case. Effort: XS. (rev-t2, P0.2 review.)

---

## 🔬 Deep review findings (2026-07-07) — Jorvis full-subsystem map

_5-lane read-only recon (main-process core · renderer UI · IPC/DB plumbing · integrations · docs/philosophy) run at `563ae08` (main) while grounding the Jorvis-evolution cycle. Full synthesized map lives in the session record + Ruflo `patterns/verdict:jorvis-full-map-2026-07-07`. All paths `app/src/…` unless noted._

### Confirmed bugs

> ✅ **Struck items FIXED in PR #222 `2805d37` (2026-07-07, Phase 19 / Jorvis P0):** orphan `assistant:security` emit DELETED (P2+ owns the real surface) · concurrent-turn guard shipped (atomic claim, race-test-pinned after the sigma-check round-1 catch) · `refResolve` routed through path-guard (now follows symlinks; dotfiles excluded, disclosed+pinned) · `resumeHint` schema stub added · stale WISHLIST twin archived to `docs/03-plan/archive/WISHLIST-legacy-2026-07-07.md` · stale comments fixed. Kept below struck-through as the record.

- ~~🐞 **[medium][assistant] `assistant:security` is an orphan event — the "Security: PENDING → active" UX does not exist**~~ — `main/core/assistant/controller.ts:189` emits `assistant:security` from the aidefence audit hook (comments at `controller.ts:182-183`, `rpc-router.ts:2562`, `aidefence-gate.ts:5,16` all describe a renderer surface consuming it), but the event is absent from the `EVENTS` allowlist in `shared/rpc-channels.ts` (preload would silently no-op it, #188 dead-plane class) AND zero renderer subscribers exist (grep-verified). The aidefence audit signal is write-only telemetry nobody reads. Fix: either wire it end-to-end (EVENTS entry + subscriber + a security indicator surface) or delete the emit + the three stale comments. The renderer-wide `eventOn()` scan test (`rpc-channels.test.ts:656`) can't catch emitted-but-never-subscribed events — consider an inverse check. Effort: S–M.
- ~~🐞 **[medium][assistant] no concurrent-turn cap — N `claude` child processes can run against one conversation**~~ — `controller.ts:178` `activeTurns` is an unbounded Map; `send()` (`controller.ts:422`) fires an unawaited async IIFE per call with no per-conversation dedupe/queue. The only guard is the renderer's `busy` composer gate — which is per-window state, so multi-window / Telegram / external origins can stack turns. Fix: main-side per-conversation in-flight guard (reject or queue a second `send` while a turn is live). Effort: S.
- ~~🐞 **[low][assistant] `refResolve` @-mention file walk bypasses the `read_files` sandbox**~~ — `controller.ts:780-839` does a synchronous recursive walk trusting the workspace's own `rootPath`, with none of the `assertAllowedPath`/realpath-symlink safety the hardened `read_files` path has (`tools.ts:637-642`, `security/path-guard.ts:91-116`). Low blast radius (workspace the user already opened) but an inconsistency between two file-touching surfaces in the same subsystem. Fix: route the walk's root + each resolved path through the same path-guard. Effort: S.
- ~~🐞 **[low][rpc] `assistant.conversations.resumeHint` has no `schemas.ts` entry — payload flows validation-free with a dead warning branch**~~ — live in `CHANNELS` (`shared/rpc-channels.ts:255`), documented in `router-shape.ts:877-879`, real handler (`conversations-controller.ts:97-124`), but `core/rpc/schemas.ts:952-955` only registers `list`/`get`/`delete`. Per `validate.ts:41-52` a schema-less channel passes through unvalidated, and the "gap visible in dev" warn only fires under `VALIDATION_MODE==='warn'` while it's hardcoded `'enforce'` (`schemas.ts:151`). Handler has a manual typeof guard so severity is low, but it breaks the "every channel gets at least a stub" invariant. Fix: add the stub; consider making the missing-schema warn fire under `enforce` too. Effort: S.

### Docs rot / hygiene

- ~~🧹 **[docs] stale twin `docs/03-plan/WISHLIST.md` actively misleads recon — archive or delete it**~~ — an older wishlist lineage (last touched `4aea51e`, ~v2.5.0 era) coexists with this canonical root file; it still lists the 2026-06-10 Jorvis renderer bugs (pane-events copy-on-add, hydrate token guard, jump-to-message single-rAF, setState-in-updater) as OPEN although all 4 fixes are live in source with inline audit-finding comments (`renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:32`, `use-jorvis-conversations.ts:76-181`, `use-jorvis-jump-to-message.ts:14`, `use-jorvis-assistant-state.ts:187-208`). A docs-only recon lane got fooled by it on 2026-07-07. Effort: XS.
- ~~🧹 **[comments] stale-fact comments in the assistant core**~~ — (a) `controller.ts:60-64` says the CLI registers "the 13 Sigma tools"; live count is **39** (`tools.ts` `TOOLS`, contract-tested vs `tool-catalogue.ts`). (b) `authorization.test.ts:87` test TITLE lists only 3 of the 4 `DANGEROUS_REMOTE` members (assertion is correct, includes `kill_swarm`). Effort: XS.
- 🧹 **[naming] three naming eras coexist in jorvis-assistant test-ids** — `bridge-conversations-panel` (`ConversationsPanel.tsx:58`), `sigma-interrupted-banner`/`sigma-resume-banner` (`InterruptedTurnBanner.tsx:15`, `ResumeBanner.tsx:13`) vs the current `jorvis-*` convention. Cosmetic; rename alongside the next e2e touch. Effort: XS.
- 🧹 **[nit] two separate `lazy()` wrappers for `JorvisRoom`** — `app/App.tsx:66` (standalone room) + `right-rail/JorvisTabPlaceholder.tsx:16-19` (rail tab) each mint their own lazy identity/Suspense boundary for the same chunk. Harmless; unify if the double-spinner is ever noticed. Effort: XS.

### Known-and-acknowledged (carried forward as explicit watch items)

- ⚠️ **[security/hardening] browser agent-guard has no DNS-rebinding protection** — self-documented at `main/core/browser/agent-guard.ts:24-29`: SSRF checks are literal-hostname-only; a public hostname rebinding to a private IP post-check slips through. File recommends `webRequest.onBeforeRequest`-level hardening. Only reachable when the default-OFF `browser.agentDriving` KV is enabled. Effort: M.
- ⚠️ **[skills] skill "bindings" are informational-only — they do NOT change what Jorvis can do** — `main/core/skills/controller.ts:142-147` self-documents: attach/detach are UI chip associations; behavioral activation is a deferred enhancement. Flag kept here so nobody assumes attaching a skill alters dispatch/tool-calling. (Behavioral skills are in-scope for the Jorvis-evolution brainstorm.)
- ℹ️ **[db] shell-first `cli-exited` events are deliberately NOT persisted to `jorvis_pane_events`** — `rpc-router.ts:1009-1013`: `'cli-exited'` isn't in the table's kind CHECK constraint and no migration was added; notification still fires. Asymmetry to remember if a pane-timeline/activity view is ever built over that table. Effort: S (migration) if ever needed.
- ℹ️ **[jorvis] `turnId` missing on the `ToolTrace` payload** — `InlineToolChips.tsx:28` keeps a dead `turnId` prop; chips are conversation-scoped only, can't distinguish overlapping turns (relevant the moment the concurrent-turn cap work lands, or if concurrent turns ever become a feature). Carried from the pre-jorvis-cycle inbox. Effort: S.

---

## 📥 Parked follow-ups (2026-07-10) — Jorvis Phases 20–22 ship (#225 / #229 / #230)

_Review-acked non-blockers + infra debt from the P1b/P1c/P2/P3 gate reviews. All shipped code is opus-gate GREEN; these are the logged minors._

- ⚠️ **[security-posture][control] external mission reads are id-addressable, not client-scoped** — `check_task`/`get_report` (and the already-free `mission_board`) let any bearer-token client read ANY mission by id, incl. operator-private ones. Accepted D2 posture (single trusted token; ids are randomUUID) — but document in ADR-011 that the two-plane door is not a confidentiality boundary, and scope reads per `client_label` before the audience broadens. Effort: M. (gate-230.)
- ⚠️ **[availability][operator] a 120s autonomous `confirmViaTelegram` holds the single global wake drain loop** — scheduler drains serially (`await runWake`), so one pending phone confirm starves every other mission's wakes for up to 120s. Fail-closed, no permanent hang. Fix: run confirms off-loop or add a per-wake timeout budget. Effort: S–M. (rev-p3 I7.)
- 🧹 **[semantics][remote] mission ACTIONS (`/mission /approve /deny`) bypass the idle-lock** — commands are allowlist-gated but deliberately lock-bypassing (so `/unlock` works); mission mutations ride that same bypass. The allowlist is the real boundary (a locked-out attacker could `/unlock` anyway), so this is drift, not a hole. Fix: honor the lock for mutating commands with a "locked" reply. Effort: XS. (rev-p3 I8.)
- 🧹 **[remote] `/status` lost its dedicated bridge-health meaning** — repurposed to the board summary (P3 cockpit); a lock-state prefix line was kept as the interim. Add `/health` if the full health check (token-set, allowlist size, poll state) is wanted back in chat. Effort: XS.
- 🧹 **[operator] `KV_OPERATOR_CONVERSATION` still has zero consumers** — annotated P3-reserved during P2, but P3 shipped without binding the Telegram command channel to it (replies ride `assistant.send`'s own conversation). Wire it or drop it next time the bridge conversation model is touched. Effort: S. (rev-p2 M4.)
- 🧹 **[operator] no-verdict review turn leaves a task in `reviewing` forever** — if the brain calls no verdict tool, the task stalls visibly (fails safe, operator picks it up). A staleness sweep (reviewing > N hours → blocked + notify) would close it. Effort: S.
- 🧹 **[test-infra] `db-fake-drizzle.ts` has no `.delete()` support** — `memory.test.ts` monkey-patches one locally; every future hard-delete DAO hits the same wall. Add a real `.delete().where().run()` to the shared fake. Effort: S. (p2-t2.)
- 🧹 **[hygiene][remote] `bridge.ts` is ~950 lines** (500-line guideline) — grew through P0/R-1/P3; split candidates: command dispatcher, confirm machinery, relay/push send path. Effort: M.
- 🧹 **[hygiene][scripts] `sync-jorvis-charter.cjs` hardcodes the operator-machine absolute Sigma-Profile path** as its default source — fine for the solo flow, non-portable for contributors; add an env/relative fallback. Effort: XS. (gate-229.)
- 🧹 **[nit][operator] `recallMemories({workspaceId})` filter is dead via the `recall` tool** — only `context.ts` passes it; expose or drop the tool param. Effort: XS. (gate-229.)
- ℹ️ **[cross-repo] Sigma-Profile `feat/jorvis-target` (`ac09421`) is local-only** — the vendored `charter-default.ts` on main depends on that render; push/merge the Sigma-Profile branch so the source of truth matches the vendored copy, then re-run `--check`.
- ℹ️ **[smoke] the live token smoke still owes the real-device half** — boot smoke PASSED (migrations/FTS/seeds live); remaining: flip `missions.autonomy.enabled` in a test profile + drive a real mission end-to-end, Telegram push/confirm round-trip with the real bot token, external-client `submit_task` → `get_report` over the real socket.

---

## 📥 Parked follow-ups (2026-07-11) — pane permissions / computer-use investigation

_Root cause of the "granted permissions keep re-asking" issue = ad-hoc signature pins macOS TCC grants to one build's cdhash (fixed via `app/scripts/macos-stable-sign.sh` + installer/afterSign stable-identity hooks). These are the same-class and adjacent findings parked out of that fix's scope._

- ⚠️ **[sigma-voice] same ad-hoc TCC class as SigmaLink** — `sigma-voice/scripts/adhoc-sign.cjs` + `sigma-voice/electron-builder.yml` ship the identical ad-hoc pattern, so SigmaVoice's microphone/accessibility TCC grants die on every update too. Fix: reuse the stable-identity pattern (share the "SigmaLink Local Signing" cert or mint a "SigmaVoice Local Signing" twin + installer hook). Effort: S. Build when the next SigmaVoice release is cut.
- ⚠️ **[panes][worktrees] worktree panes lose ALL claude project config** — `.claude/` is gitignored at both levels (`.gitignore:110` `**/.claude/`, `app/.gitignore:22`) and `.mcp.json` is untracked, so a pane spawned into a worktree gets no permission allowlist, no hooks, no project MCP servers, and a fresh grantless `~/.claude.json` project entry (10+ stale `claude-pane-*` project keys observed). Invisible today because recent panes spawn in-place (`agent_sessions.worktree_path` NULL), but it re-bites the moment worktree panes are used. Fix: seed `.claude/settings(.local).json` + `.mcp.json` from the source repo at worktree creation (`app/src/main/core/git/worktree.ts` has no seeding hook). Effort: M.
- ℹ️ **[panes][UX] surface the claude computer-use single-session lock** — the claude CLI allows ONE computer-use session per machine (`~/.claude/computer-use.lock`; other sessions get "Computer use is in use by another Claude session (…). Wait for that session to finish or run /exit there."). With multiple panes + the operator's own session, contention is by-design confusing; SigmaLink could detect the message in pane scrollback and show a friendly "computer use is held by another session" hint. Effort: S–M.
- 🧹 **[mcp][hygiene] ruflo MCP defined in two scopes with different endpoints** — project `.mcp.json` says `npx -y @claude-flow/cli@latest mcp start` while the local scope (`~/.claude.json` → `projects["/Users/aisigma/projects/SigmaLink"].mcpServers`) says `npx ruflo@3.7.0-alpha.69 mcp start`; `claude mcp list` flags the conflict (OAuth/token state is per-endpoint). Keep one: `claude mcp remove ruflo -s project` or `-s local`. Effort: XS.
