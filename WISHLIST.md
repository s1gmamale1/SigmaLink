# SigmaLink — Wishlist

> **Capture inbox for future, nice-to-have, and explicitly deferred work.**
> The pre-audit inbox is archived at [WISHLIST-pre-performance-audit-2026-07-24.md](docs/03-plan/archive/WISHLIST-pre-performance-audit-2026-07-24.md).
> Full evidence and independent receipts: [2026-07-24 performance/platform audit](docs/03-plan/audits/2026-07-24-performance-platform-cleanup-audit.md).
>
> Promote an item to `ROADMAP.md` only after assigning an owner and acceptance gate. Remove it when shipped or rejected; completed work belongs in the audit and Git history. Metadata is `evidence · severity · effort`.

---

## 🚫 Deferred by design (out of scope for now)

- **[terminal] Profile hidden-pane GPU retention (C-019).** `Hypothesis · low · M`. Citations: `app/src/renderer/features/command-room/PaneGrid.tsx:314-337`, `app/src/renderer/features/command-room/PaneShell.tsx:599-610`, `app/src/renderer/lib/terminal-cache.ts:539-569`. Action: measure renderer/GPU memory across repeated fullscreen, minimise, scratch-tab, and workspace-hide cycles before changing intentional keep-alive behavior. Verification trigger: a repeatable packaged-build trace demonstrates an excessive retained-resource bound.
- **[Windows/path] Test legal `%VAR%` directory names (C-039).** `Hypothesis · low · S`. Citation: `app/src/main/core/util/windows-spawn.ts:181`. Action: verify shell-open behavior on a Windows device before altering expansion semantics. Build trigger: a disposable Windows fixture reproduces path corruption without relying on synthetic strings alone.

## ✨ Future enhancements (planned-later upgrades)

- **[product/navigation] Drive navigation from one room registry (C-049).** `Confirmed · medium · M`. Citations: `app/src/renderer/app/state.types.ts:45-55`, `app/src/renderer/features/top-bar/rooms-menu-items.ts:30-47`, `app/src/renderer/features/command-palette/CommandPalette.tsx:105-126`. Action: drive menus, palette, and lazy loaders from one typed registry. Verification trigger: a completeness test covers every `RoomId` and all intended entry points.
- **[product/deprecation] Decide duplicate room/rail surfaces (C-053).** `Strong static evidence · medium · L`. Citations: `app/src/renderer/app/room-loaders.ts:25-65`, `app/src/renderer/features/right-rail/RightRailContext.data.ts:8-21`, `app/src/renderer/features/right-rail/RightRailTabs.tsx:83-103`. Action: decide whether Browser/Jorvis/Skills/Swarm are rooms, rail companions, or deliberately both before deprecating a surface. Verification trigger: product sign-off plus lifecycle tests preventing accidental simultaneous same-surface mounts.
- **[providers/deprecation] Retire compatibility scaffolding only after sign-off (C-048).** `Strong static evidence · low · M`. Citations: `app/src/shared/providers.ts:64-69,287-295`, `app/src/main/core/workspaces/launcher.ts:53-63`, `app/src/main/core/swarms/factory-spawn.ts:372-380`, `app/src/renderer/features/settings/ProvidersTab.tsx:19`. Action: inspect persisted and external provider definitions, then remove unused legacy/coming-soon/fallback branches and per-launch KV reads if compatibility is clear. Verification trigger: provider launch/resume/settings tests pass against migrated persisted data.
- **[rail/deprecation] Resolve the historical right-rail enable flag (C-052).** `Confirmed · low · M`. Citations: `app/src/renderer/features/right-rail/use-right-rail-enabled.ts:9-37`, `app/src/renderer/features/right-rail/RightRailContext.data.ts:23-31`, `app/src/renderer/app/App.tsx:188-205`. Action: migrate or explicitly preserve profiles with `rightRail.enabled=0`, then remove the read-only flag and identity normalizer. Verification trigger: persisted-profile migration plus rail boot tests.
- **[voice/consolidation] Merge duplicated model registries (C-050).** `Confirmed · low · L`. Citations: `app/src/main/core/voice/model-registry.ts:65-138`, `app/packages/voice-core/src/model-registry.ts:56-127`. Action: rewire both apps to one model catalog before deleting either live copy. Build trigger: download, abort, and tiny-model parity tests plus an Electron bundle diff.
- **[voice/consolidation] Merge duplicated dictionary normalization (C-051).** `Confirmed · low · S`. Citations: `app/src/shared/voice-dictionary.ts:45-70`, `app/packages/voice-core/src/global-capture.ts:41-88,609-610`. Action: rewire both apps to one normalizer before deleting either live copy. Verification trigger: normalization parity tests cover punctuation, case, and replacements.
- **[database/archive] Decide pending migration 0026 (C-054).** `Confirmed · medium · M`. Citations: `app/src/main/core/db/migrate.ts:91-98`, `app/src/main/core/db/__tests__/migrate.spec.ts:205-214`, `app/src/main/core/db/migrations/0026_sf12_pane_slot_repair.pending.ts:20`. Action: audit affected databases, then either sign off and register the repair or archive the migration and dormancy test with a written data decision. Verification trigger: production-ABI migration fixtures cover both upgraded and already-correct rows.
- **[repository/archive] Remove stale manifests and instructions (C-055).** `Confirmed · low · S`. Citations: `docs/marketplace/skills.json:1-4`, `app/public/marketplace/skills.json:1-5`, `sigma-voice/README.md:9-30`, `sigma-voice/package.json:1-18`. Action: remove the stale docs marketplace manifest and repair SigmaVoice build instructions against canonical sources. Verification trigger: docs/link checks and marketplace loading remain green.
- **[repository/archive] Decide storage for historical media (C-056).** `Confirmed · low · L`. Citation: `app/electron-builder.yml:7-10`; measurement receipt: audit C-056. Action: choose LFS/release storage for the measured 1,107 historical frames and ownership for unreferenced backgrounds. Verification trigger: tracked-size and packaged-inventory commands prove the move has no runtime payload regression.
- **[assistant/deprecation] Remove unreachable stub prose (C-057).** `Strong static evidence · low · S`. Citations: `app/src/main/core/assistant/controller.ts:631-643,1014-1021,1051-1060`. Action: delete `composeStubReply` after pinning the two forced-reply fallback paths. Verification trigger: focused assistant-controller tests cover missing-binary and driver-error responses.

## 🆕 New ideas (untriaged)

None. The inbox was cleared during this evidence-gated audit; new ideas should be added with a concrete trigger rather than mixed into verified findings.

## 🔬 Deep review findings (2026-07-24)

- **[P0 · dependencies] Rebuild deterministic installation (C-001).** `Confirmed · critical · M`. Citations: `.gitignore:120-127`, `app/package.json:15-33,35-109`, `app/pnpm-workspace.yaml:1-18`. Action: track a current lockfile and encode pnpm/native build approvals consistently. Build trigger: clean macOS and Windows jobs pass `pnpm install --frozen-lockfile`, native rebuild, compile, and launch against the identical graph.
- **[P0 · database] Redesign live restore (C-022).** `Confirmed · critical · XL`. Citations: `app/src/main/core/db/client.ts:414-454`, `app/src/main/core/memory/controller.ts:180-198`, `app/src/main/core/sync/engine.ts:159-169`, `app/src/renderer/features/settings/StorageTab.tsx:87-104`. Action: retain a usable original connection on failure and reconstruct every DB-owning service on success. Verification trigger: production-SQLite lock-failure rollback and successful service-rebind integration tests.
- **[P0 · memory] Remove or invalidate the stale full-body index (C-024).** `Confirmed · high · M`. Citations: `app/src/main/core/memory/manager.ts:339-406`, `app/src/main/core/memory/index.ts:88-109,127-156`, `app/src/main/core/memory/mcp-server.ts:304-334`. Action: remove the duplicate index or coherently invalidate it across processes. Verification trigger: two-process write/search tests never return stale hits and long-session heap use remains bounded.
- **[P0 · persistence] Serialize Markdown/SQLite commits (C-025).** `Strong static evidence · high · XL`. Citations: `app/src/main/core/memory/manager.ts:375-407`, `app/src/main/core/memory/db.ts:202-226`, `app/src/main/core/memory/storage.ts:124-159`. Action: add an inter-process commit/recovery design spanning database and atomic file replacement. Verification trigger: controlled two-process interleavings cannot leave divergent bodies.
- **[P0 · packaging] Prove packaged native voice (C-029).** `Strong static evidence · high · L`. Citations: `app/package.json:50-51`, `app/packages/voice-core/package.json:21-25`, `app/electron-builder.yml:7-10`. Action: explicitly include the intended macOS/Windows modules at runtime-resolved paths. Build trigger: unpacked-artifact smoke-load and live device availability on both target OSes.
- **[P1 · packaging] Prove packaged runtime icons (C-035).** `Strong static evidence · medium · M`. Citations: `app/electron/main.ts:165-185`, `app/src/main/core/notifications/os-notify.ts:144-153`, `app/electron-builder.yml:4-10`. Action: explicitly include tray/notification resources at runtime-resolved paths. Build trigger: unpacked-artifact tray and notification checks on macOS and Windows.
- **[P0 · smoke] Replace false-green RPC/navigation coverage (C-041).** `Confirmed · high · M`. Citations: `app/electron/preload.ts:33-39`, `app/tests/e2e/smoke.spec.ts:240-270,689-722`. Action: unwrap/assert RPC envelopes and fail on navigation or screenshot-step errors. Build trigger: CI fails on one injected RPC or navigation failure.
- **[P0 · performance] Enforce real budgets and lifecycle soaks (C-042).** `Confirmed · high · L`. Citations: `app/tests/perf/jank-review.spec.ts:123-191`; workflow-absence receipt: audit C-042. Action: enforce repeated per-platform latency/jank budgets and pane create/close memory/child-count soaks. Build trigger: CI fails on an exceeded budget or retained pane resource.
- **[P1 · process lifecycle] Unify awaited child-tree shutdown (C-007/C-036).** `Strong static evidence + Confirmed on POSIX · high · L`. Citations: `app/src/main/core/process/process-tree.ts:213-244`, `app/src/main/core/pty/registry.ts:642-675`, `app/src/main/core/review/runner.ts:166-183`, `app/src/main/rpc-router.ts:3723-3844`. Action: use one TERM→bounded wait→tree-KILL contract for PTYs and ReviewRunner before database close. Verification trigger: POSIX integration tests and Windows CI leave zero owned descendants.
- **[P1 · process tests] Replace lifecycle fakes/source-position assertions (C-044).** `Confirmed · medium · M`. Citations: `app/src/main/core/ruflo/supervisor.test.ts:20-41`, `app/src/main/core/ruflo/http-daemon-supervisor.test.ts:121-145`, `app/src/main/rpc-router.shutdown-order.test.ts:20-24`. Action: use real trapped child/descendant fixtures and direct shutdown behavior assertions. Verification trigger: tests fail when real exit semantics, descendant cleanup, or awaited shutdown order regress.
- **[P1 · startup] Move non-critical cleanup after first window (C-028).** `Strong static evidence · medium · M`. Citations: `app/electron/main.ts:1017-1018`, `app/src/main/rpc-router.ts:484-503`, `app/src/main/core/workspaces/worktree-cleanup.ts:159-177,235-250`. Action: preserve recovery invariants while scheduling bounded repository/image cleanup after usable UI. Verification trigger: repeated production cold-start traces show repository count and one slow Git prune no longer delay first window.
- **[P2 · startup] Lazily compose optional sync (C-030).** `Confirmed composition · low · M`. Citations: `app/src/main/rpc-router.ts:165,3244-3248`, `app/src/main/core/sync/controller.ts:12-31`, `app/src/main/core/sync/engine.ts:21-36`, `app/src/main/core/sync/git-client.ts:26-29`, `app/src/main/core/sync/crypto.ts:40`. Action: construct/import Git and crypto services only when sync is configured or invoked. Verification trigger: repeated production Electron startup benchmark plus complete sync behavior tests.
- **[P1 · account lifecycle] Clear late expected-exit state (C-008).** `Strong static evidence · medium · S`. Citations: `app/src/main/core/pty/claude-account-watch.ts:280-294`, `app/src/main/core/pty/registry.ts:522-531`, `app/src/main/core/pty/resume-launcher.ts:296-318`. Action: clear or token-scope `expectedExit` when account switching times out or continues. Verification trigger: a deterministic delayed-exit test proves later genuine exits persist and report normally.
- **[P1 · Windows/process] Give orphan cleanup profile ownership (C-038).** `Confirmed matching + Strong static kill trace · high · L`. Citations: `app/src/main/core/process/orphan-sweep.ts:30-49,69-101`, `app/src/main/rpc-router.ts:446-452`. Action: replace command-substring matching with a userData/profile PID registry or equivalent identity. Verification trigger: two concurrent Windows profiles cannot terminate each other's servers.
- **[P1 · assistant] Paginate and virtualize conversation history (C-014).** `Strong static evidence · medium · L`. Citations: `app/src/main/core/assistant/conversations.ts:150-177`, `app/src/renderer/features/jorvis-assistant/use-jorvis-conversations.ts:98-138`, `app/src/renderer/features/jorvis-assistant/ChatTranscript.tsx:118-181`. Action: add database pagination and transcript virtualization. Verification trigger: agreed-scale long-history heap and interaction measurements.
- **[P1 · assistant] Bound active pane-event history (C-015).** `Strong static evidence · medium · M`. Citation: `app/src/renderer/features/jorvis-assistant/use-jorvis-pane-events.ts:14-69`. Action: keep a bounded or persisted event window instead of cloning/rendering an unbounded array. Verification trigger: long-conversation tests enforce the agreed event bound.
- **[P1 · hidden rail] Stop inactive panel work (C-010).** `Strong static evidence · medium · M`. Citations: `app/src/renderer/features/right-rail/RightRail.tsx:108-127,195-242`, `app/src/renderer/features/right-rail/RightRailTabs.tsx:83-103`. Action: inactive panels must not keep filesystem/health/event subscriptions. Verification trigger: inactive-tab lifecycle tests show zero relevant RPC calls and listeners.
- **[P1 · editor] Release hidden shortcuts and drag resources (C-011/C-012).** `Strong static evidence · medium · S`. Citation: `app/src/renderer/features/editor/EditorTab.tsx:171-225,254-265`. Action: scope Cmd/Ctrl+S to the active editor and clean pointer/animation/body state on unmount. Verification trigger: hidden-editor and unmount-during-drag tests.
- **[P2 · swarm rail] Pause hidden derived scans (C-016).** `Strong static evidence · low · S`. Citations: `app/src/renderer/features/right-rail/RightRail.tsx:119-127,216-227`, `app/src/renderer/features/right-rail/SwarmRailTab.tsx:22-106`. Action: stop hidden subscriptions or memoized full-message scans. Verification trigger: inactive-tab updates perform no derived scan.
- **[P1 · terminal] Make renderer switching atomic (C-020).** `Strong static evidence · medium · M`. Citations: `app/src/renderer/features/command-room/Terminal.tsx:240-280`, `app/src/renderer/features/command-room/DomTerminalView.tsx:58-79`. Action: prevent the replacement host from creating its cache before the old renderer is destroyed. Verification trigger: switch tests prove exactly one live presenter/subscription throughout the transition.
- **[P2 · renderer memory] Evict lifetime session metadata (C-013).** `Strong static evidence · low · M`. Citations: `app/src/renderer/lib/renderer-flag.ts:30-70`, `app/src/renderer/lib/pty-data-bus.ts:25-31,53-59,98-112`. Action: evict closed sessions or scope storage to lifecycle owners. Verification trigger: repeated pane create/close soak returns each map/set to baseline.
- **[P2 · main memory] Evict deleted-conversation routes (C-027).** `Strong static evidence · low · S`. Citations: `app/src/main/rpc-router.ts:350-359`, `app/src/main/core/assistant/conversations.ts:259-265`. Action: delete cache entries with their conversation or use a lifecycle-scoped lookup. Verification trigger: repeated create/delete soak returns the cache to baseline.
- **[P2 · renderer startup] Replace all-room idle prefetch with measured warming (C-009).** `Strong static evidence · low · M`. Citations: `app/src/renderer/app/room-loaders.ts:24-125`, `app/src/renderer/app/App.tsx:289-295`. Action: prefetch only likely-next rooms or warm on input/viewport signals. Verification trigger: cold/idle bundle transfer and first-navigation measurements on representative hardware.
- **[P2 · query performance] Push mission event limits into SQL (C-026).** `Confirmed · low · S`. Citations: `app/src/main/core/missions/dao.ts:300-308`, `app/src/main/core/db/schema.ts:626-636`. Action: query indexed `ORDER BY ts DESC LIMIT ?` instead of loading, mapping, sorting, and slicing the full history. Verification trigger: production-ABI equivalence and large-history query tests.
- **[P2 · release time] Choose one native rebuild owner (C-031).** `Confirmed · low · S`. Citations: `app/package.json:24-32`, `app/electron-builder.yml:29-30`, `.github/workflows/release-macos.yml:81-94`, `.github/workflows/release-windows.yml:74-91`, `.github/workflows/release-linux.yml:65-68`. Action: remove duplicate native rebuild ownership. Build trigger: clean release duration comparison plus native launch smoke tests.
- **[P2 · package size] Measure and remove duplicate packaged output (C-032).** `Confirmed · low · M`. Citations: `app/scripts/build-electron.cjs:14-20`, `app/electron-builder.yml:7-10,25-33`; artifact-size receipt: audit C-032. Action: evaluate source-map shipping, duplicate renderer resources, and `asar` choices with artifacts. Build trigger: clean unpacked-size comparison plus native launch smoke tests.
- **[P1 · CI lifecycle] Restore pane/crash gates (C-043).** `Confirmed · high · M`. Citations: `app/tests/e2e/multi-workspace.spec.ts:175-188`, `app/tests/e2e/pane-split.spec.ts:42-69`, `.github/workflows/e2e-matrix.yml:83-103`. Action: repair stale RPC fixtures and run crash recovery plus pane split/preservation on supported OSes. Build trigger: each OS job exercises the repaired tests.
- **[P1 · packaged CI] Launch built artifacts on every target OS (C-046).** `Confirmed · high · XL`. Citations: `.github/workflows/e2e-matrix.yml:83-103`, `.github/workflows/release-macos.yml:113-139`, `.github/workflows/release-windows.yml:94-118`, `.github/workflows/release-linux.yml:71-95`. Action: add packaged application launch gates after build/upload preparation. Build trigger: macOS, Windows, and Linux jobs exercise the actual packaged executable.
- **[P1 · Windows/scripts] Make opt-in scripts shell-portable (C-047).** `Confirmed · medium · S`. Citation: `app/package.json:20-21`. Action: replace inline POSIX assignments with a cross-platform launcher or Node wrapper. Verification trigger: the perf and crash commands start under default Windows `cmd.exe` and POSIX shells.

---

## 🔬 Deep review findings (2026-07-24) — Kimi Code pane compatibility

Investigation into two user-reported Kimi Code issues, run on worktree
`SigmaLink-wt-kimi-code` (branch `fix/kimi-code-pane-rendering`).
Confirmed bugs below are `file:line`-cited with severity and effort.

### A. Pane DOM flickers while Kimi Code streams output

**Key mechanism:** Kimi Code's TUI (OpenTUI inline renderer, verified in the installed
`@moonshot-ai/kimi-code` binary) wraps every repaint frame in **synchronized output**
(`CSI ? 2026 h/l`) and repaints via erase-then-rewrite (`\r\x1B[2K`). It **never enters
the alternate screen** (no `1049`/`1047` in the binary) — so Kimi is the *only* major
provider that renders through SigmaLink's `FlowView`; claude/codex/opencode ride
`GridView` (alt screen), where the same artifacts are far less visible.
`@xterm/headless` 6.0.0 only *tracks* mode 2026 (`synchronizedOutput` flag, DECRQM
answer) — it does **not** defer buffer mutation between BSU/ESU. SigmaLink drops the
sync signal end-to-end.

- 🐞 **[high] Torn frames: 2026 sync-output frames painted mid-frame** — a Kimi repaint
  frame (erase line → rewrite line, tens of KB) is split across node-pty reads and the
  12 ms `PtyDataCoalescer` flush (`app/src/main/core/pty/pty-data-coalescer.ts:42-43,53`).
  The engine mutates the buffer as bytes arrive and the rAF notify
  (`app/src/renderer/lib/terminal-engine.ts:349-369`) can fire between the flush with
  the erases and the flush with the rewrites → FlowView paints the region **blank for
  one frame**, repeatedly, at token rate = persistent flicker.
  Fix: honor sync mode in the engine — register CSI handlers for `?2026h/l` (the
  `watch1006` pattern at `terminal-engine.ts:119-128` is the template) or read
  `term.modes.synchronizedOutputMode`; hold `scheduleNotify` while set, fire one notify
  on ESU. ~15 lines, single choke point. **Recommended first fix.** Effort: S.
- 🐞 **[medium] Scroll-pin churn in FlowView jiggles the whole transcript every frame** —
  `use-stick-to-bottom.ts:53-63` re-pins `scrollTop = scrollHeight` in a layout effect
  on every render plus a rAF re-assert; Kimi's live region re-wraps per token so
  `scrollHeight` oscillates, amplified by `content-visibility: auto` +
  `containIntrinsicSize: auto 17px` estimation (`FlowView.tsx:160-163`).
  Fix: only re-pin when scrollHeight grew beyond slop; drop the unconditional rAF
  re-assert during continuous output. Effort: S.
- 🐞 **[medium] Per-frame O(whole-buffer) extraction saturates the main thread** — every
  notify, `FlowView.tsx:233` calls `engine.logicalLines()` with **no window** (up to
  8000 scrollback rows re-stringified), then ~1500 `LineRow` memos re-compare freshly
  allocated strings (`FlowView.tsx:180-190`). Cost grows with transcript length; dropped
  frames read as flicker. Windowed extraction already exists
  (`terminal-engine.ts:211`) but is unused.
  Fix: window extraction to the render slice and/or cache logical lines between
  notifies; consider 30 fps notify throttle during streams. Effort: M.
- 🐞 **[low] Cursor visibility (DECSET 25) ignored — block cursor teleports during
  repaints** — both views render the block cursor unconditionally (`FlowView.tsx:129-159`,
  `GridView.tsx:38-67`); `terminal-engine.ts:196-202` doesn't even expose `cursorHidden`.
  Kimi hides the cursor while painting.
  Fix: expose `cursorHidden` in `modes`, gate the cursor span on it. Effort: S.
- **Ruled out:** missing batching (present at both layers: 12 ms main coalescer + rAF
  engine notify); React per-chunk state churn; remount/dispose cycles; Kimi-specific
  env/TERM handling (identical spawn env for all providers, `local-pty.ts:543-548`).
  The current branch `fix/pane-stale-render-esc-focus` is orthogonal — it targets
  restore-from-hidden/focus, not the streaming path (verified via diff).

### B. Pane label resets to the SigmaLink default when Kimi Code renames its session

**Context:** the header shows two slots (`PaneHeader.tsx:210-211`): **NAME**
(persisted `agent_sessions.name`, written only by `rpc.panes.rename` /
`set_pane_label`) and **LABEL** (ephemeral store `app/src/renderer/lib/pane-labels.ts:36-75`,
fed by (1) `pane-prompt-capture.ts` → cloud summarizer on every typed Enter, and
(2) `label-reader.ts` → `onAgentLabel` on a `SIGMA::LABEL` sentinel — **now dead code**,
the claude-only injection was removed and Kimi never emits it).

- 🐞 **[high] OSC 0/1/2 terminal titles are ingested nowhere** — the only OSC handler in
  the codebase is OSC 133 shell integration (`app/src/renderer/lib/terminal-engine.ts:134`).
  No `registerOscHandler(0|1|2)`, no `onTitleChange` anywhere; main-process byte scanners
  explicitly skip OSC. Kimi's rename title is consumed by xterm internally and dropped —
  the label stays whatever SigmaLink computed.
  Fix: add an OSC title sink mirroring the OSC-133 pattern (`registerOscHandler(2 /*and 0*/)`,
  sanitize, feed `onAgentLabel` — reuses the existing "agent override supersedes in-flight
  summary" plumbing, `pane-title-orchestrator.ts:47-51`). Effort: S–M.
- 🐞 **[high] Prompt-capture titler is last-writer-wins with no lock — renames get
  clobbered** — typing `/rename …` commits as a "prompt" (`pane-prompt-capture.ts:61-73`)
  and the summarizer retitles from it; the next substantive Enter overwrites it
  (`pane-title-orchestrator.ts:42`), and the generation counter (`:23-25,40-41`) can drop
  the rename-derived summary entirely inside the ~2 s window. No
  `labelLocked`/`customLabel`/`titleSource` concept exists.
  Fix: (a) give agent-provided titles a precedence tier above prompt summaries
  (`titleSource` flag in `pane-labels.ts` blocking `onPrompt` overwrites until a genuinely
  new task); (b) skip slash-command lines in `pane-prompt-capture.commit()` — a leading
  `/` is a CLI command, not a task, and shouldn't reach the cloud titler (privacy win too).
  Effort: S–M.
- 🐞 **[medium] Label-store GC clear can resurrect the default floor** — `clearAgentLabel`
  in `use-terminal-cache-gc.ts:56` fires when a session id transiently vanishes from
  `state.sessionsByWorkspace`; header then falls back to
  `summarizePrompt(session.initialPrompt)` = the SigmaLink default. A PTY burst →
  session-list refresh that transiently omits the session would produce exactly the
  reported "reset to default name".
  Fix: require N consecutive absent ticks before clearing. Effort: S.
- 🐞 **[low] NAME slot never agent-writable** — `PaneHeader.tsx:131-137` resyncs
  `localName` from the `session.name` prop on every session-prop change; Kimi's on-disk
  session name (`~/.kimi/sessions/<uuid>/state.json`) is read only for the resume picker
  (`session-disk-scanner.ts:617` maps `data.model`→`title`, never the session name).
  Fix: extend the kimi disk-scan capture to write `agent_sessions.name` only when the
  operator hasn't manually renamed. Effort: M.
- **Open question (needs a live probe):** what Kimi CLI actually emits on rename
  (OSC 0 vs 2 vs buffer text) — register a temporary OSC handler and log before
  implementing the OSC sink. Effort: S.

### C. `+` pane / Workspaces launch of kimi fails after updating Kimi Code (typed `kimi` in a plain terminal works)

**What changed on the kimi side (verified on disk):** Kimi migrated from the old Python
`kimi-cli` (config in `~/.kimi`) to a single-binary `kimi-code` v0.29.1 living **only**
at `~/.kimi-code/bin/kimi` (`which -a kimi` = exactly one hit; `~/.kimi/.migrated-to-kimi-code`
+ migration report confirm it ran Jul 24 02:03 local). The migration added
`export PATH="$HOME/.kimi-code/bin:$PATH"` to `~/.zshrc:30`. That dir is in **no**
system/default PATH — only fresh login shells see it.

- 🐞 **[critical] Stale `PATH` in the Electron main process — pre-flight ENOENT before
  any PTY spawns** — the app spawns kimi by bare name (`command: 'kimi'`,
  `app/src/shared/providers.ts:168-190`), and `spawnLocalPty` does a **synchronous
  pre-flight PATH resolution against Electron's own `process.env.PATH`**, throwing
  ENOENT before spawning: direct mode `app/src/main/core/pty/local-pty.ts:520-535`,
  shell-first mode (the default) `local-pty.ts:713-727` (H-9). `resolveAndSpawn` then
  throws `ProviderLaunchError('spawn-failed')` (`app/src/main/core/providers/launcher.ts:403-410`)
  → pane error banner via `app/src/main/core/workspaces/launcher.ts:746-756`. The PTY
  never starts. Electron's PATH is only enriched with the login-shell PATH by
  `startShellPathBootstrap`, which is a **no-op in dev**
  (`app/src/main/core/util/shell-path.ts:87-90` `isDev` check; wired at
  `electron/main.ts:978-989`) — a dev app keeps the PATH of whatever shell started it.
  The packaged app is also suspect: its cache
  `~/Library/Application Support/SigmaLink/shell-path-cache.json` (dated Jul 21)
  predates the migration, a warm boot applies it instantly (`shell-path.ts:92-101`),
  and `whenShellPathReady()` resolves immediately on a cache hit (`shell-path.ts:116`).
  A **plain terminal pane works** because it spawns `zsh -l` (`local-pty.ts:128-131`),
  which sources `~/.zshrc` itself. Verified: fresh `zsh -ilc` PATH has
  `~/.kimi-code/bin` at #1; the app's cached PATH lacks it entirely.
  Fix: don't let Electron's PATH hard-gate a binary the pane's own login shell can
  resolve — in shell-first mode either (a) skip/downgrade the H-9 pre-flight ENOENT
  throw (the injected `kimi` line resolves via `.zshrc`; the existing sentinel/exit-127
  path already handles genuine not-found), or (b) on pre-flight miss, lazily re-resolve
  PATH via a `zsh -ilc` probe before giving up. Also make `whenShellPathReady` wait for
  the live resolve instead of resolving instantly on cache hit. Effort: S–M.
  **User workaround until fixed:** restart the app from a fresh login shell (or, for the
  packaged app, wait a few seconds after boot before the first spawn).

**Migration fallout (same root: paths moved `~/.kimi` → `~/.kimi-code`):**

- 🐞 **[medium] MCP autowrite targets the old home** — `app/src/main/core/workspaces/mcp-autowrite.ts:135`
  writes `~/.kimi/mcp.json`; the new binary reads `~/.kimi-code/mcp.json`. Ruflo MCP
  silently stops being injected for kimi. Fix: target the new path with legacy fallback.
  Effort: S.
- 🐞 **[medium] Resume picker scans the old sessions dir** — `app/src/main/core/pty/session-disk-scanner.ts`
  reads `~/.kimi/sessions/<uuid>/state.json`; new sessions live under
  `~/.kimi-code/sessions/` with a different layout (`wd_<name>_<hash>/` buckets +
  `session_index.jsonl`, no `<uuid>/state.json`). Kimi resume-from-picker finds nothing.
  Fix: add the `~/.kimi-code` layout to the scanner. Effort: M.
- 🐞 **[low] Stale install metadata** — `app/src/shared/providers.ts:178-189` still
  claims kimi ships via PyPI (`pip install kimi-cli`); the new distribution is the
  `@moonshot-ai/kimi-code` single binary. The Install button would install the legacy
  package. Effort: S.
- **Ruled out:** version-probe gating (probe is UI-only, doesn't gate `resolveAndSpawn`);
  launch args/env mismatch (identical spawn env to plain panes, no `KIMI_*`/`MOONSHOT_*`
  in shell init); early-death/output sniffing (spawn throws before any PTY exists).

### Related cleanup

- **[kimi-code] Dead `SIGMA::LABEL` label-reader path** — `label-reader.ts` /
  `pane-label-scan.ts:11` scan for a sentinel nothing emits anymore (injection removed,
  per `pane-title-orchestrator.ts:10-11`). Either re-emit the sentinel for supported
  agents or remove the path. Effort: S.

---

## ✅ Promotions + 🔬 follow-up findings (2026-07-24, Phase 1 executed)

Phase 1 ([ROADMAP.md](ROADMAP.md)) was executed via subagent-driven development,
commits `608e062..7d89668` on branch `fix/kimi-code-pane-rendering`
(plan: `app/docs/superpowers/plans/2026-07-24-kimi-code-pane-compatibility.md`).

**Promoted & implemented** (kept above as history):

- ~~**[critical] Stale PATH pre-flight ENOENT breaks kimi launch**~~ → Phase 1 Task 1 (`608e062`).
- ~~**[high] Torn frames: 2026 sync-output painted mid-frame**~~ → Phase 1 Task 2 (`4bdcb39`).
- ~~**[high] OSC 0/1/2 titles ingested nowhere**~~ → Phase 1 Task 3 (`1e49560`) + post-review gate fix (`7d89668`).
- ~~**[high] Prompt-capture titler clobbers renames**~~ → Phase 1 Task 4 slash-skip (`2e9c2c1`);
  the `titleSource` precedence-tier half was superseded by the OSC sink's generation-bump override.
- ~~**[medium] Label-store GC clear resurrects the default floor**~~ → Phase 1 Task 5 (`c17e2f4`).
- ~~**[medium] MCP autowrite targets the old home**~~ → Phase 1 Task 6 (`73d7576`).
- ~~**[medium] Resume picker scans the old sessions dir**~~ → Phase 1 Task 7 (`4838a12`).
- ~~**[low] Stale install metadata**~~ → Phase 1 Task 8 (`cfa452a`).

**Still parked above (not in Phase 1):** FlowView scroll-pin churn, `logicalLines()`
windowing, DECSET-25 `cursorHidden` gating, NAME-slot sync from `state.json`,
shell-path cache freshness, dead `SIGMA::LABEL` reader removal.

**New findings captured during Phase 1 execution:**

- 🐞 **[medium] `verify.ts` + `mcp-diagnostic.ts` still read only legacy `~/.kimi/mcp.json`** —
  `app/src/main/core/ruflo/verify.ts:92`, `app/src/main/core/workspaces/mcp-diagnostic.ts:149`;
  on migrated installs the ruflo verify/diagnostic checks the dead path while autowrite now
  writes `~/.kimi-code/mcp.json`. Fix: mirror the Task 6 modern-first target selection. Effort: S.
- 🐞 **[low] Genuinely-missing CLI now shows a dead pane instead of the install hint** —
  Task 1's soft-miss means POSIX shell-first never reaches the launcher's
  `No usable command found … Install the CLI` error (`launcher.ts:405-410`); a missing
  binary prints `command not found` + exit 127 in the pane. Fix: watch for an immediate
  exit-127 sentinel and surface the provider's install hint in the pane/banner. Effort: M.
- 🐞 **[low] Codex `$`-prefixed skill commands still reach the pane titler** —
  `pane-prompt-capture.ts` skips `/` only; codex skill commands use `$`
  (`insertSkillCommand.ts`). Fix: extend the command-prefix skip to `$`. Effort: S.
- **[hardening] Fix-later batch from the whole-branch review** (all ≤5 lines, one PR):
  prune `missCount` with `everSeen` (`use-terminal-cache-gc.ts:86-88`); one-line `resize()`
  comment re: notify during held sync frame; `onTitleChange` docstring ("raw" → trimmed);
  scanner dedupe root order so modern metadata wins; restore `process.env.PATH` in the
  rewritten local-pty test; OSC 1 handler parity in the engine path (xterm path already
  fires for it); record the node-pty `spawn-helper` chmod env quirk for fresh worktrees
  (a reinstall loses the execute bit and real-spawn tests get the fake `pid:-1` handle).
- **[testing] Cross-task composition tests** — pin the interactions this branch is about:
  a title arriving mid-sync-frame (Tasks 2×3), an OSC rename surviving a transient GC
  miss (Tasks 3×5), and a gated shell pane not forwarding titles end-to-end (Task 3-fix).
