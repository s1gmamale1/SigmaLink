# V3 Parity Backlog — Locked Execution Tickets

Compiled: 2026-05-10. Scope-frozen output of Wave 11.5. Source of truth for Waves 12-15.

Sources cited per ticket:
- `docs/02-research/v3-frame-by-frame.md` — frame log (553 frames @ `docs/02-research/frames/v3/<NNNN>.jpg`).
- `docs/02-research/v3-delta-vs-current.md` — master backlog (this file's parent).
- `docs/02-research/v3-protocol-delta.md` — mailbox + RPC additions.
- `docs/02-research/v3-providers-delta.md` — provider matrix.
- `docs/02-research/v3-agent-roles-delta.md` — role + roster.

Effort: **S** ≤ 1 day, **M** ≤ 3 days, **L** > 3 days.

---

## Bridge Assistant Verdict — **BUILD (Wave 13)**

V3 promotes Bridge Assistant from "research-only deferred" to a **first-class core
surface**. Two surfaces, one agent: right-rail tab on desktop (frames 0080, 0090, 0100,
0150, 0410) and a mobile-dashboard tile (0455). Walker-A transcript L82-96 / L147-158
shows: voice intake → bulk-spawn 8 panes → per-pane prompt dispatch (`Implement {feature}`
/ `Find and fix a bug in @filename` / `Run /review on my current changes` / `Write tests
for @filename`) with `@filename` resolution against indexed codebase. Synthesizer verdict
in `v3-delta-vs-current.md` §"Bridge Assistant Verdict" is unambiguous: **build, do not
defer**. Master memory entry that classes Bridge Assistant as deferred is **superseded by
this backlog**. Wave 13 ships the chat UI, orb state machine, ten-tool surface (per
PRODUCT_SPEC §3.10) plus the new `assistant.*` RPC namespace from
`v3-protocol-delta.md` §3, the right-rail tab, and per-pane dispatch echo. Bridge Canvas
follows in W14 off the same Browser/Editor/Bridge dock foundation.

---

## Wave Sequencing Summary

```
W12 (parallel debt + V3 quick-wins)
  └─ infra: providers, presets, schema migrations, RPC allowlist groups
  └─ surfaces: workspace launcher chrome, swarm wizard chrome, console scaffold
        ▼
W13 (V3 parity sweep + Bridge Assistant)
  └─ depends on W12 RPC/migration/preset work
  └─ right-rail Browser/Editor/Bridge dock; Operator Console body; Bridge Assistant
        ▼
W14 (Bridge Canvas + Editor + auto-update)
  └─ depends on W13 right-rail dock + browser foundation
  └─ Bridge Canvas (element picker, per-prompt picker, drag-drop, HMR poke)
  └─ Editor tab (Monaco file tree); auto-update channel
        ▼
W15 (CI matrix + voice + dogfood)
  └─ depends on full W12-W14 surface set
  └─ BridgeVoice intake; CI matrix; dogfood cycle; plan-gating capability matrix
```

Cross-wave guarantees:
- W12 lands all migration tickets first so W13-15 never block on schema.
- W12 lands all RPC allowlist groups so W13-15 controllers compile against frozen channels.
- W13 ships the right-rail dock skeleton before Editor (W14) and Canvas (W14) drop in.
- All ticket IDs grep-able as `[V3-WNN-XXX]`.

---

## Wave 12 — Parallel Debt + V3 Quick-Wins

Goal: every cheap-and-low-risk delta plus all migrations / RPC scaffolding so W13-15
agents never block on a schema or channel-allowlist change.

### Provider matrix (source `v3-providers-delta.md`)

> **OBSOLETED by v1.2.4 provider-registry cleanup (2026-05-13)** — see
> `docs/08-bugs/BACKLOG.md` → "v1.1.10 — provider registry cleanup → Shipped &
> verified — v1.2.4". The shipping registry was trimmed to the 5 CLIs
> SigmaLink actually targets (Claude, Codex, Gemini, Kimi, OpenCode). The
> tickets below are kept for historical context; their original acceptance
> criteria no longer apply.

#### [V3-W12-001] ~~Add BridgeCode provider stub~~ — **obsoleted v1.2.4**
- BridgeCode placeholder was removed from the registry. The launcher's
  comingSoon → fallback machinery (the original deliverable of this ticket)
  is retained as generic infrastructure for future stubs but ships unused.
- Original spec preserved in git history.

#### [V3-W12-002] Demote Kimi to model option under OpenCode — **superseded v1.2.4**
- v1.2.4 promotes Kimi back to a first-class CLI provider with its own
  registry row (`id: 'kimi'`, `command: 'kimi'`). The Kimi-under-OpenCode
  model option was removed from `models.ts` and replaced with a native
  `kimi` provider entry.

#### [V3-W12-003] ~~Hide Aider/Continue behind Settings toggle~~ — **obsoleted v1.2.4**
- Aider and Continue were removed from the registry entirely. The
  `providers.showLegacy` kv flag and legacy-provider gate machinery are
  retained as infrastructure but ship with no consumers.

#### [V3-W12-004] Wizard matrix order + quick-fills + Custom Command row — **superseded v1.2.4**
- v1.2.4 matrix order is `Claude | Codex | Gemini | Kimi | OpenCode | Custom
  Command` (Droid + Copilot stubs removed; BridgeCode removed; Cursor
  removed). Quick-fill buttons and the Custom Command row continue to ship.

### Workspace launcher chrome (source `v3-delta-vs-current.md` §"Workspace launcher")

#### [V3-W12-005] 3-card picker: BridgeSpace / BridgeSwarm / BridgeCanvas (ALPHA)
- Frames: 0020, 0180. Citation: *"Build the future."* / `⌘T · ⌘S · ⌘K`.
- Files: `app/src/renderer/features/workspace-launcher/Launcher.tsx`.
- Acceptance:
  - Picker renders three cards with hotkey hints `⌘T`/`⌘S`/`⌘K`.
  - BridgeCanvas card carries `ALPHA` chip and routes to canvas-creation flow (V3-W14-001+).
  - Bottom action row `+ NEW TERMINAL · SPLIT RIGHT · SETTINGS`.
- Effort: S.
- Depends on: none.

#### [V3-W12-006] Stepper Start → Layout → Agents
- Frames: 0030, 0040, 0055. Citation: chapter A *"Stepper Start ✓ → Layout → Agents"*.
- Files: `app/src/renderer/features/workspace-launcher/Launcher.tsx`.
- Acceptance:
  - Three-step stepper component above wizard body with check-state per completed step.
  - Step 1 = folder + name + repo detection. Step 2 = layout/preset. Step 3 = agents.
  - "Skip — no agents" / "Open without AI" affordance present on Step 3 (frames 0030, 0055).
- Effort: S.
- Depends on: V3-W12-005.

#### [V3-W12-007] Layout step: tile grid + folder picker + presets
- Frames: 0030, 0035, 0040. Citation: `1/2/4/6/8/10/12` tiles, hover *"4 terminals · 2x2 grid"*; preset row `BridgeMind | Test 3 | Test 2 | Test | NEW`.
- Files: `app/src/renderer/features/workspace-launcher/LayoutStep.tsx` (new), `app/src/renderer/features/workspace-launcher/PresetRow.tsx` (new).
- Acceptance:
  - Folder field with picker + autocomplete (recents from `workspaces` table).
  - Tile grid 1/2/4/6/8/10/12 with hover tooltip `<N> terminals · <RxC> grid`.
  - Preset row showing recent saved layouts, terminating in `+ NEW`.
- Effort: M.
- Depends on: V3-W12-006.

#### [V3-W12-008] Sidebar tabs with status dot + agent-count pill + breadcrumb
- Frames: 0020+, 0080, 0185. Citation: app breadcrumb `Workspace 10 / matthewmiller`.
- Files: `app/src/renderer/features/sidebar/Sidebar.tsx`, `app/src/renderer/features/top-bar/Breadcrumb.tsx` (new).
- Acceptance:
  - Each workspace tab shows `<name> · <status-dot> · <agent-count-pill>`.
  - Top breadcrumb component renders `Workspace <N> / <user>` from active workspace + OS user.
  - Status dot colour follows session status (running=green, error=amber, exited=grey).
- Effort: S.
- Depends on: V3-W12-005.

### Swarm wizard + Operator Console scaffold

#### [V3-W12-009] Roster preset rename Legion → Battalion + Custom cap 20
- Frames: 0184, 0185. Source: `v3-agent-roles-delta.md` §2.
- Files: `app/src/renderer/features/swarm-room/preset-data.ts`, `app/src/main/core/db/schema.ts` (CHECK constraint), new migration.
- Acceptance:
  - Preset list = `Squad 5 (1/2/1/1) · Team 10 (2/5/2/1) · Platoon 15 (2/7/3/3) · Battalion 20 (3/11/3/3 [INFERRED]) · Custom 1..20`.
  - `swarms.preset` CHECK constraint accepts `'battalion'`; existing `'legion'` rows survive but new swarms reject `legion`.
  - Custom roster cap dropped from 50 → 20.
  - Existing > 20-agent swarms load read-only with `legacy: true` flag.
- Effort: S.
- Depends on: none.

#### [V3-W12-010] Role colour CSS tokens
- Frames: 0185, 0205, 0250, 0295. Source: `v3-agent-roles-delta.md` §1.
- Files: `app/src/renderer/index.css`.
- Acceptance:
  - Four `--role-coordinator` (216 90% 60%), `--role-builder` (266 85% 65%), `--role-scout` (150 75% 50%), `--role-reviewer` (40 90% 60%) CSS vars present in every theme block.
  - Tailwind `bg-role-<n>` / `text-role-<n>` utilities resolve through these vars.
- Effort: S.
- Depends on: none.

#### [V3-W12-011] Swarm wizard 5-step shell
- Frames: 0184, 0220. Citation: *Roster · Mission · Directory · Context · Name*.
- Files: `app/src/renderer/features/swarm-room/SwarmCreate.tsx`.
- Acceptance:
  - Five-step navigation; stepper `STEP 1 of 5 · SWARM ▸`; per-step Cancel + Next.
  - Step bodies = roster / mission / directory / context-files / name (existing roster panel reused, others stubbed).
- Effort: S.
- Depends on: V3-W12-009.

#### [V3-W12-012] CLI-agent-for-all global provider strip
- Frames: 0205. Source: `v3-delta-vs-current.md` §Swarm row 5.
- Files: `app/src/renderer/features/swarm-room/RoleRoster.tsx`.
- Acceptance:
  - Strip of 9 providers above the role rows; click sets every role's provider in one shot.
  - Strip respects `comingSoon` provider semantics (V3-W12-001).
- Effort: S.
- Depends on: V3-W12-004.

#### [V3-W12-013] Operator Console top-bar tabs + STOP ALL + group-filter chips
- Frames: 0250, 0265, 0295. Citation: `TERMINALS · CHAT · ACTIVITY` tabs + STOP ALL red pill + `All Agents · COORDINATORS · BUILDERS · REVIEWERS · SCOUTS`.
- Files: new `app/src/renderer/features/operator-console/TopBar.tsx`, `app/src/renderer/features/operator-console/index.tsx`.
- Acceptance:
  - Three tabs render with unread badges from `swarm:counters` event.
  - STOP ALL invokes `swarm:stop-all` RPC and shows confirm dialog with `reason` field.
  - Group filter chips scope both chat tail and the constellation graph (V3-W13 ticket).
- Effort: M.
- Depends on: V3-W12-014.

#### [V3-W12-014] Operator Console RPC + counters
- Frames: 0250, 0265, 0295. Source: `v3-protocol-delta.md` §5.
- Files: `app/src/shared/rpc-channels.ts`, new `app/src/main/core/swarms/console-controller.ts`.
- Acceptance:
  - RPC channels added: `swarm:console-tab`, `swarm:stop-all`, `swarm:counters` (event), `swarm:constellation-layout`, `swarm:agent-filter`, `swarm:ledger` (event), `swarm:mission-rename`.
  - `swarm:counters` event payload `{ escalations, review, quiet, errors }` projected from `swarm_messages` filtered by kind + `resolvedAt IS NULL`.
  - Bottom-bar ledger event `{ agentsTotal, messagesTotal, elapsedMs }` ticks per-second.
- Effort: M.
- Depends on: V3-W12-016.

#### [V3-W12-015] Composer chrome — `@all` chip + status pills
- Frames: 0250, 0265, 0310. Citation: pills `BSC/SUE/INFO/BTU/DONE/MSG/ACK/ESCALATE`.
- Files: `app/src/renderer/features/swarm-room/SideChat.tsx`.
- Acceptance:
  - Composer recipient chip supports `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers`, plus per-agent ids (V3-W12-016 addressing primitives).
  - Per-message status pill renders via colour + 3-letter code.
- Effort: S.
- Depends on: V3-W12-016.

### Mailbox / RPC migrations (source `v3-protocol-delta.md`)

#### [V3-W12-016] Mailbox envelope kinds + addressing primitives + `resolvedAt` migration
- Source: `v3-protocol-delta.md` §1, §2.
- Files: `app/src/main/core/swarms/types.ts`, `app/src/main/core/db/schema.ts`, `app/src/main/core/db/migrations/<N>_v3_mailbox.ts`.
- Acceptance:
  - `MailboxEnvelope.kind` extended with `escalation` (promoted), `review_request`, `quiet_tick`, `error_report`, `task_brief`, `board_post`, `bridge_dispatch`, `design_dispatch`, `skill_toggle`. Per-kind zod payload schemas in `types.ts`.
  - `swarm_messages.resolvedAt INTEGER NULL` column added via migration; existing rows backfilled `NULL`.
  - Addressing recipients accept `'@all' | '@coordinators' | '@builders' | '@scouts' | '@reviewers'` in addition to id / `'*'`.
  - `directive` envelope adds `echo: 'pane'` flag; when set, target PTY echoes `[Operator → <Role> <N>] <body>` via stdin.
- Effort: M.
- Depends on: none.

#### [V3-W12-017] RPC allowlist groups for `assistant.*`, `design.*`, `voice:state`, new `swarm:*`
- Source: `v3-protocol-delta.md` §7.
- Files: `app/src/shared/rpc-channels.ts`, `app/electron/preload.ts`.
- Acceptance:
  - Four new allowlist groups with method ids fully enumerated (channels can land empty in W12; bodies fill in W13-15).
  - Preload rejects any channel outside allowlist.
- Effort: S.
- Depends on: none.

#### [V3-W12-018] Per-row Auto-approve + per-row provider override schema
- Frames: 0205. Source: `v3-agent-roles-delta.md` §3, §4.
- Files: `app/src/main/core/db/schema.ts`, migration, `app/src/renderer/features/swarm-room/RoleRoster.tsx`.
- Acceptance:
  - Migration adds `swarm_agents.autoApprove INTEGER NOT NULL DEFAULT 0`.
  - Each role row in `RoleRoster.tsx` exposes provider chip strip + model dropdown + `Auto` chip + count -/+ + colour stripe.
  - Auto-approve persists via `swarms.update-agent` RPC.
- Effort: M.
- Depends on: V3-W12-010.

---

## Wave 13 — V3 Parity Sweep + Bridge Assistant

Goal: every parity-blocking V3 surface lands. Bridge Assistant ships full.

### Right-rail dock + per-pane chrome

#### [V3-W13-001] Right-rail dock with Browser / Editor / Bridge tabs + splitter
- Frames: 0080, 0340, 0410. Source: `v3-delta-vs-current.md` §Browser+Editor+Bridge.
- Files: new `app/src/renderer/features/right-rail/RightRail.tsx`, `RightRailTabs.tsx`, `Splitter.tsx`.
- Acceptance:
  - Three persistent tabs (Browser, Editor, Bridge); per-pane state survives tab switch.
  - Resizable vertical splitter; width persisted in `kv['rightRail.width']`.
  - Empty state per tab when not yet activated.
- Effort: M.
- Depends on: V3-W12-013.

#### [V3-W13-002] Browser tab — recents panel + click-link-in-pane → built-in browser
- Frames: 0340. Citation: recents `localhost / openrouter.ai / www.bridgemind.ai`; *L209* link-routing.
- Files: `app/src/renderer/features/browser/BrowserRoom.tsx`, `app/src/main/core/browser/manager.ts`.
- Acceptance:
  - Recents panel lists last 10 distinct origins, filtered to current workspace.
  - Click-on-link inside any agent pane (PTY OSC8 hyperlink or detected URL) opens in Browser tab, not OS.
- Effort: M.
- Depends on: V3-W13-001.

#### [V3-W13-003] Per-pane top-bar chrome variants + provider splash + footer hints
- Frames: 0045, 0070, 0100, 0140. Citation: `Claude Code v2.1.116 · Opus 4.7 (1M) · Claude Max`, Codex `OpenAI Codex (v0.121.0) · gpt-5.4 high fast · directory: ~/Desktop/bridgemind`, OpenCode ASCII + `Build · Kimi K2.6 OpenRouter`, `auto mode on (shift+tab to cycle)`, `bypass permissions on`.
- Files: `app/src/renderer/features/command-room/PaneHeader.tsx`, `PaneSplash.tsx`, `PaneFooter.tsx`.
- Acceptance:
  - Per-provider splash variants render at pane boot (Claude / Codex / OpenCode visuals).
  - Top-bar shows close + branch (`dev`) + status dot.
  - Prompt-bar mid-strip: `<model> <effort> <speed> · <cwd>`.
  - Footer hint cycles through `auto mode on (shift+tab)` / `bypass permissions on` based on agent state.
- Effort: M.
- Depends on: V3-W12-002.

#### [V3-W13-004] Multi-pane terminal grid layouts
- Frames: 0045, 0100, 0150. Citation: 4-pane grid → 10-pane grid.
- Files: `app/src/renderer/features/command-room/CommandRoom.tsx`, new `GridLayout.tsx`.
- Acceptance:
  - Layout supports 1/2/4/6/8/10/12 panes via CSS grid; matches preset from launcher.
  - Per-pane drag-to-resize within grid cell.
  - Active-pane focus ring and `Cmd+Alt+<N>` jump.
- Effort: M.
- Depends on: V3-W12-007.

### Operator Console body

#### [V3-W13-005] Constellation graph (drag/zoom)
- Frames: 0250, 0295. Citation: hub-and-spoke Coord 1 centre; `DRAG CANVAS`.
- Files: new `app/src/renderer/features/operator-console/Constellation.tsx`.
- Acceptance:
  - Hand-rolled canvas (reuses Memory force-directed pattern from W6d).
  - Multi-coordinator presets render multi-hub topology via `swarm_agents.coordinatorId` (V3-W13-014).
  - Drag-canvas pan + scroll-zoom; `swarm:constellation-layout` persists positions.
- Effort: L.
- Depends on: V3-W12-014, V3-W13-014.

#### [V3-W13-006] Activity-feed sidebar (per-agent timeline)
- Frames: 0250. Citation: activity rail right of constellation.
- Files: new `app/src/renderer/features/operator-console/ActivityFeed.tsx`.
- Acceptance:
  - Right-side panel lists last N events per agent (status / completion / escalation / board_post).
  - Filter chips reuse V3-W12-013 group filters.
- Effort: M.
- Depends on: V3-W12-016.

#### [V3-W13-007] Coordinator structured task brief envelope + render
- Frames: 0265. Source: `v3-protocol-delta.md` §1 `task_brief`.
- Files: `app/src/main/core/swarms/protocol.ts`, `app/src/renderer/features/swarm-room/MailboxBubble.tsx`.
- Acceptance:
  - Coordinator → worker structured `task_brief` payload `{ taskId, urgency, headings: { title, bullets, links }[] }`.
  - Renderer shows `URGENT` chip (red) when `urgency === 'urgent'`, headings bold, sub-bullets indented, links live.
- Effort: M.
- Depends on: V3-W12-016.

#### [V3-W13-008] Per-agent board namespace + `boards` table
- Frames: 0280; transcript L247.
- Files: migration, `app/src/main/core/swarms/boards.ts` (new).
- Acceptance:
  - New table `boards (id, swarmId, agentId, postId, title, bodyMd, attachmentsJson, createdAt)`.
  - Disk path `<userData>/swarms/<swarmId>/boards/<agentId>/<postId>.md`; atomic temp+rename.
  - `board_post` envelope writes both DB row + disk file in one transaction.
- Effort: M.
- Depends on: V3-W12-016.

#### [V3-W13-009] Operator → agent DM echo into PTY
- Frames: 0325; transcript L296-301. Citation: `[Operator → Coordinator 1] Okay, that was good…`.
- Files: `app/src/main/core/swarms/mailbox.ts`, `app/src/main/core/pty/local-pty.ts`.
- Acceptance:
  - When `directive.echo === 'pane'`, target agent's PTY stdin receives `[Operator → <Role> <N>] <body>\n`.
  - DM also persists to `swarm_messages` so it shows in the chat tail.
- Effort: M.
- Depends on: V3-W12-016.

#### [V3-W13-010] Mission `@<workspaceSlug>` autocomplete
- Frames: 0210, 0235. Source: `v3-protocol-delta.md` §2.
- Files: `app/src/renderer/features/swarm-room/MissionStep.tsx` (new).
- Acceptance:
  - Typing `@` in mission textarea opens an autocomplete listing workspace slugs.
  - On submit, `@<slug>` resolves to absolute path + last branch and is replaced inline.
- Effort: M.
- Depends on: V3-W12-011.

### Swarm Skills

#### [V3-W13-011] Swarm Skills 12-tile grid + on/off pills
- Frames: 0210, 0220. Citation: groups Workflow / Quality / Ops / Analysis.
- Files: new `app/src/renderer/features/swarm-room/SwarmSkillsStep.tsx`, migration for `swarm_skills` table.
- Acceptance:
  - 12 tiles grouped: Workflow (Incremental Commits, Refactor Only, Monorepo Aware), Quality (Test-Driven, Code Review, Documentation, Security Audit, DRY, Accessibility), Ops (Keep CI Green, Migration Safe), Analysis (Performance).
  - Each tile shows on/off pill; toggle persists to `swarm_skills (swarmId, skillKey, on, group)`.
  - Toggling fires `skill_toggle` envelope into mailbox so coordinator prompts incorporate active skills.
- Effort: M.
- Depends on: V3-W12-016.

### Bridge Assistant — full build (source `v3-protocol-delta.md` §3, frame 0080-0170)

#### [V3-W13-012] Bridge Assistant chat panel + orb state machine
- Frames: 0080, 0090, 0100, 0150, 0410. Citation: orb states `STANDBY · LISTENING · RECEIVING · THINKING`; chat labels `BRIDGE` / `YOU` rounded pills.
- Files: new `app/src/renderer/features/bridge-agent/BridgeRoom.tsx`, `Orb.tsx`, `ChatTranscript.tsx`.
- Acceptance:
  - Orb component with 4 states; tap orb → enters LISTENING (W15 wires real mic).
  - Transcript renders rounded-pill role labels; assistant messages stream char-by-char.
  - Right-rail Bridge tab mounts this room (V3-W13-001).
- Effort: L.
- Depends on: V3-W13-001.

#### [V3-W13-013] `assistant.*` RPC namespace + tool tracer
- Source: `v3-protocol-delta.md` §3.
- Files: `app/src/shared/rpc-channels.ts`, new `app/src/main/core/assistant/{controller,conversations,tools,tool-tracer}.ts`.
- Acceptance:
  - Channels implemented: `assistant:listen`, `assistant:state` (event), `assistant:dispatch-pane`, `assistant:dispatch-bulk`, `assistant:ref-resolve`, `assistant:turn-cancel`, `assistant:tool-trace` (event).
  - `assistant:dispatch-bulk` spec `{ provider, count, initialPrompt? }[]` spawns N panes via existing `pty.create`.
  - `assistant:ref-resolve { atRef }` walks workspace index for `@filename` matches; returns `{ absPath, snippet }`.
  - Tool-call inspector UI shows call/response pairs in chat panel; persisted to `messages.toolCallId`.
- Effort: L.
- Depends on: V3-W12-017, V3-W13-012.

#### [V3-W13-014] `swarm_agents.coordinatorId` + multi-hub constellation
- Source: `v3-agent-roles-delta.md` §6.
- Files: migration, `app/src/main/core/swarms/factory.ts`.
- Acceptance:
  - `swarm_agents.coordinatorId TEXT NULL REFERENCES swarm_agents(id)`.
  - Factory assigns each non-coordinator agent to a coordinator (round-robin in multi-coord presets).
  - Constellation (V3-W13-005) draws glow lines only between a coordinator and its assignees.
- Effort: M.
- Depends on: V3-W12-009.

#### [V3-W13-015] Bridge Assistant cross-workspace Jump-to-pane + completion ding
- Transcript L122-137. Citation: completion ding + jump-to-pane toast.
- Files: `app/src/renderer/features/bridge-agent/BridgeRoom.tsx`, `app/src/renderer/lib/notifications.ts`.
- Acceptance:
  - Completion of an `assistant:dispatch-pane` fires a sonner toast with `Jump to pane` action.
  - Clicking action sets `state.activeWorkspace` + `state.room='command'` + focuses target sessionId.
  - Subtle ding via `<audio>` tag (asset under `app/public/sounds/ding.wav`); user-toggleable in Settings.
- Effort: S.
- Depends on: V3-W13-013.

---

## Wave 14 — Bridge Canvas + Editor Tab + Auto-update

Goal: visual design tool ships; Editor right-rail tab ships; auto-update channel wired.

### Bridge Canvas (source `v3-protocol-delta.md` §4, frames 0368-0405)

#### [V3-W14-001] Element-picker overlay
- Frames: 0368, 0369. Citation: `Click an element in the preview` banner.
- Files: new `app/src/renderer/features/browser/DesignOverlay.tsx`, `app/src/main/core/design/picker.ts`.
- Acceptance:
  - "Activate Design Tool" toggle in Browser address bar enters picker mode.
  - Hover-highlight via DevTools-style overlay; click freezes selection.
  - RPC `design:start-pick { tabId } → { pickerToken }` + `design:pick-result` event with `{ selector, outerHTML, computedStyles, screenshotPng }`.
- Effort: L.
- Depends on: V3-W13-001.

#### [V3-W14-002] Captured-element source paste in left dock
- Frames: 0368, 0380. Citation: `[Design Mode • Claude — Selected: div.relative.w-full]` + source paste pill.
- Files: `app/src/renderer/features/browser/DesignDock.tsx` (new).
- Acceptance:
  - Left dock shows captured selector + outerHTML snippet (collapsible) + screenshot thumbnail.
  - "Paste source" button injects outerHTML into prompt buffer.
- Effort: M.
- Depends on: V3-W14-001.

#### [V3-W14-003] Per-prompt provider picker with Shift/Alt multi-select
- Frames: 0380. Citation: hints `SHIFT + CLICK to select multiple`, `ALT + CLICK to deselect`. Providers: Claude / Codex / Gemini / OpenCode.
- Files: `app/src/renderer/features/browser/DesignDock.tsx`.
- Acceptance:
  - Four provider chips rendered; Shift-click adds, Alt-click removes.
  - Default selection = `claude` if no prior choice; persists per-canvas via `canvases.lastProviders`.
- Effort: M.
- Depends on: V3-W14-002.

#### [V3-W14-004] Drag-and-drop asset → absolute path in prompt buffer
- Frames: 0398, 0405. Citation: drag video → buffer `'/Users/matthewmiller/Desktop/bridgemind/bridgespace-v3.mp4'`.
- Files: `app/src/renderer/features/browser/DesignDock.tsx`, `app/src/main/core/design/staging.ts`.
- Acceptance:
  - HTML5 drag of file from desktop into prompt buffer triggers `design:attach-file`.
  - File staged to `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`; absolute staging path inserted into prompt as quoted string.
- Effort: M.
- Depends on: V3-W14-003.

#### [V3-W14-005] Live-DOM patch HMR poke
- Frames: 0405. Citation: live diff confirmation on `MarketingHero` L295-363.
- Files: new `app/src/main/core/design/hmr-poke.ts`.
- Acceptance:
  - When agent writes a file under the active dev-server's source root, `design:patch-applied` event fires `{ tabId, file, range }`.
  - Browser tab posts a `location.reload()` if no HMR socket detected; otherwise sends a no-op WebSocket frame to the dev server's HMR endpoint to nudge a re-evaluation.
- Effort: L.
- Depends on: V3-W14-004.

#### [V3-W14-006] BridgeCanvas card live in workspace picker (no longer ALPHA-only)
- Frames: 0020, 0180.
- Files: `app/src/renderer/features/workspace-launcher/Launcher.tsx`.
- Acceptance:
  - BridgeCanvas card retains `ALPHA` chip until W14 acceptance smoke; toggleable via `kv['canvas.gaSign']`.
  - Selecting it creates a `canvases` row + opens Canvas surface.
- Effort: S.
- Depends on: V3-W12-005, V3-W14-001.

### Editor right-rail tab

#### [V3-W14-007] Editor tab — file tree + Monaco
- Frames: 0420, 0430; transcript L380-403. Citation: `KanbanAnimation.tsx` + `RouteGuard.tsx` with TS/JSX syntax + line numbers.
- Files: new `app/src/renderer/features/editor/EditorTab.tsx`, `FileTree.tsx`.
- Acceptance:
  - Lazy-loaded `monaco-editor` (no initial bundle bloat); fallback to CodeMirror if Monaco fails to load.
  - File tree rooted at active workspace; expand/collapse persisted in kv.
  - Click-path in any chat / pane footer focuses the file in Editor tab.
- Effort: L.
- Depends on: V3-W13-001.

### Auto-update + housekeeping

#### [V3-W14-008] Wire `electron-updater` channel (optional opt-in)
- Source: `master_memory.md` deferred list.
- Files: `app/electron/main.ts`, `app/src/renderer/features/settings/UpdatesTab.tsx` (new).
- Acceptance:
  - `electron-updater` initialised on startup; disabled by default behind `kv['updates.optIn']='1'`.
  - Settings tab exposes "Check for updates" + last-check timestamp; release channel pinned to GitHub releases.
- Effort: M.
- Depends on: none.

#### [V3-W14-009] Re-probe agents + native-module rebuild prompt
- Source: `master_memory.md` recommended next-session priorities #1.
- Files: `app/src/renderer/features/settings/ProvidersTab.tsx`.
- Acceptance:
  - Settings Providers tab gains "Re-probe all" button → `providers.probeAll()`.
  - On startup, if `better-sqlite3` ABI mismatch detected, modal prompts user to run `npm rebuild`.
- Effort: S.
- Depends on: none.

---

## Wave 15 — CI Matrix + Voice + Dogfood

Goal: BridgeVoice intake; Windows/macOS/Linux CI matrix; dogfood cycle; plan-gating
capability matrix lands as a `kv` row (no billing UI).

#### [V3-W15-001] BridgeVoice intake — title-bar pill + `voice:state` event
- Frames: 0220. Source: `v3-protocol-delta.md` §6.
- Files: new `app/src/renderer/features/voice/VoicePill.tsx`, `app/src/main/core/voice/adapter.ts`.
- Acceptance:
  - Centred title-bar `BridgeVoice` pill appears whenever any capture is active.
  - One OS speech adapter (macOS Speech / Windows SAPI / Linux PocketSphinx fallback); only one capture session at a time.
  - Global `voice:state` event `{ active, source: 'mission'|'assistant'|'palette' }` fires on transitions.
- Effort: M.
- Depends on: V3-W12-017.

#### [V3-W15-002] Voice intake → swarm-mission textarea
- Frames: 0235. Citation: `@bridgespace-tauri  I want you to create a 30 second marketing video…`.
- Files: `app/src/renderer/features/swarm-room/MissionStep.tsx`.
- Acceptance:
  - Mic button on mission textarea routes to `voice:state { source: 'mission' }`.
  - Streamed transcription dropped into textarea; Cmd+Enter submits.
- Effort: S.
- Depends on: V3-W15-001, V3-W13-010.

#### [V3-W15-003] Voice intake → Bridge orb + Command Palette
- Frames: 0080, 0090. Transcript L86-96, L190.
- Files: `app/src/renderer/features/bridge-agent/Orb.tsx`, `app/src/renderer/features/command-palette/CommandPalette.tsx`.
- Acceptance:
  - Tapping orb fires `voice:state { source: 'assistant' }`; transcript flows into `assistant:listen` conversation.
  - Cmd+Shift+K voice-mode toggle in palette; transcribes into search field.
- Effort: M.
- Depends on: V3-W15-001, V3-W13-013.

#### [V3-W15-004] CI matrix — Windows / macOS / Linux Playwright `_electron` smoke
- Source: master_memory recommended priorities.
- Files: `.github/workflows/e2e-matrix.yml`.
- Acceptance:
  - Matrix runs `app/tests/e2e/smoke.spec.ts` on `windows-latest`, `macos-14`, `ubuntu-latest`.
  - Artefacts: `visual-summary.json` + screenshots per OS.
  - Required check on PR.
- Effort: M.
- Depends on: V3-W12 / W13 / W14 acceptance smokes.

#### [V3-W15-005] Plan-gating capability matrix (`kv['plan.tier']`)
- Frames: 0500, 0510. Citation: Basic / Pro / Ultra feature lists.
- Files: new `app/src/main/core/plan/capabilities.ts`, `app/src/renderer/lib/canDo.ts`.
- Acceptance:
  - `Capability` enum lists every plan-gated affordance (BridgeMCP slot count, BridgeVoice on/off, max swarm size, BridgeCode access).
  - `canDo(cap): boolean` consulted by all gated UIs; default tier = `'ultra'` since SigmaLink is local-only/free (capability matrix exists for forward compat only).
  - Settings exposes hidden tier-override for QA via `kv['plan.tier']`.
- Effort: S.
- Depends on: none.

#### [V3-W15-006] Dogfood cycle — 4-pane swarm against non-trivial repo
- Source: master_memory recommended priorities #5.
- Files: `docs/07-test/DOGFOOD_RUN_W15.md`.
- Acceptance:
  - Launch Claude + Codex + Gemini + OpenCode in a 4-pane swarm against a real repo.
  - Run for ≥30 min; capture screen recording + bug list.
  - Filed bugs land in `docs/08-bugs/OPEN.md` with `[V3-DOGFOOD-NN]` prefix.
- Effort: M.
- Depends on: all W12-W14 tickets.

#### [V3-W15-007] Skills marketplace stub (read-only)
- Source: master_memory deferred list.
- Files: `app/src/renderer/features/skills/MarketplaceTab.tsx`.
- Acceptance:
  - Read-only listing pulled from a static JSON manifest in repo (`docs/marketplace/skills.json`).
  - Clicking install → directs to drag-and-drop instructions; no network fetch.
- Effort: S.
- Depends on: none.

---

## Ticket count

Total: **45** tickets across 4 waves.
- Wave 12: 18 tickets (mostly S/M; foundation + migrations).
- Wave 13: 15 tickets (M/L; right-rail dock + Bridge Assistant + Operator Console).
- Wave 14: 9 tickets (M/L; Bridge Canvas + Editor + auto-update).
- Wave 15: 7 tickets (S/M; voice + CI + dogfood).

Within the ≤ 60-ticket cap. Each ticket grep-able as `[V3-WNN-NNN]`.
