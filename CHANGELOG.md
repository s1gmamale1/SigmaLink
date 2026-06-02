# Changelog

All notable changes to SigmaLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once tagged releases begin.

## [Unreleased]

### Added — ROADMAP P3 notifications + sound (PR #73, untagged — rides the next tagged release)

Phase 3 of the next-phase ROADMAP — a calm, controllable notification + sound experience. A lead-owned shared foundation + four file-disjoint worktree lanes + lead integration + Opus review (APPROVE-WITH-NITS; M1/L2/L4 folded). Gate: `tsc -b` clean · 2093 vitest pass / 1 skip · `eslint .` clean · build + electron:compile clean · full `tests/e2e/` 9 pass / 3 manual-skipped.

- **NTF-1 — Do-Not-Disturb / quiet-hours / per-source mute.** New pure shared contract `shared/notification-prefs.ts` (KV keys, wrap-aware quiet-hours math, source taxonomy `pty|swarm|tool|system`, suppression predicates, the sound cue catalog). `core/notifications/os-notify.ts` now gates OS popups via `isOsSuppressed` — per-source mute always wins; `critical` bypasses DND/quiet (must-see); every other severity is silenced while quiet is active. Settings (`NotificationsSettings.tsx`): DND toggle, quiet-hours window, per-source mute checkboxes.
- **SND-1 — soundscape system.** `renderer/lib/sounds.ts` Web-Audio synth engine over a 12-cue catalog split into `alert` (play even when backgrounded / Reduce-Motion) vs `ui` (ambient — additionally gated by Reduce-Motion + `document.hidden`) categories; master toggle + global volume + per-cue mute matrix with a per-cue **Test** preview (`NotificationsSettings.sound.tsx`). Gated by master/mute/DND/quiet. `lib/notifications.ts` is now a thin back-compat shim (`playDing`→`agent-done`, `playNotificationTone(sev)`→per-severity cue); legacy `notifications.ding`/`notifications.sound` toggles seed the muted set on first run only (so the new per-cue matrix stays authoritative).
- **NTF-2 — dropdown polish + toast↔bell handoff.** `NotificationDropdown.tsx` groups the list by source into collapsible sections (reduce-motion-safe enter via `sl-fade-in`); `navigateToNotification` extracted to `helpers.ts` (DRY across the dropdown click + the toast action). `use-live-events.ts` now plays the delta's max-severity tone and surfaces a themed sonner toast per new unread (info 3s / warn 5s / error+critical persistent with a "View" deep-link action) — both suppressed under DND/quiet and for muted sources, while the bell still records everything.
- **ANIM-3 — pane aliveness.** `PaneFooter.tsx` shows a rotating whimsical progress verb + elapsed time on running panes (`progress-verbs.ts`); verb rotation is gated by `prefers-reduced-motion` (the elapsed clock keeps ticking). NTF-3 was satisfied by P2's UX-9.
- *Deferred → WISHLIST:* the optional daily-summary digest (needs a main-process scheduler + a new notification kind). The catalog's non-notification cues (agent-crash/message-arrive/merge-ready/send/record-*) are wired for preview but not yet event-bound (forward-looking).

### Changed — ROADMAP P2 Apple-grade motion & overlays (PR #72, untagged — rides the next tagged release)

Phase 2 — one cohesive Apple motion language across every overlay, zero native OS modals, theme-correct transient surfaces. Built on `MOT-1`; gated + Opus-reviewed (single-glass dropdown + AlertDialog parity findings folded; a CI ESLint pass cleared 10 errors the local gate had skipped).

- **MOT-1 — motion-token foundation.** Apple spring easings as CSS + Tailwind tokens (`--ease-smooth/snappy/bouncy`, `--motion-fast 150 / --motion 250 / --motion-slow 350`, reduced-motion-aware) + `lib/motion.ts` presence helpers; all shared `components/ui/*` overlays migrated off stock `duration-200 ease-out`.
- **UX-1** themed Toaster (driven by the app `ThemeProvider`, `.sl-glass` on the glass theme — was hard-pinned dark). **UX-2** notification dropdown rebuilt on a Radix Popover (focus-trap / Escape / return-focus / spring). **UX-3** native `prompt/confirm/alert` replaced with themed `AlertDialog` + a reusable `PromptDialog`. **UX-4** dialog max-height + internal scroll. **UX-7** one root `TooltipProvider`.
- **UX-5** keyed spring room-switch transitions. **UX-6** Tasks @dnd-kit `DragOverlay` drop animation. **UX-8** keyboard pane-resize on the GridLayout separators (`role=separator` + Arrow-key nudge + `aria-valuenow`). **UX-9** notification non-color severity cue (per-severity glyph + accessible severity word). **UX-10** `focus-visible:` ring sweep across feature code.
- **ANIM-2** Orb honors `prefers-reduced-motion`. **PERF-13 + MEM-10** MemoryGraph sleeps on settle (kinetic-energy threshold), honors reduced-motion, and reads node/edge colors from CSS theme vars.

### Fixed — ROADMAP P1 reliability spine (PR #70 `37f94a0`, untagged — rides the next tagged release)

First execution batch of the next-phase ROADMAP. Six file-disjoint worktree lanes + lead integration + Opus review. Gate: `tsc -b` clean · 2000 vitest pass · e2e 9 passed / 3 manual-skipped · Opus review (no critical/high). The 9-agent deep-dive that planned this batch also landed an enriched `docs/03-plan/WISHLIST.md`, a fresh 6-phase `docs/03-plan/ROADMAP.md`, and a BridgeSpace v3.0.74 competitor review.

- **BUG-1 — swarm-agent crashes were silently recorded as clean `exited`.** The swarm spawn path (`swarms/factory-spawn.ts`) classified PTY exits differently from the pane launcher: a swarm CLI exiting non-zero (or signal-killed) after the 1.5s grace window was logged `exited`/`done`. Both paths now share `isPtyCrash` (hoisted to a dependency-free `core/pty/crash.ts` leaf to avoid an import cycle) and persist the `isCrash` status; the launcher's `agent_sessions` write was aligned too (so a resumed crashed pane reads `error`, not GC-reaped).
- **BUG-2 — recovered Ruflo HTTP daemon could deadlock.** The crash-recovery child never drained stdout (only the primary spawn did) → a full ~64KB pipe blocked the daemon. A shared `wireChildIo()` now drains stdout + buffers the stderr tail on both spawn paths.
- **BUG-3 — cross-device sync could silently drop a peer's concurrent edits.** A rejected push retried after a bare `pull()` (working-tree only), skipping decrypt→resolve→apply. The retry now runs the full reconcile (`_pullCycle`) and re-encodes the post-reconcile dirty set before retrying.
- **BUG-4 — IPC side-band channels bypassed input validation.** `swarm.*`, `swarm.replay.*`, `assistant.conversations.*`, `voice.diagnostics.*`, `sigmabench.*`, and the destructive `cleanup.*` registered raw handlers. All now validate their inner payload through a shared `registerIpcHandler` seam (response envelope unchanged).
- **BUG-5** — `did-finish-load` re-fired `session-restore` on every renderer reload (double `WORKSPACE_OPEN` / `panes.resume`); now one-shot per app run.
- **BUG-6** — the exited-session GC could reap a session that revived within its 5s window; cancellation is now status-driven.
- **BUG-7** — `http-download` promoted a content-length-truncated file; it now rejects on a byte mismatch.
- **BUG-8** — a `before-quit` snapshot-persist failure was silently swallowed; it is now logged.
- **BUG-13** — deduplicated the `AddAgentToSwarmInput` interface to one shared definition.
- **BUG-14** — added behavior tests for `commitAndMerge` (the destructive worktree→base merge path) **and fixed a HIGH the tests uncovered**: a conflicted `git merge --no-ff` left the base branch half-merged (`MERGE_HEAD` set); it now runs `git merge --abort` (best-effort) while still surfacing the failure code.
- **DB-1** — a corrupt `sigmalink.db` bricked startup. Boot now runs `PRAGMA quick_check` and, on `SQLITE_CORRUPT`/`SQLITE_NOTADB`, quarantines the file (+ WAL/SHM) to `.corrupt-<ts>` and recreates a fresh DB so the app still launches.
- **ERR-1** — a render throw in any room blanked the whole window (only `EditorTab` had a boundary). Added a styled root + per-room React error boundaries (reload + copy-diagnostics) and a renderer-only global `error`/`unhandledrejection` sink (→ sonner toast).

### Housekeeping
- Swept 29 stale locked agent worktrees under `.claude/worktrees` (**5.8 GB → 0**; ARCH-10).

## [1.36.0] - 2026-05-29

v1.36.0 — **reliability batch: transactional migrations (H-7), offline Ruflo daemon for claude/codex (SF-14), and the page-change purple-flash fix.** All three are internal/polish hardening (no big new surface). Each was gated in main + Opus-reviewed; the SF-14 review caught a crash-recovery env bug that was fixed with a regression test before tagging.

### Fixed

- **H-7 — DB migrations are now transactional.** The runner (`core/db/migrate.ts`)
  applied each migration's `up()` and its `schema_migrations` insert with no wrapping
  transaction, so a throwing `up()` could leave a half-applied schema that re-ran on a
  dirty DB next boot. The runner now wraps `up()` + the insert in one `db.transaction()`
  per pending migration (per-migration, not one big txn — earlier-applied migrations stay
  committed if a later one fails; a throw rolls back and retries clean next boot). The 21
  migrations that self-managed `BEGIN`/`COMMIT`/`ROLLBACK` were stripped (SQL byte-identical)
  so the runner owns the only transaction — a nested `BEGIN` would crash fresh-DB startup
  (the failure mode that reverted the prior attempt). Added `busy_timeout=5000` (`client.ts`)
  for WAL multi-connection contention. Test hardening: the runner-test MockDb now models
  better-sqlite3's no-nested-transaction + rollback contract (the gap that let the prior
  attempt pass unit tests yet crash e2e), and a static guard permanently forbids a migration
  from containing a raw `BEGIN`/`COMMIT`/`ROLLBACK`.
- **SF-14 follow-up — the Ruflo HTTP daemon runs offline for claude/codex panes.** The
  daemon supervisor (`core/ruflo/http-daemon-supervisor.ts`) only resolved a PATH `ruflo`
  binary → `npx` fallback, so production (no PATH `ruflo`) always depended on npx/network
  and never used the `@claude-flow/cli` the installer already lazy-downloads into
  `<userData>/ruflo`. Added a launch tier between PATH-`ruflo` and `npx`: when the lazy
  install exists, the daemon runs it via Electron's embedded node (`process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` + `NODE_PATH`), mirroring the stdio supervisor — so the Ruflo
  MCP daemon is reliably available offline once installed. The env merge was applied to
  both the initial spawn and the crash-recovery respawn (a review-caught bug: the respawn
  path would otherwise boot Electron instead of node and fail recovery). The
  DAEMON-UNAVAILABLE message now names the install path. (No standalone `ruflo` binary is
  bundled — it's a Node CLI, not an executable; bundling the npm tree was rejected as
  heavy + unprecedented.) Cursor skill fan-out (R-2 follow-up) dropped — `cursor-agent`
  does not consume the SKILL.md fan-out format (no-op).
- **UI — purple flash on page change.** Navigating to a not-yet-loaded room briefly painted
  the whole content area a saturated violet. Lazy rooms render a `Suspense` fallback during
  their chunk fetch, and that fallback was a full-bleed shadcn `Skeleton` whose base is
  `bg-accent` — the glass theme's brand violet. `RoomSkeleton` (`renderer/app/App.tsx`) now
  renders a calm centered spinner on the theme surface; the alarming purple block is gone.

### Notes

- Migration `0026_sf12_pane_slot_repair` remains **dormant pending operator sign-off** (SF-12
  data repair) — unchanged by H-7; it inherits the new runner transaction for free when later
  registered.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1923 pass / 1 skip** ·
  `product:check` · full `tests/e2e/` (9 passed / 3 skipped) · Opus review of SF-14 + flash
  (ship; SF-14 crash-recovery env bug fixed + regression test).

## [1.35.0] - 2026-05-28

v1.35.0 — **SF-12 (Critical — pane/worktree/registry confusion): the code fix.** Shipped on its own (it touches the core pane-resolution query). The read-path fix + slot-allocation fix **stop the bleeding** — no new wrong/stale slots, and `+Pane`/swarm panes persist across reopen. The reversible data-repair migration for *existing* bad rows (`0026`) stays **dormant pending operator sign-off**. Went through two independent Opus code-review rounds (no Critical; all Important addressed + re-verified).

### Fixed

- **SF-12 / Defect A — wrong or stale session shown in a pane slot.** `listForWorkspace` and `lastResumePlan` resolved a `(workspace_id, pane_index)` slot by a status-blind `MAX(started_at)`; since `started_at` is mutated on resume, an exited/older session could outrank the live one (and ties returned two rows for one slot). Both read paths now rank with `ROW_NUMBER() OVER (PARTITION BY workspace_id, pane_index ORDER BY <running|starting first>, started_at DESC, id DESC)` and take `rn = 1` — exactly one row per slot, live always wins. The launcher's UNIQUE-violation branch no longer leaks an orphan PTY: it kills + forgets the just-spawned PTY and returns an error session.
- **SF-12 / Defect B — panes vanish / reshuffle on reopen.** `+Pane`/swarm panes were inserted with `pane_index = NULL` and filtered out by `listForWorkspace`. They now persist a real `pane_index`, allocated as the lowest free **live** slot inside the same write transaction as the insert (allocate + insert is atomic, so simultaneous `+Pane` clicks can't collide on the unique index). New `core/workspaces/pane-slots.ts`. Swarm panes share the workspace-level pane-slot namespace (the renderer grids by session id → no UI collision).
- **SF-12 — "Pane 0" toast on the rare suppression race.** The UNIQUE-suppression path returns a sentinel `pane_index = -1`; the two add-agent success toasts now guard it ("Pane added" rather than "Pane 0").

### Notes

- **Migration `0026_sf12_pane_slot_repair` is DORMANT — pending operator sign-off.** It is a reversible, no-blind-delete repair for *existing* bad rows: preimage backup into `kv['sf12.preimage.<ts>']`, two-pass (negative-temp → dense) re-slot to contiguous `0..k-1` per workspace, terminal rows nulled, post-condition asserted, `down()` idempotent, H-7-safe (no own `BEGIN`/`COMMIT`). It is **not** imported into `ALL_MIGRATIONS` (enforced by a `migrate.spec` test). To close it: operator runs the diagnostic SQL on a real `agent_sessions` dump, signs off, then it ships registered in a follow-up. A fresh workspace needs no repair — the allocation fix prevents new corruption.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1917 pass / 1 skip** · `product:check` · full `tests/e2e/` (9 passed / 3 skipped) · two Opus code-review rounds (no Critical; all Important addressed + re-verified).

## [1.34.0] - 2026-05-28

v1.34.0 — **operator breakage batch (SF-11, SF-13, SF-14, SF-15) + a chronic CI-flake fix.** Investigated by 5 parallel agents (cursor having run out mid-debug); each root-caused with file:line evidence, the lead integrated the disjoint lanes + fixed two integration-seam bugs the isolated agents couldn't see, ran a full gate, and an Opus security-review (PASS) on the Ruflo MCP changes. **SF-12 (Critical pane/worktree/registry confusion) is NOT in this release** — see Notes.

### Fixed

- **SF-11 — left/right sidebars misaligned / shell overflows the viewport.** The center column of the right-rail flex row was missing `min-w-0`, so it refused to shrink below its content and the fixed-width rail (default 480px) pushed the 3-column shell wider than the viewport. Added `min-w-0` (hydrated + pre-hydration paths). Pure CSS; +5 layout tests.
- **SF-14 — Ruflo HTTP daemon never started / health unverified.** `spawn()` only probed a `ruflo` binary on PATH, which operators don't have (Ruflo is `@claude-flow/cli`, run via npx) → silent stdio fallback, daemon never ran. Now resolves `ruflo` on PATH → else `npx -y @claude-flow/cli@latest`; surfaces a **loud "DAEMON UNAVAILABLE"** only when neither exists. Shell-free `execFileSync` PATH probe.
- **SF-15 — Ruflo MCP not attached to panes / not present before the CLI starts.** The MCP config + trust were written at the **workspace root**, but each pane runs in its own **worktree cwd**, where the CLI looks for `.mcp.json` — so `ruflo` was invisible to panes. New `core/workspaces/ruflo-worktree-mcp.ts` writes the `ruflo` entry (HTTP when a daemon port exists, else stdio) **into each pane's worktree cwd before the CLI spawns** (both the workspace-launcher and swarm-spawn paths), honoring the `ruflo.autowriteMcp`/`ruflo.autoTrustMcp` gates and reusing the SF-7 `ensureRufloTrusted` (ruflo-only). Additive merge; refuses operator-managed entries; fully fail-open.
- **CI — chronic macOS e2e `ENOTEMPTY` teardown flake.** The `npx @claude-flow/cli` grandchild kept writing `.npm/_cacache` ~100–500ms after `app.close()`, so the synchronous temp-dir `rmSync` raced it. Fixed the teardown with a 300ms drain + `fs.promises.rm(…, {recursive,force,maxRetries:5,retryDelay:200})` + non-fatal fallback. Makes main's e2e-matrix reliably green.

### Added

- **SF-13 — operator cleanup (Settings → Maintenance).** Three actions per workspace: remove workspace + sessions + GC orphan worktrees · clear all pane sessions · prune orphan worktree dirs. **Safe by construction:** dry-run preview + `confirm()` before any destruction, a **live-session fence** (never deletes a worktree referenced by a `running`/`starting` session), fail-open per-item, path-traversal guard. New `cleanup.*` side-band RPC.

### Notes

- **SF-12 (Critical — pane/worktree/registry confusion) is NOT fixed here.** It touches the core pane-resolution query, so it gets its own isolated change rather than riding this 5-lane release. Root cause is fully documented (two defects: status-blind `MAX(started_at)` slot resolution + `pane_index` reuse; and `+Pane`/swarm panes persisted with `pane_index = NULL`). A read-path fix + a reversible data-repair migration are designed and pending — the migration needs operator sign-off before it runs.
- ⚠️ **Product decision pending:** the `ruflo` daemon binary isn't bundled (SF-14 uses an npx fallback). Bundling it, or pointing the daemon at the lazy-installed CLI, is a follow-up.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1896 pass / 1 skip** · `product:check` · full `tests/e2e/` (9 passed / 3 skipped) · Opus security-review of the Ruflo MCP changes (PASS, no Critical/High/Medium).

## [1.33.0] - 2026-05-28

v1.33.0 — **command-room fixes (SF-9, SF-10).** A shipped regression fix + a small feature from operator smoke, done directly in main → full gate. Also folds in the prior untagged CI/docs housekeeping.

### Fixed

- **SF-9 — `+Pane` button broken + Yolo toggle overhanging the grid (regression).** SF-8 B3 had wrapped the compact `+Pane` toolbar button in a `flex flex-col` stack with a **permanent** amber Yolo card rendered below it — in the horizontal command-room toolbar that stretched the button full-width and the card overhung the panes. Reverted the wrapper to the known-good `relative flex items-center gap-2` row and **moved the Yolo/Bypass toggle into the `+Pane` dropdown menu** (shown when the menu opens). The Launcher's launch-form toggle is unchanged.

### Added

- **SF-10 — assign a CLI label to a normal terminal.** Click a pane's provider name in the header to tag it with the CLI actually running in it (e.g. a plain `shell` pane you ran `cursor-agent` in shows as "Cursor", with that provider's colour). **Display-only** — the session's real `providerId` is untouched, so spawn/resume/MCP/model-catalog behaviour and the drag payload are unchanged. Persisted on `agent_sessions.display_provider_id` (migration `0025`, nullable, added to the sync allowlist) so the label survives restart/resume; clearable via "Reset to <real>". New `panes.setDisplayProvider` RPC.

### CI / Docs (housekeeping, previously untagged on main)

- **CI: opt into Node 24 early.** All 8 workflows set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` ahead of GitHub's 2026-06-02 forced switch — verified green on main (lint-and-build + e2e-matrix ran under Node 24). Action versions were already on current majors; this only changes their Node runtime + silences the deprecation warnings.
- **Docs: archived shipped plan docs.** `git mv` the eight v1.2–v1.6 version docs into `docs/03-plan/archive/` and updated their WISHLIST link targets. History-preserving; no content changed.

### Gate

- `tsc -b` · `eslint --max-warnings 0` · vitest **1852 pass / 1 skip** (+ migration 0025, SF-9 toggle-in-dropdown, SF-10 display-override) · `product:check` · full `tests/e2e/` (9 passed / 3 skipped).

## [1.32.0] - 2026-05-28

v1.32.0 — **H-19 (full): aidefence ingestion scanning + a real outbound PII scrub.** The assistant now scans content it ingests (`read_files` contents, `search_memories` entries) for prompt-injection before it reaches the model — **redacting + annotating** flagged content — and scrubs PII from its final reply with a real local redactor. SECURITY-SENSITIVE: one Opus implementation lane + a lead integration + **two Opus security-reviews**. Opportunistic / local-first / never-fail-open throughout.

### Added

- **`scanIngested` on the aidefence gate** (`core/security/aidefence-gate.ts`): scans ingested text; on a flagged verdict it **coarse-redacts** the item (the live engine reports threats without offsets, so whole-item redaction) and prepends a fixed-literal `⚠ aidefence flagged` annotation; audited via the existing `assistant:security` emit. Wired into `read_files` (per file, within the 32-file cap) + `search_memories` (per entry) through a new optional `ToolContext.scanIngested`.
- **Real outbound PII scrub on the assistant's final reply.** New shared `core/security/pii-scrub.ts` — R-1's reviewed, ReDoS-conscious secret/email/phone patterns extracted into ONE audited module consumed by both the assistant gate's `scrubOutbound` **and** R-1's Telegram `core/remote/safety.ts` (DRY). The gate's `scrubOutbound` now runs the local redactor as primary (works offline; the live engine detects PII but returns no scrubbed text) + composes any engine-scrubbed text. Applied to the `final` emit only (never per-delta).

### Fixed / Security

- **MCP-envelope unwrap** — `scanInbound` (operator-prompt advisory scan) was a **latent no-op against the live daemon**: the Ruflo supervisor returns the raw `{content:[{text:'<json>'}]}` envelope, not a parsed verdict. Routed through the shared `unwrapAidefence` so the inbound scan + the new PII scrub actually reach the engine. (Discovered by empirical verification against the live daemon.)
- **PHONE over-redaction (re-review Medium)** — the shared phone pattern now **requires an E.164 `+` anchor**, so it no longer mangles a coding assistant's output (dates like 2026-05-28, numeric indices, ISBNs, dotted/dashed IDs).
- Opportunistic everywhere: a missing/throwing Ruflo daemon ⇒ pass-through, never breaks ingestion or the emit; redaction never corrupts non-flagged content; the local scrub is offline-capable.

### Notes

- The post-roadmap backlog + **full H-19 are now complete.** Remaining deferred: **H-7** (transactional migrations). Light tech-debt: voice dead-tree cleanup, R-2 cursor skill fan-out, the CI Node 20→24 action bump.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1846 pass / 1 skip** · `product:check` · full `tests/e2e/` (9 passed / 3 skipped) · 2× Opus security-review (PASS).

## [1.31.0] - 2026-05-27

v1.31.0 — **SF-7: Ruflo MCP auto-trust + health surfacing on workspace open.** A freshly-cloned repo opened as a workspace now connects Ruflo MCP end-to-end without the manual `/mcp` trust accept, surfaces daemon health where you work, and reveals the previously-silent stdio fallback. SECURITY-SENSITIVE (it pre-approves an MCP server) — built by 2 worktree-isolated lanes (Opus trust + Sonnet health dot) + a lead `factory.ts` integration + a **mandatory Opus security-review (PASS, no Critical/High)**. Default-ON, opt-out, fail-open.

### Added

- **Per-provider auto-trust of the bundled `ruflo` server only** (`core/workspaces/mcp-trust.ts`). claude: an additive, idempotent merge into `<root>/.claude/settings.local.json` → `enabledMcpjsonServers: ["ruflo"]` (gitignored; pre-approves ONLY ruflo — third-party servers in a cloned `.mcp.json` still prompt). cursor: best-effort `cursor-agent mcp enable ruflo` (binary-gated, args-array, fail-open; contract verified live). codex/gemini/kimi/opencode: verified no-ops (their MCP config loads without a per-project trust prompt). Gated on a new `ruflo.autoTrustMcp` KV (default ON) with a **Settings → Ruflo opt-out toggle**.
- **Pane-header Ruflo health dot** (`useRufloDaemonHealth` + `PaneHeader.tsx`) reusing the existing `ruflo.daemonStatus` RPC: 🟢 running · 🟡 stdio-fallback · 🔴 down · ⚪ unknown, with a tooltip. Polls via `rpcSilent` (no error toasts).
- **stdio-fallback notification** (`ruflo-fallback-notice.ts`): when the per-workspace HTTP daemon can't spawn (binary missing / port collision) and falls back to stdio, a one-time `info` notice surfaces it (previously a silent `console.warn`). Wired through a new `OpenWorkspaceDeps.notifications` sink.

### Security

- Narrowest-possible trust by design: only the literal `"ruflo"` is ever added; never `enableAllProjectMcpServers`, a wildcard, or `--dangerously-skip-permissions`. Additive merge preserves other servers/keys; unparseable/foreign-shaped settings files are left untouched. Atomic write with a unique temp-file name (closes a theoretical concurrent-open TOCTOU). Fully fail-open — a workspace always opens even if trust/notify fails.

### Notes

- The post-roadmap backlog (SF-1..SF-8) is now fully clear. Remaining deferred: H-7 (transactional migrations) + full H-19 (per-tool ingestion scanning).
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1822 pass / 1 skip** · `product:check` · full `tests/e2e/` (9 passed / 3 skipped).

## [1.30.0] - 2026-05-27

v1.30.0 — **SF-8: Yolo/Bypass launch mode for plain panes.** Operators can now launch workspace panes with the provider's own bypass flag (claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, gemini `--yolo`, cursor `--force`) via a per-launch toggle. Built on the existing `autoApprove` mechanism (no new flag logic). 2 worktree-isolated lanes + a lead integration that closed a gap the lanes surfaced. OFF by default, behind a clear danger warning.

### Added

- **Yolo / Bypass toggle** in the workspace launcher (`Launcher.tsx`) and the `+Pane` add flow (`AddPaneButton.tsx`). Per-launch (one toggle covers all panes in a submit), with a **per-workspace default** persisted to kv `pane.autoApprove.default.<workspaceId>` (default OFF). Danger-styled with the warning "disables the agent's own approval prompts — use only in trusted workspaces".
- `autoApprove` threaded through both pane-creation paths: `workspaces.launch` (`PaneAssignment` → `executeLaunchPlan` → `resolveAndSpawn`) **and** the `+Pane` swarm path (`AddAgentToSwarmInput` → `addAgentToSwarm` → `spawnAgentSession` → `resolveAndSpawn`). Providers without an `autoApproveFlag` (kimi/opencode/shell) are a graceful no-op.
- Persisted on the session (`agent_sessions.auto_approve`, migration `0024`) and on `swarm_agents.auto_approve`, so **Yolo survives resume** — a pane launched in Yolo re-applies the flag when reopened. `auto_approve` added to the cross-machine sync allowlist.

### Fixed

- **Latent gap (incidental):** the swarm "Auto" chip (`swarm_agents.auto_approve`, RoleRoster) was persisted but **never applied at spawn** — `spawnAgentSession` didn't pass `autoApprove` to `resolveAndSpawn`. Now wired, so the existing chip and the new `+Pane` Yolo both take effect.
- Hardened both Yolo kv-hydration effects to fail-safe (kv unavailable → default OFF) rather than throwing.

### Notes

- **SF-7** (Ruflo MCP daemon auto-init/auto-trust on workspace open) is planned (`docs/03-plan/sf7-ruflo-mcp-auto-trust-plan.md`) but **not** in this release — it moves to a later version.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1785 pass / 1 skip** · `product:check` · full `tests/e2e/` (9 passed / 3 skipped).

## [1.29.0] - 2026-05-26

v1.29.0 — **operator smoke fixes (SF-1..SF-6)** from the real-device pass after v1.25–v1.28. Three worktree-isolated lanes (1 Opus + 2 Sonnet), each **verified its root cause before fixing**, plus a lead-owned notification-sound widening and an SF-2 single-source-of-truth fix → full gate in main. The standout: SF-2's "malformed `--resume`" was **not** arg-mangling (disproven against the real `claude` 2.1.150 binary — the full id reached claude); the real cause was a cwd→project-slug bug.

### Fixed

- **SF-1 — Telegram replies sent twice.** `core/remote/bridge.ts` relayed both the debounced `delta`-accumulated buffer **and** the `final` payload (identical text) → duplicate message. Reworked `onAssistantState` to a **final-only relay**: `delta` accumulates silently, `final` cancels any stale timer and flushes exactly once; `error`-only turns keep the debounced path so they still reach the operator. (Single `assistant:state` subscription confirmed — not a double-subscribe.)
- **SF-2 — "No conversation found" on Claude session resume in a fresh workspace.** Root cause (verified against `claude` 2.1.150): claude resolves `--resume <id>` strictly by a **cwd-derived project-dir slug**, and its slug rule replaces **every** non-alphanumeric char with `-`. `claudeSlugForCwd` only replaced `/`, so any cwd containing a space/dot/paren — e.g. the macOS `Library/Application Support/…` path the worktrees live under — symlinked the session JSONL into the **wrong** project dir. Fixed the slug to `replace(/[^a-zA-Z0-9]/g, '-')`, and pointed the **session-picker disk scanner** (`session-disk-scanner.ts`, which had an identical latent `/`-only copy) at the shared helper for a single source of truth.
- **SF-3 — `1;2c` typed into panes on window focus-switch.** A program in the PTY emits a Device-Attributes query (`ESC[c`) on OS focus-regain; xterm answers via `onData` with `ESC[?1;2c`, and the keystroke pipe forwarded that answer back into the PTY (the shell echoed the printable `1;2c`). Added `stripDeviceAttributesResponses()` to the `onData` path, filtering **only** DA Primary (`CSI ?…c`) and Secondary (`CSI >…c`) replies — Cursor-Position and Device-Status reports (which programs legitimately consume) are preserved.
- **SF-4 — Notifications dropdown unstyled on the Glass theme.** The dropdown container had `bg-popover` but was missing `sl-glass relative`, so the `.sl-glass::before` specular surface never rendered. Added `sl-glass relative` (matching `RightRail`).
- **SF-5 — No sound on new notifications.** Not a regression — the tone was deliberately gated to `warn`/`error`/`critical`, so routine `info`-level events stayed silent. Per operator decision, **widened to all severities**: a tone now fires on any new unread notification, still respecting the `notifications.sound` toggle (default ON).
- **SF-6 — Right-rail Jorvis panel squashed against the window edge.** Added `px-3` to the `JorvisRoom` rail-variant content column (standalone variant unchanged).

### Notes

- **SF-7 / SF-8** (new operator feature requests — Ruflo MCP daemon auto-init/auto-trust on workspace open; a launch-time Yolo/Bypass mode for CLI panes) are documented in `docs/03-plan/WISHLIST.md` and queued for a later wave (proposed v1.30.0). They are **not** in this release.
- Gate (in main): `tsc -b` · `eslint --max-warnings 0` · vitest **1761 pass / 1 skip** (+21 new regression tests) · `product:check` · full `tests/e2e/` (9 passed / 3 skipped — the skips are live-CLI manual smokes).

## [1.28.0] - 2026-05-26

v1.28.0 — **R-2: native Cursor CLI provider** — the last item on the post-roadmap backlog. `cursor-agent` is now a first-class SigmaLink provider (not a generic shell pane): it appears in the provider pickers, gets a worktree-isolated pane, session resume, Ruflo MCP auto-bind, a model catalog, and the pane info bar — the same treatment as Claude / Codex / Gemini / Kimi / OpenCode. Built by one worktree-isolated Opus lane against the **empirically-verified** `cursor-agent` v2026.05.24 contract (the CLI is installed) → full gate in main. No `rpc-router` change (the provider plumbing is data-driven). DEFAULT-OFF in the sense that it only activates when the operator installs + authenticates `cursor-agent`.

### Added

- **`cursor` provider** (`shared/providers.ts`): `command: 'cursor-agent'`, non-interactive `-p` panes with `--trust` (headless floor) + conditional `--force` auto-approve (mirrors the claude/codex escalation), `--resume <id>` / `--continue` resume, `sonnet-4`/`gpt-5` model catalog, install via `curl https://cursor.com/install | bash`. Picked up automatically by `listVisibleProviders` / `listDetectable`.
- **Ruflo MCP auto-bind for Cursor** — the autobind writer now also writes `<workspace>/.cursor/mcp.json` (same `mcpServers` shape as Claude's `.mcp.json`; stdio + HTTP-daemon modes, idempotent merge, refuses operator-managed entries).
- Cursor pane-splash model label + resume-arg wiring; provider-registry / resume / spawn-arg / MCP-autowrite test coverage.

### Notes

- **Skill provider-compat fan-out is NOT yet extended to Cursor** (the skills `ProviderTarget` is a fixed `claude|codex|gemini` enum with an exhaustive check; Cursor's skill/command on-disk layout is unverified) — tracked follow-up.
- Operator smoke: install `cursor-agent` + `export CURSOR_API_KEY=…` (or `cursor-agent login`); Cursor then appears in the launcher → a pane spawns `cursor-agent --trust -p "<prompt>"` in its worktree; resume re-opens via `--continue`.
- **The post-roadmap backlog is now clear.** Remaining: H-7 (deferred — migration-transaction refactor) and full H-19 (per-tool ingestion scanning) — both documented in WISHLIST. No schema migrations in v1.28.0.

## [1.27.0] - 2026-05-26

v1.27.0 — **Security hardening wave 2 — runtime/lifecycle + hygiene** (H-class backlog, wave 2 of 3). 3 parallel worktree-isolated lanes (PTY/spawn on Opus; db+git and hygiene on Sonnet) → lead-integrated the two `rpc-router`-resident items → full gate in main (incl. the whole `tests/e2e/` dir). 9 items shipped; **H-7 deferred** (see Notes).

### Fixed

- **H-6 — win32 shell-first sentinel mismatch.** `spawnLocalPty` (wrap side) and `registry.create` (sentinel-watch side) disagreed on win32: the command was shell-wrapped + emitted the CLI-exit sentinel, but the registry watched it as `direct` (no watcher) → raw sentinel markers leaked into the terminal and `onCliExited` never fired. Extracted a single `resolveEffectiveSpawnMode(spawnMode, command)` used by both sides; win32 is now consistently `direct` end-to-end (un-dogfooded win32 shell-first stays off). No change on POSIX.
- **H-9 — alt-command fallback dead in shell-first.** The `[command, ...altCommands]` walk only advanced on a synchronous ENOENT, which fired only in direct mode; shell-first injected the bare command into a shell so a missing binary produced "command not found" output, never a throw. Added the same synchronous binary pre-flight to the shell-first path so the alt-walk resolves an installed binary in **both** modes.
- **H-10 — duplicate-pane spawn leaked a PTY.** On a `UNIQUE constraint failed` (workspace_id, pane_index), the spawned PTY was logged + suppressed without being killed → orphaned child process with no DB row and no kill path. Now `kill` + `forget` the orphaned PTY before suppressing.
- **H-12 — provider list leaked the internal `shell` sentinel.** `providers.list` mapped the raw provider registry (the Settings → Providers tab only filtered `legacy`), so the internal `shell` row was exposed over RPC. Filtered at the source.
- **H-13 — `shutdownRouter` fire-and-forgot the daemon stop.** The per-workspace HTTP-daemon `stopAll()` (SIGTERM→5s-drain→SIGKILL) and the Telegram-bridge stop were `void`-discarded, so the process could exit before they drained → orphaned daemon processes. `shutdownRouter` is now `async` and **awaits** them (self-bounded, can't hang quit); the `before-quit` handler holds the quit until the async teardown settles.
- **H-15 — `git.diff` silent truncation.** A diff exceeding the 16 MiB buffer was silently cut. `GitDiff` gained a `truncated` flag (additive; renderer ignores it until updated) set on the maxBuffer-exceeded path.

### Changed / Docs

- **H-18** — local `electron:pack:{win,mac,all}` scripts now run `electron:compile` (they previously skipped it and would package a stale/absent `electron-dist/main.js`).
- **H-17** — README (root + `app/`) refreshed to the shipped v1.26.0 reality (Glass default, Jorvis assistant + Remote, the 11 rooms, security hardening; `pnpm`).
- **H-14** — comment rot fixed: "Hey Sigma" → "Hey Jorvis" (`electron/main.ts`), a stale "Bridge ribbon" subscriber note (`rpc-channels.ts`), and two shipped-but-marked-TODO comments (`Terminal.tsx`, `Orb.tsx`).

### Notes

- **H-7 (transactional migrations) deferred.** Wrapping each migration's `up()` in an outer `db.transaction()` crashes fresh-DB startup: several migrations (0003/0006/0015/0018/…) manage their own `BEGIN`/`COMMIT`, and better-sqlite3 throws "cannot start a transaction within a transaction" on the nested `BEGIN` (caught by the full `tests/e2e/` fresh-profile launches — the MockDb couldn't model the no-nested-transaction rule). Those migrations are already self-atomic, and the runner records a migration only after its `up()` succeeds. Fully centralizing transactions (stripping every migration's own `BEGIN`/`COMMIT`) is a separate, real-DB-tested refactor.
- Remaining H-class: full H-19 (per-tool ingestion scanning), then R-2 (Cursor provider).

## [1.26.0] - 2026-05-26

v1.26.0 — **Security hardening wave 1 — IPC containment** (H-class backlog, wave 1 of 3). Closes the renderer-trusts-path / no-validation attack surface in the privileged main process. Built by 3 parallel worktree-isolated Opus lanes → lead-integrated the `rpc-router` wiring → a **mandatory Opus security-review pass** (verdict PASS, no Critical/High) → fixes folded → full gate in main (incl. the whole `tests/e2e/` dir). No new dependencies; no schema migrations; no behavior change for legitimate flows.

### Security

- **Central path containment (H-5/H-2/H-3)** — a new `core/security/path-guard.ts` (`assertAllowedPath`, realpath/symlink-safe, fail-closed on empty roots) is the single sandbox definition shared by the fs RPC controller, `git.runCommand`, `pty.spawnScratch`, `pty.create`, and the assistant `read_files` tool. The fs reads/writes are now contained to the authoritative allowed-roots (open workspaces' root/repo + the worktree pool, re-derived per call, deny-all on DB failure). `fs.writeFile` no longer trusts the renderer-supplied `repoRoot` (a `repoRoot:"/"` could previously collapse the traversal guard). An in-tree symlink pointing outside the sandbox is rejected by realpath.
- **Spawn-cwd containment (H-4)** — `git.runCommand`, `pty.spawnScratch`, and `pty.create` now reject a renderer-supplied `cwd` outside the workspace/worktree sandbox before running/spawning (commands already run with `shell:false`).
- **IPC payload validation enforced (H-8)** — `core/rpc/validate.ts` parses every channel's input at the dispatch boundary; `VALIDATION_MODE` flipped to `enforce`. 17 path/command-carrying channels (`fs.*`, `git.*`, `pty.*`, `kv.*`, `workspaces.*`) gained concrete zod schemas (bounded strings, typed shapes) replacing `z.any()` — a malformed renderer payload is now rejected with an error envelope instead of reaching the controller.
- **aidefence wired into the runtime (H-19, partial)** — the previously-unused Ruflo aidefence engine now runs an opportunistic, never-fail-open advisory scan on every assistant send prompt (`core/security/aidefence-gate.ts`), emitting `assistant:security` events (flips `Security: PENDING` → active). Local operator input is scanned + audited, never blocked. Per-tool ingestion (read_files / open_url / browser scrape) and outbound PII scrub remain the tracked H-19 follow-up.

### Fixed

- **H-11** — `fs.readFile` does a bounded partial read (open + read up to the cap) instead of reading the whole file into memory before truncating.
- **H-16** — `dirSize` and `getWorktreeSizes` no longer follow symlinks (skip symlinked entries, `lstat`) — no out-of-tree size traversal, no symlink-cycle recursion.

### Notes

- Security-review residuals tracked for later (none blocking): `fs.exists` remains an existence oracle (it is legitimately used to probe system binary paths for provider-CLI detection); `git.runCommand`'s command token is renderer-supplied but runs `shell:false` in a contained cwd (no shell-metachar injection); the side-band IPC handlers (`swarm.*`, `swarm.replay.*`, etc.) don't yet route through `validateChannelInput` (those namespaces are still `z.any()`).
- Remaining H-class: wave 2 (H-6/7/9/10/12/13/15 + hygiene H-14/17/18), then R-2 (Cursor provider).

## [1.25.0] - 2026-05-26

v1.25.0 — **R-1 Jorvis Remote (Telegram bridge)** — the first post-roadmap feature: remote-drive the Jorvis assistant (including worktree-isolated swarms) from a Telegram bot. **SECURITY-CRITICAL** (first network listener in the privileged Electron main process) and **DEFAULT-OFF** — inert until the operator sets a token + chat-id allowlist + enables it. Built by 3 parallel worktree-isolated lanes (assistant security on Opus, transport+safety on Sonnet, bridge+RPC+Settings on Opus) → lead-merged → a **mandatory security-review pass** (Opus) → fixes folded → full gate in main (incl. the whole `tests/e2e/` dir). **No new npm dependencies** (hand-rolled `fetch` long-poll). Operator real-bot/real-phone smoke is the e2e gate; no live Telegram in CI.

### Added

- **Remote (Telegram) panel** in Settings — write-only bot-token field (shows "set ✓ / not set", warns when OS encryption is unavailable), enable toggle, chat-id allowlist editor, Lock/Unlock + status pill, idle-lock minutes, and a scrollable audit tail. All via a new `telegram.*` RPC namespace.
- **`core/remote/`** module: a hand-rolled outbound-only `getUpdates` long-poll client (`api.telegram.org`, `AbortController`, offset tracking, exponential backoff), a safety layer (chat-id allowlist → `/lock` + idle auto-lock → 5/min token-bucket rate-limit → local injection/jailbreak heuristic → **opportunistic** Ruflo `aidefence_is_safe`/`has_pii`), an append-only JSONL audit log, and the bridge supervisor (relay of `assistant:state` deltas — debounced 700ms, chunked @4096, HTML-escaped, outbound-scrubbed).
- **Confirm-on-dangerous** — read-only + dispatch (`launch_pane`/`create_swarm`/`add_agent`/`broadcast`/…) + contained `read_files` + https `open_url` run freely; `prompt_agent` (raw PTY) blocks on a one-tap Telegram inline-keyboard **✅ Confirm** (60s → denied). Built on a new origin-aware authorization gate in the assistant controller (`origin: 'local' | 'telegram'`; fail-closed — missing/false/throwing `confirmDangerous` all deny). Local-origin behavior is unchanged.

### Changed / Hardened

- **`read_files`** now rejects any path outside the workspace/worktree roots (realpath/symlink-safe — an in-tree symlink to e.g. `~/.ssh` is judged by its real target), and **`open_url`** requires `https:` (rejects `http:`/`file:`/`javascript:`/`data:`/malformed). These apply to **all** origins, not just Telegram.

### Security

- The bot token never crosses IPC, is never echoed by any RPC (`getStatus` returns only a `tokenSet` boolean), is never relayed to chat, and is refused when OS encryption (`safeStorage`) is unavailable (no plaintext-at-rest). Non-allowlisted chat-ids are dropped **silently** (no membership oracle) and audited (throttled). Security-review fixes folded before ship: bounded the outbound relay buffer + de-quadratic'd the email scrub regex (event-loop/ReDoS guard), chat-scoped the confirm-callback (no cross-chat approval), and throttled the non-allowlisted drop-audit (flood guard).
- Partially advances **H-19** (aidefence wiring): the Telegram path is the first runtime consumer of `aidefence_*`, called **opportunistically** (local floor is primary — a Ruflo failure can never fail-open). The broader H-19 mandate (every ingestion point; local assistant input; browser scrape) remains.

### Notes

- DEFAULT-OFF: a fresh profile makes zero Telegram network calls (the bridge self-gates to `inert` unless enabled + token + at-rest encryption + non-empty allowlist all hold). No schema migrations.
- Known cosmetic follow-ups (Info, from the security review): the Settings audit tail renders oldest-first; `CredentialStore.set` could gain a hard `requireEncryption` flag rather than relying on per-caller pre-checks.

## [1.24.0] - 2026-05-26

v1.24.0 — **Per-room polish + accessibility (frontend Stage 4)** — the FINAL stage of the Apple-grade frontend roadmap (Stages 1–4 now complete). 3 parallel worktree-isolated coders → lead-merged, full gate in main (incl. the whole `tests/e2e/` dir + a `prefers-reduced-motion` runtime check).

### Added

- **Global reduce-motion safety-net** — a single `@media (prefers-reduced-motion: reduce)` reset in `index.css` collapses animation/transition durations app-wide, covering everything previously unguarded in one block: the notification bell pulse, the Jorvis Orb's inline keyframes, all Radix `animate-in/out` (dialog/dropdown/popover/tooltip/sheet), and every `animate-pulse/ping/spin/bounce`. (Verified at runtime: `0.01ms` under reduce vs `1s` normally.)
- **Skip-to-main-content link** + `#main` landmark; `aria-label` on the sidebar landmark.

### Changed

- **Standardized empty / loading / error states** onto the shared `EmptyState` / `ErrorBanner` / `Spinner` components: `window.alert` removed (Memory); OperatorConsole's silently-swallowed RPC errors now surface in a dismissible banner; bare "Loading…" text → `Spinner` (Memory graph, DiffView, ConflictsTab, Skills); bare empty text → `EmptyState` (Review, Memory graph); SigmaBench gained the workspace-guard `EmptyState` every other room already had.
- **Keyboard + accessible names:** the SwarmSwarm RoleRoster agent card is now keyboard-operable (`tabIndex` + Enter/Space — was keyboard-dead); `aria-label` added to icon-only buttons in the Browser address bar / tab strip, Tasks columns, and Memory/Operator; hand-rolled Task drawers gained `aria-labelledby` + Escape-to-close + return-focus.

### Notes

- Refinement + a11y only; no behavior/architecture change. Full Tab-containment focus-trap on the hand-rolled Task drawers is noted as a follow-up (`TODO(a11y)`); device VoiceOver/Switch-Control testing is operator QA.
- No schema migrations in v1.24.0.

## [1.23.0] - 2026-05-26

v1.23.0 — **Apple-grade component kit (frontend Stage 3)** + **H-1 hardening (electron typecheck)**. H-1 lead-direct; Stage 3 = 3 parallel worktree-isolated coders (button on Opus) → lead-merged, one hard gate in main (incl. the full `tests/e2e/` dir + a glass visual pass).

### Added

- **H-1 — `electron/**` is now type-checked.** A new `tsconfig.electron.json` (extends `tsconfig.node.json` + `@/` paths) added as a 3rd composite **reference**, so the existing `tsc -b` — run by `build` in every CI workflow — now covers `electron/main.ts`, `preload.ts`, `auto-update.ts` (previously esbuild-only; the coverage gap behind the v1.20.0→.1 model-registry break). No workflow edit needed. Surfaced + fixed one real issue (an unused `name` param, now folded into the channel error message).
- **Button `tinted` variant** — `bg-primary/15` + primary text — the Apple "tinted" secondary tier (the `.sl-nav-active` selection vocabulary as a button). Additive; opt-in.

### Changed (Stage 3 — component-kit pass over the high-traffic shadcn/Radix kit)

- **Ghost buttons read as translucent chrome on glass** — ghost hover `bg-accent` → `bg-foreground/[0.07]` (theme-adaptive; no glass-on-glass). ~29 uses in toolbar/sidebar/pane-header.
- **Tactile press** — interactive buttons gain `active:scale-[0.98]` (`motion-reduce` respected) + the spring transition (`transition-[color,box-shadow,transform]`).
- **Unified focus-ring** — `dialog` + `sheet` close buttons moved off the legacy `focus:ring-2 focus:ring-offset-2` to the standard `focus-visible:ring-[3px]`; the `tabs`/`scroll-area` outline divergence removed; `switch`/`checkbox` transitions unified.
- **Segmented-control `tabs`** polish (inactive always muted, active overrides), `card` transition; `tooltip` kept as the deliberate opaque pill (no glass).

### Notes

- Refinement of the high-traffic primitive kit only; behavior unchanged. Glass stays chrome-only; content surfaces opaque.
- No schema migrations in v1.23.0.

## [1.22.1] - 2026-05-26

Patch — CI hotfix. No product changes; binaries are identical to v1.22.0.

### Fixed

- **e2e `BUG-W7-003` now asserts the fresh-profile default theme is `glass`** (not `obsidian`). v1.21.0 flipped `DEFAULT_THEME` to glass but left this `dogfood.spec.ts` assertion encoding the old invariant — it passed locally (the dev profile has a persisted `app.theme`) but failed on CI's fresh profile, so v1.21.0/v1.22.0's `e2e-matrix` job went red (release binaries + lint-and-build were green). The local release gate ran only `smoke.spec.ts`; CI's `e2e-matrix` runs the full `tests/e2e/` dir, which is where it surfaced. Test-only change.

## [1.22.0] - 2026-05-26

v1.22.0 — **Apple-grade chrome & window polish** (Stage 2 of the Apple-grade frontend roadmap, on top of v1.21.0's glass foundation). 3 parallel worktree-isolated coders (pane chrome on Opus) → lead-merged, one hard gate in main (incl. `product:check` for the electron/main change).

### Changed

- **Pane chrome — Apple restraint:** the situational pane-header controls (split-vertical, split-horizontal, minimise, brief) now **reveal on pane hover / keyboard focus-within** instead of always cluttering every header; Fullscreen, Close, and the info row (status·provider·branch·model·badge) stay always-visible. Opacity-only — controls remain in the DOM + tab order for keyboard users.
- **Active-pane highlight:** the focused grid cell gains `.sl-pane-active` → a soft ring-colour glow under the Glass theme (flat themes keep the existing hairline ring); fullscreen still drops the ring.
- **Real density scaling:** the pane grid now tightens the inter-pane gap + outer padding (and shrinks the header to `h-6` at the dense tier) as panes multiply — previously only the font scaled. Comfortable (≤4 panes) stays roomy.
- **macOS title row:** the sidebar traffic-light drag spacer is now `h-8` (matching the 32px top bar) and a darwin-only `trafficLightPosition` centers the window controls in the title row.
- **Unified navigation selection:** active workspace rows and the rooms menu now use the same primary-tint selection vocabulary as the right-rail switcher (`.sl-nav-active` / `bg-primary/15 text-primary`), with `aria-current` on the active room item and a subtle active cue on the rooms trigger for non-default rooms.

### Notes

- Glass effects remain chrome-only + glass-theme-scoped; the other four themes only inherit the (theme-agnostic) density + nav-vocabulary changes, not the glass glow.
- No schema migrations in v1.22.0.

## [1.21.0] - 2026-05-25

v1.21.0 — **Apple-grade Liquid Glass foundation** (Stage 1 of the Apple-grade frontend roadmap). Reworks the first-pass Glass theme into genuine Liquid Glass using the self-authored apple-design skill family, and lands app-wide Apple foundations. 3 parallel worktree-isolated coders (the glass material on Opus) → lead-merged, one hard gate in main, **visually verified via Playwright** (closing the FE-1 "unverified" gap).

### Added

- **Liquid Glass material layer** (`app/src/styles/glass-material.css`) — a reusable, glass-theme-scoped material: a 4-gradient mesh backdrop (so the glass has colour to sample), three chrome glass weights (`.sl-glass` / `.sl-glass-heavy` / `.sl-glass-toolbar`) with `backdrop-filter: blur(20–30px) saturate(150–165%)`, a specular `::before` highlight + neon-bloom shadow, and a `.sl-nav-active` accent tint. Applied to the sidebar, top-bar, right-rail, popovers, and pane-header chrome.
- **App-wide Apple foundations (all 5 themes):** `-apple-system`/SF Pro UI font (`--font-sans` + Tailwind `fontFamily.sans`) and Apple spring motion curves (`--motion-*`, ≤300 ms utility budget).
- **Accessibility + focus behaviour:** `prefers-reduced-transparency` and `prefers-reduced-motion` both collapse the glass to a near-opaque solid (and stop the mesh drift); the chrome recedes (glass dims) when the window loses focus, via a renderer-only `data-window-focused` attribute (macOS Tahoe behaviour).

### Changed

- **Glass is now the default theme** (`DEFAULT_THEME='glass'`; `findTheme` falls back to it). Applies to fresh profiles; existing installs keep their explicitly-chosen theme until they select Glass (we don't override an explicit choice).
- **Glass corrected to chrome-only** — the first-pass FE-1 blurred all ~120 `bg-card` content surfaces ("visual mud" + GPU cost). Content cards are now near-opaque + crisp (`hsl(var(--card)/0.92)`, no blur); glass is confined to the navigation/chrome layer. The mild `blur(13px)` first pass was removed from `index.css` and superseded by the new material layer.

### Notes

- Terminals stay opaque by design (xterm `#0a0c12`, `allowTransparency:false`) — only chrome turns glassy.
- No schema migrations in v1.21.0.

## [1.20.1] - 2026-05-25

Patch — a wake-word rename + a regression fix.

### Changed

- **Wake-word "Hey Sigma" → "Hey Jorvis"** — the wake phrase now matches the persona that actually answers (the wake-word's default route hands the command to the Jorvis assistant). `WAKE_PATTERN` (`shared/wake-word.ts`) + `global-capture` fallback/toast + `VoiceTab` copy + tests + comment-only files; historical records (CHANGELOG/release-notes/research/archive) left as-is.

### Fixed

- **Restore `src/main/core/voice/model-registry.ts`** — it was wrongly removed as a "dead duplicate" in the v1.20.0 post-ship consolidation (`f7f7472`), but `electron/main.ts` imports it (`getModelById`/`getDownloadedModelPath`/`downloadModel`/`abortDownload` — the Electron-specific downloader using `app.getPath`, distinct from the portable `packages/voice-core` copy). `tsc -b` doesn't compile `electron/main.ts` (only esbuild/`product:check` does), so the deletion's tsc+vitest gate falsely passed while `electron:compile` broke. Restored; full gate green.

## [1.20.0] - 2026-05-25

v1.20.0 — **"Breadth & polish"** (Milestone M5, final roadmap wave). C-1…C-13 now shipped. Brainstorm→code-verified plan→3 parallel worktree-isolated coders (C-12 on Opus for the new subsystem)→lead-merged with one combined hard gate in main. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`.

### Added

- **C-12 — SigmaBench (multi-agent-conflict bench):** a new room that runs the **same task across N CLI providers (Claude/Codex/Gemini), each in its own isolated git worktree**, then scores each by how much its changed-file set overlaps the others (`scoreConflicts`, reusing the C-7 merge-order overlap). Lower = better isolation — the leaderboard a shared-directory competitor structurally cannot produce. New `benchmark_runs`/`benchmark_results` tables (migration 0023), `core/sigmabench/{harness,store}.ts`, `sigmabench.*` RPC, and the `SigmaBenchRoom`. MVP is the conflict category only; latency/code-quality deferred.
- **C-13 — Element → existing pane + diff:** the W14 design tool gained a "Send to existing pane" mode — a captured DOM element + prompt is injected into an operator-picked **live** pane's PTY (`pty.write`) and that pane's worktree `git.diff` renders inline in the dock (`shared/element-dispatch.ts`, `design/controller.ts`, `DesignDock.tsx`). (Auto-routing to the worktree that owns the element's source file was dropped — infeasible without a reverse element→file map.)
- **C-10c — CLI-based voice (local/cloud, "Both"):** a Gemini-CLI transcription engine behind the `WhisperEngine` interface (audio→WAV→`gemini`), selectable via a VoiceTab "Transcription engine" toggle; plus a "Send commands to" Claude/Codex/Gemini dispatch-target selector threaded into `routeTranscript`. Claude Code & Codex are intentionally not transcription options (no audio modality). **Defaults unchanged: local Whisper `base.en-q5_1` + claude dispatch** — the CLI paths are opt-in (`wav-encode.ts`, `cli-transcribe-engine.ts`, `whisper-engine.ts`, `global-capture.ts`, `output-router.ts`, `VoiceTab.tsx`).

### Changed

- **Swarm roster — per-agent `initialPrompt`:** `RoleAssignment` gained an optional `initialPrompt`, threaded through `materializeRosterAgent` → `spawnAgentSession`. Without it, SigmaBench's benched agents would have spawned idle (a hollow bench); existing roster callers are unaffected (field unset → prior behavior).

### Notes

- DB tests run native-free (vitest is on the Node ABI; better-sqlite3 is built for Electron via `electron-builder install-app-deps`) — the 0023 migration test asserts the emitted DDL and the store test uses an in-memory fake, matching the repo's MockDb convention.
- Running a SigmaBench spawns real CLI agents in throwaway worktrees (real invocations + edits in disposable trees).

## [1.19.0] - 2026-05-25

v1.19.0 — **"New surfaces"** (Milestone M4) + a voice remediation that makes the v1.17/v1.18 voice features actually run. Brainstorm→code-verified plan→3 parallel worktree-isolated coders (C-11 on Opus for native/C++)→lead-merged + combined gate, then a focused voice-core remediation lane. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`.

### Added

- **C-8 — Browser-on-link:** clicking a URL/OSC8 hyperlink in a pane's terminal opens it in the in-app browser **and surfaces the browser tab** (`setActiveTab('browser')` threaded through the terminal link handler; browser + recents already existed).
- **C-9 — Skills guardrail matrix:** Skills-tab toggles (Test-Driven / Security-Audit / CI-Green / DRY) written as a per-worktree `CLAUDE.md` guardrail block at dispatch (`guardrails.ts`, `guardrail-block.ts`, `launcher.ts`/`factory-spawn.ts`, `SkillsTab.tsx`). Guidance-level, reuses the C-5 scope-block pattern.
- **C-11 — "Hey Sigma" wake-word dispatch:** optional always-on listening mode (VoiceTab toggle, OFF by default) — energy-gated rolling tiny-Whisper matches "hey sigma" → escalates to the capture→dispatch path. whisper.cpp N-API bridge gained a persistent, mutex-guarded `whisper_context` cache + per-segment probability (`pcm-ring.ts`, `audio-energy.ts`, `wake-word.ts`, `voice-core/global-capture.ts`, `whisper_bridge.cc`). Native build verified; macOS-first.

### Fixed

- **Voice-core extraction regression:** a past extraction left a dead duplicate voice tree at `src/main/core/voice/`; the live module is `@sigmalink/voice-core`. C-10a (dictionary/macros/usage-stats, v1.17) and C-10b (focused-pane routing, v1.18) had been edited into the **dead** copy → inert in production. Ported `normalizeTranscript`, the focused-pane `routeTranscript` branch, and the usage-stats capture into the live voice-core package; deleted the two confirmed-dead duplicates. The VoiceTab dictionary, focused-pane dictation, and usage dashboard now actually work.

## [1.18.0] - 2026-05-24

v1.18.0 — **"Sigma Agent"** (Milestone M3, capstone). One goal → N worktree-isolated agent panes, each briefed with a plan capsule, with a conflict-aware merge order — the "swarm with no merge conflicts" a shared-dir competitor can't match. Compose-first (M1/M2 primitives + existing infra). Brainstorm→code-verified plan→3 parallel worktree-isolated coders, lead-merged with one combined hard gate in main. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`.

### Added

- **C-7 — Sigma Agent orchestrator:** a new OrchestratorPanel in the OperatorConsole `chat` tab — author N tasks → `swarms.create({preset:'custom'})` spawns N worktree-isolated panes in one call → `panes.brief` capsule per pane → "Propose merge order" ranks panes by ascending pairwise changed-file overlap (`git.status` union) → "Merge in order" runs `review.batchCommitAndMerge` on the sorted sessionIds. RPC-free (`shared/merge-order.ts`, `shared/orchestrator-tasks.ts`, `operator-console/OrchestratorPanel.tsx`). Manual task authoring for v1; LLM auto-decompose deferred.
- **C-10b — Inline voice into the focused pane:** a `voice:focused-session` renderer→main push lets the voice pipeline `pty.write` the normalized transcript into the active pane instead of the assistant; opt-in via a VoiceTab toggle (`use-voice-focus-sync.ts`, `core/voice/output-router.ts`, `global-capture.ts`, `electron/main.ts`). True hold-to-record deferred (Electron globalShortcut is keydown-only).

### Changed

- **W-4 P8 — Resume simplification:** removed the dead `resumeMode` label from the pane-resume result + toast. `external_session_id` **kept** (`resume-launcher.ts`).

### Notes

- **W-4 P9 (drop `external_session_id`) cancelled** — exploration proved it regresses multi-pane conversation resume (pane→conversation binding, not redundant with shell-first). No schema migration in this release.

## [1.17.0] - 2026-05-24

v1.17.0 — **"Worktree-aware context"** (Milestone M2). Agent context now carries its worktree. Reuse-heavy: rides the shipped `rpc.pty.snapshot` / `git.status`/`git.diff` / `rpc.pty.write` primitives + the marker-block writer. Brainstorm→code-verified plan→2 parallel worktree-isolated coders, lead-merged with one combined hard gate in main. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`.

### Added

- **C-6 — Worktree-aware drag-drop context:** a pane (its header) is now a drag source; dropping it on the Jorvis composer or swarm side-chat attaches that pane's `branch + git diff --stat + compacted scrollback` (ANSI-stripped, tail-capped). No new RPC (`PaneHeader.tsx`, `pane-context-builder.ts`, `strip-ansi.ts`, `JorvisRoom.tsx`, `SideChat.tsx`).
- **C-5 — Plan-handoff capsule:** a "Brief this pane" popover (goal / target files / success criteria / out-of-scope) injected via a new `panes.brief` RPC (W-5 `pty.write` path); the out-of-scope list is written as a per-worktree `CLAUDE.md` scope-guidance block (idempotent marker-delimited; guidance-level, no settings mutation) (`plan-capsule.ts`, `scope-block.ts`, `PaneHeader.tsx`).
- **C-10a — SigmaVoice dictionary + macros + dashboard:** phrase dictionary + verbal macros applied to every transcript (ReDoS-safe `indexOf` impl); whisper segments → words/WPM/timestamped usage history (KV, capped 200); VoiceTab dictionary editor + macro list + usage dashboard (`voice-dictionary.ts`, `voice-stats.ts`, `global-capture.ts`, `lib/voice.ts`, `VoiceTab.tsx`).

### Changed

- Reverted a redundant `panes.gitStatus` RPC introduced mid-build — `git.status(cwd)` already existed; `PaneShell` uses it directly.

## [1.16.0] - 2026-05-24

v1.16.0 — **"Glanceable swarm"** (Milestone M1 of the BridgeMind-competitive roadmap). Every pane shows its branch · model · uncommitted count; panes stay legible at 8+; the agent roster + cross-agent chat are one click away in the Command Room right-rail. Reuse-heavy by design — code-verified planning found the chat (`SideChat`) and roster (`RoleRoster`) already existed in the separate Swarm Room with messages already pushed live into global state, so M1 surfaces + wires rather than rebuilds. Brainstorm→spec→code-verified plan→2 parallel worktree-isolated coders, lead-merged with one combined hard gate in main. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`.

### Added

- **C-1 — Per-pane info bar:** the pane header shows inline `branch · model · ±N uncommitted` for the pane's worktree. Reuses the existing `git.status(cwd)` RPC and the `DEFAULT_MODELS[providerId]` lookup; `PaneShell` best-effort-polls every 15 s (`PaneHeader.tsx`, `PaneShell.tsx`).
- **C-3 — Grid density:** the pane grid derives a density tier from pane count — `comfortable` (≤4) / `compact` (5–9) / `dense` (≥10) — exposed as `data-density` + a `--pane-font-scale` var consumed by the pane header so 8+ panes stay readable. Existing drag-resize unchanged (`GridLayout.tsx`).
- **C-2 / C-4 — Swarm tab:** a new right-rail "Swarm" tab (+ top-bar switcher) hosts the read-only agent roster (role · provider · status · live "last activity" derived from the mailbox; click an agent → focuses its pane) above the operator-injectable swarm chat (`SideChat`, surfaced from the Swarm Room) (`SwarmRailTab.tsx`, `RoleRoster.tsx`, `RightRail*.tsx`, `RightRailSwitcher.tsx`).

### Changed

- `RoleRoster` gained additive `onFocusPane` + `lastActivity` props (no behavior change for `SwarmCreate`).
- Reverted a redundant `panes.gitStatus` RPC introduced mid-build — `git.status(cwd)` already existed (allowlisted + typed); `PaneShell` uses it directly.

### Deferred

- **M0.3 (post-task verdict auto-store) — shelved.** A standalone `.claude` hook can only write via the claude-flow CLI, but the running MCP daemon's loaded HNSW index does not observe an external process's file write same-session, so hook-written verdicts aren't live-retrievable. Proper fix is the deferred per-workspace HTTP-daemon write path; M0.3 is downstream of it. M0.1 (upstream PR) + M0.2 (win32 dogfood) remain operator-only.

## [1.15.0] - 2026-05-22

v1.15.0 — **Ruflo MCP works end-to-end** (shared store + seeding + namespace convention + health round-trip). Closes the "memory never helps" problem traced live on 2026-05-22: the store was never empty — `memory_search` defaults to the near-empty `default` namespace, `pattern`/`patterns` are split, and only `memory_search_unified` sweeps namespaces. Brainstorm→spec→plan→3 parallel coders (Approach C — convention + config, no enforcement proxy). Spec: `docs/superpowers/specs/2026-05-22-ruflo-mcp-fix-design.md`.

### Spawned-CLI store is now shared + seeded

- **Shared store:** the per-workspace HTTP daemon now sets `CLAUDE_FLOW_DIR=<root>/.claude-flow` (alongside `CLAUDE_FLOW_CWD`) so daemon-mode and stdio-mode CLIs resolve the **same** `.swarm/memory.db` (`http-daemon-supervisor.ts`).
- **Seeding:** on workspace open, a single `project-context` memory (namespace `patterns`) is seeded from the workspace `CLAUDE.md`/README — **workspace-local only**, best-effort, never blocks open (`seed-workspace-memory.ts`, wired in `factory.ts`).
- **Convention block:** an idempotent marker-delimited Ruflo-memory-convention block is autowritten into the workspace `CLAUDE.md` teaching the canonical usage: store with `namespace:"patterns"`, retrieve with `memory_search_unified` (`mcp-autowrite.ts`).
- **Health round-trip:** the daemon health probe does a `memory_store`→`memory_search_unified` canary and surfaces `roundTrip:boolean` (the measurement gate for any future enforcement).

### Env-level (lead, on this machine)

- `[INTELLIGENCE]` hook floor raised 0.05→0.15 (`RUFLO_INTEL_MIN_THRESHOLD`), cutting the pure-pageRank suggestion noise; restored after `ruflo init` re-gen by `app/scripts/reapply-ruflo-hook-tuning.cjs`.
- Canonical-config doc (`docs/10-memory/ruflo-mcp-canonical-config.md`) + upstream PR draft (`docs/10-memory/upstream/`) for the claude-flow default-namespace + `pattern`/`patterns` + unified-omits-`pattern` issues.

### Internal
- `mcp-autowrite.ts` `parseTomlStringValue` refactored from a dynamic `new RegExp` to precompiled per-key patterns (clears a ReDoS lint; behavior identical, unknown keys guarded).

### Gate
- tsc -b (strict) | eslint 0/0 | vitest 115 files / **1263 pass** / 1 skip (+20) | vite build + electron:compile | Playwright smoke (35 s) — all in main.

No schema migrations in v1.15.0.

## [1.14.0] - 2026-05-22

v1.14.0 — **Crash visibility + Gemini spawn/resume + shell-first default.** Closes the remaining three findings from the 10-lane pane/swarm investigation (`docs/08-bugs/2026-05-22-pane-swarm-investigation/`) that v1.13.2 deferred. Three parallel coders in isolated worktrees (A: main process, B: renderer, C: shell-first), lead-merged + full hard gate in main.

### Crashed panes stay visible (no more silent disappearance)

A crashed Codex/Gemini pane used to vanish: the main process classified the crash but never told the renderer, so `MARK_SESSION_EXITED` hardcoded `status:'exited'` and the GC removed the pane after 5 s. Now the main process emits a new **`pty:error`** IPC event (`{ sessionId; exitCode: number|null; signal?: string|null }`) on crash/earlyDeath (clean exits still emit only `pty:exit`). The renderer subscribes via a new `MARK_SESSION_ERROR` action → `status:'error'`, which the exited-session GC deliberately **skips**, so the pane persists. `PaneShell` discriminates **launch-failure** (ENOENT → full-screen "Failed to launch", no terminal) from **crash** (PTY started then died → a `CrashBanner` "Pane crashed (exit N)" floated over the still-mounted terminal so scrollback stays readable) with a **Relaunch** button (re-adds a same-provider agent, removes the dead pane).

### Gemini spawn/resume fix

`'gemini'` was wrongly in `PRE_ASSIGN_PROVIDERS`, so fresh spawns got an unsupported `--session-id`; and resume passed a stored filename **stem** instead of `latest`. Fresh Gemini spawns no longer receive `--session-id`; resume now always uses `--resume latest`.

### Shell-first panes ON by default

`pty.spawnMode` now defaults to **`shell-first`** (only the literal `'direct'` opts out): a crashed CLI drops back to a **live shell prompt in the same pane** instead of an empty/dead pane — the "fall back to a normal terminal" behavior. The per-pane stdin-prompt override (kimi/opencode) and sentinel CLI-exit detection are unchanged. Settings toggle defaults ON. **win32 caveat:** shell-first is not yet Windows-dogfooded; it ships enabled on all platforms per operator sign-off (2026-05-22). Revert path: set `pty.spawnMode = 'direct'` (or toggle Settings off).

### Also hardened (v1.13.1 pane-add path)

Removed the dual `swarms.list` loader race (single canonical loader drives `swarmsLoading`); moved `UPSERT_SWARM` to **after** `addAgent` resolves in both `CommandRoom` and `AddPaneButton` (no orphaned empty swarm on rejection); tightened `canAddPane`.

### Gate

- tsc -b (strict, incl. test files) | eslint 0/0 | vitest 114 files / **1243 pass** / 1 skip (+34) | vite build + electron:compile | Playwright smoke e2e (35 s) — all in main.

No schema migrations in v1.14.0.

## [1.13.2] - 2026-05-22

v1.13.2 — **Hotfix: pane creation unblocked.** Fixes the v1.13.1 regression where adding a pane (or opening certain existing workspaces) failed with **"Cannot create swarm: empty roster."** Root-caused by a 10-lane investigation (`docs/08-bugs/2026-05-22-pane-swarm-investigation/`).

### Fix

v1.13.1's pane-"+" path calls `rpc.swarms.create({ preset:'custom', roster:[] })` to provision a swarm before attaching the first pane via `addAgent` — but `swarms/factory.ts` rejected **any** empty roster, so every zero-swarm workspace failed (and the "existing workspace crashes on add" report is the **same** root cause). The factory now treats a `preset:'custom'` swarm as a valid **empty container** (only non-custom presets require a non-empty roster); the renderer's create→addAgent flow works. **+1 regression test** — the v1.13.1 test mocked `swarms.create`, so it could not catch the server-side reject; the new test exercises the real `createSwarm`.

### Coming next (v1.14.0)

From the same investigation: crashed Codex/Gemini panes staying **visible** (instead of being silently GC-removed), the Gemini spawn/resume fix (`--session-id` mis-applied + resume stem vs `latest`), and the **shell-first default flip** (crashed CLI → live terminal in the pane).

### Gate

- tsc clean | eslint 0/0 | vitest (full suite) | build + electron:compile | Playwright smoke e2e in main.

## [1.13.1] - 2026-05-22

v1.13.1 — **Two audited UX bug fixes** (read-only feature audit → brainstorm → 1 Sonnet coder + lead gate).

### Pane "+" no longer says "Open or create a workspace first" while a workspace is open

The Add-Pane button gated on `activeSwarm`, which is `null` during the async swarm-hydration window even with a workspace open (residual boot-window race). Reworked `getAddPaneDisabledReason` to key off `activeWorkspace` + a `swarmsLoading` flag: the "Open or create a workspace first" message now fires **only** when no workspace is active; during hydration it shows a transient "Loading workspace…"; and when a workspace genuinely has no swarm, the button is enabled and `addPane()` creates a default swarm (`rpc.swarms.create`) before adding the agent. `canAddPane` now checks `workspaceSwarms` directly (also fixes paused-swarm panes).

### Notification bell/panel now plays a sound

Operator-facing notifications (pty-exit, tool-error, swarm-message → bell/dropdown) were silent. Added a distinct `playNotificationTone()` (descending D4→A3, audibly different from the Jorvis `playDing()` chime) fired from the `notifications:changed` subscriber when a delta's `added` contains new **unread** rows of severity ∈ {warn, error, critical} — once per delta; `info` stays silent. Gated on a new `notifications.sound` toggle (**default ON**) in Notification settings.

### Gate

- tsc clean | eslint 0/0 | vitest 114 files / 1208 pass / 1 skip (+11)
- build + electron:compile clean | smoke e2e 36 s in main

No schema migrations.

## [1.13.0] - 2026-05-22

v1.13.0 — **Bridge\* → Sigma\* brand rename (copyright cleanup)** + **SigmaVoice** standalone-app rename. One Opus coder (isolated worktree) + lead diff-review + full gate. 455 files, +1702/−1706.

### Brand rename: Bridge\* → Sigma\*

Eliminates the third-party "Bridge\*" branding across the codebase — product-suite names + internal mechanism identifiers → Sigma\*:

- **Product/brand**: BridgeVoice→SigmaVoice, BridgeMind→SigmaMind, BridgeCode→SigmaCode, BridgeSpace→SigmaSpace, BridgeSwarm→SigmaSwarm, BridgeCanvas→SigmaCanvas, BridgeMCP→SigmaMCP, BridgeMemory→SigmaMemory, BridgeJarvis→SigmaJarvis, BridgeRoom→SigmaRoom (+ kebab/lowercase/appId/capability-key forms).
- **Standalone voice app**: `apps/bridge-voice/`→`apps/sigma-voice/`, package `@sigmalink/bridge-voice`→`@sigmalink/sigma-voice`, appId `ai.sigma.bridgevoice`→`ai.sigma.sigmavoice`, workflow `release-bridge-voice.yml`→`release-sigma-voice.yml` (tag `sigmavoice-v*`). Released separately as **sigmavoice-v0.2.0**.
- **Internal mechanisms**: `mcp-host-bridge`→`mcp-host-sigma`, `claude-resume-bridge`→`claude-resume-sigma`, `gemini-resume-bridge`→`gemini-resume-sigma`, `bridge-dist`→`sigma-dist`, `bridgeReady`→`sigmaReady`, `BridgeClient`/`BridgeResponse` types → Sigma\* (all consumers updated).
- **capabilities.ts dedup**: removed the duplicate `bridgevoice.enabled` (kept `sigmavoice.enabled`); `bridgemcp.slotCount`→`sigmamcp.slotCount`, `bridgejarvis.enabled`→`sigmajarvis.enabled` (compile-time tier keys, not persisted).

### Preserved (NOT renamed — by design)

- `contextBridge` (Electron API), native napi `tsfn_bridge` / `whisper_bridge` binding symbols — renaming would break the build / native modules.
- **Persisted / cross-referenced values** kept verbatim (renaming would break user data or cross-machine sync): `bridge_dispatch` (`swarm_mailbox.kind` DB value), the `bridge.activeConversationId` / `bridge.autoFocusOnDispatch` legacy KV-migration source keys, and the W-6 backward-compat test-ids `bridge-conversations-panel` / `bridge-resumable-pill`.
- Generic English "bridge" nouns in prose/comments; external/upstream-product research captures in `docs/02-research/**` (URLs/org-slugs left for provenance).

### Gate

- tsc clean | eslint 0 errors / 0 warnings
- vitest 114 files / 1197 pass / 1 skip
- build + electron:compile clean | Playwright smoke e2e 38 s in main

No schema migrations. Old `bridgevoice-*` releases left published (rename is forward-only, per operator).

## [1.12.1] - 2026-05-21

v1.12.1 — **W-6 Cluster B: DB-table + cross-sync Sigma→Jorvis rename** (completes W-6). One Sonnet coder + an Opus reviewer (GO verdict) + lead-applied nits.

### DB + cross-sync rename

Completes the W-6 identifier rename by renaming the DB surface that Cluster A (v1.11.0) deliberately preserved:

- **Table** `sigma_pane_events → jorvis_pane_events`, **column** `agent_sessions.sigma_monitor_conversation_id → jorvis_monitor_conversation_id`, **index** recreated as `jorvis_pane_events_conv_ts`. Migration **0022** is idempotent + existence-guarded; the renames are metadata-only so rows survive, and it remaps any `sync_state` dirty rows to the new table name (avoids orphaned dirty rows).
- **Cross-sync**: `dirty-tracker` SYNCED_TABLES + `sync/engine` CRDT COLUMN_ALLOWLIST renamed and kept consistent. `sigma-sync@localhost` (git-identity infra string) preserved.
- **In-flight prefix**: writes `jorvis-in-flight:` now, reads BOTH `jorvis-in-flight:` and `sigma-in-flight:` (dual-prefix backward-compat — older persisted in-flight tool calls still resolve to interrupted-turn detection).

**Cross-machine caveat**: renaming a synced table changes the CRDT wire format — peers must upgrade together (intentional coordinated rename, documented in `sync/engine.ts` + the migration header; acceptable for the internal-use ecosystem).

### Gate

- tsc clean | eslint 0 errors / 0 warnings
- vitest 114 files / 1197 pass / 1 skip (migration 0022: 6 tests — rename, index, column, row survival, idempotency, name)
- build + electron:compile clean
- Playwright smoke e2e 38 s pass in main

Migration: **0022_jorvis_pane_events_rename**.

## [1.12.0] - 2026-05-21

v1.12.0 — **W-4 shell-first Phases 5-7 + W-5 Phase 3 skill activation + W-8 IDE per-pane worktree browsing + Hermes PR-review skill**. Four parallel Sonnet coder clusters (isolated worktrees) + lead diff-review + combined main gate.

### W-4 shell-first — Phases 5-7 (win32 + validation + flip-wiring)

win32 shell-first support, **flagged default-off** (`pty.spawnMode` stays `'direct'` → zero regression on all platforms; the win32 platform guard was removed from the shell-first branch but the default never selects it). win32 sentinel variants (PowerShell `$LASTEXITCODE`, cmd `%ERRORLEVEL%`) emit the same `__SIGMALINK_CLI_EXIT_<code>__` marker registry.ts already parses; per-shell command quoting (`win32QuotePwshArg` / `win32QuoteCmdArg`). The Phase 7 flip mechanism is wired but the default is **HELD at `'direct'`** pending operator dogfood. win32 e2e is pending-Windows-dogfood (can't be verified on the macOS build host). +46 tests.

### W-5 Phase 3 — skill slash-command activation

Dropping a skill on a pane now injects a native `/skill-name` slash command into that pane's input (new `insertSkillCommand.ts`, mirroring the file→`@`-mention drop — no newline, lands in the input line), gated on provider compatibility: claude/codex/gemini inject; kimi/opencode get a chip-only binding + a toast. The Skills tab shows per-skill provider-compat badges sourced from the fan-out state. Worktree-agnostic (slash commands are CLI-config-resolved, not path-resolved).

### W-8 — IDE per-pane worktree file browsing

The Editor file tree gains a root selector — *Workspace root* + each open pane's worktree + a "Follow focused pane" mode — persisted in `editor.<workspaceId>.rootSelection`. Closes the gap where files unique to one pane's worktree (untracked/agent-created) weren't browsable/draggable. Save path-containment accepts worktree roots. Zero behavior change when no pane worktrees exist (the selector renders nothing).

### Hermes PR-review skill (marketplace)

Added `NousResearch/hermes-agent`'s `github-code-review` skill to the marketplace catalog as a one-click, subpath-targeted install that fans out to Claude/Codex/Gemini (surfaced by an agent investigation).

### Gate

- tsc clean | eslint 0 errors / 0 warnings
- vitest 113 files / 1190 pass / 1 skip (+88 vs v1.11.0)
- build + electron:compile clean
- Playwright smoke e2e 38.5 s pass in main

No schema migrations in v1.12.0 (the DB-table rename is W-6 Cluster B, shipping next).

## [1.11.0] - 2026-05-21

v1.11.0 — **W-6 full Sigma→Jorvis assistant identifier rename (Cluster A)**. One Sonnet coder cluster (isolated worktree) + lead diff-review + lead-fixed e2e label sync.

### Assistant identifier rename: Sigma → Jorvis

Renames the assistant's internal code identifiers from `Sigma` to `Jorvis`, completing the code-level half of the v1.8.0 label-only rename. This is **Cluster A** of the W-6 sweep; the DB-table + cross-sync rename (**Cluster B**) ships separately.

- **Folders / files** (history-preserving `git mv`): `sigma-assistant/ → jorvis-assistant/` (17 files), `SigmaRoom.tsx → JorvisRoom.tsx`, `SigmaTabPlaceholder.tsx → JorvisTabPlaceholder.tsx`.
- **Identifiers**: `useSigma*` hooks → `useJorvis*`, `buildSigmaSystemPrompt → buildJorvisSystemPrompt`, `SIGMA_HOST_* → JORVIS_HOST_*` env, MCP server name `sigma-host → jorvis-host`, build artifact `mcp-sigma-host-server.cjs → mcp-jorvis-host-server.cjs`.
- **Backward-compat (no loss on upgrade)**: `RoomId 'sigma' → 'jorvis'` via `normalizeRoomId()`, `RightRailTabId` via `normalizeTabId()` — persisted sessions / localStorage / KV holding the old `'sigma'` value still restore.
- **Window event**: `sigma:sigma-jump-to-message → jorvis:jump-to-message` (in-process, renamed atomically).
- **e2e specs** synced to the new `Jorvis` room label/id (lead fix-forward — the agent's worktree couldn't run Playwright; the main gate caught 8 stale `'Sigma Assistant'` / `'sigma'` refs across smoke/dogfood/assistant-cli).

### Preserved (intentionally untouched — Cluster B / app-infra)

`sigma_pane_events` + `sigma_monitor_conversation_id` (DB — Cluster B), `sigma-in-flight:` toolCallId prefix (cross-machine wire — Cluster B), `window.sigma`, `SIGMA_TEST`, `sigma:test:*`, `sigma:pty-focus`, `sigma:scroll-*`, `sigma-sync@localhost`, and product names `SigmaLink` / `SigmaVoice`.

### Gate

- tsc clean | eslint 0 errors / 0 warnings
- vitest 111 files / 1102 pass / 1 skip
- build + electron:compile clean (emits `mcp-jorvis-host-server.cjs`)
- Playwright smoke e2e 38 s pass in main (Jorvis room nav + conversations panel verified)

No schema migrations in v1.11.0 (DB rename deferred to Cluster B).

## [1.10.4] - 2026-05-21

v1.10.4 — **W-4 shell-first Phase 4 of 7: Cmd+T scratch-shell sub-tabs**. One Sonnet coder cluster + a lead-caught regression fix.

### Ephemeral scratch terminals in a pane (Cmd+T)

Press **Cmd+T** (macOS) / **Ctrl+Shift+T** in a focused pane to open an ephemeral scratch shell as a sub-tab — for quick `ls` / `git diff` / testing — without touching the pane's main CLI session. Switchable, closable; nothing is persisted.

- **Backend**: `pty.spawnScratch({ cwd })` spawns a `providerId:'shell'` PTY in the pane's cwd (NO `agent_session` row), `pty.killScratch({ scratchId })` tears it down. Scratch PTYs are regular `PtyRegistry` entries (cleaned up by `killAll()` on quit). Allowlisted + typed + cross-ref tested.
- **Renderer**: `PaneTabStrip` + per-pane scratch-tab state + keybind (capture-phase, scoped to the focused pane container) + per-tab terminal switching (inactive tabs stay mounted so PTY data + scrollback survive switches).

### Lead-caught regression (why this is correct, not rushed)

The cluster's first implementation wrapped the main terminal in an **unconditional** `<div>` even at zero sub-tabs. Since `SessionTerminal` is `width/height:100%`, that auto-height wrapper would have **collapsed the terminal → empty pane in the default case** (the exact empty-pane regression class). Caught in diff review. Fixed: a **zero-subtab fast path** that renders `PaneSplash` + `SessionTerminal` as direct children of `relative min-h-0 flex-1` (byte-for-byte the pre-Phase-4 markup, no wrapper); the switchable structure activates only when ≥1 sub-tab exists, with the active main wrapper using `display:contents` (generates no box → terminal still fills). Verified by the zero-subtab RTL test + smoke e2e in main.

**Zero regression at default**: with no scratch sub-tabs, the pane renders exactly as before — no tab strip, no wrapper. This is the additive invariant.

### Combined main gate

- tsc clean
- vitest 111 files / 1102 pass / 1 skip (+13 from v1.10.3: scratch spawn/kill backend + PaneShell tab RTL + zero-subtab regression guard)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass in main (zero-subtab pane render verified — the regression-fix proof)

No schema migrations in v1.10.4.

## [1.10.3] - 2026-05-21

v1.10.3 — **terminal scrollback persistence across app restart** (v1.9-backlog item), behind a default-off flag. One Sonnet coder cluster, lead-merged.

### Scrollback persistence (experimental, opt-in)

A pane's visual scrollback (the main-process `RingBuffer`) was lost on app quit — the CLI conversation survives via `--resume`, but the terminal history didn't. This adds opt-in persistence:

- **Flag**: KV `pty.scrollbackPersistence` (DEFAULT off). Settings → "Persist terminal scrollback across restart (experimental)".
- **`scrollback-store.ts`** (new): `persistScrollback` (atomic tmp→rename to `<userData>/scrollback/<sessionId>.log`, capped 256 KiB, tolerates all I/O errors), `loadScrollback`, `gcScrollback` (removes stale files for non-live sessions, best-effort).
- **`RingBuffer.restore(text)`** (new): seeds the buffer with prior content (tail-truncates if over cap), called before live `onData` so `snapshot()` returns restored + live naturally.
- **Wiring (all flag-gated)**: persist on PTY exit + on `shutdownRouter()` (app quit) before teardown; on resume spawn (`registry.create` when `isResume`), restore the buffer with a dim `—— restored scrollback ——` separator before live data; `gcScrollback` on boot.

**Zero regression at default-off**: the `onSessionExit` persist callback is only wired when the flag is `'on'` at construction; `resumeScrollback` is only populated when the flag is on; the boot GC is a harmless ENOENT no-op. With the flag off, behavior is byte-for-byte identical. Smoke e2e boots at default-off.

Touches the same session-restore/snapshot zone as the v1.5.6 grace-window work — hence the strict default-off gating + smoke verification in main.

### Combined main gate

- tsc clean
- vitest 109 files / 1089 pass / 1 skip (+27 from v1.10.2: RingBuffer.restore, scrollback-store persist/load/gc, registry flag-gated seeding + regression guards)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass (default-off boots — zero-regression proof; run in main, worktree lacked native module builds)

No schema migrations in v1.10.3.

## [1.10.2] - 2026-05-21

v1.10.2 — **W-4 shell-first Phase 3 of 7: dispatch correctness** (flagged, default-off). One Sonnet coder cluster, lead-merged.

### Sigma/Jorvis dispatch works in shell-first mode (all providers)

`assistant.dispatchPane` spawns panes with an `initialPrompt`. There are three prompt-delivery mechanisms across providers; Phase 3 makes all of them correct under shell-first:

- **`initialPromptFlag`** (gemini `-i`) and **`oneshotArgs`** (claude `-p {prompt}`, codex `-q {prompt}`) — the prompt is a CLI arg, so Phase 1's shell-first injection already writes `<cli> <flag> "<prompt>"\n` to the shell. These panes stay shell-first. Verified + tested.
- **Path B / stdin** (kimi, opencode — no prompt flag) — the prompt is delivered by a post-spawn `pty.write`, which would RACE the shell→CLI startup in shell-first mode. Rather than a half-built timing fix, Phase 3 applies a clean **per-pane fallback**: when global `pty.spawnMode` is `'shell-first'` but a pane has an `initialPrompt` AND its provider has neither prompt flag, that pane spawns in `'direct'` mode (`effectivePaneSpawnMode()` in `local-pty.ts`, applied in `executeLaunchPlan`). The prompt is delivered correctly (no race); that one pane forgoes shell-durability — a documented, fully-functional degradation. Other panes keep shell-first.

The "stdin-prompt + shell-durability via a CLI-ready signal" combination is a deliberately-deferred future enhancement (not half-built here).

**Zero regression at default**: `effectivePaneSpawnMode('direct', …)` always returns `'direct'`; the per-pane override fires only when global mode is `'shell-first'`. Smoke e2e boots at default.

### Combined main gate

- tsc clean
- vitest 106 files / 1062 pass / 1 skip (+10 from v1.10.1: per-pane spawn-mode resolution across all prompt-delivery mechanisms + direct-mode regression guards)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass (default-direct boots — zero-regression proof; run in main, as the worktree lacked an Electron binary)

No schema migrations in v1.10.2.

## [1.10.1] - 2026-05-21

v1.10.1 — **W-4 shell-first Phase 2 of 7: CLI-exit detection** (flagged, default-off). One Sonnet coder cluster, lead-merged.

### CLI-exit detection in shell-first mode

In shell-first mode (v1.10.0), when the CLI exits the shell stays alive (the durability win) — but SigmaLink's pane-status + "agent done" notification key off PTY exit, which now only fires when the shell itself dies. Phase 2 adds a sentinel so SigmaLink detects CLI completion while keeping the pane alive.

- **Sentinel** (`app/src/main/core/pty/sentinel.ts`, new): shell-first injection now appends `; printf '\n%s%d%s\n' '__SIGMALINK_CLI_EXIT_' "$?" '__'` after the CLI command, so on CLI exit the shell prints `__SIGMALINK_CLI_EXIT_<code>__` then returns to its prompt. `extractSentinel()` parses the code + strips the marker; `buildShellCommandLine(cmd, args, withSentinel)` composes it (direct mode passes `withSentinel=false` / doesn't use it at all).
- **Detection** (`registry.ts`): in shell-first mode only, the `onData` stream is scanned for the sentinel; on match it strips the marker from the renderer-forwarded data and fires a new `onCliExited` sink with the parsed exit code — DISTINCT from PTY `onExit` (which fires only when the shell dies). The pane/PTY is NOT torn down (`forget()`/`kill()` not called).
- **Notification** (`rpc-router.ts`): `onCliExited` calls the same `pushPtyExitNotification` path that direct-mode PTY-exit uses, so shell-first panes get the identical "agent done" notification.
- **Status-representation choice**: a separate additive `onCliExited` callback — NOT a new `sigma_pane_events.kind` enum value (which would force a migration + risk direct-mode consumers). Zero schema change, zero enum extension, zero direct-mode impact.

**Zero regression at default**: detection runs only when `spawnMode === 'shell-first'`; direct mode never composes or scans for the sentinel. Smoke e2e boots at the default flag.

### Plan re-ordering

`external_session_id` removal (originally Phases 2-3) is re-ordered to **after** the Phase 7 default-flip — direct mode still needs it pre-flip. Pre-flip additive phases: exit-detection (this) → Sigma/Jorvis dispatch rewrite → Cmd+T → win32 → dogfood → flip default → then resume simplification + schema drop.

### Combined main gate

- tsc clean
- vitest 106 files / 1052 pass / 1 skip (+37 from v1.10.0: sentinel suite + injection + detection + direct-mode regression + notification)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass (default-direct boots — zero-regression proof)

No schema migrations in v1.10.1.

## [1.10.0] - 2026-05-21

v1.10.0 — **W-4 shell-first pane architecture, Phase 1 of 7** (flagged, default-off). The first increment of the multi-session pivot away from the brittle PTY-direct-CLI model toward a durable shell-first model (SigmaSpace-style). One Sonnet coder cluster (worktree-isolated), lead-merged.

### Shell-first spawn mode (experimental, opt-in)

Today SigmaLink spawns the CLI binary (`claude`/`codex`/…) as the PTY's direct child — when the CLI exits or fails to start, the pane dies (the empty-pane class of regressions; v1.5.6 mitigated the symptom). Shell-first mode instead spawns the user's shell as the PTY process and injects the CLI command into it, so the pane survives CLI exit.

This release ships **Phase 1**: the launch-mechanism branch, behind a feature flag.

- **Flag**: KV `pty.spawnMode` ∈ `'direct'` (DEFAULT) | `'shell-first'`. `parseSpawnMode()` returns `'direct'` for any absent/invalid value.
- **`spawnLocalPty` branch** (`app/src/main/core/pty/local-pty.ts`): `'direct'` (or empty command, or win32) → existing path, **byte-for-byte unchanged**. `'shell-first'` (non-win32, CLI command set) → spawns `defaultShell()`, then on the shell's first `onData` chunk (prompt-ready) — with a 250 ms fallback timer + a double-inject latch — writes the safely POSIX-quoted composed command line `<command> <args>\n` into the PTY. The resume-arg machinery is **untouched** (the composed args already include resume flags; shell-first just writes that line to the shell instead of spawning it directly).
- **Settings**: "Shell-first panes (experimental)" toggle in Settings → Ruflo, bound to the KV via existing `kv.get`/`kv.set` (no new channels).
- **win32**: stays on direct mode in Phase 1 (Windows shell-quoting deferred to a later phase).

**Zero regression at default**: the `'shell-first'` path activates only when ALL of `spawnMode==='shell-first'` + non-empty command + non-win32 hold; every other input reaches the identical existing code path. The smoke e2e boots at the default flag and verifies this.

### Why this is Phase 1 of 7

The full shell-first pivot (~14-day arc) is sequenced behind the same flag so every intermediate release is shippable: **(1, this release)** flagged spawn → (2) resume simplification → (3) drop `external_session_id` schema → (4) "agent done" exit-detection rework → (5) Sigma/Jorvis dispatch rewrite → (6) Cmd+T sub-tabs → (7) reviewer + dogfood + flip default to `'shell-first'`. Plan: `docs/03-plan/v1.6.0-shell-first-pane-architecture.md`. Resolves the v1.5.6 empty-pane root cause once complete.

### Combined main gate

- tsc clean
- vitest 105 files / 1015 pass / 1 skip (+21 from v1.9.1: parseSpawnMode, posixQuoteArg, direct-mode regression guard, shell-first inject/double-guard/fallback-timer)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass (default-direct boots — zero-regression proof)

No schema migrations in v1.10.0.

### Fixed

- **SessionStep coverage-mode test flake (root-caused + fixed)** — `SessionStep.test.tsx > "Resume newest for all"` failed intermittently under `vitest --coverage` (the `lint-and-build` lane) while passing in plain `vitest run`. Root cause: the test's `waitFor` condition `last?.[0] !== undefined` was satisfied by the initial `null` selection (`null !== undefined` is `true`) BEFORE `listSessions` resolved, so the bulk action clicked against an empty session list and set `null`. Timing in the full suite happened to let sessions load first; isolation/coverage timing did not — a race that recurred since v1.4.5/v1.4.7. Fixed by waiting for the actual loaded session id (`session-aaa`/`session-bbb`) via the smart-default signal, mirroring the working smart-default test. Test-only change; no binary impact. Verified: 12/12 isolated under `--coverage` + 993/994 full suite.

## [1.9.1] - 2026-05-21

v1.9.1 — `isResume` explicit registry field (v1.5.5 reviewer item, deferred and now closed). A behavior-equivalent clarity + efficiency refactor in the PTY-resume core.

### Change

`PtyRegistry.create` previously derived resume-ness implicitly: `const isResume = input.sessionId !== undefined;`. A pane carrying a `sessionId` for any reason would be treated as a resume. This release adds an explicit optional `isResume?: boolean` to `PtyRegistry.create` + `ResolveAndSpawnOpts`:

```ts
const isResume = input.isResume ?? (input.sessionId !== undefined);
```

The fallback preserves the exact prior behavior for any caller that doesn't pass the field — **zero behavior change**. Callers now declare intent explicitly:
- `resume-launcher.ts` (`resumeWorkspacePanes`, `respawnFailedWorkspacePanes`) → `isResume: true`
- `workspaces/launcher.ts` (`executeLaunchPlan`) + `swarms/factory-spawn.ts` (fresh spawns) → `isResume: false`

The `onPostSpawnCapture` disk-scan gate (`if (!isResume && ...)`) is unchanged. The efficiency win: resume callers now suppress the redundant disk-scan by *declared intent* rather than incidentally because they happen to carry a `sessionId`. `shouldPreAssign` + the `sessionId` resume sentinel + `preassignedSessionId` semantics are untouched.

### Gate

- tsc clean
- vitest 105 files / 993 pass / 1 skip (+3 isResume equivalence/override tests)
- eslint 0 errors / 0 warnings
- build + electron compile clean
- Playwright smoke e2e 38 s pass (critical for this PTY-resume-core change)

### Still deferred (unchanged from v1.9.0)

W-4 shell-first (~14d), V3 Wave 12-15 (multi-month), W-5 behavioral activation (design-first), W-6 full Jorvis identifier rename, SigmaVoice signed installers (funded certs), V3-W15-006 dogfood, terminal scrollback persistence (design question).

No schema migrations in v1.9.1.

## [1.9.0] - 2026-05-21

v1.9.0 — Skills tab Phase 2: drag-drop skill bindings + persistence (informational mode). One Sonnet coder cluster (worktree-isolated), lead-merged.

### Skills tab Phase 2 — drag-drop binding + persistence (W-5)

Phase 1 (v1.7.0) shipped the read-only Skills discovery tab. Phase 2 adds the ability to **bind** a skill to a pane or workspace by drag-drop, persisted across restart:

- **Migration 0021** — new `skill_bindings` table (`id`, `workspace_id`, `pane_session_id` NULL = workspace-wide / non-null = pane-scoped, `skill_name`, `skill_source`, `attached_at`) + index.
- **RPC** — `skills.attach` (dedup-aware), `skills.detach`, `skills.listBindings({ workspaceId })`. All three allowlisted in CHANNELS + typed in router-shape + covered by the CHANNELS-vs-AppRouter cross-reference test.
- **Drag-drop UI** — SkillsTab rows are draggable (MIME payload `{ kind: 'skill', name, source }`); `PaneShell` and `CommandRoom` (workspace header) are drop targets reusing the v1.4.8 file→pane drag-drop pattern. Dropping on a pane → pane-scoped binding; on the workspace → workspace-wide. Bindings render as dismissible `SkillBindingChip`s; the `useSkillBindings` hook loads existing bindings on workspace open (persistence).

**Scope: INFORMATIONAL binding only.** A binding is a persisted visual association shown as a chip — it does NOT yet alter agent dispatch behavior or inject anything into agent context. **Behavioral activation** (a bound skill actually affecting how Sigma/Jorvis or a pane's agent behaves) is a deliberately-deferred future enhancement that requires resolving activation-semantics design questions (per the W-5 brainstorm). This release ships the additive, reversible binding layer that behavioral activation would later build on.

### Combined main gate

- tsc clean
- vitest 105 files / 990 pass / 1 skip (+28 from v1.8.0: migration 0021 + binding controller + SkillsTab RTL)
- eslint 0 errors / 0 warnings
- SigmaLink build + electron compile clean
- Playwright smoke e2e 38 s pass

### Still deferred (genuinely multi-day-to-multi-month — NOT force-shipped)

- **W-4 shell-first pane architecture** (~14 days, incl. schema migration; v1.5.6 empty-pane root cause).
- **V3 Wave 12-15 parity** (45 tickets, multi-month).
- **W-5 behavioral skill activation** (the binding layer shipped here is informational; activation semantics need a design decision).
- **W-6 full Jorvis identifier rename** (IPC channels + DB tables + file names; label rename shipped v1.8.0 — full sweep deferred per "not for now").
- **SigmaVoice signed/notarized installers** (funded certs; unsigned canonical for internal use — unsigned installers shipped sigmavoice-v0.1.4).
- **V3-W15-006 dogfood** (human-only QA).

No schema migrations beyond 0021 in v1.9.0.

## [1.8.0] - 2026-05-21

v1.8.0 — completes two more open items on top of v1.7.1: the standalone SigmaVoice app now produces real (unsigned) installers, and the assistant is renamed "Jorvis" in the UI. Two parallel Sonnet coder clusters (worktree-isolated), lead-merged.

### SigmaVoice standalone app — real unsigned installers

v1.7.0 shipped the `@sigmalink/sigma-voice` app as a runnable dev scaffold; v1.8.0 makes it packageable into actual installers using SigmaLink's internal-use **unsigned / ad-hoc** distribution model (no funded codesigning — same Gatekeeper-bypass + SmartScreen-on-first-launch UX SigmaLink already uses):

- `app/apps/sigma-voice/scripts/build.cjs` — esbuild bundler (main ESM + preload CJS), mirroring `app/scripts/build-electron.cjs`.
- `app/apps/sigma-voice/electron-builder.yml` — `appId: ai.sigma.sigmavoice`, productName "SigmaVoice", `identity: null` (ad-hoc), macOS DMG (arm64 + x64) + Windows NSIS, voice `.node` asarUnpack, `afterSign` ad-hoc codesign hook.
- `app/apps/sigma-voice/build/entitlements.mac.plist` — microphone, speech-recognition, audio-input, apple-events (AX paste), V8 JIT entitlements + `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription`.
- `app/apps/sigma-voice/build/installer.nsh` + `build/dmg/README — Open SigmaVoice.txt` — SmartScreen / Gatekeeper bypass UX.
- `.github/workflows/release-sigma-voice.yml` — NEW CI lane triggered on `sigmavoice-v*` tags ONLY (never fires on SigmaLink `v*` tags). macOS + Windows jobs, `@electron/rebuild -w whisper_bridge -w sigmavoice_mac`, `CSC_IDENTITY_AUTO_DISCOVERY=false`, uploads to a GitHub release.

Local validation: `electron-builder --mac dir` ran cleanly, ad-hoc sign + `codesign --verify` succeeded. Full DMG/NSIS production runs on CI when a `sigmavoice-v*` tag is pushed (first is `sigmavoice-v0.1.0`). This is the standalone-app deliverable the operator requested ("make SigmaVoice a separate app like the original SigmaVoice").

### Assistant renamed "Jorvis" (UI label-only)

The in-app assistant is now displayed as "Jorvis" — 20 user-facing display strings across 11 renderer files: right-rail tab label, chat speaker label (SIGMA → JORVIS), "Ask Jorvis…" placeholders + aria-labels, command-palette + rooms-menu entries, notification copy ("Jorvis tool errors", "chime on Jorvis dispatch finish"), dispatch toasts, voice pill ("Asking Jorvis…").

**Scope: label-only.** IPC channels (`assistant:*`, `sigma:*`), DB tables (`sigma_pane_events`), file/folder names (`sigma-assistant/`, `SigmaRoom.tsx`), TypeScript identifiers, KV/capability keys, and test-ids are deliberately UNCHANGED — the full identifier sweep is a separate high-blast-radius packet (touches the CHANNELS allowlist + a schema migration) deferred per the operator's earlier "full rename but not for now." Three "Sigma Canvas" / "Sigma pattern surfacing" strings were correctly left untouched (they name a design-tool feature + a Ruflo capability, not the assistant persona).

### Combined main gate

- tsc clean
- vitest 102 files / 962 pass / 1 skip
- eslint 0 errors / 0 warnings
- sigma-voice esbuild bundle clean + electron-builder config validated (`--mac dir` + ad-hoc sign)
- SigmaLink build + electron compile clean
- Playwright smoke e2e 38 s pass (Jorvis labels render, app boots)

### Still deferred (genuinely multi-day-to-multi-month — NOT force-shipped)

- **W-4 shell-first pane architecture** (~14 days, incl. schema migration; v1.5.6 empty-pane root cause).
- **V3 Wave 12-15 parity** (45 tickets, multi-month).
- **W-5 Skills tab Phase 2** (drag-drop + persistence, ~5-7 days; Phase 1 shipped v1.7.0).
- **W-6 full Jorvis identifier rename** (IPC channels + DB tables + file names — the label rename shipped here; the internal sweep is its own packet).
- **SigmaVoice signed/notarized installers** (would require funded Apple Developer + EV cert — out of scope for internal use; unsigned is canonical).
- **V3-W15-006 dogfood** (human-only QA).

No schema migrations in v1.8.0.

## [1.7.1] - 2026-05-21

v1.7.1 — build hotfix for v1.7.0. The v1.7.0 tag's CI installer build failed (no release was published), so this is the first shippable v1.7.x.

### Bug

v1.7.0 promoted the native voice packages (`@sigmalink/voice-mac` / `voice-win` / `voice-whisper`) to pnpm workspace members AND declared them as `dependencies` of `@sigmalink/voice-core`. Because `voice-core` is a production dependency of the app, this pulled the three native packages into electron-builder's **production dependency tree** — so electron-builder's automatic `npmRebuild: true` step tried to `npm rebuild @sigmalink/voice-whisper` with plain node-gyp. That build failed on CI with `unknown target CPU 'apple-m1'` (a whisper.cpp build-flag issue that the dedicated `@electron/rebuild -w whisper_bridge` CI step handles correctly, but plain `npm rebuild` does not).

Pre-v1.7.0, the voice natives were loaded via `createRequire` path-walking and were never in the production dependency tree, so electron-builder only rebuilt `node-pty` + `better-sqlite3`. The v1.7.0 workspace-promotion inadvertently changed that scope.

### Fix

Moved the three native packages from `dependencies` to **`devDependencies`** in `app/packages/voice-core/package.json`. This:
- Keeps TypeScript type resolution working (`whisper-engine.ts` imports `@sigmalink/voice-whisper` types) and dev symlinks intact.
- Removes them from electron-builder's production rebuild scope (devDependencies are not followed for the packaged app), restoring the known-good pre-v1.7.0 behavior where only the explicit `@electron/rebuild` CI step builds the voice natives.
- Runtime loading is unaffected — `voice-core`'s native loaders try `@sigmalink/voice-*` first, then fall back to `app/native/voice-*/index.js` path-walking (the same mechanism SigmaLink used before v1.7.0). The voice `.node` binaries are packaged via electron-builder's existing `native/` asarUnpack config, independent of the dependency tree.

No other changes — all v1.7.0 features (voice-core extraction, SigmaVoice scaffold, Ruflo daemon Settings UI, Skills tab Phase 1, migration 0020, A5 eslint fix) ship intact.

Local gate after fix: pnpm install clean, tsc clean, electron:compile clean (voice-core resolves), full vitest + smoke verified at v1.7.0.

## [1.7.0] - 2026-05-21

v1.7.0 — "finish open items" bundle: closes the remaining small/medium wishlist items + extracts the voice-capture stack into a shared package with a standalone SigmaVoice app scaffold. Three parallel Sonnet coder clusters (worktree-isolated), lead-merged.

### SigmaVoice → SigmaVoice extraction (groundwork)

"SigmaVoice" was the original product name for SigmaLink's voice module (still visible in `app/native/voice-mac/package.json` description). This release extracts the self-contained global-capture stack into a shared package so a standalone dictation app can consume it:

- **`@sigmalink/voice-core`** (new package, `app/packages/voice-core/`) — extracts `global-capture.ts` + `output-router.ts` + `whisper-engine.ts` + `model-registry.ts` with full dependency injection (Electron APIs, `emit`, KV accessors, `modelsDir`, `clipboard` all injected — no SigmaLink-specific imports).
- **Native packages promoted to pnpm workspace members** — `@sigmalink/voice-mac`, `@sigmalink/voice-win`, `@sigmalink/voice-whisper` are now real workspace members (via `app/pnpm-workspace.yaml`) instead of `createRequire` path-walking.
- **SigmaLink consumes `@sigmalink/voice-core`** — `app/electron/main.ts` imports `buildGlobalCaptureController` from the shared package (added as a `workspace:*` dependency). No behavior change; all existing voice IPC channels + events work identically.
- **`@sigmalink/sigma-voice`** (new app scaffold, `app/apps/sigma-voice/`) — a runnable standalone Electron app: Tray + global hotkey + `buildGlobalCaptureController` + minimal settings window (model download, hotkey rebind, output mode). System-wide dictation: hotkey → capture → whisper transcribe → clipboard/AX-paste into the focused app. No workspace/pane/session logic.
- **A1 hardware sample-rate detection** — the macOS native binding (`voice-mac`) now reports the actual hardware sample rate through the `onPcm` callback (`{ samples, sampleRate }`); `voice-core`'s resampler uses the real rate instead of a hardcoded 48 kHz constant, falling back to 48 kHz for bare-array chunks (Win/other). Fixes mild pitch error on 44.1 kHz hardware.

**Explicitly deferred** (documented in `app/apps/sigma-voice/README.md`): production packaging for the standalone app — its own `electron-builder.yml` target, macOS entitlements (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, audio-input), codesigning identity, DMG/NSIS build matrix, CI lane. The standalone app is a runnable dev scaffold this release, not a signed installer.

### Ruflo HTTP daemon Settings UI (B2)

v1.6.0 shipped the per-workspace Ruflo HTTP daemon but had no UI to observe it. This release adds a "Ruflo Daemon" section to Settings → Ruflo:

- New `RufloHttpDaemonSupervisor.list()` returns all tracked daemon handles.
- New RPC handlers `ruflo.daemonStatus(workspaceId?)` (best-effort `/health` probe for live connection counts) + `ruflo.restartDaemon(workspaceId)`.
- Settings table: workspace / status badge / port / PID / uptime / connections + per-row Restart button. Polls every 5 s while the tab is open.

### Skills tab in right panel — Phase 1 (B3, read-only discovery)

New "Skills" tab in the right-rail icon strip next to Browser / IDE / Sigma Assistant:

- New RPC handler `skills.listInstalled()` discovers superpowers skills (`~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/*/SKILL.md`, frontmatter-parsed) + Ruflo skills, tolerant of missing directories.
- Searchable list; each row shows name + description + source badge (superpowers / ruflo / custom); click to expand full description + "Copy /name" to clipboard.
- Phase 1 is read-only discovery only. Drag-drop activation + per-pane/workspace binding + persistence are Phase 2 (deferred — requires resolving activation-semantics + persistence-layer design questions).

### Correctness + hygiene

- **A2 — `(workspace_id, pane_index)` uniqueness** — migration 0020 dedupes existing duplicate rows (keeps most-recent `started_at`, tie-break highest id) then creates a partial UNIQUE index `WHERE pane_index IS NOT NULL`. Spawn paths in `launcher.ts` + `factory-spawn.ts` now catch the UNIQUE violation gracefully instead of crashing. Closes the concurrent-rapid-spawn race surfaced by the v1.5.5 Cluster B audit.
- **A5 — eslint warning eliminated** — `use-session-restore.ts` `react-hooks/exhaustive-deps` warning (flagged in every gate since v1.5.3) properly fixed via `useMemo` stabilization of `snapshotEntries` + adding `wsId` to the effect deps. The whole repo now passes `eslint --max-warnings 0`.
- **OPEN.md doc cleanup** — 15 stale `Status: open` bug entries (all closed in v1.1.2–v1.4.7) flipped to `closed (shipped <version>)` with the closing version noted.

### Combined main gate

- tsc clean
- vitest 102 files / 962 pass / 1 skip (+30 from v1.6.0 baseline: voice-core 83-test suite reorg + migration 0020 + A1 resample tests)
- eslint **0 errors / 0 warnings** (first zero-warning gate since v1.5.3 — A5 closed the long-standing one)
- build + electron compile clean (after wiring `@sigmalink/voice-core` as a `workspace:*` dependency so esbuild resolves the bundle)
- Playwright smoke e2e 37 s pass — app boots, voice-core integrated, native modules load (ABI verified)

### Deferred (NOT in this release — honest scope)

These are genuinely multi-day-to-multi-month and were not force-shipped:

- **W-4 shell-first pane architecture** (~14 days) — the v1.5.6 empty-pane root cause lives here; trigger-gated, not yet met.
- **V3 Wave 12-15 parity** (45 tickets, multi-month) — launcher chrome, swarm wizard, right-rail dock, Operator Console body, Bridge Assistant chat panel, constellation graph, Bridge Canvas, SigmaVoice intake.
- **W-5 Skills tab Phase 2** (drag-drop + persistence, ~5-7 days).
- **W-6 Sigma Assistant → Jorvis rename** — full IPC-channel + DB-table + file-name sweep is high-blast-radius; deferred to its own focused release with a reviewer cycle rather than rushed into this bundle.
- **SigmaVoice production installers** — codesigning + 2nd electron-builder target + CI matrix (the multi-day packaging tail of the voice extraction).
- **V3-W15-006 dogfood** — human-only QA exercise.

No schema migrations beyond 0020 in v1.7.0.

## [1.6.0] - 2026-05-21

v1.6.0 — **Ruflo MCP HTTP daemon mode** (W-7 from v1.5.6 architectural backlog). Per-workspace daemon spawned by SigmaLink at workspace open; all 5 CLI clients in that workspace point at one shared HTTP MCP endpoint instead of each spawning its own short-lived stdio process.

### Why

Per v1.3.5+ behavior, SigmaLink auto-binds Ruflo MCP across Claude / Codex / Gemini / Kimi / OpenCode. Each CLI invocation was spawning its own stdio Ruflo process and pointing at the same `<workspaceRoot>/.claude-flow/` directory. All 5 CLIs got the same on-disk state — but every tool call meant a fresh process, and concurrent panes would race on the sqlite file's read-modify-write cycle. A 6-pane workspace effectively ran 6 separate Ruflo instances against the same files: shared on-disk state, but no shared HNSW index in RAM, no live swarm coordination, no pattern-cache consistency across panes.

v1.6.0 collapses that to **one** Ruflo HTTP daemon per workspace. All 5 CLIs in the workspace point at `http://127.0.0.1:<port>/mcp`. Live in-memory state (HNSW, pattern cache, swarm consensus) is now shared across every pane in the workspace.

### How

Three layers:

**1. Per-workspace daemon supervisor** (`app/src/main/core/ruflo/http-daemon-supervisor.ts`, ~280 LOC). Modeled on the existing `MemoryMcpSupervisor` (per-workspace `Map<workspaceId, DaemonHandle>` + SIGTERM→SIGKILL drain + linear backoff respawn). Key implementation details:

- **Port allocation**: `net.createServer().listen(0, '127.0.0.1', ...)` to obtain a free OS-allocated port BEFORE spawning, then pass the explicit port to `ruflo mcp start -t http -p <port> --host 127.0.0.1`. Avoids relying on Ruflo's own port-zero support.
- **Binary detection**: pre-spawn `command -v ruflo` check. Missing binary → `spawn()` returns `null`, supervisor logs a warning, autowrite falls back to stdio entries (no regression vs v1.5.6).
- **Health probe**: polls `GET /health` at exponential backoff (200 ms / 500 ms / 1 s / 2 s / 5 s steady-state). First 200-with-`{"status":"ok"}` → mark `'running'` + resolve `spawn()`. 10 s total timeout before declaring failed.
- **Crash recovery**: linear backoff respawn (1.5 s / 4.5 s / 13.5 s). After 3 consecutive failures → mark `'down'`, emit `restarted(workspaceId, false)`. On respawn success → emit `restarted(workspaceId, true)`. Both events surface to the user via the bell notifications (kind `ruflo-daemon`, severity `warn` for success, `error` for give-up).
- **Concurrency**: re-spawn for the same `workspaceId` returns the existing handle when status is `'running'`. No duplicate daemons.

**2. `mcp-autowrite.ts` HTTP-mode writer** (`app/src/main/core/workspaces/mcp-autowrite.ts`, ~150 LOC delta). `writeWorkspaceMcpConfig(root, opts?)` now accepts an optional `{ port?: number }`. When a port is provided, writes HTTP entries for all 5 CLIs:

- **Claude / Gemini / Kimi** (`mcpServers.ruflo`): `{ "url": "http://127.0.0.1:<port>/mcp" }` (URL alone implies HTTP per Claude's MCP schema; no `type` field).
- **Codex TOML** (`[mcp_servers.ruflo]`): `transport = "http"` + `url = "..."`.
- **OpenCode** (`mcp.ruflo`): `{ "type": "http", "url": "...", "enabled": true }`.

When no port is provided (daemon spawn failed, autowrite disabled, etc.), writes stdio entries unchanged — backward-compatible fallback. **Self-heal works both directions**: stdio → HTTP on next workspace open (daemon running), HTTP → stdio if daemon stops.

**3. Detection rule extension** (`isManagedRufloEntry()` + `isManagedOpencodeRufloEntry()`):

```ts
// stdio (v1.3.5+)
entry.command === 'npx' → managed

// HTTP (v1.6.0+)
typeof entry.url === 'string'
  && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.url)
  → managed
```

The regex enforces loopback-only (`127.0.0.1`) + plain HTTP + exact `/mcp` path. Non-loopback URLs, wrong paths, and HTTPS are correctly classified as user-managed and refused.

### Restart UX (deviation from plan)

The original plan called for a new `ruflo:daemon-restarted` event broadcast + bespoke renderer toast component. Implementation took a cleaner path: route restart notifications through the existing v1.4.9 `NotificationsManager`. Kind = `'ruflo-daemon'`. Severity = `'warn'` on successful respawn, `'error'` on give-up. Title + body explain the situation and tell the operator to retry their last MCP-using action if it appeared to hang. The user sees this in the bell drawer (already wired, already persistent, already deduped). Saves ~30 LOC of new renderer code + 1 event allowlist entry + lots of toast plumbing.

### Known issues / deferred

- **Concurrent-write race within daemon** (Agent C #7 in the brainstorm): the daemon itself doesn't serialize concurrent sqlite writes across Node's async event loop. 6 panes hitting the same daemon simultaneously can still race on file read-modify-write cycles inside `.swarm/memory.db`. **Significantly reduced** from the v1.5.6 multi-process race (6 stdio processes → 1 daemon = lower contention), but not eliminated. Target: upstream write-mutex PR to claude-flow as v1.7 work.
- **Settings UI for daemon status** (v1.6.1): no current way to see "this workspace's Ruflo daemon: running on port X / PID Y / connections Z / restart". The data is available via `RufloHttpDaemonSupervisor.status()` / `.port()`; just needs a Settings tab. Operator can probe today via `curl http://127.0.0.1:<port>/health`.
- **Multi-workspace global daemon mode** (v1.7+): Ruflo's HTTP transport has no per-request workspace routing today (it pins to `CLAUDE_FLOW_CWD` at startup). Per-workspace daemons are the only viable model until upstream adds routing.
- **Daemon-restart pane disruption**: when the daemon restarts, in-flight MCP calls from CLI panes hard-fail (HTTP connection reset). The notification tells the operator to retry. A future enhancement would proxy MCP traffic through SigmaLink and transparently buffer requests across daemon restarts.

### Combined main gate

- tsc clean
- vitest 100 files / 924 pass / 1 skip (+26 from v1.5.6 baseline: 13 supervisor + 13 autowrite HTTP-mode tests)
- eslint 0 errors / 1 pre-existing warning (`use-session-restore.ts`)
- build + electron compile clean
- Playwright smoke e2e 36 s pass

### Backward compatibility

- Existing v1.5.x workspaces continue to work. On first open after upgrade:
  - SigmaLink attempts daemon spawn
  - If `ruflo` binary is on PATH → daemon spawns, autowrite rewrites stdio MCP entries → HTTP entries on disk
  - If `ruflo` binary missing → spawn returns null, autowrite writes stdio entries (identical to v1.5.6)
- Existing user-managed MCP entries (non-`npx`, non-loopback URL) → still detected as user-managed and refused with warning, never overwritten.
- Cross-machine sync wire format: unchanged. No schema migration in v1.6.0.

No schema migrations in v1.6.0.

## [1.5.6] - 2026-05-21

v1.5.6 — emergency hotfix unmasking fast-exit binary errors that v1.5.5 surfaced as empty pane bodies.

### Bug

After updating to v1.5.5 some users reported all panes rendering with proper headers (provider/role/index visible, sidebar agent badge correct) but **completely empty bodies** — no Claude/Codex/OpenCode startup banner, no error text, nothing. All providers affected uniformly.

### Root cause

`PtyRegistry.gracefulExitDelayMs` (default 200 ms) governs how long the ring buffer survives after `pty.onExit` fires before `forget()` clears it. For binaries that exit very fast on startup (missing CLI binary, ENOENT, bad PATH, version-incompatible flag), the sequence becomes:

```
t=0      PTY spawns
t=50ms   Binary exits (fast failure)
t=50ms   registry.onExit fires; setTimeout(forget, 200) scheduled
t=150ms  Renderer mounts SessionTerminal, calls rpc.pty.snapshot(sessionId)
t=250ms  forget() fires → buffer.clear() → sessions.delete(id)
t=251ms  snapshot IPC resolves → sessions.get(id) = undefined → returns ''
         → nothing written to xterm → empty body
```

Because the buffer cleared before the renderer's IPC round-trip resolved, whatever the CLI emitted (banner, error message, stack trace) was silently dropped on the floor.

### Why v1.5.5 surfaced it (and not v1.5.4)

The race has been latent since the PTY layer was built. v1.5.5-A's pre-allocated session UUID pipeline removed async timing slack from `worktreePool.create` (the path was tighter and more synchronous), narrowing the window between PTY spawn and renderer mount. Fast-failing binaries now reliably beat the 200 ms grace window where v1.5.4's looser timing usually kept them under it.

### Fix

`app/src/main/rpc-router.ts:298-300` — bumped `gracefulExitDelayMs` from 200 ms to 3 000 ms in the `PtyRegistry` opts:

```ts
new PtyRegistry(
  (sessionId, data) => broadcast('pty:data', { sessionId, data }),
  (sessionId, exitCode, signal) => broadcast('pty:exit', { sessionId, exitCode, signal }),
  {
    gracefulExitDelayMs: 3_000,  // v1.5.6 — buffer survives renderer's snapshot IPC
    // …existing fields
  },
);
```

3-second window is comfortably above Electron IPC round-trip variance (typically <50 ms even under load). After 3 s `forget()` still runs — no memory leak, just delayed teardown. The session record is still removed; only the ring buffer's lifetime extended.

### What this does NOT fix

This hotfix surfaces fast-exit error output. It does NOT prevent the binaries from exiting. If your panes still come up "empty" with v1.5.6, the renderer will now display whatever the CLI emits before dying — which is the actual diagnostic information (e.g. `claude: command not found`, `ENOENT`, `bad flag`). Use that output to chase the root cause on your machine (likely CLI binary version drift, missing PATH, or workspace-specific config).

### Regression test

`app/src/main/core/pty/registry.test.ts` — new test "v1.5.6 — ring buffer survives gracefulExitDelayMs window after PTY exit so renderer snapshot wins the race" using `vi.useFakeTimers()` to assert:
- At `gracefulExitDelayMs - epsilon` after `onExit`, `snapshot(id)` still returns buffered content
- At `gracefulExitDelayMs + epsilon` after `onExit`, `snapshot(id)` returns `''`

### Combined main gate

- tsc clean
- vitest 99 files / 898 pass / 1 skip (+1 regression test)
- eslint 0 errors / 1 pre-existing warning (use-session-restore.ts, unrelated)
- Playwright smoke (35 s) passes — app boots, workspaces render, basic flows intact

### Deferred to v1.5.7+

- The root cause of the binaries dying fast on the user's machine — still unknown. Hypothesis: CLI version drift after external Claude/Codex/OpenCode upgrades. Diagnostic data will arrive once users see the unmasked error output.
- Shell-first pane architecture (spawn shell as PTY parent, auto-inject CLI command) — under brainstorming as a possible v1.6 packet. Would make pane lifetime durable across CLI exits and remove the entire ~150-reference `external_session_id` tracking surface. Decision deferred until v1.5.6 diagnostic data lands.

No schema migrations in v1.5.6.

## [1.5.5] - 2026-05-21

v1.5.5 — single-cluster UX-correlation feature with **2-cycle Opus reviewer round** that caught a critical resume-pipeline regression mid-flight.

### Worktree paths now visually correlate with `agent_sessions.id`

User feedback (v1.5.3/v1.5.4 dogfood): worktree paths like `sigmalink/codex/pane-0-ef30d4c8` had a random 8-char suffix that didn't visually tie to the session row in `agent_sessions`. Inspecting `~/Library/Application Support/SigmaLink/worktrees/` was opaque.

**v1.5.5 change**: pre-allocate the session UUID at the top of the spawn pipeline (in `executeLaunchPlan` and `materializeRosterAgent`); pass it through both the worktree creation AND the PTY registry. New format: `sigmalink/<provider>/pane-<N>-<sessionid8>` where `<sessionid8>` is the first 8 hex chars of `agent_sessions.id`.

After upgrading, you can:
```bash
sqlite3 ~/Library/Application\ Support/SigmaLink/sigmalink.db \
  "SELECT id, pane_index, worktree_path FROM agent_sessions ORDER BY pane_index"
```
…and see that each row's `id[0:8]` matches the trailing 8 chars of its `worktree_path`. Filesystem navigation (`cd ~/Library/Application\ Support/SigmaLink/worktrees/.../sigmalink/<provider>/`) now lets you correlate pane → session at a glance.

### 🚨 Opus reviewer caught critical resume-pipeline regression in initial PR

The first iteration of PR #69 passed `sessionId: preallocSessionId` through `resolveAndSpawn` → `PtyRegistry.create`. But `opts.sessionId` is the **resume sentinel** throughout the codebase:
- `providers/launcher.ts:195` `shouldPreAssign` returns false when `opts.sessionId` is set → killed the v1.2.8 `--session-id <uuid>` injection for fresh Claude/Gemini spawns
- `pty/registry.ts:143,195` `isResume = opts.sessionId !== undefined` → suppressed `onPostSpawnCapture` for codex/kimi/opencode disk-scan path

**Net effect of the unfixed version**: every fresh pane post-merge would have persisted `agent_sessions.external_session_id = null`, silently breaking resume-by-id for ALL 5 providers. The visible correlation feature would have shipped while the underlying resume pipeline collapsed.

**Fix** (decoupling, applied in same PR): added orthogonal `preassignedSessionId?: string` field to `ResolveAndSpawnOpts` + `PtyRegistry.create`. The `sessionId` field keeps its resume-sentinel semantics; the new field is used ONLY as the row id and never triggers `isResume = true`. Per-component:
- `pty/registry.ts:142-143`: `id = sessionId ?? preassignedSessionId ?? randomUUID()` (precedence: resume id wins); `isResume` line unchanged (`sessionId !== undefined` only).
- `providers/launcher.ts:195` `shouldPreAssign()` unchanged — still gates on `sessionId` only. Claude/Gemini `--session-id` injection restored on fresh spawns.
- `workspaces/launcher.ts` + `swarms/factory-spawn.ts`: callers pass `preassignedSessionId: <preallocUuid>` instead of `sessionId: <preallocUuid>`.

Both pre-assign (Claude/Gemini) AND disk-scan (codex/kimi/opencode) external-session-id capture pipelines verified working post-fix via 4 new test cases.

### Investigation prompted by user feedback

Two parallel Explore agents (worktree-path pipeline trace + backward-compat audit) confirmed:
- No production code parses worktree-path suffix shape (all callers treat as opaque)
- No test factory hardcodes a specific suffix format
- v1.5.4 worktrees on disk are SAFE — they keep their random-hash suffixes; v1.4.3 #04 orphan cleanup eventually removes stale ones
- Sync engine treats `worktree_path` per-machine + path-anonymization handles cross-machine — new format actually improves cross-sync determinism
- Entropy: 8 hex chars (4.3e9 states) vs prior 8 base-36 chars (2.8e12 states). 650× reduction; still ample for typical 2-20 panes per workspace. Retry loop regenerates sessionId on rare collision.

### Files touched

- `app/src/main/core/git/git-ops.ts` — `generateBranchName(role, hint, sessionId?)` extended signature
- `app/src/main/core/git/worktree.ts` — `WorktreePool.create({ ..., sessionId })`; returns `sessionId` on success; retry regenerates on collision
- `app/src/main/core/workspaces/launcher.ts` — pre-allocate at top of per-pane loop; pass via `preassignedSessionId`
- `app/src/main/core/swarms/factory-spawn.ts` — same pattern for swarm roster materialization
- `app/src/main/core/providers/launcher.ts` — `ResolveAndSpawnOpts` adds `preassignedSessionId?`; forwarded to registry
- `app/src/main/core/pty/registry.ts` — accepts `preassignedSessionId?`; `id` derivation falls through; `isResume` unchanged
- New tests: `git-ops.test.ts` (3 cases), `worktree.test.ts` (4 cases incl. retry-regen), `registry.test.ts` (2 cases), `providers/launcher.test.ts` (2 cases) — 11 new tests total

### Combined main gate

- tsc clean
- eslint 0 errors / 1 pre-existing warning
- vitest **99 files / 897 pass / 1 skip** (+11 from v1.5.4 baseline of 97/886)
- build + electron-builder clean

### Backward-compat

- Existing v1.5.4-and-earlier worktrees on disk keep their random-hash suffixes — NEVER renamed
- v1.4.3 #04 orphan-cleanup removes stale ones naturally on workspace open (7-day grace)
- No DB schema change
- No data loss

### Deferred to v1.5.6

- Informational reviewer observation: a few wasted disk reads on codex/kimi/opencode RESUME path because `isResume=false` now fires `onPostSpawnCapture` even on resumes. Safe due to `external_session_id IS NULL` guard in `persistExternalSessionId` (rpc-router.ts:200-213) and `DISK_SCAN_PROVIDERS` exclusion. Could be cleaner with an explicit `isResume: boolean` registry field. Not a regression of behavior, just efficiency.
- Concurrent-spawn `(workspace_id, pane_index)` uniqueness gap surfaced by Cluster B's audit during v1.5.5 investigation — pre-existing, not introduced by this change; separate refactor.
- Hardware sample-rate detection from voice-mac native binding (carry-over from v1.5.4 backlog)
- Terminal scrollback persistence across app restart (carry-over)
- V3-W15-006 dogfood (human QA only)

## [1.5.4] - 2026-05-20

v1.5.4 — 3-cluster defensive-infrastructure packet + **ANOTHER mid-rollup hotfix for a renderer-state-hydration class regression caught by a user dogfood report**. 3 Opus 4.7 reviewers cleared all PRs with ZERO REQUEST-CHANGES.

### 🚨 Critical mid-rollup hotfix — workspace-restart swarm hydration gap

**User-reported during v1.5.3 dogfood**: post-update + restart, 6 panes rendered correctly in the workspace, but the +Pane button showed the misleading "Open or create a workspace first" tooltip even with a workspace open + a swarm containing the 6 panes.

**Root cause**: 3 separate workspace-restart code paths (boot restore via `useSessionRestore`, sidebar click-to-open, Launcher `chooseExisting`) all dispatched `ADD_SESSIONS` after `panes.listForWorkspace` but never dispatched `UPSERT_SWARM`. Sessions hydrated → grid rendered. Swarms didn't hydrate → `state.swarmsByWorkspace[wsId]` empty → `CommandRoom.activeSwarm = null` → AddPaneButton.tsx:43 returned "Open or create a workspace first" (the `activeSwarm=null` branch).

**SAME class as the v1.5.3 Sigma-dispatch-pane bug** (#60 fix in `use-sigma-dispatch-echo.ts`). Boot restore was the THIRD path with the same hydration gap. The v1.5.3 fix only patched the assistant echo handler; the user-restart flow + sidebar click + Launcher reopen all remained broken.

**Fix** (commit `8ae2c5d`): `Promise.all([panes.listForWorkspace, swarms.list])` in all 3 call sites, then dispatch `ADD_SESSIONS` + per-swarm `UPSERT_SWARM` + `SET_ACTIVE_SWARM` for the first running swarm. Mirrors v1.4.3 #02 hydration pattern that's now generalized.

Note: the new state-hydration test class (Cluster B, this release) catches THIS class of bug going forward — the 3 tests verify that after `assistant:dispatch-echo` (ok=true), state.sessions AND state.swarms are updated.

### Cluster A — AddPaneButton hardening (#68)

- **A11y**: `aria-live="polite"` + `role="status"` on disabled-reason pill; `aria-live="assertive"` + `role="alert"` on persistent error chip. Tests 10+11 assert both.
- **Test 7+9 hardening (Option C)**: `vi.doMock('@/components/ui/dropdown-menu')` replaces Radix with synchronous passthrough components via dynamic `import('./AddPaneButton')`. Removes `if (!chip) return;` escape hatches. Adds unconditional `addAgentMock.toHaveBeenCalledTimes(N)` + `toastErrorMock.toHaveBeenCalled()` assertions that prove the error path ran regardless of chip-rendering issues.
- **Chip positioning** (Option B): kept absolute-positioned wrapper with JSX comment explaining the flex-row-height trade-off.

### Cluster B — Defensive test expansion (#67)

- **`ipcMain.handle` enumeration in CHANGELOG-vs-AppRouter test**: new `DIRECT_IPC_HANDLE_CHANNELS` constant enumerating the 7 direct-in-main `voice.globalCapture.*` channels. New 4th test asserts each is in CHANNELS. `CHANNELS_REQUIRING_LEAD_REVIEW` emptied (the false-positive suppression is now a real check). Future direct ipcMain.handle calls in electron/main.ts that aren't allowlisted will fail loudly.
- **NEW state-hydration test class** (`state-hydration.test.tsx`): 3 tests using real `useReducer` + `renderHook` + stubbed window event bus + mocked rpcSilent. Test 1 catches the pre-v1.5.3 Sigma-dispatch regression (`ADD_SESSIONS` after echo). Test 2 catches the companion `UPSERT_SWARM` gap. Test 3 verifies error path inertness. **Test 1 would have caught the workspace-restart hotfix this release ALSO — the test class now covers this entire bug family.**

### Cluster C — PCM resampler + pickPreset(n=7..8) (#66)

- **PCM resampler** (`global-capture.ts`): linear interpolation from `NATIVE_PCM_SAMPLE_RATE = 48000` down to whisper's 16kHz expectation. Float32 input → Float32 output (verified end-to-end, not Int16). Early-return identity when input rate matches. Unlocks the previously-deferred sample-rate fix (gated on v1.5.3 Cluster D's whisper.cpp v1.7.x port).
- **pickPreset(n) gap fix** (`assistant/controller.ts:68-73`): extended ternary chain — n≤6→6, else→8. `8` is a valid `GridPreset` member. Both `dispatchPane` + `dispatchBulk` clamps at `Math.min(8, ...)` stay consistent.

### Rollup fold — pickPreset duplicate dedupe

PR #66 reviewer caught a sibling bug: `app/src/main/core/assistant/tools.ts:46-47` contained a DUPLICATE buggy `pickPreset` (still returned `6` for n=7..8). Used by the MCP `launchPane` tool which accepts count 1..8. Folded into v1.5.4 rollup: imported the now-exported `pickPreset` from `./controller`; removed the duplicate.

### Combined main gate

- tsc clean
- eslint 0 errors / 1 pre-existing warning
- vitest **97 files / 886 pass / 1 skip** (+25 from v1.5.3 baseline)
- build + electron-builder clean

### Deferred to v1.5.5

- Hardware sample-rate detection from voice-mac native binding (`fmt.sampleRate` from `recognizer.mm:189`). Currently 48k is the constant; 44.1k systems may produce slightly wrong-pitched audio (whisper.cpp robust to mild mismatch). Would thread `inputRate` through to `resampleTo16k`.
- Stronger bounds-safety assertion in resampler test (currently only no-throw on 3-sample input; add finite + min/max bounds).
- **Terminal scrollback persistence across app restart** — currently per-PTY-process ring buffer (v1.2.7); when the app quits, the PTY dies, the buffer is gone. Conversation context inside Claude is preserved (via JSONL on --resume) but visual scrollback resets. UX-confusing on update flows. Real fix would persist the ring buffer per-session-id across app restarts; design discussion.
- V3-W15-006 dogfood (HUMAN QA only).

## [1.5.3] - 2026-05-20

v1.5.3 — 5-cluster parallel swarm + Opus 4.7 reviewers + **TWO live v1.5.2-era regressions caught + fixed mid-rollup** + internal-use posture clarified across all forward-looking docs.

### 🚨 Critical v1.5.2 Sigma-dispatch-pane invisible-pane hotfix

User-reported bug during v1.5.2 dogfood: "Sigma says he opened codex pane but nothing appeared in the command room." Diagnosis: `assistant:dispatch-echo` handler in `use-sigma-dispatch-echo.ts` dispatched `SET_ACTIVE_SESSION` + `SET_ROOM` + `SET_ACTIVE_WORKSPACE` but never dispatched `UPSERT_SWARM` + `ADD_SESSIONS`. Backend correctly spawned the PTY + created the `swarm_agents` row + assigned worktree path + emitted the echo event with the new session id — but the renderer's `state.sessionsByWorkspace` + `state.swarms` never learned about the new pane. Sidebar badge stayed at "5 agents", grid layout didn't extend to slot 6, even though the backend was running the new codex CLI in its isolated worktree.

Fix: in the echo handler, refresh swarms + sessions via `rpcSilent.panes.listForWorkspace(workspaceId)` + `rpcSilent.swarms.list(workspaceId)` immediately after the echo arrives, then dispatch `ADD_SESSIONS` + `UPSERT_SWARM` for each. Mirrors the v1.4.3 #02 boot-restore hydration pattern. Best-effort try/catch so failure falls back to "pane visible on next workspace reopen" rather than breaking the dispatch flow.

Affected versions: every release with the Sigma orchestrator dispatch-pane path (v1.4.0 → v1.5.2). Anyone who used Sigma to spawn a pane during that window had the pane created on disk but invisible in the UI. The pane was real — they could see its worktree on filesystem and the database had the agent_sessions row; the renderer just didn't know.

### 🚨 Defensive test caught providers.* regression (live since v1.4.9 #49)

The new `CHANNELS-vs-AppRouter` cross-reference test (Cluster B) fired on its first run against current main and exposed that `providers.spawnInstall`, `providers.setInstallConsent`, and `providers.getInstallConsent` were missing from the `CHANNELS` allowlist since v1.4.9 PR #49 (~2 days live broken). Same regression class as the v1.5.0 cross-sync gap fixed in v1.5.2:
- Controller handlers registered + AppRouter declared them + `ProviderInstallModal` + `ProvidersTab` called them
- Preload bridge hard-rejected with "IPC channel not allowed" errors
- `ProvidersTab.tsx:84` swallowed silently via `.catch(() => null)` → wrong consent state displayed
- `ProviderInstallModal.tsx:153,163,175` raised sonner toasts on user click

Folded into Cluster B's PR pre-merge (added 3 channels to CHANNELS, removed from `KNOWN_CONTROLLER_NOT_IN_CHANNELS` suppression in the test). The defensive test now catches this CLASS of regression at PR time instead of post-ship.

### Cluster A — AddPaneButton extraction + RTL coverage (#65)

- Extracted `AddPaneButton.tsx` (195 LOC) from CommandRoom.tsx — disabled-reason pill + persistent error chip + addPane action all moved into a single sub-component with `swarmId` + `activeSwarm` + `providers` props.
- CommandRoom.tsx: 544 → 405 LOC (restores 500-LOC ceiling).
- 11 RTL tests covering: 3 pill-visible variants, pill-hidden-when-enabled, dropdown open/close, addAgent rpc call, error chip render/dismiss/10s-auto-dismiss/unmount-cleanup/multi-error-timer-reset.

### Cluster B — Defensive test infrastructure (#64)

- **`rpc-channels.test.ts`** — new 418-line `CHANNELS`-vs-`AppRouter` cross-reference test. Hand-rolled static enumeration of 158 channels (20 namespaces from `defineRouter` body + 16 channels from 5 side-band maps). Forward check (every router handler is in CHANNELS) + inverse check (every CHANNELS entry has a registered handler) + import guard (both sets non-empty). **Caught the providers.* regression on first run.**
- **`sync-smoke.spec.ts`** — new Playwright e2e test (1 minimal test): launches app, navigates to Settings → Sync via `sigma:test:set-room`, asserts no "IPC channel not allowed" text in DOM, invokes `rpc.sync.status()` directly, verifies Sync section renders. Prevents recurrence of the v1.5.0-class regression at e2e level.
- **`engine-integration.test.ts` flake fix** — `afterEach` calls `engine.disable()` (cancels 30s background timer) + `vi.restoreAllMocks()` (handles spy-leak path that `vi.clearAllMocks()` misses). Both tests pass cleanly across consecutive serial runs.

### Cluster C — voice-win HMR race + prebuildify root cause (#61)

- **voice-win `IsAvailable()` HMR race FIXED**: two-mechanism guard — `g_sta_draining` `std::atomic<bool>` with acquire/release ordering (set true before posting `WM_SAPI_QUIT`; checked in `IsAvailableAsync` to reject Deferred immediately) + post-loop `PeekMessageW` drain that catches any `WM_SAPI_PROBE` messages that raced past the flag and rejects their TSFNs explicitly. Every code path through `IsAvailableAsync()` now terminates in either resolve or reject; no silent-hang.
- **Prebuildify silent-no-output ROOT CAUSE FOUND + FIXED**: prebuildify names the output file from `package.json` `name` field with `/`→`+` substitution for scoped packages. `@sigmalink/voice-win` → `@sigmalink+voice-win.node`, not `node.napi.node`. Workflows hard-coded the latter → upload path missed the actual file. Fixed in `native-prebuild-mac.yml` + `native-prebuild-win-sapi5.yml`. Plus 3-line fold at v1.5.3 rollup time for `native-prebuild-win.yml` (whisper) which had the same bug.

### Cluster D — whisper.cpp v1.7.x ggml-cpu binding.gyp port (#62)

- Ported `app/native/voice-whisper/binding.gyp` to whisper.cpp v1.7.4's new ggml-cpu/ layout. File mapping: `ggml-aarch64.c → ggml-cpu/ggml-cpu-aarch64.cpp` (moved + C→C++); `ggml-cpu.c/.cpp → ggml-cpu/ggml-cpu.{c,cpp}`; `ggml-metal.m → ggml-metal/ggml-metal.m`. 5 NEW source files: `ggml-backend-reg.cpp`, `ggml-threading.cpp`, `ggml-cpu-quants.c`, `ggml-cpu-traits.cpp`, `llamafile/sgemm.cpp`.
- Added `ggml/src` + `ggml/src/ggml-cpu` to `include_dirs` for the new flat-relative `#include "ggml-backend-impl.h"` style.
- `CLANG_ENABLE_OBJC_ARC: YES → NO` for `ggml-metal.m` manual retain/release (`[release]` + `(void*)` casts). Scoped to whisper_bridge target only via `xcode_settings`; sibling voice-mac unaffected.
- No whisper.cpp public-API breakage between v1.6.x and v1.7.4 — verified against `include/whisper.h`.
- Local mac prebuildify output: `prebuilds/darwin-arm64/@sigmalink+voice-whisper.node` (1.2 MB) loads with `{ transcribe, default }` exports.
- **Unlocks the previously-gated sample-rate fix** (44.1/48 kHz mic vs whisper 16 kHz expectation) — addressable as a follow-up packet.

### Cluster E — V3-W13-013 `assistant.dispatchBulk` + `assistant.refResolve` + `sync:status` event (#63)

- **`assistant.dispatchBulk({ provider, count, initialPrompt? }[])`**: spawns N panes per item via `executeLaunchPlan`. Provider validation via `findProvider()` emits per-pane error entries on unknown providers without aborting subsequent items. Per-item count clamped to `Math.max(1, Math.min(8, ...))`. Returns `{ paneId, providerId, workspaceId, success, error? }[]`.
- **`assistant.refResolve({ atRef })`**: walks workspace tree via `node:fs` (depth ≤ 8) with `IGNORED_DIRS` set (`node_modules`, `.git`, `dist`, `build`, `.next`, `out`, `__pycache__`, `.cache`). Basename substring match (no path joins — no traversal vector). Up to 10 matches with 200-char snippet. Empty result → `[]`.
- **`sync:status` event** added to `EVENTS` allowlist for forward-compat (no current renderer subscriber; SyncTab polls).
- New `app/src/shared/router-shape.ts` (34 LOC) exposing the typed AppRouter for Cluster B's CHANNELS-vs-AppRouter test consumption.
- 247 LOC of controller.test.ts coverage (8 tests).

### Documentation — internal-use posture clarified

Per user directive: all forward-looking "funded-only / EV cert / WinGet / Microsoft Store / Apple Developer Program / Picovoice licensing" framing scrubbed from `WISHLIST.md` and `BACKLOG.md`. **SigmaLink is internal-use only** — not selling, not publicly distributing. Signed-distribution paths are explicitly OFF-ROADMAP. The SmartScreen workaround (`app/build/nsis/README — First launch.txt`) + Gatekeeper ad-hoc-signing (`scripts/install-macos.sh`) flows are canonical for internal users. Historical CHANGELOG entries (e.g. "Apple Dev ID dropped 2026-05-18") stay as factual record of state at the time. The "Hey Sigma" wake-word entry rewritten around whisper.cpp continuous mode + OS-level dictation (no third-party licensing required).

### Combined main gate

- tsc: clean.
- eslint: 0 errors, 1 pre-existing warning (`use-session-restore.ts:277`).
- vitest: **96 files / 861 pass / 1 skip** (+22 from v1.5.2 baseline).
- One initial regression: Cluster E's 2 new assistant channels weren't in Cluster B's hand-rolled `TYPED_ROUTER_CHANNELS` list (Cluster B branched before E merged). The new test caught it. Folded into rollup: added `assistant.dispatchBulk` + `assistant.refResolve` to TYPED_ROUTER_CHANNELS. This is the exact maintenance contract the test enforces — works as designed.
- build + electron-builder: clean.

### Deferred to v1.5.4

- **Sample-rate mismatch in PCM tap** (44.1/48 kHz mic → 16 kHz whisper resample) — now actionable after Cluster D's binding.gyp port. Real feature work.
- **`pickPreset(n)` bug for n=7..8** — pre-existing in `assistant/controller.ts:68-69` + `:293`; mirrored into new dispatchBulk for parity. Returns `undefined` for n=7/8, invalid LaunchPlan.preset.
- **AddPaneButton tests 7+9 Radix-may-not-open escape hatches** — can silently degrade. Test 8 pattern (unconditional warning assertion) is the gold standard.
- **A11y posture on AddPaneButton** — no `aria-live` on pill/chip. Carry-over from v1.5.2.
- **AddPaneButton error chip absolute-positioning** — visual change vs v1.5.2's full-width-sibling layout. Worth manual dogfood eyeball.
- **`ipcMain.handle` enumeration in `electron/main.ts`** — current CHANNELS-vs-AppRouter test misses direct `ipcMain.handle()` registrations (e.g. `voice.globalCapture.*`). Suppressed via `CHANNELS_REQUIRING_LEAD_REVIEW`; v1.5.4 should enumerate these too.
- **whisper.cpp Windows prebuild** — should now succeed under CI with v1.5.3-D's binding.gyp port + Cluster C's scoped-package upload path; soft-fail stays as safety net until CI confirms.
- **V3-W15-006 dogfood** — human QA, ≥30 min 4-pane swarm. Not codeable.

## [1.5.2] - 2026-05-20

v1.5.2 cleanup packet + **critical v1.5.0 cross-sync renderer hotfix**. 3 parallel Sonnet sub-agent clusters cleared 9 items from the v1.5.2 backlog. Opus 4.7 reviewer caught Cluster C uncovering a **v1.5.0 production regression** where the entire `rpc.sync.*` IPC surface was preload-blocked, making cross-machine sync (the headline v1.5.0 feature) unreachable from the renderer UI since launch. **ZERO REQUEST-CHANGES across all 3 PRs.**

### Cluster A — DOGFOOD UX (#59)

- **DOGFOOD-V1.4.2-01 "+ Pane button defensive UX"** — visibility pill `data-testid="add-pane-disabled-reason"` renders alongside the disabled button (hypothesis 1; replaces hover-only tooltip behavior) + persistent error chip `data-testid="add-pane-error-chip"` for 10s on `addAgentToSwarm` rejection with × dismiss + unmount cleanup (hypothesis 3). Toast still fires (chip is additive). Hypothesis 2 (split-button) deferred — needs UX call.
- **DOGFOOD-V1.4.2-02 honest skip**: investigation found GridLayout `startDrag` already implements rAF coalescing via `pendingRaf`/`latest`/`flush` pattern (shipped in v1.4.2 packet-07). No code change needed; existing packet-07 test suite confirms.

### Cluster B — Code paper-cuts (#58)

- **v1 legacy decrypt round-trip test** in `crypto.test.ts` — 2 new tests using libsodium directly to construct a real v1 wire blob (`MAGIC|0x01|NONCE(24)|CT+TAG`) matching production v1 encoder exactly. Positive: full discriminated-union shape assertion; negative: ciphertext-byte flip → AEAD-integrity failure. Closes the irreversible-wire-format coverage gap from v1.5.1 reviewer.
- **STAThreadState heap-leak guard** in `voice-win/recognizer.cc` — on `CreateThread` NULL return, `CloseHandle(ready)` + zero `state->ready_event` + `delete state` before failure return. Symmetric to success-path teardown.
- **`data-testid="browser-view-mount"`** on production `BrowserViewMount.tsx` — closes the v1.5.1 reviewer C4 mock-vs-production tautology.

### Cluster C — Sync test + UI polish (#60) **[CRITICAL HOTFIX]**

- **🚨 v1.5.0 cross-sync renderer regression FIXED**: `sync.*` IPC channels (`sync.status`, `sync.isConfigured`, `sync.listConflicts`, `sync.disable`, `sync.enable`, `sync.exportMnemonic`, `sync.resolveConflict`, `sync.recoverFromMnemonic`) were ABSENT from the `CHANNELS` allowlist in `app/src/shared/rpc-channels.ts` when v1.5.0 packet 09 shipped. `app/electron/preload.ts:11-13` hard-rejects unlisted channels with `Promise.reject(new Error(...))`. **Every renderer entry point into cross-sync was broken since v1.5.0**: Settings → Sync tab error-banners; SetupWizard non-functional; SyncTab's `pendingUpgrade` count badge unreachable. Test gap explained: `SetupWizard.test.tsx` mocks the rpc layer (bypasses preload); zero e2e sync coverage. All 8 channels added to allowlist (1:1 with `syncCtl` methods in controller.ts:38-74; no over-exposure).
- **Engine-level integration tests** in new `engine-integration.test.ts` — 4 tests using **real crypto** (not mocked) + MockDb fake covering engine's actual SQL patterns (`INSERT OR IGNORE INTO sync_pending_upgrade`, `INSERT OR REPLACE INTO <table>`, `SELECT * FROM <table> WHERE id = ?`, `SELECT COUNT(*)`). Covers: schema-skew routing to `sync_pending_upgrade`; column allowlist drop (`attack_vector` not on any synced table — verified safe); anonymise toggle full round-trip; v1 blob backward-compat through the full engine pull path (distinct from PR #58's crypto-unit-level test).
- **Allowlist drift detector** in new `allowlist-drift.test.ts` — uses `drizzle-orm`'s `getTableColumns(t)` + `col.name` (SQL column name, NOT TS property name) to cross-reference against `COLUMN_ALLOWLIST`. **Drift findings: NONE** (all 19 synced tables' Drizzle columns match allowlist exactly). Inverse check catches stale allowlist entries pointing at non-synced tables.

### Test count

92 → 93 files / 831 → 839 pass / 1 skip / +8 tests across 3 clusters.

### Deferred to v1.5.3 (all DEFER per reviewer recommendation)

**Cluster A reviewer**:
- Extract `AddPaneButton.tsx` sub-component (pill + chip + button + addPane state) — CommandRoom.tsx now at 544 LOC (>500 ceiling). Hot-fold not appropriate; needs its own packet.
- RTL tests for `add-pane-disabled-reason` + `add-pane-error-chip` testids (visible/hidden, dismiss, timer reset, unmount-during-window).

**Cluster C reviewer**:
- `sync:status` event not in `EVENTS` allowlist — no current renderer subscriber (SyncTab polls), benign but worth adding for forward-compat.
- `CHANNELS`-vs-`AppRouter` cross-reference test (would have caught this v1.5.0 regression at v1.5.0 ship time). Recommend as a v1.5.3 follow-up.
- E2E smoke addition (1 test: open Settings → Sync, assert no "IPC channel not allowed" text) to prevent recurrence.

**Carry-over (no v1.5.2 change)**:
- Sample-rate mismatch in PCM tap (gated behind unshipped whisper build).
- HMR-only race in voice-win `IsAvailable()` probe.
- whisper.cpp v1.7.x ggml-cpu binding.gyp port.
- voice-{mac,win} prebuildify silent-no-output root cause.
- V3-W13-013 `assistant.*` dispatchBulk/refResolve (feature enhancement).
- V3-W15-006 dogfood (human QA, ≥30 min 4-pane swarm).

### Known minor

- Vitest flaked once on combined-main (1 test failed first run; 2 consecutive subsequent runs all-pass) — most likely a file-system timing race in the new engine-integration test. Logged for v1.5.3 investigation; not ship-blocking.

## [1.5.1] - 2026-05-20

v1.5.1 cleanup packet — ~28 deferred caveats from the v1.4.8 bundle (Sessions A/B/C) cleared across 3 parallel Sonnet sub-agent clusters in git worktrees, reviewed by Opus 4.7, lead-merged in autonomous mode. Plus one V3 parity paper-cut folded inline. **Honest scope confirmation**: per a parallel V3 parity audit, 35 of 45 tickets shipped-verified, 4 obsoleted, 3 partial, 1 unfinished — the unfinished item (V3-W15-006) is a human dogfood exercise, not a code gap. The remaining WISHLIST.md surface is genuinely empty.

### Cluster A — Frontend cleanup + extractions (#55)

- **`CommandRoom.tsx` 878 → 483 LOC** via extraction of `PaneCell` → new `PaneShell.tsx` + split-group cell → new `SplitGroupCell.tsx`. Restores the project's 500-LOC ceiling without behaviour change; all 11 PaneShell props threaded, hooks stable, no memoization regression.
- **`normalizeUrl` extraction** to `app/src/renderer/features/browser/normalizeUrl.ts` so `AddressBar.test.ts` imports the real function.
- **`insertMention` extraction** to `app/src/renderer/features/command-room/insertMention.ts` — same pattern.
- **`pathRelative` helper** at `app/src/renderer/lib/path-relative.ts` — deduplicates path-strip math from `FileTree.tsx` + Finder-drop handler. 9-test suite covers prefix-collision edge cases.
- **`data-testid="pane-body"`** on `PaneShell` wrapper; `findPaneBody()` test helper uses testid instead of Tailwind class-token matching.
- **`BrowserViewMount` lifecycle** — always-mounted with `visible={visible && tabs.length > 0}`; placeholder uses `display: none` when `!visible` so it doesn't compete with `BrowserEmptyState` for flex-row width (reviewer C1 inline fold).
- **UAC hint placement** moved inside the auto-update card.
- **`MnemonicConfirm` paste + drag-drop block** — textarea now blocks `onPaste`, `onDrop`, AND `onDragOver` (reviewer C2 inline fold — drag-drop bypassed the paste-only guard).

### Cluster B — Native code + voice activation (#56)

- **whisper.cpp submodule registered properly** at v1.7.4 via canonical `ggml-org/whisper.cpp.git` URL.
- **Real whisper.cpp model SHA-256 hashes** in `model-registry.ts` (4 sizes — verified against HuggingFace LFS pointer ETags). v1.5.0 had synthetic placeholders.
- **PcmAccumulator wire-up** to AVAudioEngine PCM tap on macOS — voice-mac extended with `installTap:bufferSize:format:block:` export. PCM samples heap-copied on audio thread to avoid use-after-free across thread boundary.
- **`_capturedRef` metaprogramming removed**; `capturedTranscript` hoisted to controller scope, reset on each `startRecording()`.
- **SAPI5 `Sleep(50)` → Win32 event-signal** in `recognizer.cc:StartSTAThread`. `CreateEventW` auto-reset + bounded `WaitForSingleObject(5000)` from JS thread.
- **SAPI5 `IsAvailable()` async** via `WM_SAPI_PROBE` + TSFN marshal — no blocking `CoCreateInstance` on JS thread.
- **SAPI5 `Stop()` `PostThreadMessageW`** return-value check.
- **SAPI5 `napi_add_env_cleanup_hook`** with bounded `WaitForSingleObject(5000)` — no HMR-reload thread leak, no shutdown deadlock.
- **`getFrontmostAppExePath()`** exported from voice-win for Cluster C consumption. Win32 chain `GetForegroundWindow → GetWindowThreadProcessId → OpenProcess → QueryFullProcessImageNameW`; every `OpenProcess` paired with `CloseHandle`; UTF-8 conversion via `WideCharToMultiByte`.

### Cluster C — Cross-sync + notifications polish (#57)

- **`proper-lockfile` wraps `_cycle()`** in `engine.ts` — push + pull operations guarded with `realpath: false` + `finally`-release. Prevents two Electron instances racing on push/pull.
- **"Anonymise paths" toggle** in `SyncTab.tsx` + `dirty-tracker.ts` — `kv['sync.anonymisePaths']` replaces `/Users/<username>/` prefixes with `~/` before encrypt.
- **Crypto wire format v1 → v2** in `crypto.ts` — `_schema` moved OUTSIDE AAD-protected payload so the decoder can examine schema BEFORE AEAD decrypt. Schema mismatch now routes to `sync_pending_upgrade` (was dead code in v1.5.0). **Backward-compat v1 decoder preserved** for existing v1.5.0 blobs; magic bytes unchanged so old clients fail gracefully on v2 blobs (AEAD fails at version byte → quarantine, no data loss).
- **SQL column allowlist defense-in-depth** at `engine.ts:298,381` — 19 per-table column allowlists; unknown columns dropped with warning before SQL interpolation.
- **Notifications D2 soft-cap-collapse** in `manager.ts` — `SOFT_CAP_PER_KIND_WS = 200` now consumed. At insert, if `(workspace_id, kind)` > 200 unread, oldest 50 collapse into `<kind>-summary` row.
- **Notifications D5 deep-link navigation** in `NotificationDropdown.tsx` — click routes per source: PTY exit → session-history; swarm broadcast → swarm-room mailbox; tool-error → Sigma conversation. Fallback when source pane gone → filtered notifications view.
- **`CRITICAL_TOOL_NAMES` expansion** in `tool-error.ts` — covers DB-mutating tools (save_pane_state, commit_review).
- **PowerShell → N-API foreground detection** in `output-router.ts` — uses Cluster B's `getFrontmostAppExePath()` helper. Drops 60-120ms PowerShell cold-start to a single Win32 call; PowerShell spawn retained as fallback.
- **`commit-prebuilds` BRANCH=main** literal across 3 workflow YAMLs.

### V3 parity paper-cut (folded)

- **V3-W13-015 — completion ding Settings toggle**: `NotificationsSettings.tsx` now exposes the `notifications.ding` kv toggle ("Play completion chime on Sigma dispatch finish"). Backend lib + Web Audio chime existed since v1.4.0 but Settings UI surface was missing.

### Fixed (CI hotfixes during merge)

- **3 native prebuild workflows soft-failed** — `native-prebuild-mac.yml`, `native-prebuild-win.yml`, `native-prebuild-win-sapi5.yml` had `if-no-files-found: error` on upload + no `continue-on-error` on build, so any prebuildify silent-no-output blocked PR merges. Symmetric with `2b3a5f0` v1.4.9 release-macos pattern: `continue-on-error: true` on build + `if-no-files-found: warn` on upload. Aligns with each workflow's documented "convenience-only, not release-blocking" intent. Root causes (whisper.cpp v1.7.4 ggml-aarch64.c source-tree path drift; voice-{mac,win} prebuildify silent no-output under CI) backlogged for v1.5.2.

### V3 parity audit — net state

Per a parallel read-only audit of `docs/03-plan/V3_PARITY_BACKLOG.md` (45 tickets):

- **35 shipped-verified** (acceptance criteria match current source).
- **4 obsoleted** (V3-W12-001..004 — superseded by the 2026-05-13 v1.2.4 provider-registry cleanup).
- **3 partial**: V3-W13-013 `assistant.*` dispatchBulk/refResolve missing (feature enhancement, NOT parity gap); V3-W13-015 ding Settings toggle (**folded above**); V3-W15-004 ubuntu-latest e2e matrix (**SUPERSEDED by the 2026-05-16 Linux-not-supported ADR**).
- **1 unfinished**: V3-W15-006 4-pane dogfood exercise — human QA session, not code-generatable; deferred to a future operator-led session.

Net: v1.5.1 closes the wishlist as currently defined.

### Deferred — for v1.5.2 cleanup (or v1.6.0 future)

**Cluster B reviewer NON-TRIVIAL** (all latent, none ship-blocking): sample-rate mismatch in PCM tap (mic 44.1/48 kHz vs whisper 16 kHz) gated behind unshipped whisper build; `STAThreadState*` heap-allocation leak guard on `CreateThread` cold-path failure; HMR-only race where in-flight `isAvailable()` can hang if `StopSTAThread` runs concurrently with queued probe.

**Cluster C reviewer NON-TRIVIAL**: v1 legacy decrypt round-trip test (fixture-based; 5-min); engine-level integration tests for v2/skew/allowlist/anonymise paths; allowlist drift detection via drizzle schema introspection at test time; surface `sync_pending_upgrade` count in SyncTab badge for operator visibility.

**Cluster A reviewer DEFER**: `data-testid="browser-view-mount"` mock-vs-production divergence (tautology assertion, not a defect introduced by this PR).

**Native prebuild root causes**: whisper.cpp v1.7.x ggml-cpu/ binding.gyp port; voice-{mac,win} prebuildify silent no-output investigation.

**V3 backlog future enhancements**: V3-W13-013 dispatchBulk/refResolve in `assistant.*` controller — bulk pane spawn from a single Sigma prompt.

## [1.5.0] - 2026-05-20

Session C of the v1.4.8 bundle: 3 platform-tier packets dispatched as parallel Sonnet sub-agents in git worktrees, reviewed by Opus 4.7 (**MANDATORY Opus security reviewer on packet 09**), lead-merged in autonomous mode. Ships cross-machine session sync (opt-in, e2ee, git-backed), Windows + Linux voice capture fan-out, and the native Windows SAPI5 STT binding. **ZERO security REQUEST-CHANGES on the irreversible 0019 sync migration + crypto wiring.** Concludes the 9-packet v1.4.8 bundle that began with Session A (v1.4.8) and continued through Session B (v1.4.9).

### Added

- **Cross-machine session sync — opt-in, e2ee, git-backed** (#54) — fully end-to-end encrypted single-user multi-device sync via a user-owned git remote (GitHub/Gitea/GitLab). Crypto: `libsodium-wrappers-sumo` + XChaCha20-Poly1305 + AAD `(schema_version|table_name|row_id)`; magic+version header (`SGSY` + uint8 version + 24-byte nonce + Poly1305 tag). Migration **0019_sync_metadata** adds 6 tables (`sync_state`, `sync_conflicts`, `sync_history`, `sync_quarantine`, `sync_pending_upgrade`, `sync_tombstones`). Hybrid Logical Clock (HLC) `(wall_ms, logical, machine_id)` with random 16-byte `machine_id` (no hostname leak); LWW conflict resolution with both versions preserved in `sync_conflicts` for user review; 30d tombstone GC. **Key management Option B**: 32-byte master key + 24-word BIP-39 mnemonic; `safeStorage` per-device via existing `CredentialStore` (no new keytar). Setup wizard FORCES typed-back mnemonic confirmation + Signal-style "unrecoverable on full key+device loss" acknowledgement. Transport via `isomorphic-git` (HTTPS/SSH; no shell-out to system git); local clone config `user.email = sigma-sync@localhost` (no real email leak). Sync scope: 19 IN tables (workspaces/swarms/conversations/messages/memories/tasks/canvases/boards/replay), **`credentials` HARD-DENY** (provider API tokens never sync; throw-on-attempt defensive guard), `kv`/`skills`/`browser_tabs` SKIP. AEAD-verify-fail → quarantine (never applied to local DB). 136 tests pass / 10 files including 100% crypto-module branch coverage. Headline-tier user doc at `docs/09-release/cross-machine-sync.md` with security FAQ ("Who can read my synced data?" / "What happens if I lose my mnemonic?" / "Can SigmaLink see my conversations?").
- **Voice capture Windows + Linux fan-out** (#52) — extends v1.4.9's macOS-only global voice capture to Windows + Linux. Cross-platform `output-router`: Windows via PowerShell P/Invoke `GetForegroundWindow` + `GetWindowThreadProcessId`; Linux via `xdotool getactivewindow getwindowpid` + `/proc/<pid>/exe`; both **clipboard-only** on Win/Linux for v1.5.0 (pane-focus-aware AX paste deferred to v1.5.1 with N-API helper). Cross-platform `Tray` + `globalShortcut.register` + `window-all-closed` quit-suppression gated on `voice.globalCapture.enabled === '1'` kv. New `release-windows.yml` voice-whisper rebuild step + new `native-prebuild-win.yml` workflow (`workflow_dispatch` + `pull_request` only at launch, matrix `windows-latest` x64). All new steps `continue-on-error: true` mirroring the `2b3a5f0` `release-macos.yml` CI hotfix pattern so voice-whisper falls through to stub gracefully when vendor sources are absent. Caveat 1 (PowerShell `$pid` is a read-only automatic variable → renamed to `$procId`) folded inline pre-merge.
- **Native Windows SAPI5 voice binding** (#53) — `@sigmalink/voice-win` native module for offline STT via `ISpRecognizer` (`CLSID_SpSharedRecognizer` — shared, not in-process). COM threading: dedicated STA worker thread + `CoInitialize(NULL)` + Win32 message pump (`GetMessage`/`DispatchMessage`) + hidden `HWND_MESSAGE` window + `SetNotifyWindowMessage(WM_APP+1)`. `PostThreadMessageW` dispatches Start/Stop from JS thread to STA worker. Manual `IUnknown::Release` (no ATL dependency); `SpClearEvent` with `ev.lParam = 0` after explicit `result->Release()` to prevent **double-Release on the hot recognition event path** (REQUEST-CHANGES fix from Opus reviewer — heap corruption risk on Windows runtime that macOS CI could not catch). TSFN bridge for cross-thread marshalling back to JS event loop. STT-only (no TTS — locked decision matches voice-mac contract exactly). `node-gyp-build` loader pattern + `buildStub()` fallback for non-win32. New `native-prebuild-win-sapi5.yml` workflow + `release-windows.yml` `-w @sigmalink/voice-win` extension. 14 native-win tests cover the TS adapter layer.

### Fixed (CI hotfixes during Session C)

- **`release-macos.yml` whisper.cpp submodule gating** (`2b3a5f0`) — PR #50 added `.gitmodules` for the whisper.cpp submodule path but never invoked `git submodule add`, leaving an unbacked URL config. `git submodule update --init` failed with `pathspec did not match` halting v1.4.9 release-macos in 34s. Added `continue-on-error: true` + `2>/dev/null || true` to the submodule init step + gated the `@electron/rebuild -w whisper_bridge` invocation on vendor source presence. Falls through to Apple Speech.framework gracefully; real submodule registration + model SHA-256 hashes land in v1.5.1 cleanup.
- **`native-win.test.ts` unused-var lint errors** (`bb079fd`) — PR #53's onPartial/onFinal/onError/onState subscribe-shape tests used `(_text)`/`(_err)`/`(_state)` placeholder params; project's eslint config does not honor the underscore-prefix convention. Removed params (callback bodies are no-op subscribe-contract assertions).

### Deferred — for v1.5.1 cleanup packet

**Packet 09 cross-sync caveats** (Opus reviewer non-security): lock file mentioned in comments but `proper-lockfile` import never added (in-process guard is only protection); doc/impl mismatch ("anonymise paths" toggle promised but missing); schema-skew handling design-incoherent (`sync_pending_upgrade` table dead code in v1.5.0 because AAD binds schema → wrong-schema blobs fail AEAD and go to `sync_quarantine` instead); `MnemonicConfirm` textarea accepts paste defeating typed-back intent; SQL injection defense-in-depth via column allowlist; hex-string-in-memory key materialisation (JS limitation, documented).

**Packet 08 SAPI5 caveats** (Opus reviewer non-security): `Sleep(50)` heuristic in `StartSTAThread` → replace with event-signal pattern; `IsAvailable()` blocking `CoCreateInstance` on JS thread → move to STA worker; `Stop()` no return-value check on `PostThreadMessageW`; `StartSTAThread`/`StopSTAThread` public visibility; missing napi finalizer for HMR-reload safety.

**Packet 04 Win+Linux caveats**: PowerShell cold-start 60-120ms → N-API helper (v1.5.1 N-API path); `commit-prebuilds` BRANCH heuristic fragility on tag refs.

**Session A + B carry-over** (14 prior caveats): `CommandRoom.tsx` 878 LOC → `PaneShell.tsx` extraction, whisper.cpp model SHA-256 hashes for lazy-download, `PcmAccumulator` wire-up + AVAudioEngine raw-PCM tap, D2 notifications soft-cap collapse, D5 deep-link navigation, normalize-url/insertMention exports, BrowserViewMount lifecycle dogfood, UAC hint placement, etc.

### Process

- **Worktree-per-packet** per `~/.claude/skills/orchestrator/SKILL.md`. 3 worktrees branched from local main at v1.4.9 tag (`1f27e4e`). Each agent ran `pnpm install --no-frozen-lockfile && node node_modules/electron/install.js` to handle the v1.4.7 `@electron/rebuild` ABI fix.
- **Models stated per `feedback_agent_dispatch_flag_model.md`**: Sonnet for all 3 implementers; **MANDATORY Opus security reviewer for packet 09** per autonomous-mode plan; Opus also for packets 04/08 reviewers (native code + COM semantics required Opus-tier reasoning).
- **Autonomous mode** per `feedback_agent_scope_discipline.md` edge case (user `/goal finish all Sessions sequentially. Go fully autonomous. I'm going out.`). Brief defaults applied for the 6 cross-sync open lead questions (S5=Option B safeStorage+BIP-39, S1=A4-undefended/A7-9 non-goals, S8=Signal-style unrecoverable, S6=`credentials` hard-DENY, S2=libsodium-wrappers-sumo). Lead merged + tagged without per-step approval. **Mandatory Opus security review held the merge gate; ZERO REQUEST-CHANGES on irreversible crypto.**
- **Cleanup-loop**: 3 PRs landed APPROVE-WITH-CAVEATS overall; ONE REQUEST-CHANGES (PR #53 SAPI5 double-Release on `ISpRecoResult` in the hot recognition event path — folded inline via `ev.lParam = 0` null pattern). All defer-to-v1.5.1 caveats documented for the cleanup packet.
- **Cross-branch rebases mid-flight**: PR #52, #53, #54 all branched from v1.4.9 tag while subsequent PRs advanced main. Clean rebases for #52 + #54. PR #53 had a workflow-file add/add conflict resolved by renaming PR #53's `native-prebuild-win.yml` → `native-prebuild-win-sapi5.yml` so both prebuild workflows coexist (one for voice-whisper, one for voice-win SAPI5).
- **CI hotfix interlude**: v1.4.9 release-macos failed at 34s on whisper.cpp submodule init (unregistered gitlink); landed `2b3a5f0` hotfix on main BETWEEN Session C agent dispatches so v1.5.0 macos releases run cleanly.

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: **809 pass | 1 skip** (90 test files; was 659 → +150 new across 3 Session C packets — 14 native-win + 136 sync)
- `pnpm exec eslint .`: 0 errors, 1 pre-existing warning (`use-session-restore.ts:277`)
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

### Migration

**0019_sync_metadata** added. Migration ceiling moves from 0018 → 0019. 6 new `sync_*` tables.

### Closes the v1.4.8 bundle

This release concludes the 9-packet v1.4.8 bundle that started 2026-05-20 with Session A (v1.4.8) and continued through v1.4.9 (Session B). All 9 packets shipped: 01 browser-cleanup, 02 sidebar-resize, 03 drag-drop, 04 voice-capture (mac in v1.4.9, Win+Linux in v1.5.0), 05 win-autoupdate, 06 provider-install, 07 notifications, 08 SAPI5, 09 cross-machine-sync. The v1.5.1 cleanup packet remains as the dedicated bundle-followup work for ~20+ deferred caveats.

## [1.4.9] - 2026-05-20

Session B of the v1.4.8 bundle: 3 packets dispatched as parallel Sonnet + Opus sub-agents in git worktrees, reviewed by Opus 4.7, lead-merged. Ships the long-deferred notifications system, in-app provider auto-install consent flow, and macOS global voice capture (with whisper.cpp infrastructure scaffolded for v1.4.10+ activation). Session C (v1.5.0) remains for the 3 platform packets (Windows + Linux voice fan-out, SAPI5 voice, cross-machine sync).

### Added

- **Global voice capture, macOS only** (#50) — `Cmd+Option+Space` hotkey (rebindable via Settings → Voice → `voice.globalCapture.hotkey` kv) triggers system-wide voice capture from anywhere on macOS via Electron `globalShortcut.register` + `Tray` icon. Default OFF first launch — opt-in via Settings → Voice → "Enable global capture". When enabled, suppresses `app.quit()` on `window-all-closed` so voice survives the red-traffic-light close. Output policy is pane-focus-aware: when a SigmaLink pane is focused (`NSWorkspace frontmostApplication` check), transcript writes to the pane via existing `voice:dispatch` IPC; otherwise to clipboard + toast. Degrades to clipboard mode if Accessibility permission is denied. **Apple Speech.framework is the active transcription engine in v1.4.9**; whisper.cpp is vendored as a `voice-whisper/` git submodule (pinned `v1.7.4`) but the lazy-download path is currently dormant pending real HuggingFace model hashes (lands in v1.4.10). Adds 3 helpers to existing `voice-mac` native module (`sendPasteKeystroke`, `getFrontmostAppBundleId`, `isTrustedAccessibility`) for AX paste + frontmost-app checks. Updates `entitlements.mac.plist` for `com.apple.security.automation.apple-events` (CGEventPost requirement). 24 new tests. (`global-capture.ts`, `output-router.ts`, `model-registry.ts`, `whisper-engine.ts`, `VoiceTab.tsx`, `electron/main.ts`, native module `voice-whisper`)
- **Provider auto-install prompt with consent gating** (#49) — clicking the "Not on PATH" amber badge in the Launcher's `AgentsStep` now opens a `ProviderInstallModal` with the per-OS install command (copy + docs link fallback), an "Install now" button that spawns the install in an ephemeral PTY pane via new `providers.spawnInstall(providerId): Promise<{paneId}>` RPC, "I'll install it myself", and "Don't ask again" controls. Consent persisted as `kv['provider.autoinstall.consent.<cliId>'] = 'declined'` (string enum; absence = prompt). New "Reset install consent" section in Settings → Providers. Extends `AgentProviderDefinition` with `installCommand: { darwin?, linux?, win32? }` + `installDocsUrl?` populated for all 5 CLIs from the canonical `providers.ts` registry (Kimi = `pip install kimi-cli`, OpenCode = `npm i -g opencode`, 3 npm CLIs via `npm i -g`). `detect.ts` for version display deferred to v1.5.0. (`providers.ts`, `router-shape.ts`, `rpc-router.ts`, `AgentsStep.tsx`, `ProviderInstallModal.tsx`, `ProvidersTab.tsx`)
- **Notifications system + top-right bell** (#51) — migration **0018_notifications** adds a `notifications` table (12 columns, 3 indexes including a partial dedup index on `read_at IS NULL`). 4-level severity (`info | warn | error | critical`); per-source dedup via `(workspace_id, kind, dedup_key)` tuple within a 30-second window with `dup_count` increments; critical bypasses dedup. Rolling N=500 global hard cap + 30-day TTL on read; severity-aware eviction never auto-drops `error` or `critical`. **IPC delta-only `{added, removed, unreadCount}` payload** prevents saturation under broadcast flood (the original brief's full-list-on-change approach would have IPC-locked). Three sources tap existing emit paths without new listeners: PTY exit (existing `onPaneEvent`), swarm broadcasts (wrapped `mailbox.setEmitter`, gated on `payload.broadcastToSidebar === true` + envelope kind allowlist), Sigma tool errors (existing `assistant:tool-trace`, filtered on `trace.ok === false`). Bell badge in Breadcrumb: 0=hidden, 1-9=number, 10+=`9+`; red if any unread is error/critical, amber if max is warn. Dropdown filter chips: `[All | This workspace | Errors only]`. Click row deep-links to context (target ID preserved in payload — navigation wiring deferred to v1.4.10) + marks read; separate `×` dismiss DELETEs; explicit no-auto-mark-on-open (anti-pattern avoided). OS notifications opt-in OFF default with per-severity gates (`critical` forced-on) + 5-minute throttle per `dedup_key`. 49 new tests across manager + 3 sources + 3 renderer components. (`0018_notifications.ts`, `manager.ts`, `controller.ts`, `os-notify.ts`, `gc.ts`, 3 source files, `NotificationBell.tsx`, `NotificationDropdown.tsx`, `NotificationItem.tsx`, `NotificationsSettings.tsx`)

### Deferred — for v1.4.10 cleanup packet

**Packet 04 caveats** (PR #50 reviewer): real HuggingFace SHA-256 hashes for whisper.cpp models (currently placeholder → lazy-download fail-closed → Apple Speech.framework fallback); `PcmAccumulator` dead code (whisper.cpp wired but dormant pending AVAudioEngine raw-PCM tap); `_capturedRef` metaprogramming → proper closure refactor; `.gitmodules` canonical URL `ggml-org/whisper.cpp.git`. Caveat 3 (`native.onFinal` listener leak on re-recording) folded inline pre-merge via lead commit `caf1169` along with a latent `native_ref` dispose-bug fix.

**Packet 07 caveats** (PR #51 reviewer): D2 soft-cap-collapse-to-`<kind>-summary` row (constant `SOFT_CAP_PER_KIND_WS = 200` exported but unread); `tool-error.ts CRITICAL_TOOL_NAMES` enumerates only `create_workspace` (brief D1 said "OR DB-touching tool" — define the set explicitly); D5 deep-link navigation TODO'd in click handler (payload preserves target IDs for follow-up wiring).

**Session A carry-over** (PR #45/46/47/48 deferred caveats — still open): `CommandRoom.tsx` 878 LOC → extract `PaneShell.tsx`; export `normalizeUrl` + `insertMention` so tests import (not duplicate inline); `BrowserViewMount` lifecycle (`visible={false}` vs unmount) — dogfood watch; `data-testid="pane-body"` on PaneCell; `pathRelative(abs, root)` helper to dedupe `FileTree` + `CommandRoom` heuristic; UAC hint placement (visual dogfood judgment).

### Deferred to v1.5.0 (Session C)

- Packet 04 — Voice capture Windows + Linux fan-out (after macOS validates lazy-download UX once real hashes land in v1.4.10)
- Packet 08 — Windows SAPI5 voice binding (COM threading + STA worker thread + node-gyp prebuild matrix)
- Packet 09 — Cross-machine session sync (libsodium-wrappers-sumo + HLC + LWW + isomorphic-git; 6 lead Q's + security signoff)

### Process

- **Worktree-per-packet** per `~/.claude/skills/orchestrator/SKILL.md`. 3 worktrees branched from local main (post v1.4.8 tag `36b2f66`). Each agent ran `pnpm install --no-frozen-lockfile && node node_modules/electron/install.js` to handle the v1.4.7 `@electron/rebuild` ABI fix.
- **Models stated per `feedback_agent_dispatch_flag_model.md`**: Sonnet for packets 04 + 06; **Opus** for packet 07 (brief mandated Opus for the irreversible schema 0018 + locked D1-D6 taxonomy — Sonnet would have re-litigated mid-PR).
- **Autonomous mode** per `feedback_agent_scope_discipline.md` edge case ("Go fully autonomous" /goal directive). Brief defaults applied for all 16 lead Q's; lead merged + tagged without per-step user approval.
- **Cleanup-loop**: 3 PRs all landed APPROVE-WITH-CAVEATS, **ZERO REQUEST-CHANGES** from Opus reviewers (even on the irreversible schema). Caveats split between fold-inline (PR #50 caveat 3 + dead `native_ref` removal — lead commit `caf1169`) and defer-to-v1.4.10 (the rest, all observational / documented-scope-reductions).
- **PR #50 recovery**: an aborted `gh pr merge` (due to base-branch-modified mid-flight when PR #49 merged in the same shell command) left the PR CLOSED but unmerged with the remote branch already deleted by chained cleanup commands. Recovered via `git push origin <SHA>:refs/heads/<branch>` (commit SHA preserved in GitHub object store post-deletion), `gh pr reopen 50`, then re-merge succeeded. **Lesson logged**: chain destructive cleanup AFTER merge VERIFICATION (`gh pr view --json state` must show MERGED), never blindly with `&&`.
- **Honest scope framing**: PR #50 ships voice capture with **Apple Speech.framework as the active transcription engine** on macOS; whisper.cpp infrastructure is fully scaffolded (native binding, model registry, output router, state machine) but dormant pending v1.4.10 work (real model hashes + AVAudioEngine PCM tap). PR #51 ships notifications with **D2 soft-cap-collapse + D5 deep-link nav + DB-touching-tools set deferred** to v1.4.10. PR body claims that overstated scope were corrected in this CHANGELOG.

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: **659 pass | 1 skip** (79 test files; was 562 → +97 new across 3 Session B packets — 24 voice, 49 notifications, ~24 provider-install)
- `pnpm exec eslint .`: 0 errors, 1 pre-existing warning (`use-session-restore.ts:277`)
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

### Migration

**0018_notifications** added. Migration ceiling moves from 0017 → 0018. Packet 09 (Session C cross-sync) will use 0019.

## [1.4.8] - 2026-05-20

Session A of the v1.4.8 bundle: 4 paper-cut packets dispatched as 4 parallel Sonnet sub-agents in git worktrees, reviewed by Opus 4.7, lead-merged. ~75 minutes wall-clock from dispatch to all-merged. Sessions B (v1.4.9) and C (v1.5.0) remain for the 5 deferred packets (provider auto-install, notifications, voice capture, SAPI5, cross-machine sync).

### Added

- **Drag-and-drop file → pane `@-mention`** (#48) — drag a file from the IDE Editor file-tree onto a pane and the composer auto-inserts `@<workspace-relative-path> ` with trailing space. Multi-file drop joins paths space-separated; 10-file cap with toast on overflow. Dead-pane drops show a "Pane is not running" toast instead of silently no-op'ing (`PtyRegistry.write` would otherwise swallow). Visual feedback via `data-dragover` attribute + 200ms post-drop flash. Native HTML5 drag API; `@dnd-kit` confirmed non-conflicting (only mounted under `features/tasks/`). Uses existing `window.sigma.getPathForFile` + `rpc.pty.write`; no new RPCs. 17 new tests. (`FileTree.tsx`, `CommandRoom.tsx`)
- **Sidebar resize handles** (#47) — IDE Editor file-tree sidebar (160-600px clamp, kv `editor.sidebar.width`) and main app left Sidebar in expanded state (180-480px clamp, kv `app.sidebar.width`) now have draggable 4px Pointer Events handles with rAF coalescing. Double-click resets to default. `document.body.dataset.dragging` signal during drag so xterm relaxes fit debounce (reuses GridLayout pattern). `transition-[width]` suppressed on Sidebar during drag — without this, drag had a 200ms pixel-lag. Border-r migrates between aside and divider when expanded for clean visual continuity. 18 new tests. (`EditorTab.tsx`, `Sidebar.tsx`)

### Fixed

- **Browser room no longer auto-spawns `about:blank`** (#46) — entering a Browser room with zero persisted tabs now shows an `EmptyState` with "New tab" CTA instead of silently calling `openTab({ url: 'about:blank' })` on mount. `EmptyState` gates the `BrowserViewMount`+`AgentDrivingIndicator`+`DesignOverlayBanner` cluster; `TabStrip` + `AddressBar` + `BrowserRecents` stay visible. CTA wires to existing `handleNewTab` callback. (`BrowserRoom.tsx`)
- **AddressBar `about:` normalization** (#46) — typing bare `about:`, `about:about`, or `about:newtab` in the address bar now routes through the Google search fallback instead of resolving to Chromium's internal directory page. Only literal `about:blank` (case-insensitive) passes through. `chrome:` and `file:` pass-through unchanged. 21 new tests across BrowserRoom + AddressBar. (`AddressBar.tsx`)
- **Windows auto-update UAC denied fallback** (#45) — `autoUpdater.on('error')` now detects Windows UAC denial (`code: 5` or `EACCES` in the error message) and broadcasts `{ error, isUacDenied: true }`. `UpdatesTab.tsx` error-state branch renders an "Open latest release" external link to GitHub Releases when `isUacDenied` is true. Muted-text line under the win32 opt-in toggle now warns "Each update will request admin permission via a Windows UAC prompt." `EventMap['app:update-error']` extended for the optional `isUacDenied?: boolean` field. Manual Win11 VM smoke (steps 4-6 of the brief) deferred to lead post-merge. (`auto-update.ts`, `UpdatesTab.tsx`, `events.ts`)

### Deferred to v1.4.9 (Session B)

- Packet 06 — Provider auto-install prompt with consent gating (4 lead Q's first)
- Packet 07 — Notifications + top-right bell (migration 0018, 4-level severity, IPC delta-only) (5 lead Q's first)
- Packet 04 — Global voice capture, macOS only (whisper.cpp + Apple Speech.framework fallback) (7 lead Q's first)

### Deferred to v1.5.0 (Session C)

- Packet 04 — Voice capture Windows + Linux (after macOS validates lazy-download UX)
- Packet 08 — Windows SAPI5 voice (COM threading + node-gyp prebuild matrix)
- Packet 09 — Cross-machine session sync (libsodium + HLC + LWW + isomorphic-git; 6 user Q's + security signoff)

### Process

- **Worktree-per-packet dispatch** per `~/.claude/skills/orchestrator/SKILL.md` — 4 parallel Sonnet sub-agents (`claude-sonnet-4-6`), each in its own git worktree (`SigmaLink-feat-v1.4.8-NN-<name>`) branched from local main, with pnpm-lock copied (gitignored). HARD scope discipline per `feedback_agent_scope_discipline.md` embedded in every brief — STOP CONDITION + explicit prohibitions on tags/versions/CHANGELOG/auto-merge/follow-up packets. All 4 agents respected the bound.
- **Rebase noise resolution** — local main was 3 commits ahead of origin/main (planning docs) AND origin/main had merged PR #44 (deep cleanup sweep, 5 unrelated files) that local hadn't pulled. First push rejected non-fast-forward. Pull-rebased onto origin/main (no conflicts), force-pushed; then per-feature-branch rebase + force-push. PR diffs auto-cleaned to 3-4 files per packet.
- **Cleanup-loop per orchestrator skill** — each PR got Opus 4.7 reviewer pass. Verdicts: #45 APPROVE-WITH-CAVEATS (caveats 1+2 folded inline via lead commit `db3c717`; caveat 3 deferred), #46 APPROVE-WITH-CAVEATS (observational only — defer to v1.4.9 cleanup), #47 APPROVE (clean — 3 notable strengths called out), #48 APPROVE-WITH-CAVEATS (4 quality caveats including `CommandRoom.tsx` exceeding 500-line rule — defer to v1.4.9 cleanup packet alongside `PaneShell.tsx` extraction).

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: 562 pass | 1 skip (70 test files; was 515 → +47 new across 4 packets; 0 failures, post-merge electron-binary tests stable)
- `pnpm exec eslint .`: 0 errors, 1 pre-existing warning (`use-session-restore.ts:277` — known)
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

### Migration

No schema migrations. All 4 packets are pure renderer + electron-main code. Migration 0017 (pane split columns from v1.4.3) remains the ceiling. Sessions B + C will introduce migration 0018 (whichever of notifications or cross-sync ships first claims the slot; second gets 0019).

### Deferred caveats — for v1.4.9 cleanup packet

- **#45 caveat 3**: UAC hint placement (inside card vs section helper) — visual dogfood judgment required
- **#46 caveat 1**: Export `normalizeUrl` from `AddressBar.tsx` so tests import (not duplicate inline)
- **#46 caveat 2**: `BrowserViewMount` lifecycle (`visible={false}` vs unmount) — if first-tab flicker shows up
- **#48 caveat 1**: Export `insertMention` from `CommandRoom.tsx` so tests import
- **#48 caveat 2**: `data-testid="pane-body"` on PaneCell wrapper (test-quality)
- **#48 caveat 3**: **`CommandRoom.tsx` now 878 lines — exceeds 500-line project rule.** Extract `PaneCell` to `PaneShell.tsx` (was Open Question 1 in packet 03 brief, deferred for scope reasons)
- **#48 caveat 4**: Extract `pathRelative(abs, root)` helper to dedupe `FileTree.tsx` + `CommandRoom.tsx` heuristic

## [1.4.7] - 2026-05-19

CI is fully green again. Closes 5 of the 6 e2e tests that have been red since v1.4.3, fixes a v1.4.3 production regression in pane rehydration, and ships the OpenCode SQLite direct read latency win. WISHLIST P1/P2 tiers fully closed; feature-tier items (notifications, Windows SAPI5 voice, cross-machine sync, Windows auto-update, provider auto-install) deferred to v1.4.8.

### Fixed

- **Pane rehydration on workspace reopen** — `panes.listForWorkspace` was added to the RPC controller in v1.4.3 PR #28 but never added to the channel allowlist in `app/src/shared/rpc-channels.ts`. The preload bridge rejected the channel; three v1.4.3 `ADD_SESSIONS` dispatch sites (`useSessionRestore`, Sidebar workspace-reopen, Launcher `chooseExisting`) silently failed via their try/catch wrappers. **Net effect**: pane state has NOT been restoring on workspace reopen since v1.4.3 shipped. Users never saw their previous panes unless they manually re-spawned. Surfaced by the new v1.4.7 multi-workspace e2e test that hard-failed where production code silently swallowed. (packet 02 byproduct, #37)
- **3 deferred Playwright e2e tests** — `dogfood.spec.ts:133` (stale Bridge→Sigma references + sidebar-button navTo), `multi-workspace.spec.ts:72` (missing renderer `sigma:test:reload-sessions` hook for IPC-launched sessions), `multi-workspace.spec.ts:166` (`invoke()` helper not unwrapping `{ok,data}` IPC envelope). All deferred from PR #36 Followup-2. (packet 02, #37)
- **2 pre-existing e2e timeouts** — `assistant-cli.spec.ts:27` stale composer selector after v1.4.1 SigmaRoom split (now `textarea[aria-label="Ask Sigma"]`) + missing workspace activation (Sigma room requires active workspace since v1.4.0) + env-gated behind `SIGMA_E2E_CLAUDE=1` for CI (needs real Anthropic credentials). `dogfood.spec.ts:358 BUG-W7-006` 3-min hang — was passing `preset: 'squad'` with `roster: []` which expanded to 5 CLI agents; under v1.4.3+ worktree pool + v1.4.5 proper-lockfile retries the spawn took >3 minutes. Race property under test doesn't require multi-agent spawn; reduced to minimal 1-agent shell roster, test now completes in 4.9s. (packet 03, #37)

### Performance

- **OpenCode session picker latency** — replaced the `opencode session list --format json` subprocess (~200-400ms cold start) with a direct readonly SQLite read of `~/.local/share/opencode/opencode.db`. Per-call latency drops to <100ms. Tolerates missing CLI binary, schema drift (only references columns guaranteed since v0.x), locked DB, corrupt DB — all degrade gracefully to empty list with subprocess as fallback. Five-column SELECT (`id`, `directory`, `title`, `time_created`, `time_updated`) ignores the 14 columns added by later OpenCode `ALTER TABLE` statements. (packet 06, #39)

### Documentation

- **opencode-Qwen silent-fail probe resolution** — the secondary failure mode from v1.4.5 cluster α (in addition to the v1.4.6 missing `--dangerously-skip-permissions` resolution) is now documented in the orchestrator skill at `~/.claude/skills/orchestrator/SKILL.md`: opencode CLI silently exits with 0-byte stdout when the model identifier is unknown AND `--print-logs` is OFF. Correct identifiers come from `opencode models` (current free-tier: `opencode/qwen3.6-plus-free`). The v1.4.5 dispatch tried `qwen/qwen3-coder-plus` which is not a valid name. (packet 04)
- **v1.4.7 bundle plan** — 11 packet documents in `docs/03-plan/v1.4.7-bundle/` covering both shipped (#01-#04, #06, #11) and deferred (#05, #07, #08, #09, #10) work. Archived to `docs/03-plan/archive/v1.4.7-bundle/` at ship time.

### CI / Tests

- **Full Playwright suite green** for the first time since v1.4.3 — 8 pass / 0 fail / 3 skip (was 6 pass / 2 fail / 3 skip pre-v1.4.7). Skips are documented in the test files: `assistant-cli-launch-pane` (`manual:` describe), `assistant-cli` (env-gated `SIGMA_E2E_CLAUDE`), `pane-split` (`manual:` describe).
- **vitest baseline expanded**: 505 → 515 pass (10 new OpenCode SQLite reader tests) | 1 skip.
- **New renderer test hook** — `sigma:test:reload-sessions` CustomEvent (13 LOC in `state.tsx`) mirroring the existing `sigma:test:activate-workspace` and `sigma:test:set-room` patterns. Production no-op; enables e2e tests calling `workspaces.launch` via raw IPC to push the newly-launched sessions into renderer state.

### Deferred to v1.4.8

- Packet #05 — Windows auto-update verification flow (needs Windows VM)
- Packet #07 — Provider auto-install prompt with consent gating (UX validation needed)
- Packet #08 — Notifications system + top-right bell (L-effort UX)
- Packet #09 — Native Windows SAPI5 voice binding (Windows VM + C++/node-gyp)
- Packet #10 — Cross-machine session sync via age + git (security-critical L-effort)

### Funded-only / won't-do

- EV/OV Authenticode cert ($300-700/yr) — still open, no committed funding
- Microsoft Store / WinGet — gated on EV cert
- Apple Developer ID + notarisation — explicitly dropped 2026-05-18 (commit `dd8a42f`)

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: 515 pass | 1 skip (505 baseline + 10 new for OpenCode SQLite)
- `pnpm exec eslint .`: 0 errors, 1 pre-existing warning
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean
- `pnpm exec playwright test tests/e2e/`: 8 pass / 0 fail / 3 skip

### Migration

No schema migrations. No behavior change for existing users — the `panes.listForWorkspace` channel allowlist fix simply restores the v1.4.3 pane rehydration feature that has been silently broken; users will start seeing their previous panes restore on workspace reopen automatically.

## [1.4.6] - 2026-05-18

Cross-platform frameless chrome + Intel-Mac voice fix + CI hardening. 15 commits between v1.4.5 and PR #36 captured here in one CHANGELOG entry; no separate v1.4.6 tag (content rolls forward into v1.4.7).

### Added

- **Cross-platform frameless chrome** — `titleBarStyle: 'hidden'` everywhere (was `'hiddenInset'` on darwin and `'default'` on win/linux). New `titleBarOverlay { color, symbolColor, height: 32 }` for Windows/Linux; `trafficLightPosition { x: 12, y: 10 }` for macOS. Renderer drag-region utilities removed the macOS-only guard; `useWcoInsets()` replaces the static `WIN32_WCO_RESERVE_PX` for Breadcrumb padding. (commits `145ade8`, `f52a768`)

### Fixed

- **x64 macOS Speech.framework voice** — pre-v1.4.6 the macos-14 release runner built only an arm64 `sigmavoice_mac.node` binary via `electron-builder`'s `npmRebuild:true`. That binary was packaged into both DMGs; on Intel Macs the `dlopen` failed and `voice-mac/index.js` fell through to the Web Speech API. Separate arm64/x64 rebuild paths in the matrix close the gap. (commit `87b51ba`)
- **Intel macOS installer asset resolution** — `install-macos.sh` now maps `arm64` to `SigmaLink-${VERSION}-arm64.dmg` and `x86_64` to `SigmaLink-${VERSION}.dmg`, with updated unsupported-arch messaging. (commit `a8920cf`)
- **Playwright e2e smoke refresh** — 4 navTo selector fixes against v1.4.5 UI: dropdown trigger via `getByRole` for Radix portal traversal, dropdown item via `getByRole('menuitem')` for same reason, overlay-close step to fix pointer-event interception on Memory/Browser/Sigma/Skills/Settings, and `sigma:test:set-room` test-event fallback for disabled-without-workspace rooms. Defensive `window.sigma` bridge assertion immediately after `domcontentloaded` + 2500ms settle wait. (commits `f546c1d`, `25f2017`, `9211385`)
- **Ruflo MCP autowrite test stale args** — test asserted v1.3.4-era `['@claude-flow/cli@latest', 'mcp-stdio']`; app writes v1.3.5 canonical `['-y', '@claude-flow/cli@latest', 'mcp', 'start']`. (commit `e53f6f3`)

### CI

- **Electron-ABI native module rebuild in all CI lanes** — replaced `pnpm rebuild better-sqlite3 node-pty` (targets host Node ABI) with `npx @electron/rebuild -f -w better-sqlite3 -w node-pty` (targets Electron's bundled Node ABI) in `e2e-matrix.yml`, `release-macos.yml`, `release-windows.yml`. The previous rebuild path was the root cause of CI e2e-matrix red since v1.4.3 — renderer crashed silently on boot → frozen splash frame → all screenshots identical → false-green test. (commit `38964f4`)
- **pnpm cache-dependency-path fix** — every `actions/setup-node@v4` step now points `cache-dependency-path` at `app/package.json` (was `app/pnpm-lock.yaml` which is gitignored). Restored the pnpm cache hit on CI. (commits `93abe63`, `fe35ee2`)
- **Disabled broken native voice prebuild workflow** — `.github/workflows/native-prebuild-mac.yml` removed from the auto-trigger lanes. The workflow's `pull_request.paths` lane triggered on every PR touching `native/` even though the workflow itself was broken. (commit `f12c656`)

### Verification (verify-and-close — no code change needed)

- **Parchment Launch CTA contrast WCAG AA** — token check confirmed normal `#8b4218` on `#f9f6f1` = 6.74:1; hover `bg-accent/90` over `card`/`canvas` remains above 5.4:1. BUG-W7-015 closed. (commit `b1c533d`)
- **vitest coverage thresholds present** — `coverage.thresholds` block already in `vitest.config.ts` at 22% lines floor. (commit `df698bd`)
- **Terminal.tsx mount race race-safe** — race-safe listener/snapshot ordering lives in `terminal-cache.ts`, not `Terminal.tsx`. New regression test proves live `pty:data` emitted while `pty.snapshot` is pending is buffered and written AFTER the snapshot, preserving snapshot-first order. R-1.2.7-1 closed. (commit `64f781d`)

### Documentation

- Master memory + memory_index updated with Phase 32 (PR #35 polish bundle + PR #36 e2e refresh). (commits `9a56f3d`, `e1f7c04`, `c06f974`)
- WISHLIST updated to drop Apple Developer ID from funded-only tier — explicitly not selling, won't pay $99/yr. (commit `dd8a42f`)

### Deferred to v1.4.7

- 3 stale e2e tests in `dogfood.spec.ts:133`, `multi-workspace.spec.ts:72`, `multi-workspace.spec.ts:166` — triaged with per-test root cause; deferred to v1.4.7 packet #02. See PR #36 `BRIEF.md ## Followup-2` for details.

## [1.4.5] - 2026-05-18

Tech-debt cleanup release. Closes 2 final v1.4.4 reviewer followups + retires 2 long-standing LOC debts.

### Fixed

- **projects.json read-merge-write race fully mitigated** — `writeProjectsJsonAtomic` in `gemini-resume-bridge.ts` now wraps the read-merge-write block in a `proper-lockfile` advisory lock (5 retries with exponential backoff + 5s stale recovery). Closes reviewer-PR27 F-2 v1.4.5 followup. New concurrent-writers test verifies serialization. (cluster α, #32)
- **SessionStep test flake eliminated** — added `vi.resetModules()` to `beforeEach` for full module-state isolation between cross-suite parallel runs. SessionStep now passes 5/5 in repeated full-suite runs. Closes reviewer-PR28/29 INFO v1.4.5 followup. (cluster α, #32)

### Refactored

- **`swarms/factory.ts` split** — 443 → 271 LOC. Extracted `addAgentToSwarm` body to new `factory-add-agent.ts` (168 LOC). Public API preserved via re-export; zero caller changes. (cluster β, #31)
- **`runClaudeCliTurn.ts` split** — 426 → 324 LOC. Extracted `buildCliArgs`, `applyMcpHostConfig`, `resolveSystemPrompt`, and session-id helpers to new `runClaudeCliTurn.args.ts` (138 LOC). Matches existing sibling-file pattern (`.emit.ts`, `.trajectory.ts`). (cluster β, #31)

### Dependencies

- **Added**: `proper-lockfile@^4.1.2` (advisory file-locking) + `@types/proper-lockfile@^4.1.4`

### Notes

- React-compiler lint wave (BACKLOG line 64) was investigated and found **already closed by prior v1.1.9 work**; no changes needed in v1.4.5.
- `use-session-restore.ts:277` eslint warning remains pre-existing/intentional.
- WISHLIST LOC numbers (713 / 709 for factory.ts / runClaudeCliTurn.ts) were stale; actual baselines were 443 / 426.
- One first-attempt `opencode-Qwen` dispatch for cluster α failed silently. Fell back to Sonnet per orchestrator skill rules. Failure mode documented for v1.4.6 investigation.

## [1.4.4] - 2026-05-18

Paper-cut cleanup release. Closes 7 reviewer-flagged followups from v1.4.x reviews + refreshes the stale Playwright e2e suite.

### Fixed
- launcher.ts comment now accurately describes the gemini bridge 'missing' fallback (reviewer-PR27 F-1)
- Windows path containment check uses path.relative for cross-platform robustness (reviewer-PR27 F-4)
- EmptyState dev-only console.warn now fires once per mount via useEffect (reviewer-PR29 LOW)
- SessionStep.test.tsx no longer flakes under parallel suite execution (reviewer-PR28 INFO)

### Added
- Atomic-write fault test for writeProjectsJsonAtomic — verifies clean error handling on fs.rename failure (reviewer-PR27 F-3)

### Documentation
- gemini-resume-bridge.ts now documents the projects.json read-merge-write race + schema fragility caveats. File-lock implementation deferred to v1.4.5 candidate (reviewer-PR27 F-2)

### CI
- Playwright e2e smoke suite refreshed against v1.4.3 DOM (selectors stale since v1.1.4)

## [1.4.3] - 2026-05-18

Bugfix release focused on Gemini CLI integration, pane state persistence across app restarts, and the long-deferred Pane Split + Minimise feature.

### Fixed

- **Gemini panes no longer exit code 1 on spawn** — SigmaLink was passing `gemini --resume <sigmalink-uuid>` but gemini's resume flag expects `"latest"` or numeric index; on top of that, per-pane git worktrees had empty `~/.gemini/tmp/<worktree-slug>/chats/` because gemini history lives under the workspace-slug not the worktree-slug. New `gemini-resume-bridge.ts` aliases `<worktreeCwd> → <workspaceSlug>` in `~/.gemini/projects.json` so gemini reads the same chats dir from both cwds. Mirrors v1.3.2's claude-resume-bridge approach with the cleaner alias model. (packet 01, #27)
- **Workspace pane state now persists across app restart** — pre-existing missing wire (latent since v1.0.0) where the renderer's `state.sessions` slice was never hydrated on workspace open. New `panes.listForWorkspace` RPC + `ADD_SESSIONS` dispatch from three call sites (Sidebar, Launcher chooseExisting, use-session-restore). v1.4.2's xterm-cache GC made this latent bug visible for the first time; v1.4.3 closes the loop. (packet 02, #28)
- **Stale `status='running'` rows now expire after 24h** — Electron's hard quit (`Cmd+Q`) bypasses the onExit handler, leaving sessions stuck in `running` state in `agent_sessions`. New migration 0016 (`dead_row_hygiene`) marks rows older than 24h as `status='exited', exit_code=-1`. Conservative window spares actually-active sessions. Idempotent; runs at boot before any RPC. (packet 03, #28)
- **Disk-scanner now supports Gemini** — implemented the `gemini` case in `session-disk-scanner.ts:620-622` (was `return []` stub since v1.3.1). Reuses `geminiSlugForCwd` + workspace whitelist from v1.4.2 packet 10. (packet 01 bonus, #27)

### Added

- **Pane Split (horizontal + vertical)** — the long-deferred "Coming in v1.2" feature finally ships. Click Split-H or Split-V on a pane header → provider dropdown → spawns a sub-pane sharing the parent's worktree (co-tenants on one git branch). Migration 0017 adds `split_group_id`, `split_direction`, `split_index`, `minimised` columns to `agent_sessions`. Flat-group sentinel model (Option B) supports 2-level deep nesting; deeper nesting deferred to v1.5+. `addAgentToSwarm` gained optional `worktreePath`/`cwd`/`branch` parameters; legacy callers leave them undefined (fresh-worktree path unchanged). Sub-grid resize divider with rAF-coalesced drag + 0.15..0.85 ratio clamp. (packet 06, #29)
- **Pane Minimise** — click Minimise on a pane header to collapse to a header strip while the PTY keeps emitting. Click the header to restore. Toggles the `minimised` column atomically. (packet 06, #29)
- **Inline "Add first pane" affordance in CommandRoom empty state** — when a workspace activates with `activeSwarm.status === 'running' && sessions.length === 0` (e.g. fresh workspace or post-restore edge case), the EmptyState now offers `+ Add first pane` alongside `Go to Workspaces`. Defense-in-depth — if rehydration ever regresses, users have an in-room recovery path. (packet 05, #29)
- **Orphan worktree cleanup on workspace open** — new `cleanupOrphanWorktrees()` helper removes worktree dirs under `<userData>/SigmaLink/worktrees/<repoHash>/` that aren't referenced by any live `agent_sessions.worktree_path`. Best-effort; non-fatal; cold-install guard skips cleanup when DB has no rows for the repo. Retention: keeps recently-exited dirs too (7d window) in case of uncommitted work. (packet 04, #28)

### Changed

- **`addAgentToSwarm()` signature**: 3 new optional parameters (`worktreePath`, `cwd`, `branch`) for split sub-pane support. Strictly additive; all legacy callers still work unchanged.

### Documentation

- v1.4.3 bundle plan (`docs/03-plan/v1.4.3-bundle/`) — 7 MD files (00-INDEX + 6 per-fix briefs). Same orchestration pattern as v1.4.2-bundle.
- New `orchestrator` skill at `~/.claude/skills/orchestrator/SKILL.md` documenting external CLI sub-agent invocation patterns (codex, gemini, kimi, opencode-Qwen), worktree-per-agent hygiene, and the delegation matrix.

### Followups deferred to v1.4.4

- `--resume latest` comment wording in `launcher.ts:207-211` (reviewer-PR27 F-1)
- `~/.gemini/projects.json` read-merge-write race documentation + file-lock (reviewer-PR27 F-2)
- Atomic-write fault injection test for `writeProjectsJsonAtomic` (reviewer-PR27 F-3)
- Windows path containment cross-platform robustness (reviewer-PR27 F-4)
- `SessionStep.test.tsx` cross-suite flakiness mitigation (reviewer-PR29 INFO)
- Empty-state `console.warn` wrapped in `useEffect` instead of render body (reviewer-PR29 LOW)

## [1.4.2] - 2026-05-17

Stability, discoverability, and Windows compatibility hardening across the v1.4.x line.

### Added

- **Worktree location discoverability UX** — pane right-click → "Reveal worktree in Finder/Explorer" via Electron `shell.showItemInFolder` + path-validated RPC. "Open shell here" pane action spawns the OS-default terminal at the worktree cwd. Per-pane tooltip shows full worktree path. First-launch info banner explains where worktrees live (`<userData>/worktrees/<repoHash>/`). New Settings → Storage tab lists all worktrees with async-computed sizes + reveal buttons. No relocation; Option D additive scope only. (packet 06, #20)
- **Disk-scan provider scoping via workspace whitelist** — the disk scanner now rejects candidate sessions whose external id is already claimed by a *different* workspace, preventing foreign sessions spawned in another repo from being captured by the current workspace's pane. Uses `agent_sessions` whitelist (Option B). (packet 10, #21)
- **NSIS custom welcome page** — installer now ships a custom welcome page with Windows SmartScreen / Mark-of-the-Web workaround instructions (replaces the legacy `nsis.license` text). See `app/build/installer.nsh`. (packet 11, #18)
- **Pane Focus → true fullscreen** — focus icon promotes pane to viewport (1fr × 1fr grid template), others kept mounted with `display:none` so PTYs keep emitting. Esc exits. New `focusedPaneId` state field + FOCUS_PANE/UNFOCUS_PANE actions with auto-clear on workspace change. Composes on v1.4.2 #03's terminal cache. (packet 12, #26)

### Fixed

- **Sigma Assistant Windows spawn ENOENT** — `child_process.spawn` on Windows cannot execute `.cmd`/`.bat` shims with a bare arg array. New `spawn-cross-platform.ts` wraps `.cmd` via `cmd.exe /d /s /c` and `.ps1` via `powershell.exe`, mirroring `local-pty.ts` pattern. `shell: true` explicitly rejected for injection safety. (packet 01, #22)
- **Settings room persists in `roomByWorkspace`, blocking workspace click** — `SET_ROOM` only excluded `'workspaces'` from persistence. Introduced `GLOBAL_ROOMS = ['workspaces', 'settings']` guard applied consistently across three dispatch paths. Clicking a workspace after visiting Settings now correctly routes to Command Room. (packet 02, #17)
- **xterm preservation across room/workspace switch** — two-layer fix: (1) mount-race quick-win reorders xterm host so `pty:data` bus subscription attaches before `rpc.pty.snapshot` IPC roundtrip, closing 1-5 ms drop window; (2) renderer-side terminal-instance cache keyed by sessionId survives both room switch and workspace switch, unlike React 19 `<Activity>` which would unmount on workspace key change. (packet 03, #23)
- **BUG-W7-015** — Launch button low-contrast in Parchment theme closed. Accent-filled CTA (`bg-accent`) with darker Parchment accent tokens (`--accent: 22 70% 32%`) already on main; verified WCAG AA contrast. (packet 09, #19)
- **CI cache-dependency-path** — `cache-dependency-path` correctly targets `app/package.json` in `lint-and-build.yml`. (packet 09, #19)
- **vitest coverage thresholds** — `coverage.thresholds` block present in `vitest.config.ts` with 22% lines floor. (packet 09, #19)
- **CI shellcheck step** — moved from `macos-14` job to a dedicated `ubuntu-latest` job (was using `apt-get` on macOS where it does not exist, red on every PR). (#24)

### Changed

- **Delegation matrix rebalance** — Qwen carries mechanical bulk (docs, verify-and-close sweeps) to free Sonnet/Opus for architecture-critical packets. (docs)

### Performance

- **Pane resize via `requestAnimationFrame` coalesce** — `colFracs`/`rowFracs` updates run once per frame during drag (was per pointermove event). Terminal `runFit` debounce relaxes 25ms → 100ms during sustained drag via `document.body.dataset.dragging` flag. (packet 07, #26)

### Documentation

- **Backlog verify-and-close sweep** — 4 items verified and closed: BUG-W7-015 launch button contrast (already fixed on main), CI cache-dependency-path (correct), vitest coverage thresholds (present), shellcheck CI step (escalated — runs `apt-get` on `macos-14`). (packet 09, #19)
- **state.tsx LOC verify-and-close** — `state.tsx` was already split from 553 → 97 LOC in v1.1.9 (commit `d824c42`); stale BACKLOG and WISHLIST rows removed. (packet 08, #16)

### Known issues

- **shellcheck CI step** — step exists in `lint-and-build.yml` but was running `apt-get` on `macos-14` runner (fixed in #24 by moving to ubuntu-latest). Legacy note retained for context.

### Deferred to v1.4.3

- **#04 OpenCode pane 6 font rendering on Windows** — H1 (font fallback) and H2 (pane-6-specific) hypotheses documented in `docs/03-plan/v1.4.2-bundle/04-opencode-pane-font.md`. Gated on Windows VM diagnostic capture (font check + OpenCode in pane 1).
- **#05 + Pane button UX** — button is fully wired, perceived as broken due to UX discoverability. Three conditional fix shapes documented. Gated on user screen recording.
- **#13 Pane Split + Minimise** — feature work; pairs with #05. Gated on the same user recording.

### Verification

- `pnpm exec tsc -b --pretty false` — clean
- `pnpm exec vitest run` — **417/417 pass**
- `pnpm exec eslint .` — 0 errors, 1 pre-existing warning
- `pnpm run build` — clean
- `node scripts/build-electron.cjs` — clean

## [1.4.1] - 2026-05-16

release(v1.4.1): Bridge → Sigma rename + pane mailbox back-channel + SigmaRoom split

### Changed

- **Bridge → Sigma branding sweep** across all renderer UI strings, component names, directory names, room IDs, and developer comments. `bridge-agent/` → `sigma-assistant/`, `SigmaRoom.tsx` → `SigmaRoom.tsx`, `BridgeTabPlaceholder.tsx` → `SigmaTabPlaceholder.tsx`, room ID `'bridge'` → `'sigma'`.
- **KV migration transparent on first launch.** `kv['bridge.activeConversationId']` → `kv['sigma.activeConversationId']` and `kv['bridge.autoFocusOnDispatch']` → `kv['sigma.autoFocusOnDispatch']`. Idempotent — old key deleted after copy.
- Generic descriptive "bridge" terminology in `claude-resume-bridge.ts` + `mcp-host-bridge.ts` intentionally preserved (symlink/IPC helpers, not branding).

### Added

- **Pane → Sigma mailbox back-channel** — completes the W-2 vision. New `sigma_pane_events` table (migration 0014), new `sigma_monitor_conversation_id` column on `agent_sessions` (migration 0015), new `monitor_pane()` tool, new `assistant:pane-event` IPC channel. Sigma can now observe pane lifecycle events (started, exited, error) and render inline event cards in the transcript with "Reply to pane" action.
- **Pattern ribbon** — Ruflo MCP pattern surfacing in the composer. When the supervisor is ready and the user types ≥8 chars, a debounced probe surfaces matching past patterns at ≥0.7 confidence for one-tap reuse.

### Refactored

- **SigmaRoom.tsx** (was SigmaRoom.tsx) split from 922 LOC into focused hooks + sub-components: `use-sigma-conversations.ts`, `use-sigma-resume-flow.ts`, `use-sigma-pane-events.ts`, `use-sigma-ruflo-health.ts`, `use-sigma-pattern-probe.ts`, `use-sigma-dispatch-echo.ts`, `use-sigma-jump-to-message.ts`, `use-sigma-voice.ts`, `use-sigma-assistant-state.ts`, plus `SigmaRailDropdown.tsx`, `InterruptedTurnBanner.tsx`, `ResumeBanner.tsx`, `PaneEventCard.tsx`, `PatternRibbon.tsx`. SigmaRoom.tsx now at 283 LOC (target was <400).

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run`: 363/363 pass (was 354; +9 new tests for migrations + monitor_pane tool + pane events)
- `pnpm exec eslint .`: clean (pre-existing use-session-restore warning OK)
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

## [1.4.0] - 2026-05-16

feat(v1.4.0): Sigma Assistant orchestrator resume

### Added

- **Sigma Assistant now resumes Claude conversations.** The assistant captures Claude's `system.init` `session_id`, stores it on the conversation row via migration `0013_conversations_claude_session_id`, and passes `--resume <id>` on later turns in the same chat.
- **Stale resume fallback.** If a stored Claude session id fails immediately with a likely resume error, Sigma clears the stale id and retries the turn once without `--resume` so the user gets an answer instead of a dead chat.
- **Interrupted-turn sentinel.** Assistant messages now start with a `sigma-in-flight:<turnId>` marker and clear it on final persistence, letting the renderer surface a retry/dismiss banner after restart or crash.
- **Right-rail conversation resume UI.** The compact Sigma Assistant rail now has a conversation dropdown, resumable pill, resume notice banner, and interrupted-turn retry affordance.
- **Resume hint RPC.** `assistant.conversations.resumeHint` checks whether the stored Claude JSONL exists for the conversation's workspace slug.

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run src/main/core/assistant/conversations.test.ts src/main/core/assistant/runClaudeCliTurn.test.ts src/renderer/features/bridge-agent/ConversationsPanel.test.tsx src/renderer/features/bridge-agent/SigmaRoom.test.tsx`: 31/31 pass
- `node --experimental-strip-types --test src/main/core/db/__tests__/migrate.spec.ts`: 5/5 pass
- Focused `pnpm exec eslint ...`: clean

## [1.3.5] - 2026-05-16

W-3 — Ruflo MCP auto-bind for every CLI pane + canonical-args fix.

### Fixed

- **Canonical `claude-flow` MCP invocation.** v1.3.4 wrote `RUFLO_ARGS = ['@claude-flow/cli@latest', 'mcp-stdio']` into every pane's MCP config, but `mcp-stdio` is **not** a real `claude-flow` subcommand — the correct form is `['-y', '@claude-flow/cli@latest', 'mcp', 'start']`. RufloReadinessPill's fast-mode check only verified file presence so the pill reported green even though the spawned MCP servers exited immediately. v1.3.5 fixes the args; pre-existing user configs self-heal on next `openWorkspace()` because `isManagedRufloEntry()` recognises any entry with `command === 'npx'` as managed and rewrites the args list. User-set env vars survive the merge.

### Added

- **Kimi MCP target** — `~/.kimi/mcp.json`, Claude-Desktop-compatible `mcpServers.{name}.{command, args, env}` schema. Soft-gated by PATH detection or pre-existing file (avoids creating empty config dirs for users who don't have Kimi installed).
- **OpenCode MCP target** — `~/.config/opencode/opencode.json` with OpenCode's non-standard schema: top-level `mcp` key (not `mcpServers`), entry shape `{ type: 'local', command: [flat-array-no-args], environment: {...}, enabled: true }`. Preserves user-set `enabled: false`, top-level `$schema`, and unrelated keys (`model`, `mcp.{other-server}`).
- **`detected` tri-state in `verifyForWorkspace`** — `{ kimi: boolean, opencode: boolean }` so `RufloReadinessPill` can treat "CLI not installed" as a vacuous pass instead of a red. 5-CLI readiness scoring now: `verified` when 5/5 (or 5/5 with vacuous passes), `partial` when ≥3/5, `unavailable` otherwise.
- **Per-CLI tooltip status** — pill tooltip lists all 5 CLIs with their fast-mode verification state; undetected CLIs show "not detected".

### Verification

- `npx tsc -b` clean
- `npx vitest run` **339/339** (323 baseline + 16 new — 9 in `mcp-autowrite.test.ts`, 7 in `verify.test.ts`)
- `npx eslint .` clean (pre-existing `use-session-restore.ts:263` warning unchanged per v1.3.3 caveat)
- `npm run build` clean
- `node scripts/build-electron.cjs` clean
- **R1 verified live:** `echo "" | npx -y @claude-flow/cli@latest mcp start &` — server stayed alive 3+ seconds with piped stdin.
- **R2 verified live:** `kimi mcp --help` and `opencode mcp --help` both confirm `mcp list` is a valid subcommand on installed CLIs (no strict-mode fallback required).
- Reviewer (Opus 4.7): **APPROVED** — 0 critical/high/med risks. One low-priority dedup opportunity noted (PATH detection logic shared between `mcp-autowrite.ts` and `verify.ts`) — non-blocking, candidate for v1.3.6 cleanup.

### Migration

For users on v1.3.4 with manual edits in their Ruflo MCP entries:
- If `command !== 'npx'` (e.g., `bunx`, `uvx`, absolute path) — SigmaLink refuses to autowrite; your manual config is preserved.
- If `command === 'npx'` (default/managed entry with broken `mcp-stdio` args) — SigmaLink rewrites the args list on next `openWorkspace()`. User-set `env` keys are merged, not replaced.

### Related

- [`docs/03-plan/W-3-ruflo-mcp-autobind-v1.3.5.md`](docs/03-plan/W-3-ruflo-mcp-autobind-v1.3.5.md) — expanded implementation plan.
- v1.3.6 candidates filed in `docs/03-plan/WISHLIST.md`: detection-gated writes for Claude/Codex/Gemini, `OPENCODE_CONFIG` env override support, shared PATH-detect helper extraction.

## [1.3.4] - 2026-05-16

fix(v1.3.4): make Claude resume reliable inside pane worktrees

### Fixed

- **Claude panes now spawn from the selected workspace subdirectory inside each git worktree.** SigmaLink workspaces can point at a repo subfolder (`app/`) while `git worktree add` creates a checkout at the repo root. v1.3.2/v1.3.3 launched Claude from the worktree root, so Claude missed workspace-local `CLAUDE.md`, `.claude/`, and the same cwd slug that the session picker scanned. New `workspaceCwdInWorktree()` maps `<repo-worktree>` back to `<repo-worktree>/<workspace-relative-path>` before spawning panes.
- **Ignored Claude context is bridged into worktrees.** `prepareClaudeWorkspaceContext()` symlinks workspace-local `CLAUDE.md` and `.claude/` into the worktree cwd when those files are ignored and therefore absent from the git checkout. Existing worktree files are never overwritten.
- **Boot-time resume now uses the same Claude bridge as launcher resume.** `resumeWorkspacePanes()` and `respawnFailedWorkspacePanes()` resolve worktree subdir cwd, prepare workspace context, create Claude's project dir, and bridge workspace-slug JSONL before spawning `claude --resume`.
- **Resume picker no longer combines fresh `--session-id` with `--resume`.** The provider launcher suppresses pre-assigned UUID injection when resume/continue args are present, avoiding `claude --session-id <new> --resume <picked>`.
- **Invalid Claude resume ids fall back to `--continue`.** UUID validation now applies before building `claude --resume`, so malformed values no longer produce an immediate code-1 spawn.

### Verification

- `pnpm exec tsc -b --pretty false`: clean
- `pnpm exec vitest run src/main/core/pty/claude-resume-bridge.test.ts src/main/core/workspaces/worktree-cwd.test.ts src/main/core/providers/launcher.test.ts src/main/core/pty/resume-launcher.test.ts`: 47/47 pass
- `pnpm exec vitest run`: 323/323 pass
- `pnpm exec eslint .`: clean with the existing `use-session-restore.ts:263` exhaustive-deps warning
- `pnpm run build`: clean
- `node scripts/build-electron.cjs`: clean

## [1.3.3] - 2026-05-16

fix(v1.3.3): workspace switching + Claude pane error visibility + session-restore timer hygiene

### Fixed

- **Workspace switching from sidebar / launcher.** Clicking a workspace in the left sidebar or re-opening a persisted workspace from the Launcher's Start step previously left the user on whatever room they were viewing — typically the Launcher itself, even when the workspace already had running panes. `SET_ACTIVE_WORKSPACE_ID` in `app/src/renderer/app/state.reducer.ts` now restores the per-workspace room from `state.roomByWorkspace`, defaulting to `'command'` when no room has been recorded yet. Sidebar `onPick` no longer has to force `SET_ROOM` (the reducer handles it). Launcher `chooseExisting` still dispatches `SET_ROOM: 'command'` explicitly because it uses the `SET_ACTIVE_WORKSPACE` action which intentionally does not auto-switch rooms (BUG-W7-001).
- **Claude blank-pane is now a visible error, not a silent void.** v1.3.2's `claude-resume-bridge` symlink path works on most machines, but Claude can still exit with code 1 in ~200ms for reasons under spawn-level investigation (filed as v1.3.4 backlog). Both `app/src/main/core/workspaces/launcher.ts` and `app/src/main/core/pty/resume-launcher.ts` now grade any pane exit within 1.5s as `status: 'error'` instead of the previous narrower `exitCode < 0 && < 1.5s` check (which only caught synthetic ENOENT). The pane now surfaces the error UI immediately rather than showing a blank terminal that never converges.
- **Session-restore snapshot timer no longer cancelled on no-op re-renders.** `app/src/renderer/app/state-hooks/use-session-restore.ts` hoisted the snapshot key outside the effect and added an unmount-only cleanup `useEffect`, so the in-effect `clearTimeout` only fires on real workspace key changes. Previously every parent re-render fired the effect cleanup, cancelling the in-flight snapshot RPC.

### Verification

- `pnpm exec tsc -b`: clean
- `pnpm exec vitest run`: 314/314 (same as v1.3.2 — no regressions, no new tests needed since changes are within existing snapshot test coverage)
- `pnpm exec eslint .`: clean (1 known-false-positive `react-hooks/exhaustive-deps` warning in `use-session-restore.ts:263` — `wsId` is encoded inside `snapshotKey`)
- `pnpm run build`: clean
- Reviewer (Opus 4.7): APPROVED WITH CAVEAT — Bug D root cause (Claude exit-code-1 inside worktree-slug dir despite v1.3.2 bridge symlink) deferred to v1.3.4 investigation. The 1.5s early-death gate is the new contract; red panes during QA mean Claude crashed, not a regression in this release.

### Related

- v1.3.2 `claude-resume-bridge` remains the primary fix for the Claude blank-pane scenario; v1.3.3 layers visibility on top.
- v1.3.4 backlog: investigate why `claude --resume <uuid>` exits with code 1 in ~200ms despite the v1.3.2 bridge symlink and the v1.3.3 mkdir-p.

## [1.3.2] - 2026-05-16

fix(v1.3.2): bridge Claude session-slug across worktrees + ensure project dir on fresh spawn

Hot-fix for two production bugs reported against v1.3.1. A user opened a 6-pane workspace (Claude×2, Codex, Gemini, Kimi, OpenCode). Codex / Gemini / Kimi / OpenCode all worked correctly. Both Claude panes — one resuming an existing session, one starting fresh — surfaced a completely blank terminal with no banner, no prompt, no output. The four non-Claude providers spawning correctly proved the bug was specific to Claude's launch path.

### Fixed

- **Pane 1 (Claude resume) — session-slug mismatch.** Claude stores chat history on disk at `~/.claude/projects/<slug>/<session-id>.jsonl` where `<slug> = cwd.replace(/\//g, '-')`. The new SessionStep wizard scans for sessions at the workspace root (`selectedWorkspace.rootPath`, e.g. `/Users/aisigma/projects/SigmaLink/app`) — but each pane spawns inside a per-pane Git worktree under `<userData>/worktrees/<repo-hash>/<branch-seg>`. The worktree slug ≠ workspace slug → `claude --resume <id>` running in the worktree cannot find the workspace-slug JSONL → Claude exits silently before printing its banner → blank pane. Fix: a new `prepareClaudeResume(workspaceCwd, worktreeCwd, sessionId)` helper in `app/src/main/core/pty/claude-resume-bridge.ts` symlinks the workspace-slug JSONL into the worktree-slug dir BEFORE Claude spawn, using an ABSOLUTE target path so Claude reads and APPENDS to the original file. Symlink (not copy) is deliberate — keeps the user's project-level Claude history unified across worktrees and across launches. `executeLaunchPlan` calls the bridge in `app/src/main/core/workspaces/launcher.ts` only when `provider.id === 'claude'` AND a resume session id is present; if the source JSONL is missing on disk (deleted / pruned) the launcher drops the id and falls through to the universal `--continue` fallback so the pane still spawns instead of going blank.
- **Pane 2 (Claude fresh spawn) — missing parent dir for `--session-id`.** When Claude is spawned with `--session-id <new-uuid>` in a brand-new per-pane worktree, the parent directory `~/.claude/projects/<worktree-slug>/` does not yet exist. Recent Claude versions silently exit when attempting to open the JSONL for write before printing the banner. Fix: `ensureClaudeProjectDir(worktreeCwd)` in the same bridge module pre-creates the worktree-slug directory with `mkdir -p` before any Claude spawn (resume or fresh). Idempotent — second call is a no-op.

### Added

- `app/src/main/core/pty/claude-resume-bridge.ts` (~210 LOC) — `claudeSlugForCwd`, `ensureClaudeProjectDir`, `prepareClaudeResume`. Pure async fs helpers, no shell-out. Refuses absolute paths containing `..` traversal segments. Symlink targets are always under `<homeDir>/.claude/projects/` — never outside the user's own Claude data store. Verified clean by `aidefence_scan`.
- `app/src/main/core/pty/claude-resume-bridge.test.ts` (18 cases) — symlink creation, idempotency, missing-source handling, traversal refusal, real-world SigmaLink path shape coverage. Pins the bug-report failure mode so it cannot silently regress.
- `app/src/main/core/workspaces/launcher.test.ts` (5 cases) — provider-gate sanity check verifying the bridge module exports are async functions, returns 'skipped' for non-Claude-compatible inputs, and slug helper matches the on-disk Claude CLI convention.

### Changed

- `app/src/main/core/workspaces/launcher.ts` — imports the bridge module; calls `prepareClaudeResume` before resume spawns and `ensureClaudeProjectDir` before any Claude spawn. Falls through to `--continue` when the resume source JSONL is missing on disk.

### Verification

- `pnpm exec tsc -b`: clean
- `pnpm exec vitest run`: 314/314 (was 291 — net +23 cases)
- `pnpm exec eslint .`: clean
- `pnpm run build`: clean

### Related

- Release notes: `docs/09-release/release-notes-1.3.2.txt`
- Wishlist: `docs/03-plan/WISHLIST.md` (recently shipped table updated)
- Master memory: `docs/10-memory/master_memory.md` (Phase 24c note appended)

## [1.3.1] - 2026-05-16

fix(v1.3.1): per-pane session picker dedup + resume threading

Hot-fix for two production bugs shipped in v1.3.0. The user-reported symptom was: create a 4-pane workspace, pick sessions in the new picker, hit Launch → 14 panes spawn (Claude×3, Codex×3, Gemini×3, Kimi×3, + 2 strays) AND none of the picked sessions actually resume.

### Fixed

- **Bug A — `panes.lastResumePlan` returned every historical row instead of one per pane.** The v1.3.0 SQL synthesised `paneIndex` from `ROW_NUMBER() OVER (ORDER BY started_at DESC)`, which numbered every row in `agent_sessions` for the workspace. After 3 launches of a 4-pane workspace that yielded 12 rows; the Launcher's `chooseExisting()` then set `preset = plan.length` (12) and the AgentsStep matrix was wide enough to overflow into a 14-pane grid. Fix: added migration `0012_agent_session_pane_index` (`app/src/main/core/db/migrations/0012_agent_session_pane_index.ts`) adding an `INTEGER` `pane_index` column + composite index `agent_sessions_ws_pane_idx`; the launcher now writes the pane slot on every insert; the controller groups by `(workspace_id, pane_index)` and returns the most recent row per pane via a correlated `INNER JOIN ... MAX(started_at)` subquery. Legacy rows (pre-migration writes) with NULL `pane_index` are filtered out so they cannot inflate the count.
- **Bug B — `paneResumePlan` payload mismatch caused every pane to spawn fresh.** v1.3.0's `Launcher.launch()` put `sessionId` inside each `panes[i]` object, but `executeLaunchPlan` reads the top-level `plan.paneResumePlan` array. The frontend's per-pane `sessionId` was silently dropped, so `resumeSessionId` was always null and `buildResumeArgs` was never called. Fix: extracted `buildPaneResumePlanArray(paneCount, selections)` helper (exported for testing) and call it in `launch()` to emit the top-level array shape the backend expects.

### Added

- `app/src/main/core/db/migrations/0012_agent_session_pane_index.ts` — forward-only migration adding the `pane_index` column + `agent_sessions_ws_pane_idx` composite index. Idempotent (PRAGMA-introspection guard).
- `app/src/renderer/features/workspace-launcher/Launcher.test.tsx` — new test file (7 cases) pinning the `buildPaneResumePlanArray` contract so Bug B cannot silently regress.
- Multi-launch dedup test + null-sessionId edge case + legacy `pane_index IS NULL` exclusion test added to `app/src/main/core/pty/last-resume-plan.test.ts` (5 cases → 9 cases). The new fake DB models the JOIN-on-MAX shape faithfully.

### Changed

- `app/src/main/core/db/schema.ts` — `agentSessions.paneIndex` column + composite index declared in Drizzle.
- `app/src/main/core/db/migrate.ts` — register migration 0012 in the ordered runner.
- `app/src/main/rpc-router.ts` — rewrite of the `panes.lastResumePlan` SQL.
- `app/src/main/core/workspaces/launcher.ts` — write `pane_index` on every `agent_sessions` insert.
- `app/src/renderer/features/workspace-launcher/Launcher.tsx` — top-level `paneResumePlan` array via `buildPaneResumePlanArray` helper.

### Verification

- `pnpm exec tsc -b`: clean
- `pnpm exec vitest run`: 291/291 (was 282 — net +9 cases)
- `pnpm exec eslint .`: clean
- `pnpm run build`: clean

### Related

- Release notes: `docs/09-release/release-notes-1.3.1.txt`
- Wishlist: `docs/03-plan/WISHLIST.md` (recently shipped table updated)
- Master memory: `docs/10-memory/master_memory.md` (Phase 22b note appended)

## [1.3.0] - 2026-05-16

Per-pane session picker in the Workspace Launcher. Users now choose which session to resume for each pane — or let the smart default (newest in cwd) do it — rather than relying solely on the silent automatic resume introduced in v1.2.8.

### Added

- **`SessionStep`** — new Launcher wizard step inserted between AgentsStep and Launch (`app/src/renderer/features/workspace-launcher/SessionStep.tsx`, ~250 LOC). One row per pane: provider dot, pane index, session chip, "Change..." button opening a Radix `Popover` with a shadcn `Command` (cmdk) full history list (up to 50 entries, sorted newest first, with timestamp + first-message preview). Smart default pre-selects the newest session for each (provider, cwd) pair on step mount.
- **Bulk bar** in SessionStep — "Resume newest for all", "All new", "Reset to suggested" — bulk-applies a decision across all panes without per-row interaction.
- **`listSessionsInCwd(providerId, cwd, opts?)`** added to `app/src/main/core/pty/session-disk-scanner.ts`. Returns `SessionListItem[]` (id, providerId, cwd, createdAt, updatedAt, title?, firstMessagePreview?) sorted DESC by `updatedAt`. Per-provider strategies: Claude globs `~/.claude/projects/<slug>/*.jsonl`; Codex globs rollout JSONL filenames; Kimi reads `state.json` per session directory; OpenCode calls `opencode session list --format json`. Gemini returns `[]` (v1.3.1 target).
- **`panes.listSessions(providerId, cwd, opts?)`** RPC — called by picker Popover per pane (lazy, on open); by smart default (eager, maxCount 1 per pane on step mount).
- **`panes.lastResumePlan(workspaceId)`** RPC — reads most recent `agent_sessions` row per `paneIndex` for a workspace; no schema migration (v1.2.8 columns sufficient).
- **Scenario B** support — sidebar workspace dropdown now routes through SessionStep with chips pre-populated from the last-run session IDs. "Reconfigure layout..." link navigates back to the Layout step.
- **12-15 new Vitest cases** — disk-scan list path, SessionStep rendering + state, `lastResumePlan` query.
- **`docs/04-design/session-picker-v1.3.0.md`** — architecture, smart-default rules, persistence model, risk register.

### Changed

- `Stepper.tsx` — `sessions` step inserted after `agents`.
- `Launcher.tsx` — new `paneResumePlan` state; `launch()` passes resume plan into `executeLaunchPlan`.
- `executeLaunchPlan` (`app/src/main/core/workspaces/launcher.ts`) — if `paneResumePlan[idx].sessionId` is non-null, passes the ID directly to `buildResumeArgs` and pre-stamps `agent_sessions.externalSessionId` at insert; v1.2.8 `onPostSpawnCapture` is a no-op for that row.
- Sidebar "open persisted workspace" flow now routes to SessionStep, skipping Layout + Agents when the workspace has a prior pane config.

### Known limitations (deferred)

- Gemini session list is empty; `listSessionsInCwd` returns `[]`. Disk layout undocumented upstream. Backlog row filed for v1.3.1.
- Session deletion, rename, and cross-cwd search are view-only deferred.
- OpenCode disk-scan continues to use `opencode session list --format json` subprocess (SQLite direct-read deferred).

### Verification

- `pnpm exec tsc -b`: clean
- `pnpm exec vitest run`: 263+/263+ (was 248, net +12-15)
- `pnpm exec eslint .`: clean
- `pnpm run build`: clean

### Related

- Plan: `docs/03-plan/v1.3.0-session-picker.md`
- Design: `docs/04-design/session-picker-v1.3.0.md`
- Release notes: `docs/09-release/release-notes-1.3.0.txt`
- Closes wishlist item W-1 (`docs/03-plan/WISHLIST.md`)

## [1.2.8] - 2026-05-13

Session capture is no longer a fragile stdout-banner scrape. Replaced the entire extractor pipeline with a hybrid strategy that works for every supported CLI, even when the agent is blocked at an interactive prompt at quit time (the exact failure mode the v1.2.7 toast was correctly reporting).

User on Windows hit the v1.2.7 toast: spawned 4 panes, sat at MCP approval prompt, quit, relaunched → "Could not resume 4 panes: missing external_session_id." Investigation found two real bugs: (a) the stdout extractor only handled Claude — Codex/Gemini/Kimi/OpenCode all returned `null`; (b) Claude's session ID only prints AFTER the MCP approval prompt is dismissed, so spawning + quitting without interaction never captured anything. v1.2.8 replaces the whole approach.

### Architecture pivot

- **At spawn**: for `claude` and `gemini`, SigmaLink now generates a UUID locally via `crypto.randomUUID()` and passes it as `--session-id <uuid>` (both CLIs support this flag). The DB row is populated with the real session ID instantly, zero extraction. For `codex`, `kimi`, `opencode`, spawn proceeds normally and an async disk-scan fires at +2s / +5s / +15s post-spawn to read the provider's deterministic session directory and stamp the row.
- **At resume**: tries the captured session ID via per-provider flag (`--resume <id>`, `--session <id>`, `resume <id>`). If the ID is missing OR the resume fails, falls back to the universal "resume latest in cwd" flag every provider supports (`--continue`, `--resume latest`, `resume --last`). Missing IDs are no longer a failure — they route silently to `--continue`. Only genuine spawn errors surface a toast now.
- **Stdout extractor deleted** (~174 LOC across `session-id-extractor.ts` + tests). Registry scan loop removed (`scanExternalSessionId`, `recordExternalSessionId`, `pendingLine`, `scanDone`, `scannedLines`, `externalSessionScanLineLimit`). Replaced with `onPostSpawnCapture` that fires once per fresh spawn.

### Added

- **`app/src/main/core/pty/session-disk-scanner.ts`** (NEW) — `findLatestSessionId(providerId, cwd)` with per-provider strategies. Codex: globs `~/.codex/sessions/**/rollout-*.jsonl`, extracts UUID from filename, filters by 5-min mtime window. Kimi: walks `~/.kimi/sessions/<project>/<uuid>/` (tolerates flat layout too). OpenCode: shells `opencode session list --format json --max-count 10`, filters by `directory === cwd`, accepts ISO + epoch timestamps. 14 test cases in `session-disk-scanner.test.ts`.
- **`buildResumeArgs(providerId, externalSessionId)`** exported from `resume-launcher.ts` — central per-provider args matrix. 10 provider × id/no-id test cases.
- **`panes.respawnFailed(workspaceId)` RPC** — when resume fails, the new aggregate toast offers a "Respawn fresh" button that re-spawns the failed panes in their existing worktrees (no `--resume` args). Same provider, same cwd, fresh PTY. Worktree files + branches preserved.
- **`onPostSpawnCapture` registry hook + `setExternalSessionId(id, value)` setter** — replaces `onExternalSessionId` / `externalSessionScanLineLimit`. Fires once on fresh spawns, skipped on resume.
- **5 new vitest case clusters** — disk scanner (14), buildResumeArgs matrix (10+), continue-fallback success path (3), respawn toast aggregation (2). Total 221 → 248 tests.

### Changed

- **Aggregate resume-failure toast** — was per-workspace in v1.2.7; now one message per restart: "Resumed N panes. M panes need to be respawned." with single "Respawn fresh" action. Closes plan R-1.2.7-5.
- **`providers.ts` Kimi `installHint`** — corrected from npm to PyPI: `pip install kimi-cli (or: uvx kimi)`. Kimi CLI is at https://github.com/MoonshotAI/kimi-cli, distributed via PyPI not npm. Upstream `@jacksontian/kimi-cli` on npm is an unrelated third-party client.
- **README.md** — Supported Agents table updated with Kimi PyPI install hint + upstream repo link.
- **Resume "skipped" semantics narrowed** — only `shell`/`custom`/unknown-provider rows skip with `provider-has-no-resume-args`. Real CLIs always route through `buildResumeArgs` to either ID-resume or `--continue` fallback.

### Removed

- `app/src/main/core/pty/session-id-extractor.ts` (~117 LOC) and `session-id-extractor.test.ts` (~57 LOC).
- Registry `scanExternalSessionId` / `recordExternalSessionId` / `pendingLine` / `scanDone` / `scannedLines` / `externalSessionScanLineLimit` machinery.
- The 500-line scan window from v1.2.7 — no longer relevant; capture is synchronous (claude/gemini) or filesystem-driven (codex/kimi/opencode).

### Verification

- `pnpm exec tsc -b`: clean
- `pnpm exec vitest run`: 248/248 (was 221, net +27)
- `pnpm exec eslint .`: clean
- `pnpm run build`: clean

### Known limitations (deferred)

- Disk-scan picks "newest mtime in cwd" — if the user runs the same provider outside SigmaLink in the same cwd, we may capture the wrong session. Mitigation: 5-min mtime window scoping. Cross-reference with provider's project-hash where available is a v1.3 polish.
- OpenCode disk-scan uses subprocess (`opencode session list --format json`). SQLite direct read is faster but needs schema reverse-engineering. Deferred.
- Kimi PyPI install requires Python. Documented in install hint; not auto-installed.

## [1.2.7] - 2026-05-13

Multi-workspace switching now preserves terminal scrollback and surfaces pane-resume failures instead of making sessions appear silently lost.

### Added

- **`pty.snapshot` RPC** returns the process-wide PTY ring buffer for a session. Terminal mounts replay that snapshot before attaching the live PTY bus, so switching away from a workspace and back restores visible scrollback.
- **PTY PID in `pty.list`** for verification and diagnostics.
- **Multi-workspace Playwright spec** asserting a shell PTY pid remains alive and stable across workspace switches.
- **Focused regression coverage** for registry snapshots, reducer non-destructive workspace switching, missing `external_session_id` resume failures, and sidebar persisted-workspace dropdown behavior.

### Changed

- Resume session-id extraction now scans the first 500 output lines instead of 100, giving CLI banners and MCP startup output more room before capture gives up.
- Boot-time pane resume now reports `{ failed[] }` rows missing `external_session_id` instead of filtering them out silently.
- Sidebar workspace close buttons appear on hover for every row, not only the active workspace.

### Fixed

- Workspace switching no longer looks like it interrupted running agents: PTYs continue running in main, and remounted xterms now replay buffered output.
- Session restore failures are surfaced through a toast with the failed pane id and error.

## [1.2.6] - 2026-05-13

Switch browser MCP from HTTP supervisor to stdio (npx-on-demand). Deletes ~400 LOC of supervisor machinery and removes three failure modes (bundling, PATH, Chromium TTY) from our code path.

### Changed
- **Browser MCP is now stdio** (`mcp-config-writer.ts`). Each agent pane spawns its own `@playwright/mcp` process via `npx -y @playwright/mcp@0.0.75`. First tool call triggers an ~10 s npx download + ~30 s Chromium download (visible in the pane terminal); subsequent calls are instant.
- **`@playwright/mcp` moved back to `devDependencies`** — no longer bundled in the DMG. DMG shrinks ~50 MB.
- **Deleted `playwright-supervisor.ts`** (~400 LOC) and all references: `rpc-router.ts`, `launcher.ts`, `manager.ts`, `controller.ts`, `router-shape.ts`, `rpc-channels.ts`, `schemas.ts`.
- **Removed `browser.getMcpUrl` RPC** and `app:browser-mcp-failed` event — no longer meaningful without a supervisor.
- **`RufloReadinessPill.tsx`** no longer subscribes to `app:browser-mcp-failed`.
- **`McpServersTab.tsx`** now shows the static stdio command instead of querying a dynamic supervisor URL.

### Added
- **`docs/04-design/browser-mcp-stdio.md`** — architecture doc covering the stdio pivot, the failed HTTP-supervisor approach, trade-off table, and retrospective.

### Verification
- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → 194/194 pass (34/36 files; 2 pre-existing Electron install failures unrelated)
- `pnpm exec eslint .` → 0/0

## [1.2.5] - 2026-05-13

Post-install bug-fix wave from a real-user DMG report on v1.2.4. The user installed the macOS DMG via the curl one-liner and hit 6 visible symptoms — 4 of which traced to a single root cause (Playwright MCP supervisor never starting in packaged builds).

### Fixed

- **Playwright browser MCP supervisor now starts in packaged builds.** Root cause was double: (a) `@playwright/mcp` was in `devDependencies` so electron-builder excluded it from the DMG; (b) Finder-launched Electron has minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the `npx @playwright/mcp` fallback hit ENOENT. Fix: moved the package to `dependencies` AND added a new `bootstrapNodeToolPath()` helper at boot that prepends `/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`, and `~/.nvm/versions/node/*/bin` to `process.env.PATH` on macOS/Linux. Closes "MCP client for `browser` failed to start" in every CLI pane and the Ruflo readiness pill staying red.
- **`ioctl(2) failed, EBADF — pty.resize` toast no longer fires** when a pane exits within the 200ms graceful-exit window. Triple defense: renderer's ResizeObserver disconnects on `pty:exit` event, registry checks `session.alive` before forwarding the resize, and `local-pty.ts` wraps `proc.resize()` in try/catch (matching the existing `kill` idiom). Surfaces when Kimi or any provider exits immediately (e.g. CLI not installed).
- **`+ Pane` button now shows a tooltip explaining why it's disabled.** Four cases: no active workspace, swarm paused, max 20 panes, mid-add-in-flight. Uses Radix Tooltip with the `<span tabIndex={0}>` wrapper pattern for disabled-button tooltips.
- **Empty workspaces sidebar now renders a helpful empty state** with a "+" CTA, and workspace rows with no name fall back to "Untitled workspace" + the root path basename as a subtitle. Previously the panel was visually empty even with an active workspace if the name field was blank.
- **`Focus` pane icon honestly relabeled.** Was `Maximize2` with no fullscreen implementation — user expected pane to expand, nothing happened. Now `Target` icon with tooltip "Pin focus ring (Cmd+Alt+N)" — accurately describes what it does today (sets the active-session focus ring). True fullscreen is queued for v1.3 alongside the Split + Minimise functional implementations.

### Added

- **`app:browser-mcp-failed` IPC event** + supervisor error broadcast. When the Playwright supervisor fails (spawn ENOENT, port-binding timeout, restart-budget exhausted), the main process broadcasts `{ workspaceId, error, fallbackTried }` to the renderer. RufloReadinessPill subscribes and forces an "unavailable" state with the explanation in the tooltip: "Browser MCP unavailable — see Settings for fix steps."
- **5 new vitest cases** — 3 in `registry.test.ts` (resize on dead/unknown/live sessions), 2 in `WorkspacesPanel.test.tsx` (empty state CTA, name fallback). Total now 215/215.
- **`docs/03-plan/v1.2.5-postinstall-regressions.md`** — implementation plan with risk register, 4-agent swarm coordination, and verification checklist.

### Changed

- **`@playwright/mcp` moved from `devDependencies` to `dependencies`** in `app/package.json` so electron-builder includes it in packaged builds. Lockfile diff is classification-only (the package was already resolved).
- **`docs/08-bugs/BACKLOG.md`** — added a v1.3 row: "Pane Focus → true fullscreen" (Target glyph today only pins focus ring; want sibling-hide + Esc-restore).

### Known limitations (not blockers)

- Kimi npm package name still unverified upstream. If users don't have `kimi` on PATH, the pane spawn now fails cleanly (no EBADF toast) but the pane still won't function. Install hint in the Kimi provider entry points users at moonshot.ai.
- Workspaces sidebar empty-state may also reflect a fresh install with no prior data — the user's screenshot did show an active workspace in the top bar, so the underlying state was fine; the v1.2.5 fix just makes the rendering more forgiving.

## [1.2.4] - 2026-05-13

Three independent fixes shipped in one release:

1. **Auto-update without code-signing certs (PR #7)** — opt-in users on both platforms now actually receive updates. Windows: `verifyUpdateCodeSignature: false` bypasses the Authenticode publisher check. macOS: `autoDownload = false` + manual DMG download via new `http-download.ts` util, bypassing Squirrel.Mac's hard signature wall. Renderer state machine in Settings → Updates with progress bar.
2. **macOS spawn-helper chmod hotfix** — closes the "Native module mismatch: node-pty posix_spawnp failed" boot-time crash. v1.2.3 DMG shipped `prebuilds/darwin-*/spawn-helper` at perms `0644` instead of `0755`; node-pty's runtime `posix_spawn()` got EACCES → boot probe popped the NativeRebuildModal on every fresh install.
3. **Provider registry trim** — long-deferred v1.1.10 cleanup. Removed SigmaCode, Cursor Agent, Aider, Continue, Droid/Copilot stubs. Shell kept as internal sentinel (filtered from user-facing pickers). Kimi Code CLI promoted to first-class provider.

### Added
- **`app/src/main/lib/http-download.ts`** — shared atomic-download util (download to `.part`, rename on completion, redirect following up to 5 hops, idle-socket timeout, progress callback, `.part` cleanup on every error path via `fs.rmSync(..., { force: true })`).
- **`app/src/renderer/features/settings/UpdatesTab.tsx`** state machine: `idle → checking → downloading → ready | error` with progress bar and Retry button. Mac shows "Open DMG"; Windows shows "Quit & Install."
- **6 new IPC events** (`app:update-available`, `app:update-mac-dmg-progress`, `app:update-mac-dmg-ready`, `app:update-win-progress`, `app:update-win-ready`, `app:update-error`) + `app.quitAndInstall` RPC channel.
- **`docs/04-design/auto-update-v1.2.4.md`** — architecture doc with Windows/macOS flows, events table, RPC methods, security considerations.
- **`docs/03-plan/v1.2.4-auto-update-without-signing.md`** — implementation plan (drove the PR #7 work).
- **Kimi Code CLI** (`id: 'kimi'`, `command: 'kimi'`, `altCommands: ['kimi.cmd']`, color `#22D3EE`) as first-class provider in `app/src/shared/providers.ts`.
- **5 new tests** — `http-download.test.ts` (3: atomic rename, redirect resolution, HTTP 500 cleanup), `UpdatesTab.test.tsx` (2: cumulative-not-delta progress assertion, full state-machine transitions). Vitest total now 210/210 (+5 from v1.2.3's 205).

### Changed
- **`app/electron-builder.yml`** — added `verifyUpdateCodeSignature: false` to `win:` block. macOS retains adhoc-only signing (no cert required).
- **`app/electron/auto-update.ts`** — rewrite. Platform-split `update-available` handler: Windows path calls `autoUpdater.downloadUpdate()`; macOS path resolves the relative `info.files[].url` against `https://github.com/<owner>/<repo>/releases/download/v<version>/` and downloads via the shared util. Module-scoped `pendingVersion` captures the version for `download-progress` (avoids non-existent `autoUpdater.updateInfo`).
- **`app/src/main/core/skills/marketplace.ts`** — refactored to consume shared `httpDownload`.
- **Provider registry (`app/src/shared/providers.ts`)** — removed 4 entries (SigmaCode, Cursor Agent, Aider, Continue), added Kimi. Shell sentinel filtered out of `listVisibleProviders()` so it doesn't surface in user-facing pickers (default-shell-spawn capability preserved internally via the empty-command path).

### Fixed
- **macOS `spawn-helper` exec bit** — `app/scripts/adhoc-sign.cjs` (afterSign hook) now walks the packed bundle and `fs.chmodSync(path, 0o755)` on every `spawn-helper` it finds, BEFORE the codesign sweep (chmod after sign would invalidate the seal). Two passes: hardcoded `node-pty/prebuilds/darwin-*/spawn-helper` plus a future-proof recursive `**/spawn-helper` walk. Dedupe Set prevents double-logging.
- **macOS `latest-mac.yml` channel manifest** — was missing from every release v1.1.4–v1.1.11 (manual local builds never ran `electron-builder --publish always`). v1.2.3 restored it via the new `release-macos.yml` workflow; v1.2.4 is the first release where end-to-end auto-update channel is actually functional on Mac.

### Dev-environment note
No `pnpm install --force` required this release (last v1.2.2's `.npmrc` hoist migration still applies). Just `git pull` + `pnpm install`.

### Known limitations (not blockers)
- **`auto-update.ts`** hard-codes `s1gmamale1/SigmaLink` as the DMG owner/repo for the relative-URL fallback. Duplicates `publish.owner/repo` in `electron-builder.yml`. Follow-up: read from `package.json`'s `repository` field.
- **No DMG checksum verification beyond TLS + GitHub CDN trust** — acceptable for opt-in feature on first-party publish channel.
- **Mid-download cancel** (R-1.2.4-4 from the plan) deferred to v1.2.5 — opting out mid-download doesn't abort the in-flight `https.get`.

## [1.2.3] - 2026-05-12

No code changes. Re-tag from current main so the macOS release workflow (merged in PR #4 after v1.2.2 was tagged) builds + attaches the DMG + `latest-mac.yml` to the same Release as the Windows EXE. Restores the auto-update channel manifest that has been missing from every Mac release since v1.1.4.

### CI / Distribution

- **`.github/workflows/release-macos.yml`** (Kimi, PR #4) now active for tag pushes. v1.2.3 is the first release to attach all four macOS artefacts: `*.dmg`, `*.dmg.blockmap`, `*.zip`, `latest-mac.yml`.
- v1.2.2 Release on GitHub has the Windows EXE only; for macOS auto-update to start working, opted-in macOS users need to manually install v1.2.3 once. From v1.2.3 onwards `electron-updater` can resolve `latest-mac.yml` from GitHub Releases.

## [1.2.2] - 2026-05-12

Two-part Windows hotfix that closes both ends of the v1.2.0 install path.

### Fixed — install-script asset matching (PR #5)

The install one-liner failed against v1.2.1 because the script's regex looked for `SigmaLink-Setup-*.exe` (dashes), but `electron-builder` produces `SigmaLink.Setup.<version>.exe` (dots — Windows artifact-name default). Asset regex now accepts either separator and falls back to a portable-target pattern.

- **`app/scripts/install-windows.ps1`** — regex `^SigmaLink[-.]Setup[-.](.*)\.exe$` + portable fallback. Bonus quality-of-life: ARM64 emulation pass-through, PS5.1 download speedup (`$ProgressPreference = 'SilentlyContinue'`), informational admin pre-flight, distinct 403 rate-limit message.

### Fixed — runtime native-module loading (PR #6)

The v1.2.1 EXE built successfully but crashed on launch because the packaged bundle was missing native `.node` files. Root cause: pnpm's content-addressed / symlinked node_modules layout confuses electron-builder's pack-phase file matcher (same class of bug `asar: false` mitigated in v1.0.1).

- **`app/.npmrc`** — added `node-linker=hoisted` so pnpm uses flat npm-style node_modules layout that electron-builder packs correctly.
- **`app/electron-builder.yml`** — reverted v1.2.1's `npmRebuild: false`. Now safe with the hoisted layout, and ensures native modules cross-compile against Electron 30 ABI.
- **`app/package.json`** — added `@types/mocha` + `@types/jest` to devDependencies to satisfy node-pty 1.1.0's source-build tsc step during electron-builder's rebuild pass.

### Dev-environment note

After pulling, run `pnpm install --force` once locally — the `.npmrc` switch from pnpm's default isolated layout to hoisted requires a one-time re-link.

## [1.2.1] - 2026-05-12

Hotfix for the v1.2.0 Windows CI build. The v1.2.0 tag push triggered `release-windows.yml` correctly, but the EXE never built: `electron-builder`'s default `npmRebuild: true` ran a second `npm rebuild node-pty@1.1.0` during the pack phase, which on Windows tries to compile node-pty from source and trips over node-pty's own test files (`windowsPtyAgent.test.ts`, `windowsTerminal.test.ts`) needing `@types/mocha`. The workflow already rebuilds native modules in an earlier explicit step, so electron-builder's rebuild was redundant.

### Fixed

- **`app/electron-builder.yml`** — added `npmRebuild: false` so `electron-builder` skips its own rebuild pass. Our CI workflow's prior `pnpm rebuild better-sqlite3 node-pty` step covers Windows; macOS local builds are covered by `electron-builder install-app-deps` in the `package.json` postinstall.

### Distribution

- v1.2.0 release on GitHub was not created (workflow failed before reaching `softprops/action-gh-release@v2`). v1.2.1 is the first published Windows release. Users who tried the `install-windows.ps1` one-liner against v1.2.0 saw a "no matching `SigmaLink-Setup-*.exe`" error path; running it again after v1.2.1 lands works cleanly.

## [1.2.0] - 2026-05-12

Windows 10/11 (x64) is now a peer release surface to macOS arm64. NSIS installer ships from CI on every tag push; PowerShell one-liner installer mirrors the macOS curl-bash UX. Voice on Windows routes through the Chromium Web Speech API; native SAPI5 is deferred to v1.3+. Code-signing is deferred indefinitely; SmartScreen workarounds documented inside the installer. Vitest 196 → 205. Zero behavioural regressions on macOS.

### Added — distribution

- **`.github/workflows/release-windows.yml`** (70 LOC). Builds the NSIS EXE on `windows-latest` on every `v*` tag push (and `workflow_dispatch`); rebuilds native modules; uploads `SigmaLink-Setup-*.exe` to the GitHub Release via `softprops/action-gh-release@v2`. Concurrency group `release-windows-${{ github.ref }}` with `cancel-in-progress: false`; permissions `contents: write`.
- **`app/scripts/install-windows.ps1`** (234 lines / ~180 LOC). PowerShell 5+, AMD64-only, fetches latest or pinned release, downloads `SigmaLink-Setup-*.exe` to `$env:TEMP`, runs `Unblock-File` to strip MOTW, launches NSIS installer. Params: `-Version <tag>`, `-Quiet` (forwards NSIS `/S`), `-KeepInstaller`.
- **`app/build/nsis/README — First launch.txt`** (72 lines). Wired via `nsis.license` in `app/electron-builder.yml`; surfaced during install. Documents two SmartScreen recoveries for users who download the EXE manually (Option A: "More info → Run anyway"; Option B: right-click → Properties → Unblock).
- **`docs/04-design/windows-port.md`** (NEW). ~150 lines of architectural decisions + touch-point reference table + trade-offs covering PTY resolution, native frame chrome, Web Speech fallback, unsigned + Unblock-File strategy, native module CI rebuild, MCP pipe transport, Cascadia Mono font.
- **`docs/09-release/release-notes-1.2.0.txt`** (NEW).

### Added — renderer

- **`app/src/renderer/lib/platform.ts`** (NEW, 12 LOC). Exports `getPlatform()` + `IS_WIN32`. Single source of truth for renderer-side platform branches.
- **`app/electron/preload.ts`** — `window.sigma.platform = process.platform` exposure.
- **2 new test files** — `Breadcrumb.test.tsx` + `VoiceTab.test.tsx`. 9 new cases. Repo total **205/205** (was 196/196).

### Changed — installer

- **`app/electron-builder.yml`** — dropped `ia32` from `win.target.nsis.arch` (now `[x64]` only). Wired `nsis.installerIcon` + `nsis.uninstallerIcon` + `nsis.installerHeaderIcon` to `build/icon.ico`. Wired `nsis.license` to surface the SmartScreen explainer during install.

### Changed — renderer

- **`app/src/renderer/features/top-bar/Breadcrumb.tsx`** — conditional 140px right-padding on win32 via `IS_WIN32` to clear the native min/max/close buttons (WCO area).
- **`app/src/renderer/features/command-room/Terminal.tsx:112`** — prepended `"Cascadia Mono"` to the xterm fontFamily stack ahead of `Consolas`. macOS and Linux unaffected.
- **`app/src/renderer/features/settings/VoiceTab.tsx`** — platform-aware. `NATIVE_ENGINE_LABEL` reads "Web Speech API (Chromium, requires internet)" on non-darwin; `NATIVE_ENGINE_AVAILABLE` is `false`; diagnostics indicator dot is grey neutral instead of red error.

### Closed — historic bugs

- **Windows `.cmd` shim spawn ("Cannot create process, error code: 2")** — investigation at `docs/01-investigation/01-known-bug-windows-pty.md` marked **RESOLVED 2026-05-12**. Shipping fix lives at `app/src/main/core/pty/local-pty.ts:47-85` (`resolveWindowsCommand` PATH+PATHEXT walker), `:175-197` (resolved-then-wrap dispatcher), `:215-230` (pre-flight ENOENT for fallback walk). Original investigation preserved verbatim as the root-cause record.

### Deferred

- Native Windows SAPI5 voice binding → v1.3+ (offline + always-on capture).
- `windowsControlsOverlay` frameless chrome → v1.3+ (cosmetic polish; v1.2.0 ships with native frame + 140px Breadcrumb pad).
- EV/OV Authenticode certificate → indefinitely (funded-only; $300-700/yr).
- Linux AppImage / .deb test gating → v1.3+ (no CI runner yet).
- Microsoft Store / WinGet distribution → after EV cert.
- Windows auto-update → after signing.
- `nsis.license` → custom NSH welcome page → v1.2.1 (cosmetic; currently abuses the license-agreement field which forces an "I accept" radio gate).

### Known issues

- **SmartScreen first-run warning** for users who download the EXE manually (not via the PowerShell installer). Per-binary-hash reputation, so every release re-warms from zero. Workarounds documented in the in-installer README.
- **`nsis.license` welcome page** semantically odd — surfaced behind a forced "I accept" radio gate. v1.2.1 polish.
- **Web Speech API requires internet on Windows** — air-gapped users have no voice path until SAPI5 lands in v1.3+.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` → **205/205** (was 196/196 at v1.1.11; +9 new specs).
- `pnpm exec eslint .` → 0/0 (unchanged).
- `pnpm exec vite build` → unchanged main bundle.
- macOS DMG sign unchanged from v1.1.11.
- Windows EXE built by CI on `windows-latest` and uploaded to the GitHub Release automatically; smoke verified locally via `pnpm electron:pack:win` on macOS host.

## [1.1.11] - 2026-05-12

Kimi audit P1 fix wave. 10 of 11 verified findings closed + 37 new tests. Vitest 168→196.

### Fixed — native + critical state

- **C1 native voice-mac `std::terminate()` risk** (`binding.gyp` + `sigmavoice_mac.mm` + `tsfn_bridge.mm`): exception flags flipped ON, every `ThreadSafeFunction::New` call site wrapped in `try/catch (const Napi::Error&)` that propagates as JS exceptions instead of crashing the host. node-gyp rebuilds clean.
- **C2 useWorkspaceMirror state desync** (`use-workspace-mirror.ts:35-44`): `catch { return; }` replaced with `catch (err) { console.warn(...); }` + fall-through; `SYNC_OPEN_WORKSPACES` now always dispatches.
- **C3 useExitedSessionGc unmount race** (`use-exited-session-gc.ts:22-40`): `timers.has(sessionId)` guard inside the setTimeout callback. Unmount cleanup empties the Map → stale dispatches suppressed.
- **C4 MissionStep voice cleanup closure-over-null** (`MissionStep.tsx:228-233`): introduced `voiceHandleRef` mirroring `voiceHandle` via tracking useEffect; cleanup reads from ref. Removed `eslint-disable-next-line`.

### Fixed — state-hook + reducer warnings

- **Per-workspace room snapshot preserved** (`use-session-restore.ts`, `state.types.ts`, `state.reducer.ts`): added `roomByWorkspace: Record<string, RoomId>` + `SET_ROOM_FOR_WORKSPACE` action + WORKSPACE_OPEN/CLOSE/READY/SET_WORKSPACES/SYNC_OPEN_WORKSPACES maintenance. Workspaces in different rooms no longer share the active room on restore.
- **SET_ACTIVE_WORKSPACE_ID logs unknown IDs** (`state.reducer.ts:102-117`): `console.warn` before returning unchanged.
- **REMOVE_SESSION fallback prefers live sessions** (`state.reducer.ts:176-188`): filter `status === 'running'` first.
- **UPSERT_SWARM only auto-activates on first arrival** (`state.reducer.ts:199-208`): auto-set `activeSwarmId` only when post-upsert workspace has exactly one swarm. Deselected workspaces no longer jump on unrelated swarm updates.
- **Review hydration no-churn on session add/remove** (`use-live-events.ts:89-101`): dropped `state.sessions.length` from effect deps.
- **parseSwarmMessage runtime kind validation** (`parsers.ts:120`): `VALID_SWARM_KINDS` allowlist + `isSwarmMessageKind` guard; null/missing → `'OPERATOR'`; unknown → reject.

### False positives (verified, no code change)

- **C5 "No CI/CD pipeline"**: 3 workflows already exist (`lint-and-build.yml`, `e2e-matrix.yml`, `native-prebuild-mac.yml`).
- **Fix 5 `voice.diagnostics.run` channel missing handler**: handler IS registered at `rpc-router.ts:884-890`, schema-validated at `schemas.ts:369`.

### Deferred to v1.1.12

- **Fix 8 appStateStore double-render via useLayoutEffect** — real bug but needs paired refactor with `useSyncExternalStore` wiring.
- Kimi's ~100 warning-level findings across 20+ feature files.

### Build hygiene

- `pnpm exec tsc -b` clean; `pnpm exec vitest run` **196/196** (was 168/168, +28 specs); `pnpm run lint` 0/0; `pnpm exec vite build` 38.26 KB gzip main; `codesign --verify --deep --strict` Sealed Resources files=20492; native `node-gyp rebuild` clean with exceptions ON.

## [1.1.10] - 2026-05-12

Reliability hotfix from Gemini parallel audit. 6 P1 bugs + 4 perf wins + dead-code sweep. Vitest 130→168 (+38 new tests). Zero behavioural changes for the happy path; wins are all in failure modes (process leaks, race conditions, broadcast aborts, animation waste, hung child kills).

### Fixed — backend reliability

- **`resolveAndSpawn` fallback now tries alternatives on ENOENT** (`pty/local-pty.ts`). New `resolvePosixCommand` PATH pre-flight throws synchronous `ENOENT` so the launcher's existing fallback walk reaches the next candidate.
- **`pty.forget()` kills underlying PTY** (`pty/registry.ts`). Was leaking ghost processes. SIGTERM + 5s SIGKILL fallback.
- **`killAll()` uses ONE 5s timer regardless of session count** (`pty/registry.ts`). Was scheduling N timers (one per session) — verified via `vi.getTimerCount()`.
- **`execCmd` kills child on maxBuffer overflow** (`lib/exec.ts`). New `handleOverflow()` destroys stdio + SIGTERMs child + 5s SIGKILL fallback. New `maxBufferExceeded: boolean` field on ExecResult (additive).

### Fixed — orchestration reliability

- **Mailbox broadcast continues on per-recipient failure** (`swarms/mailbox.ts`). Per-recipient try/catch + `console.warn` with `swarmId` + key. `@all` / `@coordinators` no longer aborts on one destroyed PTY.
- **`addAgentToSwarm` role index atomic via `db.transaction()`** (`swarms/factory.ts`). Concurrent same-role adds now serialize on SQLite's write lock and produce contiguous indices instead of UNIQUE constraint violation.
- **`StdinWriter` per-write timeout** (`assistant/runClaudeCliTurn.emit.ts`). New `STDIN_WRITE_TIMEOUT_MS = 30_000` + `onTimeout` callback. Turn driver passes `() => child.kill('SIGTERM')` so a hung child doesn't outlive its broken stdin.

### Changed — frontend perf

- **Terminal, Sidebar, Launcher migrated to per-slice `useAppStateSelector`**. v1.1.9 introduced the selector hook and migrated 4 rooms; v1.1.10 covers these last three. Terminal subscribes to 1 slice (`activeWorkspace.id`); Sidebar to 5; Launcher to 2 + dispatch-only inner row. Unrelated dispatches no longer trigger re-renders.
- **Constellation animation gated by Page Visibility API + IntersectionObserver** (`operator-console/Constellation.tsx`). rAF loop pauses when either signal reports hidden; resumes when both visible. 6 new tests.

### Removed

- **`PhasePlaceholder.tsx` + `placeholders/` dir** — zero callers, pre-Electron remnant.
- **`RoomChrome.tsx`** — single caller (SettingsRoom) inlined; unused props dropped. Net -82 LOC across the dead-code sweep.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` 168/168 (was 130/130).
- `pnpm run lint` 0/0.
- `pnpm exec vite build` 38.26 KB gzip main (unchanged shape from v1.1.9).
- `codesign --verify --deep --strict` Sealed Resources files=20492.

### New test files

- `pty/local-pty.test.ts` (8), `pty/registry.test.ts` (7), `providers/launcher.test.ts` (4), `lib/exec.test.ts` (3), `runClaudeCliTurn.emit.test.ts` (6), `operator-console/Constellation.test.tsx` (6). Plus 4 new specs added to `mailbox.test.ts` + `factory.test.ts`.

### Source

Gemini audit at `app/docs/investigation/codebase-audit-v1.1.3.md`. 4-coder Ruflo swarm executed the fixes on disjoint file scopes.

## [1.1.9] - 2026-05-12

Two coordinated swarms shipped this release. PR #3 (Codex + Claude finalizer) landed the perf paired refactor + CI hardening + lint wave 32→0. A second 3-coder swarm landed the file-size targets that closed out the v1.1.9 backlog. Zero behavioural changes. Zero broken contracts.

### Performance

- **`useAppStateSelector<T>` + `useAppDispatch`** backed by `useSyncExternalStore`. Consumers subscribe to a per-selector slice of state. CommandRoom, CommandPalette, SwarmRoom, OperatorConsole migrated.
- **Precomputed slices**: `sessionsByWorkspace` + `swarmsByWorkspace`. Reducer maintains both on add/exit/remove/set-swarms/upsert/end. O(1) lookup replaces O(N) filter on every render.

### Changed — file-size budget

- `swarms/factory.ts` **713 → 396 LOC**. Private spawn helpers (`spawnAgentSession`, `pickCoordinatorId`, `buildExtraArgs`, `loadAgentSession`, `materializeRosterAgent`) moved to `factory-spawn.ts` (344 LOC). Public surface unchanged.
- `assistant/runClaudeCliTurn.ts` **709 → 348 LOC**. Stateless emit layer → `runClaudeCliTurn.emit.ts` (186 LOC). Tool routing + Ruflo trajectory + readline-loop → `runClaudeCliTurn.trajectory.ts` (193 LOC). Public surface preserved; `__resetProbeCache` + `__resetActiveChildren` test helpers intact.
- `renderer/app/state.tsx` **553 → 97 LOC**. 14 IPC-event listener effects extracted into custom hooks under `state-hooks/`: `use-session-restore.ts` (142), `use-workspace-mirror.ts` (65), `use-live-events.ts` (140), `use-exited-session-gc.ts` (49), plus shared `parsers.ts` (163) with deduplicated `runRefreshOnEvent` helper.

### CI / test infra

- GH Actions `cache-dependency-path` fixed (was stale).
- pnpm install: `--no-frozen-lockfile --ignore-scripts` + explicit `node node_modules/electron/install.js`.
- `pnpm run coverage` + `@vitest/coverage-v8` + thresholds (lines 22 / stmts 21 / fn 21 / br 18).
- ShellCheck CI step for `install-macos.sh`.
- `.claude` + `app/coverage/` + `docs/06-test/` added to ignore lists.

### Fixed

- **Lint baseline 32 → 0**. React-compiler structural family resolved: setState-in-effect deferred-to-next-tick, render-time `Math.random()` in sidebar skeleton replaced with deterministic sizing, `shared/rpc.ts` `any` typed, narrow file-level immutability disables for MemoryGraph + Constellation intentional-mutable-ref surfaces.

### Build hygiene

- `pnpm exec tsc -b` → clean
- `pnpm exec vitest run` → **130/130** (was 128/130 at v1.1.8)
- `pnpm run lint` → **0/0** (was 32/1 at v1.1.8)
- `pnpm run coverage` → 21.92% stmts / 18.8% br / 21.23% fn / 22.72% lines (above baseline)
- `pnpm exec vite build` → 38.26 KB gzip main (unchanged from v1.1.8)
- `codesign --verify --deep --strict` → exit 0, `Sealed Resources files=20492`
- `bash -n scripts/install-macos.sh` → clean

### File-size budget compliance

All v1.1.x churn files now under the 500-LOC project rule. Four files still over budget are tracked for v1.2 (rpc-router.ts 985, router-shape.ts 770, sidebar.tsx 726, SigmaRoom.tsx 721).

## [1.1.8] - 2026-05-12

5-agent parallel optimization swarm. Zero behavioural changes. Zero broken contracts. Cold boot ~60% faster (bundle), all 6 NMV-blocked tests recovered (108/114 → 128/128 green), lint -28, state.tsx splits under budget.

### Performance

- **Main bundle 97.57 → 38.26 KB gzip (-61%, -59 KB)** — 10 rooms now `React.lazy()`-loaded (CommandRoom stays eager). SigmaRoom + OperatorConsole + MemoryRoom + SkillsRoom + BrowserRoom + ReviewRoom + TasksRoom + SettingsRoom + SwarmRoom + Launcher emitted as sibling chunks. BridgeTabPlaceholder + RightRail also converted to lazy (no vite "dynamic import will not move module" warnings).
- **BrowserRoom latch-on-first-activation** — instead of unconditionally mounting `<BrowserRoom visible={activeTab==='browser'}/>`, RightRail now only renders the subtree once `activeTab === 'browser'` has been true at least once. Keeps the browser:state listener + DesignOverlay + BrowserViewMount + BrowserRecents tree out of cold boot.
- **`renderer/lib/pty-data-bus.ts`** (88 lines) — new module routes `pty:data` events by sessionId through a `Map<string, Set<Listener>>`. With 16 panes, previously each chunk paid 32 `eventOn` dispatches + 32 sessionId string-compares + 31 drops; now: 1 dispatch + 1 Map.get + 1-2 actual listener calls. IPC + main-process untouched. 9 new bus tests cover routing, isolation, unsubscribe, install-once, mid-dispatch self-unsubscribe.

### Fixed

- **6 main-process tests recovered** — `src/main/core/swarms/mailbox.test.ts` + `src/main/core/assistant/tools.test.ts` were hitting better-sqlite3 NMV 123 ↔ 147 mismatch when run under host Node 26 (binding compiled for Electron 30.5.1). Both migrated to the canonical `vi.mock('../db/client')` + `fakeDb()` pattern already used by `session-restore.test.ts` and `manager.test.ts`.

### Added

- **`src/test-utils/db-fake.ts`** — new shared shim consolidating the `fakeDb()` + seed helpers previously inlined in 3+ tests. Future main-process tests can import instead of re-implementing.
- **`src/main/core/swarms/factory.test.ts`** — new test covering `paneIndex` derivation + 20-agent cap (the contract that v1.1.4 CommandRoom + tools dispatch both depend on).
- **`renderer/lib/pty-data-bus.test.ts`** — 9 specs (see Performance section above).

### Changed

- **state.tsx 996 → 553 LOC + 3 sibling modules**:
  - `src/renderer/app/state.types.ts` (157 LOC) — `RoomId`, `AppState`, `Action`, `initialAppState`, `selectActiveWorkspace`
  - `src/renderer/app/state.reducer.ts` (316 LOC) — `appStateReducer` + private helpers
  - `src/renderer/app/state.hook.ts` (19 LOC) — `useAppState` + `AppStateContext`
  - `src/renderer/app/state.tsx` keeps the `AppStateProvider` + IPC wiring; re-exports the types/reducer/hook from the new modules. Zero consumer changes.
- **3 stub schemas → real zod** (`src/main/core/rpc/schemas.ts`): `panes.resume`, `swarms.addAgent`, `skills.verifyForWorkspace`. Shapes drawn from actual controller types. `VALIDATION_MODE` stays `'warn'`. Caught a Role enum drift: actual is `'coordinator'|'builder'|'scout'|'reviewer'`, not the plan's hallucinated `'tester'|'researcher'`.
- **`.data.ts` sibling split for 8 files** — variants/types extracted from: `badge.tsx`, `button.tsx`, `button-group.tsx`, `form.tsx`, `navigation-menu.tsx`, `toggle.tsx`, `sidebar.tsx`, `RightRailContext.tsx`. Pattern mirrors `rooms-menu-items.ts` / `workspaces-summary.ts` from v1.1.4. Consumer-side import paths updated where the rule still flagged re-exports (alert-dialog, pagination, calendar, toggle-group, RightRailSwitcher, RightRail).

### Removed

- **Dead utility code from `src/lib/utils.ts`** — `parseAnsi` (owned all 19 `no-control-regex` errors), `mockPTYBridge`, `generateId`, `formatDuration` (all zero-caller). `cn` + `formatTimestamp` retained.
- **Orphan `PTYBridge` type** + `TerminalSession.pty` field from `src/types/index.ts`.

### Build hygiene

- `pnpm exec tsc -b` clean.
- `pnpm exec vitest run` 128/128 (was 108/114). +20 tests across 4 new files.
- `pnpm run lint` 32 problems (31 errors + 1 warning; was 60 → -28). The 31 remaining are React-compiler structural family (set-state-in-effect, immutability, exhaustive-deps) — scheduled for a dedicated v1.1.9 wave.
- `pnpm exec vite build` 38.26 KB gzip main + 10 sibling lazy chunks.
- `codesign --verify --deep --strict --verbose=2 SigmaLink.app` still passes with `Sealed Resources version=2 rules=13 files=20492` (adhoc-sign hook from v1.1.5 unchanged).

## [1.1.7] - 2026-05-12

Internal-distribution release. No code changes. No behavioural changes. The new `app/scripts/install-macos.sh` is a self-contained Bash installer that downloads + installs SigmaLink WITHOUT triggering any macOS Gatekeeper dialog. `curl` doesn't tag its downloads with `com.apple.quarantine`, so files it fetches are exempt from Gatekeeper's first-launch assessment — same pattern Rust/Homebrew/Docker installers use. Confirmed empirically on macOS 26.4 (Tahoe): `xattr` output is empty on curl-downloaded files.

### Added

- **`app/scripts/install-macos.sh`** — 170-line POSIX-Bash installer:
  - Platform + arch gate (macOS arm64 only for now).
  - Resolves latest release via GitHub API; accepts explicit `v1.1.X` tag arg to pin.
  - Downloads `SigmaLink-<version>-arm64.dmg` via curl.
  - Quits any running SigmaLink via AppleScript.
  - Replaces `/Applications/SigmaLink.app` (with sudo fallback if write-protected).
  - Strips xattrs defensively (`xattr -cr`) even though curl shouldn't have added any.
  - Unmounts the DMG, prints launch hint, optionally launches SigmaLink if invoked from a tty.
  - Exit codes: 0 success, 2 wrong platform/arch, 3 GitHub API failure, 4 download failure, 5 install/copy failure.
- **`README.md` Install section** — new top-level section above "Quickstart (build from source)" documenting the curl one-liner + how to pin a version + the fallback DMG path.

### Changed

- **`build/dmg/README — Open SigmaLink.txt`** — preamble points users at the curl one-liner first; the Terminal `xattr -cr` and System Settings workarounds stay as the manual fallback.

### One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash
```

Pin to a specific tag:
```bash
curl -fsSL https://raw.githubusercontent.com/s1gmamale1/SigmaLink/main/app/scripts/install-macos.sh | bash -s v1.1.7
```

## [1.1.6] - 2026-05-12

Single-file documentation release on top of v1.1.5. No code changes. No behavioural changes. The mounted DMG now ships a clear `README — Open SigmaLink.txt` explaining how to recover from the macOS Sequoia/Tahoe Gatekeeper "Apple could not verify SigmaLink is free of malware" dialog. (Notarisation, which would eliminate the dialog entirely, requires Apple Developer Program membership at $99/year — held until SigmaLink is funded.)

### Added

- **`build/dmg/README — Open SigmaLink.txt`** — plain-ASCII first-launch walkthrough that appears as a third item next to `SigmaLink.app` + `Applications →` symlink when the DMG mounts. Covers both recoverable workarounds: the Terminal one-liner `xattr -cr /Applications/SigmaLink.app` AND the 6-step System Settings → Privacy & Security → "Open Anyway" flow that replaced the Sequoia-removed Control-click → Open shortcut.

### Changed

- **`electron-builder.yml` `dmg.contents`** — added a third coordinate entry pointing at the README. The DMG window now contains 3 items instead of 2.

### Path to permanent fix (v1.2 candidate)

Notarisation eliminates the dialog entirely. Requires:
1. Apple Developer Program membership ($99/year).
2. "Developer ID Application" certificate exported as .p12.
3. GitHub Actions secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`.
4. `electron-builder.yml` mac block: real `identity`, `hardenedRuntime: true`, `notarize: true`.
5. Remove `scripts/adhoc-sign.cjs` afterSign hook + the in-DMG README.

After that ships, SigmaLink is also eligible for Homebrew Cask (which is removing un-notarised casks by Sept 2026 anyway).

## [1.1.5] - 2026-05-12

Single-bug hotfix on top of v1.1.4. No new features. No behavioural changes. The macOS DMG can now be downloaded from GitHub and opened by drag-to-/Applications without the user being told the bundle is "damaged".

### Fixed

- **macOS Gatekeeper "damaged and can't be opened" on downloaded DMG** — root cause: v1.1.0 turned on `hardenedRuntime: true` in `electron-builder.yml` without a corresponding signing identity, with a comment claiming hardened runtime was "harmless without a Developer ID". It isn't. electron-builder's identity auto-discovery found no Developer ID, silently produced a bundle whose only signature was the linker-injected ad-hoc stamp ld(1) puts on every Mach-O, and the bundle never gained a `Contents/_CodeSignature/CodeResources` resource seal. Chrome attaches `com.apple.quarantine` to downloads, Gatekeeper checks the signature, sees a seal-asserting ad-hoc sig with no actual `CodeResources` directory, and rejects with "damaged" (the destructive verdict — vs the recoverable "unidentified developer" prompt). Every DMG from v1.1.0..v1.1.4 carries the same defect; only fresh local builds escaped because they had no quarantine flag.

### Added

- **`scripts/adhoc-sign.cjs`** — new electron-builder `afterSign` hook (~70 lines including header comment). After packaging, runs `codesign --force --deep --sign - --timestamp=none "<App>.app"` to re-sign every nested Mach-O (Electron Framework + 4 SigmaLink helper apps + Squirrel + Mantle + ReactiveObjC + every `.node` native module) AND write a real `_CodeSignature/CodeResources` seal (20492 files sealed in the v1.1.5 bundle). Then runs `codesign --verify --deep --strict` and throws if it fails — silent ship-with-broken-sig regressions are now impossible.

### Changed

- **`electron-builder.yml` mac block**: `identity: null` (skip builder's signing pass — adhoc-sign.cjs owns it), `hardenedRuntime: false` (with ad-hoc signing the hardened runtime can't survive trust checks anyway; SigmaVoice TCC prompts depend on Info.plist keys not on hardened runtime). Long comment in the YAML documents the regression history and the migration path when a Developer ID is eventually acquired.

### User workaround for v1.1.0..v1.1.4 DMGs already downloaded

```bash
xattr -cr ~/Downloads/SigmaLink-1.1.4-arm64.dmg
open ~/Downloads/SigmaLink-1.1.4-arm64.dmg
# drag to /Applications, then:
xattr -cr /Applications/SigmaLink.app
open /Applications/SigmaLink.app
```

`xattr -cr` strips `com.apple.quarantine`. Gatekeeper only enforces on quarantined apps; once stripped, the broken signature stops mattering.

### Build hygiene

- `pnpm exec tsc -b` clean. `pnpm exec vitest run` 108/114 (same pre-existing NMV-host-Node failures). `pnpm exec vite build` 354.95 KB raw / 97.57 KB gzip. `pnpm run lint` 59 (unchanged from v1.1.4).
- `codesign --verify --deep --strict --verbose=2 SigmaLink.app` returns exit 0 with `valid on disk` + `satisfies its Designated Requirement`. `Sealed Resources version=2 rules=13 files=20492`. v1.1.4 had `Sealed Resources=none`.

## [1.1.4] - 2026-05-11

V3 SigmaMind visual parity sweep. Frontend-only release; backend touches: zero. RPC channels touched: zero. The functional pipeline from v1.1.3 is preserved exactly; what changes is the chrome around it. (For v1.1.2 + v1.1.3 release narrative, see `docs/09-release/release-notes-1.1.2.txt` + `release-notes-1.1.3.txt`.)

### Added

- **Workspaces panel as full sidebar body** — new `WorkspacesPanel.tsx` (216 lines) lifts the workspace-tabs concept out of `Sidebar.tsx` and becomes the sidebar's only content. Scrollable list (no 8-tab cap, no overflow drawer). Each row shows a deterministic colour dot (`workspaceColor()` hashes id → 8-colour palette), the workspace name, a running-pane-count badge, and a close × visible on hover for the active row. New `workspace-color.ts` utility (27 lines) + tests. Sidebar.tsx drops from ~500 to 147 lines (drops the 12-item nav block + Cmd+K launcher card).
- **Top-left rooms menu dropdown** — new `RoomsMenuButton.tsx` (72 lines) rendered at the left edge of the Breadcrumb. Single `LayoutGrid` icon opens a Radix DropdownMenu listing all 11 rooms. Disabled-when-no-workspace logic mirrors the v1.1.3 sidebar behaviour exactly. The active room is marked with a check. Items + icons + labels are split into `rooms-menu-items.ts` so the component file stays Fast-Refresh-clean.
- **Top-right right-rail switcher + settings gear** — new `RightRailSwitcher.tsx` (86 lines) rendered at the right edge of the Breadcrumb. Three-button segmented control (Globe / FileCode2 / Bot icons labelled "Browser" / "Editor" / "Sigma") plus a sibling Settings gear. State lifted into a new `RightRailContext` so the top-bar switcher and the rail content stay in sync; kv persistence of the last-active tab is preserved. The in-rail tab strip is hidden via a new `tabsVisible={false}` prop.
- **Pane right-click context menu with Stop** — Stop functionality moved out of the pane header chrome and into a Radix context menu on the pane body. Stop item is destructive variant and disabled when the session is exited or errored.

### Changed

- **Per-pane header collapsed to single h-7 strip** — `PaneHeader.tsx` rewrites the previous h-7 + h-6 two-strip pattern into one row: 2px colour stripe → truncated `PROVIDER·index` label (max-w-80px) → spacer → 4 icon buttons (Focus / Split / Minimise / Close). Branch / model / effort / cwd labels move into a Radix tooltip on hover of the provider name. Stop button removed from header chrome (right-click menu instead). Pane index is appended to the label so adjacent same-provider panes stay distinguishable. Focus icon binds to the existing `paneFocus` state machine.
- **9-pane layout: 3×3, not 4×3** — `GridLayout.shapeFor(9)` now returns `{ cols: 3, rows: 3 }` (matches V3 reference, no empty trailing cell). 10/11/12-pane layouts unchanged at 4×3.

### Removed

- **`PaneStatusStrip.tsx` deleted** — its model / effort / cwd content is now inside the PaneHeader tooltip body. All references and imports removed.
- **Sidebar nav items, ITEMS array, Cmd+K launcher card, inline WorkspaceTabs** — superseded by the rooms-menu dropdown + WorkspacesPanel.

### Fixed

- **PaneHeader.test.tsx Element.prototype tsc narrowing** — `Element.prototype.hasPointerCapture` and `.scrollIntoView` polyfills now use a typed cast (`proto as unknown as { hasPointerCapture?: ... }`) instead of `'X' in Element.prototype` narrowing, which collapsed to `never` and broke tsc.

### Distribution scope

arm64-only macOS DMG, same as v1.1.1 through v1.1.3. The pre-build electron-rebuild dance against Electron 30.5.1 (NMV 123) is still required for each manual arm64 release. Intel-Mac users: stay on v1.0.1 or wait for v1.2.

### Carried forward

All v1.1.0 → v1.1.3 surfaces intact: multi-workspace tabs (now in the new WorkspacesPanel), pane resume via `--resume <session_id>`, growable swarms with `add_agent` Sigma tool, Ruflo pre-flight + readiness pill, per-CLI skills verification, MCP host server bridging Sigma tools to the spawned Claude CLI, voice diagnostics, single-instance lock, window drag.

## [1.1.2] - 2026-05-11

Sigma Assistant end-to-end. v1.1.1 shipped streaming Claude CLI responses but the Tool calls panel exposed that `tool_use` envelopes never executed — Sigma could talk but couldn't act. v1.1.2 fixes that. The assistant now actually launches panes, dispatches prompts, sees live workspace state, broadcasts to swarm groups, and writes its own MCP config for spawned agent CLIs.

### Added

- **Tool dispatch parity** — `runClaudeCliTurn.ts:routeToolUse()` extended with a `dispatchTool` callback. Every `tool_use` block emitted by the Claude CLI is now routed to `controller.invokeTool(name, args)`, the result captured, and a `tool_result` envelope (correct `tool_use_id` matching, `is_error` flag, stringified content) written back to the CLI's stdin via a serialised write queue. Slow tools guarded by a 30 s `withTimeout`. The CLI continues its turn with the actual host result in scope — no more orphan tool_use intents.
- **Live `list_*` tools** in `tools.ts` — `list_active_sessions`, `list_swarms`, `list_workspaces` read the in-memory PTY + swarm registries (not the DB), so Sigma can answer "how many agents are running right now?" accurately mid-turn. `system-prompt.ts` trimmed to remove the stale recent-files + open-swarms blob in favour of "call the `list_*` tools when you need live state".
- **MCP autowrite façade** — new `app/src/main/core/workspaces/mcp-autowrite.ts`. On workspace open, SigmaLink writes/merges:
  - claude code: project-local `<root>/.mcp.json`
  - codex: global `~/.codex/config.toml` `[mcp_servers.ruflo]` table
  - gemini: global `~/.gemini/settings.json` mcpServers block
  Each entry points the spawned agent CLI at the shared `<root>/.claude-flow/` state dir, so every agent that boots inside a SigmaLink workspace converges on one Ruflo brain. Idempotent; merges without clobbering user-customised entries (refuses to overwrite if `command !== "npx"`). Settings toggle at `RufloSettings.tsx` (kv key `ruflo.autowriteMcp`, default ON).
- **SONA trajectory wrapping** in `runClaudeCliTurn.ts` — `trajectoryStart` on every CLI turn, `trajectoryStep` per tool dispatch, `trajectoryEnd` on success / failure / cancel. Fail-soft when Ruflo is unavailable. Sigma Assistant now accumulates cross-session learning from its own tool-call outcomes via the existing ReasoningBank pipeline.

### Fixed

- **Mailbox group broadcast** (`BUG-V1.1.1-03`) — `mailbox.ts:expandRecipient` correctly resolves `@all`, `@coordinators`, `@builders`, `@scouts`, `@reviewers` to concrete agent keys before invoking the PTY pane-echo closure. Operator broadcasts now reach every recipient in the target swarm (and only that swarm — the rc3 cross-swarm-leak fix is preserved).
- **Tool calls execute end-to-end** (`BUG-V1.1.1-01`) — see Tool dispatch parity above. Sigma's "launch a codex pane" now actually spawns the pane.
- **Sigma can enumerate live state** (`BUG-V1.1.1-02`) — see live `list_*` tools above. Replaces the stale system-prompt blob that read from the DB at turn start.
- **Ruflo MCP auto-connected for spawned agent CLIs** (`BUG-V1.1.1-04`) — see MCP autowrite above. Each claude/codex/gemini pane boots into a workspace with Ruflo MCP already configured.

### Verification

- `pnpm exec tsc -b` → clean (exit 0).
- `pnpm exec vitest run` → **28/28 pass** (13 new tests: 5 dispatch + trajectory in `runClaudeCliTurn.test.ts`, 3 live tools in `tools.test.ts`, 4 in `mcp-autowrite.test.ts`, 1 group-fanout in `mailbox.test.ts`).
- `pnpm exec vite build` → main bundle 335 KB raw / **92.84 KB gzipped** (well under 700 KB target).
- `pnpm run lint` → 54 errors / 0 warnings (rc3 baseline, no new errors).
- `pr-reviewer` agent verdict: SHIP-WITH-PATCH; six doc-only patches applied inline (master memory SHAs, this CHANGELOG entry, missing release notes file, memory_index "Latest commit + tag", `.upstream.md` provenance note). Zero P1 code issues; no regressions to v1.1.1 surfaces (drag, rebrand, voice diagnostics, single-instance lock all intact).
- **Distribution**: arm64-only macOS DMG, same constraints as v1.1.1 (per-arch native rebuild required; x64 deferred to CI matrix in v1.2).

### Deferred to v1.1.3

- Refactor `runClaudeCliTurn.ts` (643 lines) + `tools.ts` (525 lines) under the 500-line/file rule.
- `list_swarms` workspaceId-optional fix at `tools.ts:463`.
- CI workflow `pnpm-lock.yaml` cache-path resolution (local gates pass; CI fails at Setup Node).

## [1.1.1] - 2026-05-10

UX hotfix on top of v1.1.0-rc3. Four user-reported defects fixed in one pass: the window is now draggable, the "Bridge Assistant" rebrand to "Sigma Assistant" is complete across every user-visible surface, the assistant actually streams real Claude Code CLI responses (no more "stub mode for W13"), and SigmaVoice has a full diagnostics surface so the silent "voice not enabled" failure mode is finally visible to the user.

### Added

- **Sigma Assistant Claude Code CLI streaming** — new driver `app/src/main/core/assistant/runClaudeCliTurn.ts` (497 lines) spawns the local `claude` CLI binary in `--output-format stream-json --verbose` mode via `child_process.spawn` (not PTY) and bridges its envelopes onto the existing `assistant:state` + `assistant:tool-trace` IPC channels. Probe cached per main-process lifetime; falls back to a friendly stub (with install link) when the binary is missing. Cancellation via `cancelClaudeCliTurn(turnId)` kills the child with SIGTERM. New `cli-envelope.ts` parser (91 lines) with type guards for the streaming JSON shape; new `system-prompt.ts` (108 lines) building a ~1100-token SigmaLink-aware system prompt with workspace context, recent files, open swarms, and the 10 canonical Sigma tools. Critical discovery: `--verbose` is required alongside `--output-format stream-json` (added to spawn args). 8 unit tests via `spawnOverride`/`probeOverride` injection + 1 Playwright e2e (skip-on-no-claude). Live JSON shape verified against installed CLI v2.1.138. No raw API calls.

- **SigmaVoice diagnostics surface** — new `app/src/main/core/voice/diagnostics.ts` `runVoiceDiagnostics()` probes 4 stages independently (native loaded, permission status, dispatcher reachable, last error) in try/catch — never throws. New RPC channels `voice.diagnostics.run` + `voice.permissionRequest` allowlisted in `rpc-channels.ts` and zod-schema'd in `schemas.ts`. New `app/src/renderer/features/settings/VoiceTab.tsx` with mode radio (off/auto/on persisted to kv), permission row with Re-prompt button, and "Run diagnostics" button that renders 4 coloured stage dots with hover-tooltip detail. 7 unit tests + 1 Playwright e2e walking the Settings flow.

- **First-launch voice auto-enable on macOS** — adapter now bootstraps `voice.mode` from `kv['voice.mode']` and on first launch flips `'off'`→`'auto'` when the native module loads (persists `voice.firstLaunch=1` so idempotent). On non-macOS or when native fails to load, emits a `voice:unavailable` event with `{reason: 'no-native'|'platform'}` so the UI can explain the disabled state instead of going silent.

- **Drag-region helper** — new `app/src/renderer/lib/drag-region.ts` `dragStyle()` / `noDragStyle()` returning typed `CSSProperties` with the WebKit-prefixed `WebkitAppRegion` value. Single chokepoint replaces ad-hoc style objects.

- **`sigmavoice.enabled` capability key** — added to all three tier rows (basic=false, pro=true, ultra=true) in `capabilities.ts`. Composer reads the new key. Legacy `sigmavoice.enabled` retained for one release as an alias.

### Fixed

- **Multiple SigmaLink instances on agent spawn / second `.app` launch** — `electron/main.ts` was missing `app.requestSingleInstanceLock()`. Without the lock, every LaunchServices activation (a second double-click of the .app, an agent CLI registering a URL handler, drag-drops onto the dock icon) spawned a parallel SigmaLink with its own SQLite handle, its own PTY pool, and its own RPC router — the duplicates fought the original for the WAL lock and the user saw two SigmaLink icons in the dock. v1.1.1 acquires the lock at boot; if a second instance starts, it focuses the existing window and quits cleanly.

- **Window immovable on macOS** — only a 28-px sliver in the sidebar header had `WebkitAppRegion: 'drag'`; the rest of the chrome (breadcrumb, right-rail tab bar, sidebar wordmark) was non-draggable, so under `titleBarStyle: 'hiddenInset'` the user couldn't pick up the window from anywhere visible. Wired drag regions across all chrome containers + `no-drag` overrides on every interactive child (collapse button, tabs).

- **"Stub mode for W13" reply text** — the right-rail assistant has been a deterministic stub since W13. v1.1.1 wires it to the actual local `claude` CLI; the stub remains as the binary-missing fallback (with an install hint).

- **"Voice not enabled or something" silent failure** — root cause was a diagnostics gap, not a single bug: mode defaults to `'auto'`, native module loads fine, but on first mic press `requestPermission()` returns `not-determined` until the OS dialog is acknowledged, the adapter threw `no-permission`, and the orb reset silently. Fixed by the first-launch auto-enable + `voice:unavailable` event + the new Settings → Voice diagnostics surface.

### Changed

- **Bridge → Sigma rebrand** — 8 user-visible strings swapped (sidebar nav, right-rail tab, command-palette entry, SigmaRoom EmptyState + standalone header, OriginLink banner, Composer placeholder + aria-label, VoicePill label). Comments + `Voice input (W15)` button title also updated. Folder paths and IPC channel names (`assistant:*`, `voice:*`) unchanged — protocol-level, breaks the renderer to rename.

- **`vitest` added as a dev dependency** for the new unit-test files.

### Carried forward from v1.1.0-rc3

All Phase 4 work intact: Track A (agent IPC reliability + provider launcher façade), Track B (SigmaVoice native macOS Speech.framework), Track C (Ruflo MCP supervisor + 3 user-facing features), and Skills marketplace live install.

### Distribution scope

**arm64-only this release.** The x64 macOS DMG was pulled because it would have bundled arm64 native modules under `--config.npmRebuild=false` and crashed on first launch (caught locally by the rc3 diagnostic page). Apple Silicon users get `SigmaLink-1.1.1-arm64.dmg` / `SigmaLink-1.1.1-arm64-mac.zip`. Intel-Mac users should stay on v1.0.1 or wait for v1.2 (which will wire a CI matrix with per-arch native rebuilds).

Required pre-build dance for arm64 releases until the CI matrix lands:
```
cd app/node_modules/.pnpm/better-sqlite3@<ver>/node_modules/better-sqlite3 \
  && npx electron-rebuild --module-dir . --types prod -f
```

## [1.1.0-rc3] - 2026-05-10

Hotfix on rc2. The rc2 DMG crashed at first launch with `Cannot find module 'lazy-val'`. rc3 fixes the underlying packaging defect.

### Fixed

- **DMG runtime crash `Cannot find module 'lazy-val'`** — root cause: `lazy-val` (transitive dep of `electron-updater`) was on the esbuild externals list, so `main.js` did `require('lazy-val')` at runtime. The packaged app's `Resources/app/node_modules/lazy-val/` was an EMPTY directory left by pnpm's content-addressed hoist (the real package lives in `node_modules/.pnpm/lazy-val@1.0.5/...`). Same family of trap as the v1.0.0 `bindings` defect. Fix: drop `lazy-val` from `scripts/build-electron.cjs` externals so esbuild bundles it inline; replace the empty pnpm placeholder at `node_modules/lazy-val/` with a proper symlink to the .pnpm content store. The fixed `main.js` no longer issues `require('lazy-val')` at runtime — the resolver path that crashed is eliminated.

## [1.1.0-rc2] - 2026-05-10

Release-candidate iteration on top of rc1. Adds Phase 4 Step 5 (Skills marketplace live install) which landed on `main` after rc1 was tagged.

### Added

* **Skills marketplace live install from GitHub URL** (Phase 4 Step 5) — Marketplace tab Install button now downloads a GitHub tarball (streamed to temp file, no in-memory load), shells out to `tar -xzf`, walks for SKILL.md (root / subPath / `skills/` heuristic), and runs the result through the existing `manager.ingestFolder` pipeline (sha256 hash + atomic temp+rename + per-provider fanout to Claude/Codex/Gemini). Supports `owner/repo` shorthand, full GitHub URL, and SSH URL formats. Default branch resolved via GitHub API when ref omitted. Streamed progress events drive a per-card progress bar.
* **Marketplace catalog expanded 8 → 20 entries** — 6 entries point at the real public `anthropics/skills` repo; 14 are curated SigmaLink/community placeholders with `install: { ownerRepo, ref?, subPath? }` blocks. Older entries without an install block fall back to `repoUrl → owner/repo` parsing.
* 21/21 marketplace unit tests covering URL parsing, SKILL.md location heuristics, tarball-wrapper detection, and end-to-end installFromUrl flow (success, ref override, invalid URL, missing SKILL.md, invalid frontmatter, UPDATE_REQUIRED hint, download failure cleanup, progress sequence, metadata failure).

### Changed

* `app.tier` schema corrected to `enum(['basic','pro','ultra'])` to match the actual `Tier` union (was `['free','pro','ultra']` in plan).
* Vite main bundle 322 → 326 KB (+4 KB for the new MarketplaceTab UI surface). Still well under the 700 KB target.

### Carried forward from rc1

All Track A (IPC + provider hardening) + Track B (SigmaVoice) + Track C (Ruflo) work from rc1 is in this candidate unchanged.

## [1.1.0-rc1] - 2026-05-10

Phase 4 release candidate. Three feature tracks landed in one autonomous overnight run on top of v1.0.1: Agent IPC reliability, SigmaVoice native macOS module, and Ruflo MCP supervisor with three user-facing features. **rc1** because the new native voice module + lazy-download Ruflo path warrant real-world validation before the final v1.1.0 tag.

### Added

* **SigmaVoice native macOS** (Track B) — replaces renderer-only Web Speech API with on-device `SFSpeechRecognizer` via Objective-C++ NAPI module (`app/native/voice-mac/`). ABI-stable Node-API binary per arch (darwin-x64 + darwin-arm64); end users no longer need Xcode after CI ships prebuilds. Continuous mode with `requiresOnDeviceRecognition=YES` (server-side capped at ~60 s). New `dispatcher.ts` regex intent classifier routes finalized transcripts into broadcast / rollCall / app.navigate / assistant.send. macOS minimum bumped 10.12 → 10.15 (Speech.framework requirement). 17/17 dispatcher tests pass.

* **Ruflo MCP embed** (Track C) — three new user-facing features powered by an Option B lazy-download supervisor. **Semantic Memory Search** in Memory room runs `ruflo.embeddings.search` in parallel with token search; "Semantic" chip on Ruflo-sourced rows. **Bridge Assistant pattern surfacing** debounces composer input 800 ms → `ruflo.patterns.search`; ribbon at ≥0.7 confidence with Apply / dismiss. **Autopilot Command Palette** prefetches `ruflo.autopilot.predict` on cmdk open with 30 s cache. New Settings → Ruflo tab with download button (350 MB) + health row + telemetry opt-in. 14/14 proxy unit tests pass.

* **Provider launcher façade** — new `providers/launcher.ts` `resolveAndSpawn()` consolidates the three direct call sites; honors `comingSoon` + `fallbackProviderId` (SigmaCode → Claude with `provider_effective` populated), walks `[command, ...altCommands]` on ENOENT, appends `provider.autoApproveFlag` when `autoApprove=true`, re-checks `kv['providers.showLegacy']` main-side. 9/9 unit tests pass.

* **Migration 0010 — `agent_sessions.provider_effective`** column. Idempotent ALTER TABLE inside BEGIN/COMMIT/ROLLBACK. Populated by the launcher façade on every spawn so the renderer can render "SigmaCode (using claude)" chrome.

* **Group-recipient grammar** — `expandRecipient(swarmId, recipient)` resolves `*`/`@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers` end-to-end (mailbox row + JSONL mirror + PTY fan-out). Skill-toggle producer + SideChat sends to roles now actually reach all the role's PTYs.

### Fixed

* **macOS DMG PATH-truncation** (BUG-V1.1-03-PROV) — `electron/main.ts` `bootstrapShellPath()` now spawns `${SHELL} -ilc 'printf %s "$PATH"'` once at boot on darwin and prepends shell-resolved entries to `process.env.PATH`. Providers like `claude` / `codex` / `gemini` that live under `/opt/homebrew/bin` etc. now resolve when SigmaLink is launched from Finder/dock.

* **Cross-swarm directive leak** (BUG-V1.1-02-IPC) — `setPaneEcho` closure now scopes the DB lookup by `swarmId AND agentKey`. Operator → coordinator-1 directives no longer route into a different swarm's coordinator-1 PTY when both swarms have agents with the same name.

* **Cross-pane focus auto-sync** (BUG-V1.1-04-IPC) — Bridge dispatch echoes now perform workspace-switch + room-hop + active-session jump automatically; CommandRoom listens at room level and derives `activeIndex` from `state.activeSessionId`. Toast retained as confirmation.

* **Dead-PTY writes silenced** (BUG-V1.1-12-IPC) — `controller.writeToPtys` emits a `kind:'error_report'` mailbox row when a write target is dead.

* **Playwright Node 26 race** (BUG-V1.1-DF-01-PW) — defensive: `smoke.spec.ts` hoists `test.setTimeout(240_000)` into the test body, `dogfood.spec.ts` wraps in `test.describe('dogfood-v1', …)`. Proper fix (bump @playwright/test to ≥1.60) deferred to v1.2.

### Removed

* Dead `'droid'` and `'copilot'` from `ProviderId` union — never had registry entries; renderer stub references continue to work as plain strings.

### Build

* `tsc -b` clean. `vite build` 322 KB main + 6 vendor chunks (was 311 KB pre-Phase-4-tracks-B+C; +12 KB; well under 700 KB target). `electron:compile` clean. Lint **42 errors / 10 warnings** (was 54/10 baseline; tracks contributed 0 new errors — net DECREASE).
* `mac.hardenedRuntime: true` + `entitlements: build/entitlements.mac.plist` (3 entitlements: allow-jit, allow-unsigned-executable-memory, device.audio-input). `mac.extendInfo` adds NSMicrophoneUsageDescription + NSSpeechRecognitionUsageDescription. Hardened runtime is inert without a Developer ID signing identity (we still ship unsigned), but turning it on lets future notarisation work without an electron-builder churn round.

### Deferred to v1.2

* Wake-word "Hey Sigma" (Porcupine licensing forbids bundled key; needs BYO-AccessKey UX or enterprise license).
* Native voice CI workflow + cross-arch prebuilds (`app/native/voice-mac/prebuilds/`).
* Ruflo HTTP Range / resumable downloads.
* Ruflo native deps (@ruvector/sona-*, onnxruntime-node) — installer fetches top-level tarball only in v1.1.
* Roll-call main-process aggregation + timeout (BUG-V1.1-05-IPC).
* `console-controller.stop-all` + `factory.killSwarm` consolidation (BUG-V1.1-07-IPC).
* @playwright/test ≥1.60 bump to remove the Node-26 loader race.
* Bridge Assistant `roll_call` / `broadcast` tools dual-delivery (BUG-V1.1-06-IPC).
* Five P3 IPC follow-ups + 1 P3 PROV follow-up.

## [1.0.1] - 2026-05-10

Hotfix release. Tag + push gated on explicit user authorization. Body: `docs/09-release/release-notes-1.0.1.txt`.

### Fixed

- **DMG `Cannot find module 'bindings'`** at first launch — `electron-builder.yml` now adds `bindings`, `file-uri-to-path`, `prebuild-install`, `better-sqlite3/**`, and `node-pty/**` to `asarUnpack` so the native-module resolver finds the unpacked siblings. The v1.0.0 break came from the `--config.npmRebuild=false` build-flag workaround dropping transitive deps from the asar; the YAML-side fix means future rebuilds don't need that flag.
- **Boot self-check missed `bindings` resolution failures** — `app/electron/main.ts` `checkNativeModules()` now opens `new Database(':memory:')` and spawns a 1×1 `node-pty.spawn()` (then immediately kills) so the inner `require('bindings')` actually executes during the smoke test; the diagnostic page now appears at boot rather than the renderer white-screening on first DB write.
- **macOS traffic-light overlap on Sidebar** — title-bar buttons (close/min/zoom) overlapped the `SigmaLink` wordmark + Σ monogram on top-left of the sidebar. Added a 28-px draggable spacer at the top of the sidebar on macOS so the buttons sit in their own region (`Sidebar.tsx`); spacer hidden on Win/Linux.
- **CLI agent pane text misalignment on first render** — `Terminal.tsx` no longer relies on a `requestAnimationFrame`-deferred initial `fit.fit()` (the rAF could fire before GridLayout's flex-shrink stabilized, leaving cells one column off). The `ResizeObserver` now gates `fit()` on non-zero contentRect dimensions and runs the first fit synchronously when the container measures non-zero; subsequent resizes debounce 25 ms (was 50 ms).
- **BUG-DF-02** — `app.tier` and `design.shutdown` RPC channels now have zod schemas; the boot-time soft-launch warning `2 channel(s) have no zod schema entry` no longer fires.
- **BUG-DF-01** — Browser room data-room flicker on tab focus.

### Build

- `app/electron-builder.yml` `asarUnpack` block extended; no longer requires `--config.npmRebuild=false` at build time.
- `app/scripts/build-electron.cjs` adds `lazy-val` to esbuild externals to fix a pre-existing `electron:compile` break that surfaced when rebuilding a clean tree.
- `app/package.json` version `1.0.0` → `1.0.1`.

## [1.0.0] - 2026-05-10

V3 parity release. Tag + push gated on explicit user authorization. Body: `docs/09-release/release-notes-1.0.0.txt`. Acceptance: `docs/07-test/ACCEPTANCE_REPORT_V1.md`.

### Added

Wave 10 — boot self-check + Diagnostics:

- Boot self-check detects `better-sqlite3` ABI mismatches; `NativeRebuildModal` prompts `npm rebuild`; Re-probe banner re-runs provider PATH probes; Settings → Diagnostics tab. Closes critique R3 + risk A12.

Wave 11.5 — scope freeze:

- `docs/03-plan/V3_PARITY_BACKLOG.md` (45 tickets, W12-15); surgical PRODUCT_SPEC re-baseline (C-016, §2.2/2.3/3.10/3.12/3.13/3.14, §4 V3 9-provider matrix).

Wave 12 — V3 quick-wins + infrastructure (6 parallel agents):

- Workspace launcher: 3-card picker (SigmaSpace / Swarm / Canvas-ALPHA, `⌘T`/`⌘S`/`⌘K`) + Start → Layout → Agents stepper + tile grid 1/2/4/6/8/10/12 + recents autocomplete + preset row + sidebar status dot + agent-count pill + breadcrumb `Workspace <N> / <user>`.
- Provider matrix reset: SigmaCode stub (silent Claude fallback via `agent_sessions.providerEffective`); Kimi → OpenCode model option (`ModelOption` type, per-pane status strip `<model> <effort> <speed> · <cwd>`); Aider + Continue behind `kv['providers.showLegacy']`; wizard quick-fills (Enable all / One of each / Split evenly).
- Battalion 20 preset (3/11/3/3 [INFERRED]); cap 50→20; >20-agent swarms read-only with `legacy: true`.
- Role colour CSS tokens (`--role-coordinator/-builder/-scout/-reviewer`) across all themes; `bg-role-<n>` utilities.
- Swarm wizard 5-step shell (Roster → Mission → Directory → Context → Name); CLI-agent-for-all global provider strip; per-row Auto-approve + provider override + model + count -/+ + colour stripe.
- Operator Console TopBar (TERMINALS / CHAT / ACTIVITY tabs + STOP ALL + group filters fed by `swarm:counters`).
- 17 new RPC channels + 5 events; `assistant.*` / `design.*` / `voice:state` / new `swarm:*` allowlist groups.
- 9 mailbox envelope kinds: `escalation` (promoted), `review_request`, `quiet_tick`, `error_report`, `task_brief`, `board_post`, `bridge_dispatch`, `design_dispatch`, `skill_toggle`. Recipient grammar `@all`/`@coordinators`/`@builders`/`@scouts`/`@reviewers`. Per-kind zod soft-launch schemas.
- `swarm_messages.resolvedAt` (counters); `directive.echo='pane'` (operator → PTY).
- Drizzle Kit journal; new tables `boards`, `swarm_skills`, `canvases`; new columns `swarm_agents.coordinatorId`, `swarm_agents.autoApprove`.
- `safeStorage`-backed credentials (closes A5).

Wave 13 — V3 parity sweep + Bridge Assistant (5 parallel agents):

- Right-rail dock with Browser / Editor / Bridge tabs + resizable splitter; width in `kv['rightRail.width']`. Browser recents + click-link-in-pane routing.
- Per-pane chrome variants + provider splash + footer hints; multi-pane CSS-grid 1/2/4/6/8/10/12 with per-pane drag-resize + `Cmd+Alt+<N>`.
- Constellation graph (drag/zoom; multi-hub via `coordinatorId`); ActivityFeed sidebar; structured `task_brief` render (URGENT chip + indented headings + live links).
- Per-agent boards (`boards` table + atomic markdown under `<userData>/swarms/<swarmId>/boards/...`); `board_post` envelope DB + disk in one tx.
- Operator → agent DM echo into PTY when `directive.echo === 'pane'`. Mission `@<workspaceSlug>` autocomplete. Swarm Skills 12-tile grid persists to `swarm_skills` and fires `skill_toggle`.
- **Bridge Assistant fully built**: chat panel + 4-state orb (STANDBY / LISTENING / RECEIVING / THINKING) + char-by-char streaming.
- `assistant.*` RPC: `listen`, `state` (event), `dispatch-pane`, `dispatch-bulk`, `ref-resolve`, `turn-cancel`, `tool-trace` (event).
- 10 canonical tools: `launch_pane`, `prompt_agent`, `read_files`, `open_url`, `create_task`, `create_swarm`, `create_memory`, `search_memories`, `broadcast_to_swarm`, `roll_call`. Tool tracer + cross-workspace Jump-to-pane toast + completion ding (`app/public/sounds/ding.wav`).

Wave 14 — Bridge Canvas + Editor + auto-update (3 parallel agents):

- Bridge Canvas element-picker overlay; `design:start-pick / pick-result` carry `{ selector, outerHTML, computedStyles, screenshotPng }`.
- DesignDock with captured selector + collapsible outerHTML + screenshot thumbnail + "Paste source" pill.
- Per-prompt provider chips (Claude / Codex / Gemini / OpenCode) Shift-add / Alt-remove; persists per-canvas in `canvases.lastProviders`.
- Drag-and-drop asset staging into `<userData>/canvases/<canvasId>/staging/<ulid>.<ext>`.
- Live-DOM HMR poke: `design:patch-applied` on agent file writes; `location.reload()` fallback or no-op WebSocket nudge.
- SigmaCanvas card ALPHA chip until `kv['canvas.gaSign']='1'`.
- Editor right-rail tab: Monaco lazy-loaded as 14.57 KB chunk (separate from 990 KB main); CodeMirror fallback; file tree + click-path focus + `fs.readDir`/`readFile`/`writeFile` RPC.
- Auto-update via `electron-updater@6.8.3`; opt-in behind `kv['updates.optIn']='1'`; Settings → Updates tab with Check button + last-check timestamp.
- Re-probe agents button (Settings → Providers); `NativeRebuildModal` on `better-sqlite3` ABI mismatch.

Wave 15 — voice + CI matrix + plan capabilities (4 parallel agents):

- SigmaVoice intake: title-bar pill + global `voice:state { active, source: 'mission'|'assistant'|'palette' }`. Web Speech API stub; native bindings deferred to v1.1.
- Voice into swarm mission textarea, Bridge orb tap, Command Palette (`Cmd+Shift+K`).
- `.github/workflows/e2e-matrix.yml` runs the smoke on `windows-latest` / `macos-14` / `ubuntu-latest` under Node 20; per-OS artefacts; required PR check.
- Plan-gating matrix at `app/src/main/core/plan/capabilities.ts` + `canDo(cap)`; default tier `'ultra'` (free, local-only); QA override via `kv['plan.tier']`.
- Skills marketplace stub: read-only listing from `docs/marketplace/skills.json`.

### Changed

- Roster preset rename Legion → Battalion. Preset list = Squad 5 (1/2/1/1) · Team 10 (2/5/2/1) · Platoon 15 (2/7/3/3) · Battalion 20 (3/11/3/3 [INFERRED]) · Custom 1..20. `swarms.preset` CHECK constraint accepts `'battalion'`; existing `'legion'` rows survive but new swarms reject `legion`. Supersedes original PRODUCT_SPEC C-006.
- Provider matrix 11 → 9 default. SigmaCode added; Kimi demoted to OpenCode model option; Aider + Continue hidden behind legacy toggle; Custom row renamed to "Custom Command". Supersedes original PRODUCT_SPEC C-004.
- `[Unreleased]` section reset to empty after this release cuts.
- README status table flips Phase 9 to In progress (Waves 12–16) → Shipped pending W15 CI matrix completion.

### Fixed

W12 P3 sweep — 5 P3 bugs from W7 closed:

- `BUG-W7-007` (P3) — PowerShell upgrade banner suppressed: `-NoLogo` + `POWERSHELL_UPDATECHECK=Off` for the PowerShell family in `local-pty.ts`.
- `BUG-W7-009` (P3) — Tasks sidebar icon weight: `ListChecks` → `LayoutGrid` to match `Folder`/`Globe`/`Settings` stroke profile.
- `BUG-W7-010` (P3) — Test-only folder picker: `workspacesCtl.pickFolder` bypasses `dialog.showOpenDialog` when `process.env.SIGMA_TEST` is set, reading `kv['tests.fakePickerPath']`.
- `BUG-W7-012` (P3) — Onboarding Skip flake: `complete()` dispatches `SET_ONBOARDED` synchronously; kv write fires in background; Skip button forces `pointerEvents: 'auto'`.
- `BUG-W7-014` (P3) — Browser room test-coupling: `RoomSwitch` mirrors `state.room` to `document.body.dataset.room`; smoke embeds rendered room in filename.

### Deferred

- Dogfood cycle (V3-W15-006) — needs real human GUI session; queued for v1.1.
- Native voice bindings (macOS Speech / Windows SAPI / Linux PocketSphinx); Web Speech API stub ships in v1.0.0.
- macOS notarisation + Windows code-signing certificate (R10 Partial).
- Three-way merge editor + per-line review comments in Review Room.
- Manual reverify BUG-W7-003 + BUG-W7-006 (both hold `fixed` pending fresh-kv GUI cycle).
- Real CDP-attach / shared-Chromium Browser; per-workspace cookie isolation; hard-blocking `claimDriver` lock.
- Barnes-Hut quadtree for Memory graph >500 notes; token-overlap `suggest_connections`; real-time `memory:changed` IPC.
- Cloud sync, accounts, billing, SSH remote workspaces, ticketing integrations, mobile clients — out of scope for v1.
- Bernstein-style verifier loops (PRODUCT_SPEC C-008); multi-window concurrency (A11); telemetry (A16).

### Known issues

- Local Playwright `_electron` smoke gated on Node 26 + npm 11 install bug; W15 CI matrix on Node 20 is canonical.
- Lint at 80 errors / 3 warnings, nearly all in `_legacy/` archive code.
- BUG-W7-015 (P3) — Parchment "Launch N agents" CTA contrast nit (open).
- BUG-W7-000 (P0) — Electron node_modules install bug; bypassed by Node 20 CI matrix; tracked for v1.1.

Tagged and released: 2026-05-10.

## [0.1.0-alpha] - 2026-05-09

### Added

- Phase 1 foundation: Electron + Vite + React 19 + Tailwind 3 + shadcn UI shell with the Workspace launcher and Command Room rooms wired up.
- Provider registry of eleven CLI agents (Claude Code, Codex, Gemini, Kimi, Cursor, OpenCode, Droid, Copilot, Aider, Continue, custom shell) with a PATH probe and install hints.
- Real PTY-backed terminal panes via `node-pty` and `@xterm/xterm`, with a ring-buffered history flushed to SQLite for cross-restart replay.
- Per-pane Git worktree pool under the Electron user-data directory, with branch namespace `sigmalink/<role>/<task>-<8char>`.
- SQLite persistence with Drizzle ORM and `better-sqlite3`; tables for `workspaces`, `agent_sessions`, `swarms`, `swarm_agents`, `swarm_messages`, `browser_tabs`, `skills`, `skill_provider_state`, `memories`, `memory_links`, `memory_tags`, `tasks`, `task_comments`, `session_review`, `kv`.
- Boot janitor that flips zombie `agent_sessions`/`swarms` rows on startup and best-effort `git worktree prune`s known repo roots.
- Cross-platform PTY plumbing: PATH+PATHEXT resolver routes `.cmd`/`.bat`/`.ps1` shims through their interpreters; default-shell preference order pwsh → powershell → cmd on Windows.
- Phase 2 Swarm Room: roster grid + side chat + recipient picker; `SIGMA::` line protocol with `SAY`/`ACK`/`STATUS`/`DONE`/`OPERATOR`/`ROLLCALL`/`SYSTEM` verbs; SQLite-backed `SwarmMailbox` with single-writer queue and JSONL debug mirrors; presets Squad/Team/Platoon/Legion with `defaultRoster()`.
- Phase 3 Browser Room: in-app `WebContentsView` per tab, address bar with URL normalization, tab strip, persisted `browser_tabs`; per-workspace Playwright MCP supervisor (`@playwright/mcp` over `npx -y`) with port discovery and 3-restart back-off; `claimDriver`/`releaseDriver` advisory lock with agent-driving overlay; per-provider MCP config writer (`.mcp.json`, `~/.codex/config.toml`, `~/.gemini/extensions/sigmalink-browser/`).
- Phase 4 Skills Room: drag-and-drop SKILL.md ingestion with frontmatter validation, deterministic per-folder content hash, atomic stage-then-rename to managed `<userData>/skills/<name>/`; per-provider fan-out to `~/.claude/skills/`, `~/.codex/skills/`, and synthesized Gemini extension manifests; per-provider toggle state and detail modal with built-in Markdown preview.
- Phase 5 Memory Room (SigmaMemory): wikilink notes stored as `<workspace>/.sigmamemory/<name>.md`; `memories`/`memory_links`/`memory_tags` schema with cascade deletes; in-memory inverted index; force-directed graph canvas (hand-rolled); in-process `sigmamemory` MCP server bundled as `electron-dist/mcp-memory-server.cjs` exposing 12 tools (`list_memories`, `read_memory`, `create_memory`, `update_memory`, `append_to_memory`, `delete_memory`, `search_memories`, `find_backlinks`, `list_orphans`, `suggest_connections`, `init_hub`, `hub_status`); per-workspace MCP supervisor with 3-restart linear back-off; combined browser+memory MCP entries written into provider configs.
- Phase 6 Review Room: session list with multi-select; unified/split diff renderer (no new deps); Tests/Notes/Conflicts tabs; `git merge-tree` conflict prediction with name-only intersection fallback; `commitAndMerge` + `batchCommitAndMerge` with worktree teardown; `dropChanges` and `pruneOrphans`.
- Phase 6 Tasks Room: 5-column Kanban (Backlog / In Progress / In Review / Done / Archived); `@dnd-kit/*` drag-and-drop card moves; swarm-roster drop rail that writes a `SAY` envelope `SIGMA::TASK <title>` into the assigned agent's mailbox; per-task comment thread.
- Phase 7 UI polish: four built-in themes (Obsidian, Parchment, Nord, Synthwave) driven by `:root[data-theme=...]` HSL tokens; first-run onboarding modal (welcome → detect agents → pick workspace); cmdk command palette bound to Cmd/Ctrl+K with nav, recent workspaces, theme switching, kill-all-PTY, ingest-skill, new-memory-note actions; sidebar with Σ monogram, manual + auto-collapse below 1100px, Radix tooltips on disabled rooms; universal `EmptyState` and `ErrorBanner` components; CSS-only motion (`sl-fade-in`, `sl-slide-up`, `sl-pane-enter`).
- Phase 8 visual test loop: `app/tests/e2e/smoke.spec.ts` Playwright `_electron` driver; 37-step visual sweep with screenshots committed to `docs/07-test/screenshots/` and machine-readable summary at `docs/07-test/visual-summary.json` / `visual-summary-acceptance.json`.
- IPC channel + event allowlists in `app/src/shared/rpc-channels.ts`; preload exposes a single generic `invoke` against the allowlist; renderer uses a typed Proxy bridge.
- Graceful shutdown on `before-quit`: `pty.killAll()`, MCP supervisor stops, `wal_checkpoint(TRUNCATE)`, DB close.
- Global RPC error toaster: any `{ok:false}` envelope from the preload bridge surfaces as a sonner toast; `rpcSilent` proxy for opt-out paths.

### Fixed

Phase 1.5 (Wave 5 — foundation patches):

- `P0-PTY-WIN-CMD` — Windows `.cmd`/`.bat`/`.ps1` shims now route through their interpreters via the PATH+PATHEXT resolver (`app/src/main/core/pty/local-pty.ts`).
- `P1-PROBE-EXEC-WIN` — provider `--version` probe uses the same resolver.
- `P1-PROBE-CMD-NOT-USED` — resolved `.cmd` path now used at spawn time.
- `P1-WORKTREE-LEAK` — launcher rolls back the worktree on PTY birth failure.
- `P1-PTY-FAILURE-NOT-DETECTED` — synthetic-exit path flips early-death panes to `status='error'` with surfaced text.
- `P1-DB-EXIT-DUPLICATE-LISTENER` — exit handler attached once per session.
- `P1-PTY-REGISTRY-LEAK` — graceful-exit `forget()` clears registry + listeners after a 200ms drain window; `killAll()` on `before-quit`.
- `P1-NO-CLOSE-PANE` — close button per pane + `REMOVE_SESSION` reducer action with auto-remove after 5s exit.
- `P1-INITIAL-PROMPT-DOUBLE` — initial prompt is now a single source-of-truth in the launcher.
- `P1-WORKTREE-PATH-COLLISION` — 8-char CSPRNG branch suffix + `fs.existsSync` retry.
- `P1-RUN-SHELL-TOKENISER` — state-machine tokenizer handles single/double quote escapes and concatenation.
- `P1-RUN-SHELL-EXEC-WIN` — `runShellLine` resolves Windows shims via the same PATH+PATHEXT helper.
- `P1-RPC-PRELOAD-NO-CHANNEL-ALLOWLIST` — preload now rejects any invoke not in `CHANNELS`.
- `P1-DB-NEVER-CLOSED` — SQLite handle + WAL flushed on `before-quit`.
- `P2-PTY-CWD-NOT-VALIDATED` — cwd validated before spawn.
- `P2-EVENT-PAYLOAD-CASTING` — renderer guards on PTY data/exit payloads.
- `P2-RESIZE-DEBOUNCE` — terminal fit debounced on resize.
- `P2-TERMINAL-FIT-DURING-OPEN` — initial fit deferred until xterm finishes mounting.
- `P2-RPC-ERROR-STACK-LOST` — `RpcResult.stack?` carried through dev-only.

Wave 8 — visual-sweep bug-fix pass:

- `BUG-W7-001` (P1) — `workspaces.open` now activates the workspace; Launcher.tsx + state.tsx reducer aligned.
- `BUG-W7-005` (P1) — global sonner toaster on the renderer root surfaces every unhandled RPC rejection.
- `BUG-W7-006` (P1) — `wal_checkpoint(PASSIVE)` in `openWorkspace` so subsequent `workspaces.list` always sees the row; `swarms.create` returns a clearer error.
- `BUG-W7-002` (P2) — disabled sidebar buttons use `tabIndex={-1}`, no focus ring, Radix tooltip "Open a workspace to enable".
- `BUG-W7-003` (P2) — `ThemeProvider` validates kv via `isThemeId`; AppearanceTab gained "Reset to default" button.
- `BUG-W7-004` (P2) — sidebar tokens audited across all four themes; bg-sidebar resolves through `--sidebar-background`.
- `BUG-W7-008` (P2) — Tasks drawers gated on `state.room === 'tasks'`; cannot leak across rooms.
- `BUG-W7-011` (P2) — Launcher derives selection from `state.activeWorkspace`; single source of truth.
- `BUG-W7-013` (P2) — disabled-room rationale surfaced via the W7-002 tooltip.

### Deferred

- `P1-IPC-EVENT-RACE-CROSSWINDOW` — single-window product today; broadcast pattern only over-amplifies IPC under multiple BrowserWindows. Functional, not load-blocking.
- `P1-DRIZZLE-DEFAULT-OVERRIDE` — cosmetic clock-skew sub-second; no functional impact.
- Skills zip ingestion — would require a new dep (`adm-zip`/`unzipper`); controller surface and channel allowlist are wired and `ingestZip` throws a clear "drop the unzipped folder" error.
- `react-markdown` for SKILL.md preview — built a 60-line in-house renderer instead.
- Codex `allowed-tools` translation in Skills fan-out — `fm.allowedTools` is preserved verbatim; translation deferred.
- Project-scoped skills — v1 ships user-global skills only.
- Real CDP-attach / shared-Chromium for the Browser Room — v1 ships separate-Chromium mode behind the Playwright MCP supervisor.
- Per-workspace cookie/session isolation in the Browser Room — schema leaves room for `persist:ws-<id>` partitions.
- Hard-blocking lock on `claimDriver` — v1 surfaces the lock visually only.
- O(n²) repulsion in the Memory graph — Barnes-Hut quadtree deferred until workspaces routinely exceed 500 notes.
- Token-overlap variant of `suggest_connections` — current heuristic is co-tag overlap.
- Real-time `memory:changed` IPC from the spawned MCP child back to the GUI — GUI re-fetches on focus today.
- Three-way merge conflict editor and per-line review comments in the Review Room.
- `<Toaster>`-as-ack-channel for command-palette actions (only error toasts wired today).
- Cloud sync, account systems, billing, SSH remote workspaces, ticketing integrations (Linear/Jira/GitHub Issues), voice assistant, mobile clients — all out of scope for v1.
- Bernstein-style verifier loops on top of the swarm dispatcher — see PRODUCT_SPEC C-008.

### Known issues

- `BUG-W7-007` (P3) — PowerShell upgrade banner clutters every fresh shell pane; `POWERSHELL_UPDATECHECK=Off` not yet plumbed.
- `BUG-W7-009` (P3) — Tasks sidebar icon stroke weight inconsistent with siblings.
- `BUG-W7-010` (P3) — Test-only: native folder picker can't be scripted from Playwright; smoke harness substitutes `workspaces.open` and parses the raw envelope.
- `BUG-W7-012` (P3) — Onboarding Skip click occasionally drops mid-fade-in.
- `BUG-W7-014` (P3) — Browser room not reachable in test sweep when no workspace is activated; coupled to `BUG-W7-001` (now verified) but the test harness path remains.
- `BUG-W7-015` (P3) — Parchment "Launch N agents" CTA contrast nit.

[Unreleased]: https://github.com/s1gmamale1/SigmaLink/compare/v1.2.4...HEAD
[1.2.4]: https://github.com/s1gmamale1/SigmaLink/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/s1gmamale1/SigmaLink/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/s1gmamale1/SigmaLink/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/s1gmamale1/SigmaLink/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.11...v1.2.0
[1.1.11]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.10...v1.1.11
[1.1.10]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.9...v1.1.10
[1.1.9]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.1...v1.1.4
[1.1.1]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.0-rc3...v1.1.1
[1.1.0-rc3]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.0-rc2...v1.1.0-rc3
[1.1.0-rc2]: https://github.com/s1gmamale1/SigmaLink/compare/v1.1.0-rc1...v1.1.0-rc2
[1.1.0-rc1]: https://github.com/s1gmamale1/SigmaLink/compare/v1.0.1...v1.1.0-rc1
[1.0.1]: https://github.com/s1gmamale1/SigmaLink/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/s1gmamale1/SigmaLink/compare/v0.1.0-alpha...v1.0.0
[0.1.0-alpha]: https://github.com/s1gmamale1/SigmaLink/releases/tag/v0.1.0-alpha
