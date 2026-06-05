# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the CURRENT cycle,
> derived from `WISHLIST.md`. A whiteboard — refreshed each cycle, **not permanent
> documentation**. Permanent record → `CHANGELOG.md` + master memory + Ruflo AgentDB.
>
> **Phase 0 ✅ SHIPPED to `main` (untagged) — 2026-06-05.** The disk-fill + post-crash launch-lockout +
> workspace-loss crisis is fixed: **Lane A** (disk-safety net — worktree cap + `statfs` floor + boot sweep,
> `8e203b2`) + **Lane B** (status-aware pane-slot index migration 0032 + awaited janitor + adopt/replace +
> throttled snapshot flush) + the **pane-resume regression fix** (`93fbca6`) + an automated **crash-recovery
> smoke** (`d9f3ba4`, red→green). Verified 3 ways: operator GUI force-quit→relaunch, Lane B's gate, and the
> smoke. Full record → `CHANGELOG.md` + master memory. **Phase 1 ✅ SHIPPED (`cca05ad`, 2026-06-05)** — the SMK + DEV bugfix batch (sessions/skills/browser), re-gated on `main` + CI-green (the Phase-0 crash-recovery smoke's `node:sqlite` import made lazy so it no longer crashes e2e collection on CI's Node 20). **▶ NEXT = Phase 2.** Then:
> Phase 2 OPT perf/resource + in-place worktree mode · 3 workspace/panel UX · 4 pane chrome+grid · then the
> carried feature phases (theme gallery · Jorvis FE · worktree GUI · git diff · orchestration · voice). The
> 2026-06-04 themes work also **✅ shipped** (PR #104). **v2.0.0 tag** now only awaits the remaining operator
> visual smokes (N1 wizard · N2 browser-resize · Jorvis live-reply) → `/sigmalink-release`.

This ROADMAP is the single source of truth for what to build next.

---

## How to read this
- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort:** S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Item codes (`CRIT-*`, `SMK-*`, `DEV-*`, `BSP-*`, `PERF-*`, `FEAT-*`) trace back to `WISHLIST.md`. Confirmed bugs are fixed before new feature phases.
- **Already-shipped competitor parity is NOT re-built** — see "Skip / market better" at the tail.

---

## 🔓 Release carry-over (operator-owned)
**v2.0.0 is on `main` (untagged).** Phase 0 (crisis) + Phase 1 (SMK/DEV bugfix batch) are both ✅ shipped and CI-green (e2e-matrix on Node 20). The tag now only awaits the owed operator VISUAL smokes: N1 wizard across themes · N2 browser drag/no-reload · Jorvis live reply. Tag via `/sigmalink-release`.

## 🐞 Confirmed bugs — Phase 0 + Phase 1 hotlist ✅ SHIPPED (full record → `CHANGELOG.md`)

CRIT-1/2/3 (Phase 0) + **SMK-2/3/3b + DEV-1/2/3/4** (Phase 1) all shipped to `main` 2026-06-05, each with the regression test whose absence had hidden it. **DEV-5 was refuted** — it is SMK-2 observed across multiple panes (fixed by the SMK-2 memoization), not a separate code path. **SMK-1**'s `scoped` guard already landed (B2 fix); only the benign opencode same-cwd residual remains (deferred). Remaining unshipped items:

| # | Sev | Bug | Where | Phase | Effort |
|---|-----|-----|-------|-------|--------|
| DEV-6 | low | 46 RPC channels have no zod schema (IPC input-validation hole; extends BUG-4/ARCH-9) | `core/rpc/schemas.ts`, `rpc-router.ts` | deferred → fold into a hardening/perf pass | M |
| DEV-7 | low | `electron:dev` runs a PROD build, never sets `VITE_DEV_SERVER_URL`; daemon health-probe noise | `package.json`, `electron/main.ts`, `ruflo/http-daemon-supervisor.ts` | deferred | S |
| DEV-8 | low | Bundle hygiene: `SkillsTab` static+dynamic import; split `vendor-react`/`vendor-xterm`; `ease-[var()]` warn | `vite.config.ts`, `CommandRoom/PaneShell/RightRail.tsx` | deferred | S |
| SMK-1 (residual) | low | opencode sessions not threaded with `opts.workspaceId` → can't join the Option-B whitelist (benign unless two workspaces share an identical cwd) | `session-disk-scanner.ts` (`listOpencodeSessions`) | deferred | S |
| BSP-B4 | medium | Embedded-browser input/focus reliability — audit `WebContentsView` focus forwarding to form fields | `core/browser/{manager,controller}.ts`, `BrowserViewMount.tsx` | 10 | M |

*(Phase-1 reviewers' non-blocking follow-ups, parked in `WISHLIST.md`: the closed-tabs table has no GC — `listRecents` is bounded but rows accumulate; the SMK-2 loop test fails via a 5s timeout rather than a fast message assertion.)*

---

## Phase 0 — CRIT: disk-leak + DB-infra/persistence  ·  ✅ **SHIPPED** (main, untagged, 2026-06-05)

**✅ Shipped.** Lane A disk-safety (`8e203b2` — worktree cap + `fs.statfs` floor + boot all-repo sweep + `removeAndPrune` on suppressed spawn) · Lane B DB infra/persistence (`d384b0e`/`42ee75f`/`f1b7ac8`/`b0c7725` + migration `0032` status-aware pane-slot unique index + awaited `runBootJanitor` + adopt/replace dead rows + throttled `app.lastSession` flush) · pane-resume regression fix (`93fbca6` — reaper keep-set widened to the resume-eligible set) · automated **crash-recovery smoke** (`d9f3ba4`, `npm run test:smoke:crash`, **red→green**). **Verified 3 ways:** operator GUI force-quit→relaunch, Lane B's gate, the smoke. **Deferred (non-fatal → WISHLIST):** resume self-heal Part B (recreate-if-missing worktree before spawn) · ResizeObserver-toast filter. Full record → `CHANGELOG.md` + master memory. The 7-part plan below is retained as this cycle's history.

**Goal.** The app can never fill the disk, always launches after a crash/force-quit, and never silently loses which workspaces were open.

**Deliverables.**
- **Lane A (disk/worktree — LEAD):**
  - Worktree-count cap + `fs.statfs` free-disk floor in `WorktreePool.create` (refuse + loud error session, never silently loop).
  - Boot-time **+ periodic** all-repo worktree sweep + `git worktree prune`; **reap worktrees that have NO `agent_sessions` row** (the actual leak shape) + treat `node_modules`/`dist`/`electron-dist` as **disposable** (don't let them pin a dir for the 7-day window).
  - A hardened, exported `worktreePool.removeAndPrune()` + `sweepAllReposOnBoot()` for Lane B to call.
- **Lane B (DB infra + persistence — AGENT):**
  - New migration `00NN_agent_session_pane_unique_status.ts`: drop `agent_sessions_ws_pane_uq`, recreate **status-aware** (`… WHERE pane_index IS NOT NULL AND status IN ('running','starting')`) so the allocator and the index agree.
  - `runBootJanitor` frees slots (clears the lockout) and is **awaited** before any window/auto-resume/launch.
  - Both UNIQUE-suppression guards **adopt/replace** a dead row (PTY-liveness check) instead of no-op'ing; pre-flight the pane slot **before** worktree creation.
  - Opportunistic throttled `app.lastSession` flush (not quit-only) so a crash loses ≤ a few seconds.
- **Shared:** the immediate one-time DB repair to unblock the operator's currently-broken install (see "0-now" below); the missing tests (worktree-leak-on-UNIQUE, allocator/index agreement, crash-snapshot survival).

**Why now.** It filled the operator's disk and bricked launching — nothing else matters until this is fixed, and it blocks the v2.0.0 tag. The two root causes are intertwined (the DB collision drives the worktree leak loop) but cleave into **file-disjoint lanes** so they parallelize safely.

**Scope (two lanes — file-disjoint by design).**

- **Lane A — disk/worktree (LEAD). Files: `core/git/worktree.ts`, `core/workspaces/worktree-cleanup.ts` only.**
  1. `worktree.ts:39` `WorktreePool.create` — before checkout: count existing dirs under `poolPathForRepo(repoRoot)`, refuse above a cap (≈ 2× `MAX_SWARM_AGENTS`); `fs.statfs` the volume, refuse below a free-disk floor (≈ 2 GB) → throw a typed `WorktreeDiskGuardError`. Harden/confirm `removeAndPrune` (removes dir + `git worktree prune`).
  2. `worktree-cleanup.ts:31-112` — add `sweepAllReposOnBoot()` iterating **all** `<base>/<repoHash>/*` (not just the opened repo); reap dirs with **no** `agent_sessions` row; exclude untracked-ignored `node_modules`/`dist` from the 7-day uncommitted-work protection (they hold no user work); run `git worktree prune` per repo. Keep the existing per-open cleanup but stop it protecting disposable bloat.
  3. Export `removeAndPrune` + `sweepAllReposOnBoot` with signatures agreed with Lane B up front.
- **Lane B — DB infra + persistence (AGENT). Files: `core/db/schema.ts`, new `core/db/migrations/00NN_*.ts`, `core/db/janitor.ts`, `core/workspaces/pane-slots.ts`, `core/swarms/factory-spawn.ts`, `core/workspaces/launcher.ts`, `core/session/session-restore.ts`, `electron/main.ts`, `rpc-router.ts`.**
  1. **Status-aware unique index** (ADR-005): new migration after the latest registered one; mirror `migration 0020:62-67` but add `AND status IN ('running','starting')`. Register in `ALL_MIGRATIONS` (`migrate.ts:80`).
  2. `janitor.ts:40-43` — when marking a zombie `exited`, also reconcile the slot (the status-aware index makes the exited row stop occupying it; keep `pane_index` for resume). `rpc-router.ts:276` — **await** `runBootJanitor()` (+ call Lane A's `sweepAllReposOnBoot()`) before `createWindow`/auto-resume.
  3. `factory-spawn.ts:298-350` + `launcher.ts:478-550` — move `allocateLowestFreeLivePaneIndex` **before** `worktreePool.create`; in the UNIQUE `catch`, `SELECT` the occupying row and if terminal/`!pty.alive` → **adopt** (null/delete old `pane_index` in-txn, retry INSERT) instead of killing the new PTY; on a genuine live race keep the hard-suppress. Add the `worktreePool.removeAndPrune` belt-and-suspenders call here (uses Lane A's primitive). **Sibling twins — change BOTH.**
  4. `pane-slots.ts:22-42` — confirm allocator "live" set == the new index predicate (the invariant).
  5. **Persistence (Fix D):** flush `app.lastSession` on the throttled `app:session-snapshot` IPC (`main.ts:720-723` / `session-restore.ts:78-83`), not only `before-quit`.
- **0-now (immediate operator unblock, lead, optional):** with the app quit, back up `sigmalink.db`, then `UPDATE agent_sessions SET pane_index=NULL WHERE status NOT IN ('running','starting')` (what dormant `migration 0026` does) → relaunch works again before any code ships. Reversible (backup). Operator-authorized.

**Findings + recommendation.** Six read-only agents converged: the disk hog is leaked worktrees (`sigmalink.db` is 768K — never the cause), each ~82M + up to 100s-of-MB of agent-installed `node_modules`; leaked because the UNIQUE catch branches return/`continue` without removing the worktree; the loop's *trigger* is the allocator-vs-status-agnostic-index mismatch. The cleanest root fix is the **status-aware index** (aligns both notions of "occupied") + **await the janitor** + **adopt dead rows**; the disk **safety net** (cap + `statfs` guard + boot sweep + no-row reap + node_modules disposability) makes a 49 GB fill impossible even if a new loop ever appears. Dormant `migration 0026` would repair *this* crash's rows but is a one-shot, not the recurring guard — implement the index instead and let 0026 stay the historical data-backfill. **No Tauri migration** (ADR-006): identical bug under any host language; the fix is ~7–10 h, a rewrite is months.

**Risks.**
- *Lane collision* — both root causes touch `factory-spawn.ts`/`launcher.ts`, so **Lane B owns those files exclusively**; Lane A stays in `worktree.ts`/`worktree-cleanup.ts` and exposes primitives. Worktree-isolated agent for Lane B; FF-align to a shared foundation SHA.
- *Migration safety* — status-aware index is a drop+recreate; H-7 transactional-migration discipline + a MockDb test (vitest can't load better-sqlite3). Don't register 0026 and the new index both as live without deciding which backfills.
- *`statfs` availability* — Node ≥18.15; the app's Node is fine. Guard must fail loud (error session), never silently block a legitimate spawn.
- *Awaiting the janitor* — verify nothing depends on its current un-awaited timing.

**Definition of done.** A scripted N-rapid-relaunch-against-an-occupied-slot test keeps the on-disk worktree count flat (no leak) and a fresh INSTALL into a janitor-swept slot succeeds (no UNIQUE lockout); `WorktreePool.create` refuses past the cap / under the disk floor with a loud error; a force-quit then relaunch restores the open workspaces and spawns new panes; the new tests (worktree-leak-on-UNIQUE in `repoMode:'git'`, allocator/index agreement, crash-snapshot survival) fail before / pass after; `tsc -b` · vitest · lint · build · full `tests/e2e/` green; an **operator smoke confirms a force-quit→relaunch is clean**.

---

## Phase 1 — Bugfix batch (SMK + DEV) · ✅ **SHIPPED** (2026-06-05 `cca05ad`, see `CHANGELOG.md`)

**Goal.** The two most-used entry surfaces (workspace creation, the skills rail) and the browser work correctly; the dev-log is clean.

**Deliverables.**
- **SMK-1/2/3/3b + DEV-5** sessions+skills fixes (per the prior root-cause; DEV-5 multi-provider-same-session folds into the SMK-1/2 sessions packet).
- **DEV-1/2/3** browser fixes (design-pick prompt-seed + drop the `\r`; recents soft-delete + `listRecents`; URL box opens the first tab).
- **DEV-4** workspace-rail order stability (1-line: stop `upsertOpenWorkspace` on `SET_ACTIVE_WORKSPACE_ID`).
- **DEV-6/7/8** dev-infra (zod schema coverage starting with telegram/sync/providers/memory; a real `dev:electron` script + quieter daemon probe; SkillsTab import unification + `manualChunks`).
- The missing tests (un-stubbed Launcher↔SessionStep integration, opencode-scoping unit, browser manager soft-delete).

**Why now.** Confirmed, root-caused bugs; ship right after the crisis, before any feature work touches the same launcher/browser surfaces.

**Scope.** Three file-disjoint lanes: **(a) sessions** (`session-disk-scanner.ts`, `SessionStep.tsx`, `Launcher.tsx`) — SMK-1/2 + DEV-5; **(b) skills** (`core/skills/discovery.ts` new, `controller.ts`, `SkillsTab.tsx`, `insertSkillCommand.ts`) — SMK-3/3b; **(c) browser** (`DesignDock.tsx`, `core/design/controller.ts`, `core/browser/manager.ts`, `db/schema.ts`, `BrowserRoom.tsx`, `AddressBar.tsx`, `BrowserRecents.tsx`) — DEV-1/2/3. DEV-4/6/7/8 are small disjoint extras the lead folds in. Full file:line in the hotlist + `WISHLIST.md`.

**Findings + recommendation.** All statically root-caused with adversarial disproof of the obvious theories. The 3 mirrored `InstalledSkillEntry` sites (SMK-3) and the `\r`-auto-submit (DEV-1) are the subtle ones. Lane (a) and (c) both touch `BrowserRoom`/launcher families lightly — keep them disjoint by file.

**Risks.** SMK-3's plugin-manifest walk (cache pollution + version-dir) is the only non-trivial part — read the manifest, never blind-glob. DEV-2 needs a schema migration (soft-delete column) — H-7 discipline.

**Definition of done.** Fresh workspace defaults to "New session" per pane (no cross-project resume), multi-provider launches one-each; the Skills tab lists ≥2 providers with prefixes, Codex gets `$name`; element-pick dispatches/pastes-without-Enter; closed tabs reopen from recents; the URL box opens the first tab; the rail holds position; `tsc -b` · vitest · lint · build · full e2e green.

---

## Phase 2 — OPT: perf/resource pass + in-place worktree mode · ▶ **NEXT**

**Goal.** The app's steady-state CPU/memory/disk footprint drops sharply, and users who don't need isolation can run with zero worktrees.

**Deliverables.**
- **OPT-1** high-ROI perf subset: **PERF-1** `pty:data` IPC coalescing · **PERF-3** `useAppState` selector granularity (25-consumer re-render storm) · **PERF-6/16** batch/visibility-gate the per-pane `git status` subprocess polling · **PERF-8** async disk-scan · **PERF-5** refcounted Ruflo-health poller.
- **DEV-W3b** per-workspace **in-place / no-worktree mode** (spawn agents in the repo, zero worktrees) — directly removes the Phase-0 disk class for non-isolated use.
- **ruflo-observability** structured logging/metrics for spawn + worktree + disk events (so a future runaway is *caught*, not discovered at 49 GB).

**Why now.** "Huge optimization" was the operator's explicit follow-on ask, and the perf backlog (PERF-1..16) compounds the resource pressure that made the crisis worse. In-place mode is the structural disk win and rides Phase 0's worktree work.

**Scope.** `rpc-router.ts:375` (PERF-1 coalesce) · `state.tsx:137`/`state.reducer.ts` selectors (PERF-3) · `PaneShell.tsx:101`/`git-ops.ts` + `use-git-activity-poll.ts:45` (PERF-6/16) · `session-disk-scanner.ts` async (PERF-8) · `useRufloDaemonHealth.ts:53` (PERF-5). DEV-W3b: a per-workspace `worktreeMode` (`'worktree'|'in-place'`, KV or column) short-circuiting **both** worktree gates (`launcher.ts:224` + `factory-spawn.ts:208` — sibling twins) to the existing no-worktree path (`worktree-cwd.ts:25`).

**Findings + recommendation.** PERF-1/3 are the hottest paths (one IPC per PTY chunk; whole-context re-render per dispatch). In-place mode reuses the already-existing `repoMode!=='git'` no-worktree branch — it's a gate flip + a toggle, not new infra. Surface the "agents share one tree → edits collide" trade in the UI.

**Risks.** Selector migration (PERF-3) is broad — start with the 5 worst consumers. In-place mode's two gates are mirror-drift twins — change both. Measure before/after with `npm run test:perf`.

**Definition of done.** `npm run test:perf` shows a measurable jank/IPC-rate drop; idle CPU with N panes is materially lower; selecting in-place mode spawns agents in the repo root with zero worktree dirs created; spawn/worktree/disk events are logged; gates green.

---

## Phase 3 — Workspace & panel UX quick wins · after Phase 2

**Goal.** The workspace rail and right panel behave the way the operator expects — toggleable, renamable, predictable.

**Deliverables.** **DEV-W1** SigmaLink-logo toggles the workspace rail · **DEV-W2** editable workspace names (the `name` column already exists + is decoupled — add a `workspaces.rename` RPC + inline edit) · **DEV-W4** clicking the already-active right-rail tab closes/collapses the panel (add a persisted `railOpen` state + toggle-on-active) · **DEV-W5** `+Pane` offers a plain terminal + a per-add "create in worktree" toggle.

**Why now.** All small, high-frequency UX papercuts in the chrome the operator uses constantly; cheap after the launcher/worktree work settles.

**Scope.** `sidebar/Sidebar.tsx:242-244` (logo button → existing `setCollapsed`) · `core/workspaces/factory.ts` + `rpc-router.ts:1317` + `WorkspacesPanel.tsx:223` (rename) · `right-rail/RightRailContext.{tsx,data.ts}` + `RightRailSwitcher.tsx:59` + `RightRail.tsx:180` (railOpen) · `AddPaneButton.tsx:247-282` + `factory-spawn.ts` `skipWorktree` (plain terminal via `pty.spawnScratch` + worktree toggle).

**Findings + recommendation.** DEV-W1/W2/W4 are near-trivial and isolated (state machinery already exists). DEV-W4 has two operator-decision sub-asks — **decision (revisit if wrong): Jorvis "minimize" = collapse-to-strip (same close mechanic); Settings tab returns to the last non-settings room** (recoverable from `roomByWorkspace`). DEV-W5's "agent-less pane" reuses the `providerId:'shell'` sentinel.

**Risks.** `railOpen` touches shared right-rail context + persistence — net-new tests. The DEV-W5 worktree toggle + DEV-W3b in-place mode overlap — share the `skipWorktree` plumbing (do W3b first in Phase 2).

**Definition of done.** Logo click toggles the rail; a renamed workspace persists (folder unchanged); re-clicking the active right-tab closes the panel and any tab re-opens it; `+Pane` can add a plain terminal and choose worktree on/off; gates green.

---

## Phase 4 — Pane chrome + grid (mirror BridgeSpace) · after Phase 3

**Goal.** Pane headers look clean (a faithful BridgeSpace copy) and the pane grid resizes/reflows smoothly without resetting.

**Deliverables.** **DEV-L1** pane-header redesign → `[identity pill][branch pill] … [glyph cluster]` (collapses today's ~9-13 affordances / dot-soup) · **DEV-L2** grid stickiness — preserve pane fractions across add/remove + persist per-workspace + animated reflow · **BSP-F1** single-accent active-pane focus ring · **BSP-F2** dim per-pane footer status line · **BSP-P2** branch pill · **BSP-P3** human-name alias + effort tier on the header chip.

**Why now.** The operator's explicit "pane titles are ugly / mirror BridgeSpace" ask; rides the same files as the other FE polish steals.

**Scope.** `command-room/PaneHeader.tsx` + `PaneShell.tsx` (header → pill+glyph; fold the 3 dots into one status glyph) · `command-room/GridLayout.tsx:92-93` (stop the hard fraction reset; proportion-preserving reflow) + per-workspace fraction persistence (reuse the rail-width KV pattern) + a reduced-motion-gated grid-template transition · `PaneFooter.tsx` (F2). **Prerequisite: capture fresh BridgeSpace reference frames at build time** (D187 00:33:20 / D188 00:03:00) — do NOT guess pixel/timing values.

**Findings + recommendation.** Header handlers/dropdowns/popovers stay; this is markup/Tailwind restructuring (preserve `data-testid`/`aria-label` selectors or update tests in lockstep). Grid rigidity is one root cause (`:92-93` resets all fractions) — fix within CSS-grid, NOT a Canvas rewrite (BSP-P4 stays deferred).

**Risks.** `PaneHeader.test.tsx` + `GridLayout.test.tsx` assert current behavior — update in lockstep. Don't redefine theme tokens here (Phase 5's job).

**Definition of done.** Pane header matches the BridgeSpace reference (pill + glyph cluster, no dot-soup); adding/removing a pane preserves proportions and persists across re-entry; reflow animates (reduced-motion-safe); gates green.

---

## Phase 5 — Appearance theme-gallery + per-workspace tint
**Goal.** Themes are chosen from a live card-gallery; each workspace can carry its own tint.
**Deliverables.** **BSP-T3** `AppearanceTab` card grid (live preview cards + All/Dark/Light filter + search + `✓ ACTIVE`) · **BSP-T4** per-workspace tint (KV → `--surface-tint`/`--accent`).
**Why now.** Surfaces Phase-1's 15 themes; reuses the selectable-preview-card pattern.
**Scope.** `features/settings/AppearanceTab.tsx` (list → responsive card grid; previews as lightweight static mock markup, lazy-mount); per-workspace tint in workspace KV applied on open (respect the GLOBAL boot reader).
**Findings + recommendation.** AppearanceTab is already controlled+search-aware (ONB-1); live-ish cards are the high-value detail.
**Risks.** N themed sub-trees = render cost → static mock previews, not real panes.
**Definition of done.** Gallery shows every theme as a preview card; filter+search narrow; selecting sets theme; per-workspace tint persists + doesn't leak across workspaces; gates green.

---

## Phase 6 — Premium Jorvis FE (N3, B3-unblocked)
**Goal.** The Jorvis assistant feels premium: streamed reveal, animated bubbles, inline tool chips.
**Deliverables.** rAF catch-up token reveal + in-flight `ChatMessageView`; first-mount-only spring bubble-enter; reduce-motion-gated typewriter+caret; per-turn tool-chip rail; the backend incremental-delta emit (today whole blocks).
**Why now.** B3 is fixed (v2.0.0) unblocking N3; FE quality is the cycle through-line.
**Scope.** Backend `core/assistant/cli-envelope.ts`/`emit.ts` (incremental deltas first) → renderer `jorvis-assistant/use-jorvis-stream-reveal.ts` + `InlineToolChips.tsx` + `ChatTranscript.tsx`.
**Findings + recommendation.** Streaming is fake today (whole-block emit) — the backend delta is the prerequisite. First-mount-only spring (React-19 lesson).
**Risks.** Per-token re-render storms → rAF-batch + reduce-motion gate + cap rate.
**Definition of done.** A live reply streams token-by-token with a caret, bubbles spring once, tool calls render as chips; reduce-motion shows instant text; a hung turn still clears via the watchdog; gates green.

---

## Phase 7 — Worktree GUI + multi-workspace-same-dir
**Goal.** Creating/working in worktrees is GUI-driven; you can open >1 workspace on one directory.
**Deliverables.** **BSP-G1** "Create Git Worktree" modal · **BSP-G3** "open in current pane" (cwd-swap vs spawn) · **BSP-P1** pane right-click context menu · **DEV-W3a** multiple workspaces on the same dir (drop `workspaces_root_idx` + fork the open-dedup; depends on DEV-W2 names for disambiguation).
**Why now.** We own the worktree engine; the gap is UI. W3a rides the same workspace-identity surface.
**Scope.** New modal in `renderer/command-room/*` over `core/git/worktree.ts`; context menu in `PaneHeader`/`PaneShell`; W3a = migration to drop the unique index + `factory.ts:81-89` open-flow rework (keep UUID identity).
**Findings + recommendation.** Mostly renderer + 1 RPC; "open in current pane" needs a cwd-swap distinct from spawn. W3a is the heavier half — sequence after W2.
**Risks.** cwd-swap mid-session corrupting pane state → only for idle panes. W3a: MCP autowrite writes per-path (two same-dir workspaces share config — harmless, document).
**Definition of done.** Right-click → Create worktree modal works; "open in current pane" re-homes an idle pane; two workspaces on one dir coexist (distinguishable via custom names); gates green.

---

## Phase 8 — In-app Git diff / Review panel
**Goal.** Browse diffs and review changes inside SigmaLink.
**Deliverables.** **BSP-G2** Git panel (Changes/History, staged/unstaged, inline diff, branch selector, pop-out) · **BSP-G4** ahead/behind · **BSP-G5** post-swarm auto-teardown policy (keep-all / keep-passing / destroy-failing).
**Why now.** Worktree-native yet no in-app diff viewer — the biggest feature gap the teardown surfaced.
**Scope.** New `renderer/features/review/*` over existing `core/git/git-ops.ts` + `core/review/*`; ahead/behind via `git rev-list --count`; teardown hooks C-7 post-gate; reuse Resizable + Phase-7/10 pop-out plumbing.
**Findings + recommendation.** Data layer exists; mostly a renderer surface + 2 small RPCs. Spec the layout + big-diff virtualization first.
**Risks.** Large-diff render cost → virtualized list + lazy per-file diff + "show more".
**Definition of done.** Panel shows staged/unstaged + inline diff + ahead/behind; auto-teardown destroys only failing worktrees; pop-out works; gates green.

---

## Phase 9 — Orchestration & memory surfacing
**Goal.** The Sigma orchestrator + Ruflo memory are first-class persistent surfaces.
**Deliverables.** **BSP-O1** persistent chrome-level "Sigma" rail panel (Canvas: numbered to-dos + live token delta + Review tab) · **BSP-O2** live routing trace · **BSP-O3** "Automations" nav · **BSP-O4** "Artifacts" + per-conversation named sessions · **BSP-O5** surface the Ruflo graph prominently.
**Why now.** Defends our shipped strengths (C-7, MEM-1 graph) before BridgeBoard ships.
**Scope.** Extract `operator-console/OrchestratorPanel.tsx` → `right-rail/*` persistent tab; Canvas from `shared/orchestrator-tasks.ts`/`plan-capsule.ts`; routing trace from Ruflo `hooks_route`; Artifacts in `core/memory/*`.
**Findings + recommendation.** O1 is a relocation+persistence packet, not a rebuild; O3/O4 net-new medium.
**Risks.** Right-rail real-estate contention → tabbed rail + collapse when narrow.
**Definition of done.** Sigma panel persists across layouts with live to-dos + token delta; a routing decision is visible; the graph is ≤1 click from any room; gates green.

---

## Phase 10 — Voice / model & browser depth
**Goal.** Cloud STT choice, live cost/speed visibility, a more capable embedded browser.
**Deliverables.** **BSP-V1** multi-provider STT picker · **BSP-V2** live per-pane tok/s + cost + fast/balanced/deep dispatch preset · **BSP-B2** browser detach-to-monitor / reattach · **BSP-B3** agent-drivable headless-browser skill · **BSP-B4** the embedded-browser focus audit (from the hotlist).
**Why now.** Rounds out voice/model transparency + opens "agent-native testing".
**Scope.** `resolveTranscriptionEngine` + voice settings (V1); pane-header tok/s+cost off SigmaBench + `+Pane` preset (V2); `core/browser/*` detach + a skill exposing browser RPCs (B2/B3); `WebContentsView` focus-forwarding audit (B4).
**Findings + recommendation.** V2 builds on the usage ledger + SigmaBench; B3 reuses the embedded browser + skills system; B2 shares Phase-8 pop-out plumbing.
**Risks.** B3 = SSRF/abuse surface → H-19 aidefence gate + https/same-origin allowlist + setting-gated.
**Definition of done.** STT switch works; a running pane shows live tok/s + $; an agent can navigate+evaluate the browser under the gate; browser detaches to a 2nd monitor; gates green.

---

## 🧊 Deferred (XL / big-bang — held per the DDD small-per-packet rule)
- **BSP-P4 — Canvas mode** (freeform draggable panes). XL — layout-engine rewrite. Leapfrog if shipped before BridgeCanvas.
- **BSP-P6 — multi-window / dual-window**. L–XL — multi-`BrowserWindow`. (Phase 10 B2 delivers the browser-only slice.)
- **BSP-P5 — workspaces-as-tabs** top strip. S, but a layout-shell change — fold into a future shell pass.
- **Tauri/Rust platform migration.** Evaluated + rejected for now (ADR-006) — the disk leak is a logic bug, not a platform limit; a rewrite is months for zero benefit on it. Revisit only if idle-RAM/binary-size become a strategic priority, as its own cycle.

## ✅ Skip / market better (already shipped — do NOT rebuild)
Session-resume modal ≈ **FEAT-1** · per-pane usage/cost ≈ **FEAT-3** · per-agent identity ≈ **FEAT-7** · effort control ≈ **FEAT-14** · browser-in-separate-window ≈ **C-8** · 30-sub-agent plan→review→build ≈ **C-7** · MCP autowrite per-CLI = **SF-7**. **WE LEAD & they lack:** worktree isolation, 6 providers, SigmaBench, Obsidian memory graph, voice **dispatch**, Telegram remote, agent rewind, sub-agent depth control. Positioning: **"ADE — Agent Development Environment"** + **"Context layer"**.

## ✅ Shipped this cycle (do NOT rebuild)
- **Phase-1 themes (BSP-T1/T2)** — 15 themes (Clean family + Glass Spectrum), PR #104 `f78c6e0`, CI green, operator-confirmed. → promote to CHANGELOG/memory on wrap-up.

## 🚧 Blocked / operator-owned (parked)

| # | Item | Status |
|---|------|--------|
| **rel** | v2.0.0 tag — now gated on Phase 0 + a force-quit smoke | operator-owned |
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | 🚧 needs an operator Windows device |
| **B2** | FE-4 voice items | 🚧 behind unshipped native voice builds |
| **op** | SF-12 migration `0026` register | folds into Phase 0 (historical backfill companion to the status-aware index) |
| **op** | FE-4 device a11y QA | needs the device |

---

## Architecture decisions (ADRs)

### ADR-001 — Theme variations are a tint/opacity layer, not N hand-authored themes
**Decision.** Model Glass variations as override tokens (`--surface-tint`, `--accent`, `--glass-image-opacity`) over a base `data-theme`. **Context.** BridgeSpace ships 23 themes by varying backdrop+accent over one base. **Consequences.** (+) one var → N looks; cheap per-workspace tint. (−) a radically different look (Clean) must be its own family.

### ADR-002 — "Clean/Clear" is its own flat-opaque family, separate from Glass
**Decision.** Clean is a distinct family (flat, opaque, zero-shadow, single amber ring), not a Glass tint. **Context.** Visual opposite of Glass depth. **Consequences.** (+) honest token semantics. (−) two families to maintain; audit `.sl-glass` consumers.

### ADR-003 — Defer Canvas mode + multi-window (XL) per the small-per-packet rule
**Decision.** Park BSP-P4 (Canvas) + BSP-P6 (multi-window); ship the browser-detach slice (B2) only. **Consequences.** (+) shippable increments. (−) BridgeCanvas could ship first — accepted.

### ADR-004 — Disk safety is a defense-in-depth net, independent of the spawn-loop fix
**Decision.** Even after the DB collision loop is fixed (Phase 0 Lane B), keep a hard worktree-count cap + `fs.statfs` free-disk floor + boot/periodic all-repo sweep + no-`agent_sessions`-row reaper + node_modules-as-disposable (Lane A). **Context.** The 49 GB fill had two multipliers (full checkout + agent installs) and no ceiling anywhere. **Consequences.** (+) a single guarantee the disk can never fill regardless of future loops. (−) a cap/floor can refuse a legitimate spawn under genuine disk pressure — must fail loud, not silent.

### ADR-005 — `agent_sessions` pane-slot uniqueness is status-aware
**Decision.** The partial unique index `agent_sessions_ws_pane_uq` includes `AND status IN ('running','starting')`, so the index's notion of "slot occupied" matches the allocator's. **Context.** The status-agnostic index (`migration 0020`) + a live-only allocator disagreed → permanent post-crash lockout. **Consequences.** (+) fresh spawns into a janitor-swept slot succeed; exited rows keep `pane_index` for resume. (−) a new migration (drop+recreate); dormant `0026` becomes the one-shot data backfill, not the recurring guard.

### ADR-006 — Stay on Electron; do NOT migrate to Tauri/Rust for this
**Decision.** Fix the disk leak in-codebase; do not migrate to Tauri/Rust. **Context.** The "memory leak" was a **disk** leak from a logic bug (missing worktree cleanup + allocator/index mismatch) — reproducible identically under any host language; `git worktree`/SQLite behave the same. **Consequences.** (+) ~7–10 h fix vs a multi-month rewrite of the entire main process (better-sqlite3, node-pty, RPC router, voice natives). (−) we keep Electron's ~150–250 MB idle-RAM baseline; a Tauri eval stays a deferred, separate-cycle option if binary-size/idle-RAM become strategic.

### ADR-007 — Optional per-workspace in-place (no-worktree) mode
**Decision.** Offer a per-workspace `worktreeMode: 'worktree' | 'in-place'`; in-place reuses the existing `repoMode!=='git'` no-worktree path so agents run in the repo root. **Context.** Worktrees are the disk-cost + the leak surface; not every workflow needs isolation. **Consequences.** (+) zero worktrees for users who opt in (disk win). (−) agents share one tree → concurrent-edit collisions; surface the trade in the UI; both worktree gates must honor it (sibling twins).

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| **CRIT-1 disk-leak (Lane A)** | **0** | **L** | **Critical** | **Worktree cap + statfs guard + boot sweep + no-row reaper — LEAD** |
| **CRIT-2 launch-lockout (Lane B)** | **0** | **M** | **Critical** | **Status-aware index + await janitor + adopt dead rows — agent** |
| **CRIT-3 persistence (Lane B)** | **0** | **M** | **High** | **Opportunistic snapshot flush — agent** |
| SMK-1/2/3/3b + DEV-5 | 1 | M–L | High | Sessions + skills bugfix |
| DEV-1/2/3 browser | 1 | M | Med | Design-pick, recents, URL box |
| DEV-4/6/7/8 | 1 | S | Med | Rail order, zod, dev-URL, bundle |
| OPT-1 perf subset | 2 | L | High | PERF-1/3/5/6/8/16 |
| DEV-W3b in-place worktree mode | 2 | M | High | Structural disk win |
| DEV-W1/W2/W4/W5 workspace+panel UX | 3 | M | High | Logo toggle, rename, rail toggle, +Pane |
| DEV-L1/L2 + BSP-F1/F2/P2/P3 pane chrome+grid | 4 | M–L | High | Mirror BridgeSpace; needs ref frames |
| BSP-T3/T4 theme gallery | 5 | M | High | Live preview cards |
| Premium Jorvis FE (N3) | 6 | L | High | Needs backend token-stream |
| Worktree GUI (G1/G3/P1) + DEV-W3a | 7 | M–L | High | Engine exists; UI gap |
| Git diff/Review panel (G2/G4/G5) | 8 | L | High | Biggest feature gap; spec first |
| Orchestration+memory (O1–O5) | 9 | L | Med-High | Relocate C-7 + surface graph |
| Voice/model+browser (V1/V2/B2/B3/B4) | 10 | M-L | Med | B3 needs security gate |
| Canvas mode (P4) / Multi-window (P6) / Tauri eval | deferred | XL | — | Big-bang, separate cycles |

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; mark it promoted/struck in `WISHLIST.md`; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings.
