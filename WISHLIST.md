# SigmaLink — Wishlist

> **Capture inbox for future / nice-to-have / explicitly-deferred items.** Low ceremony.
> Promote an item into [ROADMAP.md](ROADMAP.md) when it gets scoped into a phase.
>
> Buckets: **Deferred by design** (consciously out of scope) and **Future enhancements**
> (planned-later upgrades). **New ideas** is the untriaged inbox.

---

## 🚫 Deferred by design (out of scope for now)

_(consciously NOT built — each is a separate track or a non-goal, not a gap)_

- **[desktop-runtime] Tauri migration for host-shell footprint** — replacing Electron with Tauri may reduce baseline app overhead, but the current RAM bottleneck is per-pane Claude/Codex/MCP process trees. Defer until shared MCP, lazy resume, and process-tree cleanup prove the remaining host overhead is worth a platform migration.

- **[dev-workspace] multiple SigmaLink Dev instances / custom cwd / agent panes in it** — operator chose a singleton at `~` with plain shells only (AskUserQuestion 2026-06-11, Phase 14 design); revisit only if a second fixed-cwd terminal bench is requested. (`+ Pane` will technically work there — tolerated, not designed for.)

---

## ✨ Future enhancements (planned-later upgrades)

_(real upgrades to build once the current system is production-grade)_

- **[pane-lifecycle] automatic idle suspend for completed agents** — park idle/completed panes by preserving scrollback/session metadata and killing the live process tree. Build after the shared Ruflo HTTP and explicit lazy-resume path is stable, because automatic suspension needs clear pinned/keep-alive semantics.
- **[pane-lifecycle] pinned keep-alive policy for remote/autopilot agents** — mark panes that must never be parked by idle cleanup, especially Telegram/remote/autopilot lanes. Build when idle suspend is implemented.
- **[pane-lifecycle] Pane Hibernate: pause/resume-like RAM offload for inactive finished panes** — make the current "inactive/blurred/resuming" pane concept into a real memory feature: keep the pane visible as a cheap frozen shell, but stop the provider/MCP process tree so idle Claude/Codex panes no longer keep 300 MB-1 GB resident.
  Proposed behavior: add a `sleeping`/`hibernated` pane runtime state that preserves `sessionId`, provider, cwd/worktree, branch, runtime profile, external provider session id, scrollback snapshot, last RSS/process breakdown, and the visible pane card. On sleep, stop the PTY process tree and dispose or downgrade the renderer xterm cache; on resume, respawn the provider through the existing resume path and restore the pane to `running`.
  Why it matters: CSS blur/minimize only changes presentation and does not reduce Claude/MCP RSS. Raw OS pause (`SIGSTOP`/`SIGCONT`) is tempting but does not reliably free memory and may break network streams/MCP children. Hibernate is the reliable RAM win because it removes the live process tree until the user needs the pane again.
  Expected impact: in an 8-pane workspace where idle Claude panes average ~500 MB RSS, hibernating 6 finished panes can reduce provider-process RSS from roughly ~4 GB to roughly the 2 active panes plus lightweight pane metadata/scrollback. MCP-heavy panes benefit more because child MCP servers are terminated too.
  Likely touchpoints: `app/src/main/core/pty/registry.ts:401` and `app/src/main/core/pty/registry.ts:411` already expose tree-aware kill/stop; add a hibernate-specific stop path that persists a sleeping state instead of treating the pane as removed. `app/src/renderer/lib/terminal-cache.ts:31` and `app/src/renderer/lib/terminal-cache.ts:367` distinguish parking vs destroy; sleeping panes should probably destroy live xterm/subscriptions after persisting scrollback, while normal workspace switches still park. `app/src/main/core/pty/resume-launcher.ts:460` already supports subset resume by session id; reuse/extend it for explicit pane wake. `app/src/renderer/features/command-room/CommandRoom.tsx:294` and `app/src/renderer/features/command-room/CommandRoom.tsx:301` currently only remove or stop; add Sleep/Wake actions and a header badge.
  Safety policy: manual "Sleep pane" first; later auto-sleep only when there is a clear finished/idle signal, no active prompt, no recent output, low CPU, and the pane is not pinned keep-alive. Never auto-sleep remote/autopilot/Telegram or explicitly pinned panes. On wake failure, keep the frozen pane and show a resumable error rather than deleting the session.
  Trigger: build after the current RAM brake and strict MCP launch defaults have been dogfooded, and after we can reliably persist/restore scrollback for sleeping panes. Effort: L.

- **[pane-rendering] residual watches after the 2026-06-11 four-PR arc (operator-verified end-to-end)** — SHIPPED: restore-from-hidden reveal + `window:restored` + #133 residuals (#152), same-frame ⤢ refit + zero-size fit guard (#156), LIVE drag re-wrap with single-SIGWINCH-per-gesture (#159), claude `--settings '{"tui":"fullscreen"}'` killing the upstream Ink scrollback dup (#160, operator: "I see no duplicates"). Spec `docs/superpowers/specs/2026-06-11-pane-refit-controller-design.md`. Still open, all low, all watch-only:
  - **Fullscreen-renderer feel** — line-by-line scroll lag inside claude panes (upstream anthropics/claude-code#56546) and one CJK copy-mojibake report (#66269). Revert = drop the `--settings` pair in `src/shared/providers.ts` (one line).
  - **1-frame repaint flicker at drag release for a full-screen TUI** — the CLI's own redraw after SIGWINCH; not fixable our side.
  - **Snapshot/live overlap dedup caps its scan at 64 KiB** (`app/src/renderer/lib/terminal-cache.ts` MAX_OVERLAP_SCAN) — a >64 KiB pending burst at first-attach can double-write the overlap window. Bump or chunk-hash if duplicated text is ever reported ON FIRST ATTACH (not on resize).
  - **Suppressed window-restore + same-dims drag-end leaves a stale frame** (near-impossible interleaving) — fix if ever seen: latch a `pendingReveal` flag that upgrades the drag-end fit to a reveal.
  Trigger: only if re-reported. Severity: low. Effort: S.

---

## 🆕 New ideas (untriaged)

_(raw ideas land here; promote to ROADMAP.md once scoped into a phase)_

- **[mcp] detect repeated stdio MCP starts under one Codex/Claude pane** — a single pane can accumulate multiple `@claude-flow/cli mcp start` descendants. Investigate whether this is Codex plugin behavior, config reload behavior, or a leaked child cleanup issue once diagnostics can show child process history.

- **[panes/C-class] custom DOM terminal renderer / structured Claude pane (the BridgeSpace counter)** — 2026-06-11 operator screenshot + behavior analysis of BridgeSpace v3.1.12 (Tauri + React + own terminal renderer + `osc133-parser.ts`, self-evidenced in their on-stream code review). CORRECTED 2026-06-11 (operator: you can exit claude and run any CLI in their panes; the genuine CC TUI footer is visible): their panes ARE real PTY terminals — under a **custom DOM/React terminal renderer** (Warp-style: parse PTY bytes into logical lines/blocks, let CSS wrap them) instead of an xterm character grid. That's why resize can't glitch: visual reflow is a CSS operation decoupled from the PTY cols contract, and THEY choose when the app gets SIGWINCH (settle-only/quantized → Ink never spams duplicates); no grid buffer/glyph atlas to corrupt. Their cost: they maintain a whole terminal emulator (VT coverage strain on vim/htop-class grid apps; DOM layout cost on huge output — their own "terminal renderer perf" review task). Two counter-shapes for us, EITHER/OR: (a) **custom DOM renderer over our PTYs** — full structural parity, Warp-sized bet; (b) **opt-in DOM-chat claude pane** via `claude -p --output-format stream-json` + Jorvis `ChatTranscript` components — cheaper, claude-only, real scope (tool-permission UI, slash surface, resume). Their remaining structural weakness either way: all agents share one working dir (our per-pane worktrees remain the edge — see `agentic-de-design-patterns`). Trigger: claude-pane scroll-feel complaints persisting after the #160 fullscreen dogfood, or competitive pressure. Effort: (a) XXL · (b) XL.

- **[terminal] OSC-133 command-block segmentation inside xterm panes** — parse shell-integration prompt/output marks (OSC 133 A/B/C/D) on the PTY stream and surface xterm decorations: per-command collapsible blocks, copy-one-command, jump-between-commands (BridgeSpace does this via their osc133 parser; iTerm2/WezTerm-style). Orthogonal to the structured-claude-pane idea; improves plain shell panes. Needs shell-integration escapes emitted in our spawned shells (zsh/bash hooks). Trigger: after the structured-pane decision lands, or independently as a shell-pane UX phase. Effort: M–L.

_(Phase 3 bugs `+ Pane`/`launch_pane`/screenshot/copy-paste shipped in #137 and RELEASED in v2.1.0 — see CHANGELOG `[2.1.0]`; removed from inbox.)_

_(Phase 3 follow-ups — `usePaneImageStaging` extract, staged-image janitor, and `add_agent`/`create_swarm` echo — all SHIPPED in #150 (`ee89fb4`), 2026-06-11; removed from inbox. The echo verify found a real gap (those tools emitted no echo) and fixed it via a shared `emitDispatchEchoes()` helper.)_

- **[perf/UX] `create_swarm` dispatch-echo storm** — Jorvis `create_swarm` emits one `assistant:dispatch-echo` per agent (#150), so a large preset (battalion = 20) fires up to ~20 `panes.list`+`swarms.list` refetches, 20 success toasts, 20 dings, and 20 racing focus-jumps. (`launch_pane` has the same pattern, capped at 8.) Fix: emit ONE consolidated echo from `create_swarm` (or echo only the queen/first agent for focus + let the single refetch hydrate the rest), or add a short coalescing window in `app/src/renderer/features/jorvis-assistant/use-jorvis-dispatch-echo.ts`. Effort: S. [[grep-sibling-call-sites]] (Opus review #150)

- **[cleanup] `create_swarm` echo `error` field + impossible-state test** — the `create_swarm` echo hardcodes `error: null` (#150) while `launch_pane`/`add_agent` carry the real `session.error`; harmless today (the `sessionId !== null` filter excludes failed agents) but `app/src/main/core/assistant/tools.create-swarm-echo.test.ts` asserts an impossible `status:'error'`+non-null-`sessionId` state. Thread the real error if `SwarmAgent` ever carries one, or drop the impossible-state test case. Effort: S. (Opus review #150)

_(Ctrl+scroll whole-app zoom SHIPPED in PR #153 — `feat/ctrl-scroll-zoom`, native `webFrame.setZoomFactor`; 3 non-blocking hardenings deferred from the Opus review.)_

- **[security/hardening] clamp zoom factor at the preload trust boundary** — `app/electron/preload.ts` `setZoomFactor` is a thin pass-through. The renderer clamps to 0.5–2.0 (`app/src/renderer/lib/zoom.ts` `clampZoom`) on every real path, but a compromised renderer could call `window.sigma.setZoomFactor` directly with an arbitrary/`NaN` value (worst case: a self-inflicted unreadable own window — usability, not privilege/data). Fix: `Math.min(2, Math.max(0.5, Number.isFinite(factor) ? factor : 1))` inside the preload method so the boundary self-protects. Effort: S. Build when tightening the preload trust boundary. (Opus review PR #153)
- **[UX] bind Cmd/Ctrl + `+` (shifted) for zoom-in parity** — only `mod+=` is bound (`app/src/renderer/app/useZoomControls.ts`); shifted `+` (`e.key='+'`, `shiftKey=true`) is rejected by the strict `matches()` (`app/src/renderer/lib/shortcuts.ts`), so Chrome-style `Cmd++` doesn't zoom in. Wheel + `=`/`-`/`0` already cover it. Fix: add `bindShortcut('mod+shift+=', …) → zoomIn`. Effort: S. Deferred by design (minor convenience). (Opus review PR #153)
- 🐞 **[low] `app.fontSize` boot-restore is unclamped** — `app/src/renderer/app/ThemeProvider.tsx` applies any finite stored `app.fontSize` directly (pre-existing; not introduced by #153). Settings only writes bounded presets (12/13/14/16) so it's safe today, but a corrupt KV value would apply an unbounded root font size. Fix: clamp to a sane px range before `applyFontSize`. Effort: S. (Opus review PR #153)

---

## 🔬 Deep review findings (2026-06-11) — win32 DB lifecycle (Phase 15 grounding)

_Found while root-causing the Windows reopen crash (ROADMAP Phase 15). The crash itself + WAL bloat are fixed there; these are the adjacent design debts deliberately NOT fixed in that PR._

- **[db/arch] memory MCP server runs FULL `initializeDatabase()` per CLI spawn** — every agent pane's CLI spawns its own `mcp-memory-server.cjs`, and `mcp-server.ts:191` runs the complete bootstrap (BOOTSTRAP_SQL DDL + `migrate()` + kv migrations) as a persistent WRITER on the live `sigmalink.db`. N panes = N concurrent DDL writers by design — DDL races between fresh children are possible (duplicate-column throws), and every spawned CLI holds a write-capable handle the quit path must chase. Redesign: open the child connection WITHOUT DDL (schema is main's job; add a `SIGMALINK_SKIP_BOOTSTRAP=1` path or a readonly+`busy_timeout` open with lazy write), or share one supervised server instead of per-CLI copies. Effort: M. [[grep-sibling-call-sites]]

- **[db/obs] WAL-size telemetry + boot log line** — devices accumulated tens-of-MB `-wal` files silently for weeks (quit checkpoint failing on win32). Log `-wal` size at boot (before/after the Phase-15 TRUNCATE reclaim) and surface a diagnostics counter so a regressing checkpoint is visible instead of silent. Effort: S.

---

## 🔬 Deep review findings (2026-06-11 — Jorvis terminal-access debugging)

_(out-of-scope findings from the `fix/jorvis-terminal-access` root-cause session; the in-scope fixes — catalogue triple-drift, `read_pane`, `prompt_agent` liveness — SHIPPED in PR #157 `5ac6e3a` (2026-06-11, rides the next release), spec `app/docs/superpowers/specs/2026-06-11-jorvis-terminal-access-design.md`)_

- 🐞 **[medium] swarm-roster ghost entries — no healing** — live DB shows `swarm_agents` row `builder-1` (session `1580b8c7…`) with NO live/DB-running session; `list_swarms` (`app/src/main/core/assistant/tools.ts:763`) serves it to Jorvis as a real roster member, and mailbox broadcasts/roll-calls target it. The `prompt_agent` liveness guard now surfaces the ghost on direct prompts, but the roster itself never self-heals. Fix: a roster sweep that cross-checks `swarm_agents` against live sessions and marks orphans `status='lost'` (reaper keep⊇use rule applies). Effort: M.
- **[UX/low] deferred-MCP-tools flow reads as "host reconnecting" to the model** — the Claude CLI defers `mcp__jorvis-host__*` schemas (model must ToolSearch-load them; traces 2026-06-11 19:21:59 + 02:31:32), and the model narrates it as "the host is reconnecting", alarming the operator. Options: a system-prompt line ("tools may need ToolSearch — this is normal, not an outage") or investigate pre-loading via the CLI's MCP eager-load config if/when exposed. Effort: S.

- ~~**[workspaces] SigmaLink Dev special workspace** — singleton workspace from the sidebar "+" menu; NO git/worktree machinery; N plain shell terminals (stepper 1–12) at `os.homedir()`; fresh respawn on restart; side-effect containment (nothing writes into `~`).~~ → **promoted to ROADMAP Phase 14** (2026-06-11); **✅ SHIPPED PR #158 `9cda070`** (2026-06-11). Spec: `app/docs/superpowers/specs/2026-06-11-sigmalink-dev-workspace-design.md` · Plan: `app/docs/superpowers/plans/2026-06-11-sigmalink-dev-workspace.md`.

---

## 🔬 Deep review findings (2026-06-11) — manual pane-close lifecycle

> **→ Part A SHIPPED in PR #161 `a0e9bee` (2026-06-12)** — toast + resurrection both fixed; Recents recoverability (Part B) still pending; `handleRelaunch`/silent-failure items above remain open.

_Operator-reported, 3-agent root-cause sweep + Opus verification against live code. Both bugs trace to ONE structural flaw: the manual × close path is a "poor cousin" of the Jorvis `close_pane` tool — it kills the PTY but skips the bookkeeping — and `close_pane` itself is only half-complete. Design confirmed with operator: `closed_at` soft-delete marker + Recents-recoverable._

> **→ ALL FIVE items below promoted to ROADMAP Phase 13** (2026-06-11). Plan: `app/docs/superpowers/plans/2026-06-11-pane-close-lifecycle.md`; ADR-007. Kept here as history.

- 🐞 **[medium] manually closing a pane raises a spurious "Pane exited (code 143/0)" warn toast** — an intentional close is surfaced as an unexpected crash. `pushPtyExitNotification` (`app/src/main/core/notifications/sources/pty-exit.ts:47-74`) fires on EVERY pty exit with no user-initiated suppression; `PtyExitEvent` has no "closed" field. Path: manual × (`app/src/renderer/features/command-room/CommandRoom.tsx:257-262` `handleRemove` → `rpc.pty.kill` → SIGTERM → exit 143) → `registry.ts:347` `onExit` → `rpc-router.ts:558` `onPaneEvent` → `pushPtyExitNotification` → `use-live-events.ts:270-285` `toast.warning`. The Jorvis `close_pane` tool (`app/src/main/core/assistant/tools.ts:356-373`) hits the SAME path → same toast (sibling). Fix: skip the notification when the row's `closed_at` is set. Effort: S. [[grep-sibling-call-sites]]

- 🐞 **[high] manually-closed panes resurrect on app restart** — the DB re-opens panes the user deliberately ×'d. TWO layers, both confirmed: (1) manual close (`CommandRoom.tsx:257-262`) does `pty.kill()` + in-memory `REMOVE_SESSION` only — **no DB close-write, no `pane_index` clear**; (2) boot rehydrate (`app/src/renderer/app/state-hooks/use-session-restore.ts:144-149`) calls `panes.listForWorkspace` whose SQL (`app/src/main/rpc-router.ts:1224-1242`) is `WHERE pane_index IS NOT NULL` with **NO status filter** → re-adds the tile for any pane that ever had a slot. If the kill loses the race to quit, the boot janitor (`app/src/main/core/db/janitor.ts:33-50`) flips `running→exited/-1`, which `listEligibleRows` (`app/src/main/core/pty/resume-launcher.ts:328-352`) then **resumes live**. `agent_sessions` has NO `closed_at` column (soft-delete exists only on `browser_tabs`, mig 0033). NOTE: `close_pane`'s `status='exited',code=0` write blocks the live re-spawn but NOT the tile rehydrate (listForWorkspace ignores status) → `close_pane` is only half resume-proof (latent same bug). Fix: add `closed_at` to `agent_sessions` + `AND closed_at IS NULL` on `listForWorkspace`/`listEligibleRows`/`listRespawnableRows`. Effort: M. [[reaper-keep-superset-of-use]]
  ↳ **(2026-06-11, post-#158) Phase 14 widens this for SHELL panes:** `buildResumeArgs('shell')` no longer returns null, so a manually-×'d shell pane whose row stays `running`→`exited(-1)` now respawns **LIVE** on restart (previously only a ghost tile). Phase 13's `closed_at` filter on `listEligibleRows` covers it automatically — raises Phase 13's priority. Operator re-confirmed the #14 toast live on `9cda070` (2026-06-11, add+remove pane → "Pane exited (code 143/0)" toasts).

- **[pane-lifecycle] unify pane-close into ONE shared "close properly" primitive** — manual × (`handleRemove`), context-menu close (`PaneShell.tsx:687`→`onRemove`), and the `close_pane` tool (`tools.ts:356`) are three divergent close paths (the root of both bugs above). Collapse them onto one main-side primitive that sets `closed_at=now` BEFORE `pty.kill()` (so the async exit sees the marker), so future close-sites can't drift. Also audit `handleRelaunch` (`CommandRoom.tsx:273-296`) which drops the old session without a DB close-write. Effort: M. [[grep-sibling-call-sites]]

- 🐞 **[low] `handleRelaunch` still drops the old session with NO close-write** (deferred from Phase 13 Part A — out of plan scope, pre-existing): the crashed row keeps `pane_index`/`status='error'`; if the replacement takes a different slot the old row can rehydrate as a ghost tile on restart. Fix: route the drop through `rpc.panes.close` (marker write is now one call). Effort: S. (Opus review, PR #161.)

- **[ux] `panes.close` failure after the optimistic `REMOVE_SESSION` is silent** — fire-and-forget `.catch(() => undefined)` in `CommandRoom.handleRemove`; a bridge failure leaves the row unmarked → resurrects on restart with no operator signal. Pre-existing shape; add a `toast.error` in the catch. Effort: S. (Opus review, PR #161.)

- **[pane-lifecycle] Recents recoverability for closed panes** — keep the soft-deleted (`closed_at IS NOT NULL`) row and surface it in `listRecents` (mig 0033 added the recents surface) so an accidental × is reopenable (reopen = clear `closed_at` + resume/relaunch). Reaper GCs after the normal window; verify keep-set ⊇ use-set still holds with the narrower resume predicate. Effort: M.

---

## 🔬 Deep review findings (2026-06-11) — SigmaLink Dev plan grounding

_Found by the 4-lane recon + lead verification while grounding the Phase 14 plan._

- 🐞 **[high] `workspaces.rename` + `workspaces.openNew` hard-rejected at the preload bridge** — both are registered handlers (`app/src/main/rpc-router.ts:1482,1494`) and typed in `app/src/shared/router-shape.ts:323,327`, but ABSENT from the `CHANNELS` allowlist (`app/src/shared/rpc-channels.ts:78-83`); `isAllowedChannel` is exact-match (`rpc-channels.ts:491-493`), so `Sidebar.tsx:294`'s inline rename silently never persists (the optimistic `RENAME_WORKSPACE` dispatch masks it until restart). The v1.5.3-B defensive test stays green because its own hand-maintained list (`rpc-channels.test.ts:108-113`) omits them too — the RPC mirror is a QUAD (shape + router + CHANNELS + test list), not a triple. Fix: add both to `CHANNELS` + `TYPED_ROUTER_CHANNELS`. Effort: S. → **promoted to ROADMAP Phase 14 (drive-by Task 4) / hotlist #15** (2026-06-11); **FIXED in PR #158** (`bf708c7`). [[grep-sibling-call-sites]]

- **[test-infra] make `TYPED_ROUTER_CHANNELS` self-maintaining** — the v1.5.3-B CHANNELS-vs-AppRouter defensive test's enumeration (`app/src/shared/rpc-channels.test.ts:67+`) is hand-maintained, so it drifts in tandem with the allowlist it guards (exactly how the rename/openNew hole above stayed green). Replace the hand-list with a derivation from the live registration source (enumerate `rpc-router.ts`'s registered handler map at test time, or generate from `router-shape.ts` via a type-level/codegen check) so a registered-but-unlisted channel FAILS the test instead of silently joining the drift. Found by Opus quality review during Phase 14 U2 (PR #158). Effort: M. [[grep-sibling-call-sites]]
