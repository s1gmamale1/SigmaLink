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

- **[command-room/control-plane] Expose presentation order through control APIs.** `Confirmed · medium · M`. The renderer now persists visual order separately from `pane_index`, while `get_app_state.orderedSessionIds` still describes storage-slot order. Action: either publish the same presentation order main-side or rename the control-plane field so automation cannot mistake launcher slots for visual positions. Verification trigger: renderer and control snapshots agree after reorder/restart without mutating `pane_index`.
- **[command-room/multi-window] Broadcast pane-order changes between live windows.** `Confirmed · medium · M`. V1 persistence deliberately uses last-explicit-write-wins KV semantics; another window viewing the same workspace does not update live. Action: add a versioned layout-change event with stale-write protection. Verification trigger: two windows converge after alternating swaps and reload to the same durable order.
- **[command-room/reordering] Evaluate explicit before/after insertion only after swap dogfood.** `Deferred by design · low · M`. V1 exchanges exactly two target slots to minimize cross-row remounts. Action: prototype visible insertion gaps without `@dnd-kit/sortable` only if operators need free-form sequencing. Verification trigger: 3/5/7/12-pane geometry, focus, scrollback, and refit receipts remain equivalent to exact swap.
- **[command-room/layout] Harden persisted resize-fraction parsing.** `Strong static evidence · low · S`. `PaneGrid.parseFracs` validates array shapes and numeric types but not finite, positive, normalized fractions. Action: reject invalid persisted geometry before adding further layout dimensions. Verification trigger: malformed/NaN/infinite/negative/zero fixtures all fall back to even tracks.
- **[command-room/keyboard] Implement or remove the advertised pane-focus shortcut.** `Confirmed · low · S`. The UI advertises `Cmd/Ctrl+Alt+N`, but no matching handler was found during the reorder audit. Action: bind it to current visual order or remove the affordance. Verification trigger: cross-platform keyboard tests match the rendered pane ordinal after swaps.
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

## 🔬 Deep review findings (2026-07-29) — hardware-load optimization (#247 · #248)

Parked during the PR #247/#248 review loop. All three are the *same defect class*
— an operator-copyable shell command built by string interpolation without a
shared quoter. #248 fixed it at one site only.

- **[control/providers · shell-quoting] Build every operator-copyable command through ONE shared quoter (C-058).** `Confirmed · medium · M`. Citations: `app/src/main/core/control/control-rpc.ts:52-67`, `app/src/shared/provider-install.ts:4`, `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx:186,195`. Three independent sites format shell commands for the operator to paste: `quoteArg` (added #248, platform-aware, no escaping), `shellJoin` (escapes, posix-only), and a raw `cmd.join(' ')` (no quoting at all). Action: promote one quoter — platform-aware *and* escaping — into `src/shared/` and route all three through it. Verification trigger: a table test covers win32 + posix × {space in path, embedded quote, shell metacharacter} for every command-emitting surface.
- **[providers] Quote the provider install command before display and copy (C-059).** `Confirmed · medium · S`. Citations: `app/src/renderer/features/workspace-launcher/ProviderInstallModal.tsx:186,195`, `app/src/shared/providers.ts:243`. `cmd.join(' ')` renders and clipboard-copies an argv array unquoted, so cursor-agent's darwin/linux entry (`['bash','-c','curl https://cursor.com/install -fsS | bash']`) displays as `bash -c curl https://cursor.com/install -fsS | bash`. Pasting that runs `bash -c curl` with `$0` = the URL and `$1` = `-fsS`; bare `curl` writes its usage to **stderr**, so stdout is empty and `| bash` receives an empty stream. Nothing installs and the operator sees a silent no-op. The in-app spawn path is unaffected — it passes the argv array to the PTY correctly. Action: format the display/copy string with the shared quoter from C-058. Verification trigger: the rendered string for every provider round-trips through a shell tokenizer back to the original argv array.
- **[control] Escape embedded quotes in `quoteArg` on POSIX (C-060).** `Confirmed · low · S`. Citation: `app/src/main/core/control/control-rpc.ts:52-67`. `quoteArg` wraps in `'` on posix without escaping. Unreachable on win32 (`"` is a reserved path character; the pipe is `\\.\pipe\` + hex and the token is `randomBytes(32).toString('hex')`), but reachable on macOS/Linux: an app at `/Users/x/Leo's Apps/SigmaLink.app/...` closes the quote at `Leo`, word-splits, and reopens an unterminated quote that swallows the serverEntry — the shell drops to a `quote>` continuation prompt instead of running. Action: posix branch → `'${v.replace(/'/g, "'\\''")}'`, the escaping `shellJoin` already uses. Verification trigger: a path containing `'` tokenizes back to one argv entry.
- **[mcp] detect repeated stdio MCP starts under one Codex/Claude pane** — DIAGNOSED + CONTAINED (branch `fix/windows-ram-leakage`, off `origin/main`; verification doc `docs/07-test/windows-ram-leakage-verification.md`). A single pane could accumulate multiple `@claude-flow/cli mcp start` descendants; on Windows a live sample showed ~4 such node children ≈ 1.57 GB. Now: `pty.processStats.mcp` classifies + chain-collapses claude-flow stdio MCP descendants (`summarizeMcpProcesses`, ADR-013); Windows suppresses managed Codex stdio Ruflo by default with a KV opt-in (ADR-011); and an observed-process RAM brake blocks launches over the duplicate-stdio / RSS caps (ADR-012). **Still open (root cause, not just containment):** *why* Codex re-spawns the stdio server repeatedly — Codex plugin behavior vs config reload vs leaked-child cleanup — now investigable via the new `processStats.mcp` history. Effort: M.

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

## 🔬 Deep review findings (2026-07-24) — notification system

**Status:** Investigation complete. State-consistency workstream implemented and verified on
2026-07-25; window routing, native lifecycle/packaging, producer semantics, durable attention, and
UX/digest/accessibility remain open. This section preserves the original audit evidence and tracks
the remediation program against it.

### Scope and evidence standard

- Trace every production path from notification-worthy event through eligibility,
  preference/permission checks, construction, OS delivery, click/action routing, and cleanup.
- Compare behavior across macOS, Windows, and Linux, including foreground/background,
  startup/shutdown, sleep/wake, and restored-session paths where implemented.
- Inspect tests and run reproducible checks; a code smell is not a confirmed bug without a
  reachable failing path, violated contract, or demonstrable missing invariant.
- Record each confirmed issue with severity, effort, concrete impact, root cause, and precise
  `file:line` citations. Keep unproven hypotheses visibly separate.
- The 2026-07-24 evidence below is the pre-fix baseline. Implementation outcomes are recorded in a
  separate dated subsection so the original diagnosis remains auditable.

### Investigation log

- **2026-07-24 — isolated baseline created.** Worktree
  `/Users/aisigma/projects/SigmaLink-wt-notification-audit-2026-07-24`, branch
  `audit/notification-system-2026-07-24`, base `80065c3f9ef1d9c0b32eecd3401230ee2b831d06`.
- **2026-07-24 — setup caveat (environment, not a notification finding).** `pnpm install`
  resolved and linked 781 packages but exited nonzero under pnpm 11's build-approval policy:
  dependency build scripts were blocked and `electron-builder install-app-deps` could not find
  `prebuild-install`. Pure TypeScript/jsdom tests remained runnable; do not misattribute this
  fresh-worktree setup issue to notification behavior.
- **2026-07-24 — focused baseline is green.**
  `pnpm exec vitest run src/main/core/notifications src/shared/notification-prefs.test.ts
  src/renderer/features/notifications src/renderer/features/settings/NotificationsSettings.test.tsx
  src/renderer/lib/sounds.test.ts` passed **14 files / 177 tests / 0 failures**. A green unit
  slice is evidence that encoded behavior is internally consistent, not that Electron/OS delivery
  works end to end.
- **2026-07-24 — adjacent integration baseline is also green.** Startup/live-event, reducer,
  attention-detector, RPC-wiring, and notification-migration tests passed **6 files / 128 tests /
  0 failures**. Across the two root-run slices that is **305 passing assertions**; an independent
  reviewer ran a partly overlapping 240-test notification/attention/sound slice with zero failures.
  `pnpm exec tsc -b --pretty false` also exited 0. These results strengthen the conclusion that the
  remaining defects occupy missing scenarios and broken contracts rather than currently asserted
  behavior.
- **2026-07-24 — prior-memory search returned no notification-system entries.** Ruflo/AgentDB
  semantic search found zero matching memories, so no inherited diagnosis was treated as evidence.
- **2026-07-24 — seven independent review assignments completed in three bounded waves.** The
  scopes were architecture/history, manager/sources, renderer/settings, OS/platform delivery,
  lifecycle/reliability, tests/reproductions, and adversarial synthesis. The last reviewer was
  instructed to disprove/downgrade candidates and caught one false claim: daily-summary Settings
  *do* live-rearm through the generic KV controller (`app/src/main/rpc-router.ts:2669-2684`).
- **2026-07-24 — final fresh verification.** A single relevant-system run passed **24 files / 349
  tests / 0 failures**; `pnpm exec tsc -b --pretty false` exited 0. Four temporary, outside-repo
  probes using production helpers reproduced: failed-show throttle consumption, live-delta loss to
  stale hydration, off-page critical badge misclassification, and failed optimistic-mutation drift.
  `git diff --check` exited 0; final repository status contains only the intentionally rewritten
  `WISHLIST.md`.
- **2026-07-24 — Ruflo receipts closed.** All seven audit task records are completed and the
  post-task hook persisted trajectory `traj-1784920284401`. Generic `memory_store` correctly
  refused an unsafe whole-image write while a native WAL connection was active; the concise audit
  pattern was instead stored successfully through AgentDB's semantic hierarchical controller as
  `sigmalink-notification-audit-2026-07-24`.

### Implementation progress (2026-07-25) — workstream 1: state consistency

**Result:** Merged to `main` in PR #244 as squash commit `28c2a9e` after a 94/100 sigma check. The authoritative
store/change-set protocol is now versioned, transactional, race-safe, and pageable. This closes the
soft-cap data-loss/delta bug, the startup hydration race, inaccessible retained history, and
off-page urgency misclassification. It does not claim to fix native delivery, activation routing,
producer semantics, durable attention, or digest/accessibility findings.

- **Protected retention and visible collapse summaries — fixed.** Soft-cap victims are restricted
  to unread `info`/`warn` rows; unread `error`/`critical` rows are never selected. A newly inserted
  collapse summary is returned in the emitted `added` lane so all live consumers see the same state.
  Regression coverage includes protected severities and summary delivery. Commit `e1dd4c6`.
- **Persisted version clock and authoritative counts — implemented.** Migration 0043 creates the
  singleton notification-state revision. Every changing manager operation advances it and emits
  global unread counts split across `info`, `warn`, `error`, and `critical`; no-op mutations do not
  advance it. Commits `865c716` and `cd71d22`.
- **Mutation/revision atomicity — implemented.** Row mutation, revision increment, and post-mutation
  count construction now share one SQLite transaction; change sets are emitted only after commit.
  Forced revision failures cover add, mark-read, mark-all-read, mark-unread, dismiss, clear-read,
  and GC rollback. Commit `2106dd8`.
- **Atomic hydration and stable paging — implemented.** `notifications.snapshot` returns revision,
  counts, the newest page, and an opaque keyset cursor from one read transaction.
  `notifications.page` orders by `(created_at, id)` descending, validates cursors, preserves filters,
  and avoids duplicate/gapped traversal when timestamps match. Commits `3141982` and `e23f79d`.
- **Startup/live reconciliation — fixed.** Renderers subscribe before requesting the snapshot,
  buffer live change sets during hydration, reject stale snapshots, apply only consecutive
  revisions, refetch on gaps, and retry failed hydration at bounded delays. Malformed/unversioned
  envelopes are rejected instead of silently zeroing state. Commit `050b904`.
- **History and urgency UI — fixed for loaded paging contract.** Bell badge color/pulse now uses
  authoritative global severity counts, including off-page critical rows. The dropdown exposes
  accessible load/loading/retry/end controls and appends unique cursor pages. Filters remain local
  over loaded pages; server-side search/filter pagination stays in the later UX workstream. Commit
  `172e966`.
- **Legacy hydration RPCs removed; boundary validation tightened.** No renderer consumers remained,
  so `notifications.list` and `notifications.unreadCount` were removed from the controller,
  allowlist, and router shape. Concrete enforced schemas were added for the authoritative snapshot
  and page inputs. Internal manager methods remain for the main-process control snapshot. Commit
  `80a7cb0`.
- **Post-review renderer consistency hardening — fixed.** Malformed snapshot/change-set rows now
  trigger recovery instead of entering UI state. Older-page responses are bound to both their
  source cursor and authoritative revision, filter changes cannot unlock an active page request,
  and equal-revision recovery replaces the authoritative first-page window without discarding
  pages already loaded below it. Failed optimistic mark-read/dismiss RPCs now restore the original
  row unless an authoritative change for that same row has superseded it. Per-row write guards
  survive dropdown close/reopen cycles, preventing overlapping mark-read/dismiss compensation
  chains; reducer-owned per-row mutation tokens let unrelated revisions advance without suppressing
  compensation and still reject stale same-row rollback. Snapshot,
  live-change, and older-page responses now share complete runtime row validation; severity buckets
  must sum to the aggregate unread count, and legacy unknown database severities normalize to `info`
  without being dropped. The pending live-change buffer is capped at 256 entries; overflow drops an
  old revision so the existing gap detector forces snapshot recovery instead of allowing unbounded
  growth. Navigation is immediate and remains available while row mutation controls are locked.
  Dead pre-versioning reducer actions and obsolete envelope documentation were removed. Raw severity
  filters and retention lanes use the same normalization, so legacy unknown rows remain pageable
  and eligible for `info` retention. Gap refetches retain the `retrying` hydration state throughout
  recovery.
  Regression coverage exercises malformed rows and counts, live mutation and recovery during
  pagination, duplicate loads across filter changes, divergent equal-revision
  snapshots, failed/overlapping optimistic writes, and unknown legacy severities. PR #244.
- **Windows argv-smoke path — hardened.** Hosted Windows proved that Windows PowerShell 5.1's npm
  `.ps1` path both mutates quote/empty argv while forwarding to Node and closes its nested output
  collector slowly. Legacy PowerShell now deliberately uses the existing direct `.cmd` path, whose
  two-pass escaping preserves argv without a nested collector; PowerShell 7 keeps shell-first mode.
  The hosted assertion accepts Windows' case-insensitive `.CMD` resolution. The hosted Windows smoke
  remains the required proof because these paths are platform-specific.
- **Verification receipts.** Focused gate: **10 files / 233 tests / 0 failures**. Broader pure
  notification gate: **23 files / 366 tests / 0 failures**. `pnpm exec tsc -b --pretty false`,
  focused ESLint, and `git diff --check` all exited 0. The original fresh-worktree dependency-build
  restriction still prevents a trustworthy Electron/native-platform end-to-end run; packaged
  macOS/Windows/Linux delivery remains an explicit later gate, not silently counted as passing.
  Post-review compensation gate: **2 files / 88 tests / 0 failures**; the complete coverage suite
  (**486 files / 0 failures**), full lint, TypeScript build, production build, and diff check all
  exited 0. Final review-remediation gate: **5 files / 196 tests passed / 1 platform skip**; the
  complete coverage suite passed **487 files / 5,087 tests / 3 skips**, and full lint, TypeScript,
  production build, and diff check all exited 0. Remaining-issue retry: **6 files / 291 tests
  passed / 1 platform skip**; the complete coverage suite passed **487 files / 5,091 tests / 3
  skips**, and full lint, TypeScript, production build, and diff check all exited 0.
  Second sigma remediation: **487 files / 5,082 passed / 3 skipped**; full coverage, lint,
  TypeScript production build (**2,131 modules**), and diff check all exited 0.
  Hosted CI passed **6/6**, including the dedicated Windows Win32 spawn/PTY lifecycle lane;
  CodeRabbit reported zero findings across 35 changed files and the security sweep found no
  Critical/High issues.
- **Program documents.** Umbrella design:
  `docs/superpowers/specs/2026-07-25-notification-reliability-program-design.md`. Workstream design:
  `docs/superpowers/specs/2026-07-25-notification-state-consistency-design.md`. Executed plan:
  `docs/superpowers/plans/2026-07-25-notification-state-consistency.md`.

### How the system actually works

- **Durable pipeline.** PTY/CLI exits, specially-gated swarm messages, assistant tool failures,
  disk-guard/MCP/Ruflo/bridge diagnostics, and the daily summary call one main-process
  `NotificationsManager`. It persists SQLite rows, applies dedup/retention, and emits one versioned,
  post-commit change set with authoritative counts. The router broadcasts that change set to every
  renderer, attempts native delivery for each `added` row, and forwards new rows into the daily-note
  digest.
- **Renderer pipeline.** Each window subscribes first, hydrates one versioned snapshot, reconciles
  buffered/consecutive change sets, and pages older rows with an opaque cursor. Every window
  reconciles state, but only the main window creates toast/tone side effects
  (`app/src/renderer/app/state-hooks/use-live-events.ts:564-698`). The breadcrumb bell and dropdown
  also exist only in the main shell.
- **Native pipeline.** `OsNotifier` gates by platform support, master setting, any-window focus,
  severity, DND/quiet hours, source mute, and a five-minute key throttle, then constructs an Electron
  `Notification` (`app/src/main/core/notifications/os-notify.ts:156-218`). Migration 0038 makes the
  master setting default-on unless the operator explicitly stored `0`; default severity still omits
  `info`.
- **Attention is a different system.** A BEL/4-second-idle detector emits transient
  `agent:attention`; renderer state drives pane/workspace glow and an attention tone. It deliberately
  bypasses the notification DB, bell, toast, and native notifier. This split—not merely an OS
  permission problem—is load-bearing to the operator-visible failures below.

### Confirmed bugs (pre-fix evidence; see implementation status above)

- **CRITICAL · M — The soft cap destroys must-see unread rows and then hides its replacement.**
  Once one `(workspace_id, kind)` exceeds 200 unread rows, the victim query deletes the oldest 50
  without a severity predicate (`app/src/main/core/notifications/manager.ts:404-457`). Repeated
  critical events bypass dedup and can therefore drive this path (`manager.ts:159-161`). Unread
  `error`/`critical` rows are permanently replaced by a single `info` summary despite the manager's
  protected-severity invariant (`manager.ts:490-563`). The summary is inserted but the method
  returns only victim IDs; `add()` broadcasts the triggering row rather than the summary
  (`manager.ts:459-487,259-268`). Live renderers, native delivery, toast/tone, and the digest all
  miss the summary while the authoritative count includes it. Tests seed only `info` victims and
  inspect DB state, never protected severities or `delta.added`
  (`app/src/main/core/notifications/manager.test.ts:880-972`).

- **HIGH · M — The primary “agent needs me” signal is transient and can be lost forever.**
  Question/turn-finished detection uses `agent:attention`, not `NotificationsManager`; the event is
  only routed to renderer glow/sound (`app/src/main/rpc-router.ts:698-748`,
  `app/src/renderer/app/state-hooks/use-live-events.ts:68-89`). It has no DB row, toast, or native
  notification by explicit design
  (`docs/superpowers/specs/2026-06-14-agent-attention-notifications-design.md:55-69,135-139`).
  SigmaLink can keep the router and PTYs alive with zero windows, while `sendToAll()` over zero
  handles is a no-op (`app/electron/main.ts:1043-1066`,
  `app/src/main/core/windows/registry.ts:95-99`). Any attention emitted then is unrecoverable because
  a reopened renderer has no attention snapshot to hydrate. The detector retains a main-process
  in-memory map (`app/src/main/core/pty/attention-detector.ts:47-49,79-85`), but no RPC/window-create
  path replays it, so it is operationally lost to the operator. This is the central reason an
  operator away from the app can receive nothing when an agent finishes a turn or waits for input.

- **HIGH · M — Rows after the newest 100 are permanently inaccessible and hidden urgency is
  misrepresented.** Startup fetches only `{limit:100, offset:0}` while claiming infinite scroll
  (`app/src/renderer/app/state-hooks/use-live-events.ts:564-583`); the dropdown never requests a
  later page (`app/src/renderer/features/notifications/NotificationDropdown.tsx:45-64,207-272`).
  Storage retains 500+ and exposes real pagination (`app/src/main/core/notifications/manager.ts:36-44,271-303`).
  Older rows cannot be opened/dismissed. The badge count is global but red/critical/pulse state is
  derived only from the loaded slice (`app/src/renderer/features/notifications/NotificationBell.tsx:24-62`).
  A production-helper probe with 101 unread and the critical row off-page produced a gray,
  non-pulsing badge.

- **HIGH · S-M — Startup hydration can erase newer live state and never retries.** Hydration takes
  a list snapshot, separately awaits `unreadCount`, then performs a full replacement
  (`app/src/renderer/app/state-hooks/use-live-events.ts:569-591`,
  `app/src/renderer/app/state.reducer.ts:834-840`) while a separate listener merges deltas
  (`use-live-events.ts:593-619`). A deferred-snapshot probe reproduced a live added row being
  overwritten, leaving `unreadCount=1` with an empty list. The catch silently abandons hydration
  for the session; no retry/reconnect exists.

- **HIGH · M — Click/navigation contracts are broken on every notification surface.** In-app
  routing changes the room but never activates `notification.workspaceId`, so a background-workspace
  notification opens the corresponding room in the wrong workspace
  (`app/src/renderer/features/notifications/helpers.ts:177-216`). Its three
  `sigma:scroll-to-*` events have no production listeners; Jorvis listens for the different
  `jorvis:jump-to-message` event (`app/src/renderer/features/jorvis-assistant/use-jorvis-jump-to-message.ts:67-92`).
  Native clicks only focus `focusedWindow ?? all[0]`, with no source routing or read update; with no
  live window the click does nothing (`app/src/main/core/notifications/os-notify.ts:134-143,200-218`).
  Tests stop at callback or `SET_ROOM` assertions rather than mounted target arrival.

- **HIGH · M — A focused detached window can have no visible durable alert surface.** Every
  renderer receives the delta, but scoped windows exit before toast/tone work
  (`app/src/renderer/app/state-hooks/use-live-events.ts:636-640`) and `ScopedShell` has no bell
  (`app/src/renderer/app/ScopedShell.tsx:41-53`). Native banners are simultaneously suppressed when
  *any* SigmaLink window is focused (`app/src/main/core/notifications/os-notify.ts:132-166`). The
  main window may receive a toast behind/while hidden, but the window the operator is using shows
  nothing. With DND, even the hidden-main sound is suppressed despite critical normally bypassing
  DND visually. The scoped-window test enshrines “never toast/tone” without proving an alternative
  surface (`app/src/renderer/app/state-hooks/use-live-events.test.ts:655-679`).

- **MEDIUM · M — Native delivery is reported as successful before the OS outcome is known.**
  Construction occurs outside the `try`; `show()` returns no delivery result, and the notifier
  observes neither `show` nor `failed` lifecycle events before returning `true`
  (`app/src/main/core/notifications/os-notify.ts:200-240`). Automatic-path failures are swallowed
  by the manager/router; Settings maps the synchronous result to “Sent” even if the OS later rejects
  it (`app/src/renderer/features/settings/NotificationsSettings.tsx:125-131,233-258`). Electron's
  capability probe is not authorization/delivery proof. This explains why green unit tests and a
  “sent” self-check can coexist with no banner.

- **MEDIUM · S-M — Normal swarm traffic cannot satisfy the notification source gate.** The adapter
  accepts only `swarm-broadcast`, `escalation`, `review_request`, or `error_report`, then requires
  `payload.broadcastToSidebar === true`
  (`app/src/main/core/notifications/sources/swarm-message.ts:28-55`). Canonical UI broadcast is
  `kind:'OPERATOR'` with no flag (`app/src/main/core/swarms/protocol.ts:135-145`,
  `app/src/renderer/features/swarm-room/SideChat.tsx:221-235`), and no production producer sets the
  flag. The passing test fabricates `swarm-broadcast as unknown as SwarmMessageKind` and injects it
  (`app/src/main/core/notifications/sources/swarm-message.test.ts:44-55`). An external caller can
  forge the generic payload, but shipped UI/built-in agent traffic cannot reach the source.

- **MEDIUM · S — Active-but-minimized panes suppress their own attention.** The renderer drops
  attention whenever the document is focused and the session is active
  (`app/src/renderer/app/state-hooks/use-live-events.ts:76-85`). Minimizing keeps that session active
  while hiding its body (`app/src/renderer/app/state.reducer.ts:824-832`,
  `app/src/renderer/features/command-room/PaneShell.tsx:462-470,527-538`). A question/finish event
  from the hidden pane produces neither glow nor sound.

- **MEDIUM · S — Expected/preflight tool rejections are misclassified as must-see critical failures.**
  Severity depends only on tool name (`app/src/main/core/notifications/sources/tool-error.ts:23-47,62-91`).
  The same `ok:false` trace is emitted before a handler runs for denied authorization, frozen control,
  pending approval, and invalid input (`app/src/main/core/assistant/controller.ts:295-382`). A
  rejected/invalid `create_workspace`, `launch_pane`, etc. therefore becomes critical and bypasses
  DND even though no mutation or inconsistent state occurred. Tests assert the name-only mapping
  and have no failure-phase concept.

- **MEDIUM · S — Notification persistence can break the recovery path it is reporting.** Three
  disk-guard catches invoke `notifications.add()` without isolation
  (`app/src/main/core/workspaces/launcher.ts:746-796`,
  `app/src/main/core/swarms/factory-add-agent.ts:188-223`,
  `app/src/main/core/swarms/factory-spawn.ts:709-740`). A DB/disk failure there can skip worktree
  rollback/error-session creation, skip the mailbox failure record, mask the original error, or
  violate the roster loop's “never throw” contract. This is especially relevant because disk
  pressure is the precise failure being reported.

- **MEDIUM · S — One throwing window can starve later windows and native delivery.**
  `WindowRegistry.sendToAll()` has no per-handle catch
  (`app/src/main/core/windows/registry.ts:95-99`). The notification callback broadcasts before it
  invokes native delivery/digest (`app/src/main/rpc-router.ts:643-665`), and the manager swallows the
  whole callback exception (`app/src/main/core/notifications/manager.ts:571-582`). One stale
  renderer can therefore prevent subsequent windows and the OS from seeing a persisted row.

- **MEDIUM · S — Native retry/throttle state is committed incorrectly.** The five-minute timestamp
  is stored before native construction/show, so a transient failure suppresses the next legitimate
  attempt (`app/src/main/core/notifications/os-notify.ts:192-218`). A production-class probe
  reproduced one throwing `show()` followed by a throttled retry. The map is also keyed only by
  `dedupKey`, whereas manager dedup is workspace-scoped; generic disk-guard/Ruflo keys in workspace A
  suppress the same alert from workspace B for five minutes.

- **MEDIUM · S — The configured notification icon is absent from packaged applications.** Runtime
  resolves `<appPath>/build/icon.png|ico` (`app/src/main/core/notifications/os-notify.ts:144-153`),
  but builder `files` packages only `dist`, `electron-dist`, and `package.json`, and `extraResources`
  adds only `dist` (`app/electron-builder.yml:4-10,31-33`). `buildResources` supplies build-time
  assets; it does not put `build/` under `app.getAppPath()`. The missing icon's platform outcome
  (fallback icon versus native failure) still needs packaged probes.

- **LOW · M — Rejected preference writes leave false UI state.** Row-level mark-read/dismiss
  rollback is fixed in PR #244. Settings still update local state then discard KV failures, and one
  failed member of the hydration `Promise.all` renders defaults for every preference
  (`app/src/renderer/features/settings/NotificationsSettings.tsx:83-194`); sound setters also
  swallow persistence failure (`app/src/renderer/lib/sounds.ts:224-267`).

- **MEDIUM · S — Dedup-absorbed errors can stack permanent duplicate toasts.** An absorbed row is
  intentionally re-emitted in `added` (`app/src/main/core/notifications/manager.ts:217-221`). Each
  re-emission creates a new error/critical toast with `duration:Infinity` and no stable toast id
  (`app/src/renderer/app/state-hooks/use-live-events.ts:641-689`), replaying the tone and piling up
  permanent copies of one logical row.

- **MEDIUM · M — Shell-first dedup state can hide a later unrelated crash.** A CLI sentinel adds
  the session id to a process-lifetime Set (`app/src/main/rpc-router.ts:1115-1133`); shell-first mode
  deliberately keeps the PTY alive. The marker is removed only by a later PTY-exit event
  (`rpc-router.ts:1085-1093`,
  `app/src/main/core/notifications/sources/pty-exit-dedup.ts:1-10`). If that shell is reused and later
  crashes, the stale marker consumes/suppresses the real crash. Tests cover Set semantics, not
  sentinel → reuse → crash lifecycle.

- **MEDIUM · S-M — The “once-daily” summary can fire twice and undercounts deduplicated events.**
  Its same-day key is claimed to prevent duplicates, but manager dedup lasts only 30 seconds
  (`app/src/main/core/notifications/digest-builder.ts:12-14,100-108`,
  `app/src/main/core/notifications/manager.ts:32-34,161-188`). After today's first fire, changing
  Settings to a later same-day time re-arms and inserts a second row
  (`app/src/main/rpc-router.ts:2669-2684`). The query selects only kind/severity and counts rows,
  ignoring `dup_count`; dedup also moves `created_at`, making exact cross-midnight attribution
  impossible (`rpc-router.ts:1384-1391`, `digest-builder.ts:32-44,69-98`, `manager.ts:189-209`).

- **LOW · S — Daily-summary shutdown has a late-cancel window.** Shutdown starts before potentially
  awaiting daemon drains, but cancels the scheduler only near the end
  (`app/src/main/rpc-router.ts:3671-3675,3767-3775,3807-3811`). A timer can persist and surface a
  summary while the app is quitting.

- **LOW · S — Several smaller consistency/accessibility defects survive.** `pty-exit-summary` maps
  to `system`, so it would not inherit PTY mute/grouping once summary delivery is fixed
  (`app/src/shared/notification-prefs.ts:65-75`). Legacy `notifications.sound='0'` mutes info/warn/error
  but not critical (`app/src/renderer/lib/sounds.ts:101-115`). Row action controls are pointer-hover
  only with no focus-within reveal (`app/src/renderer/features/notifications/NotificationItem.tsx:123`),
  and sound/time inputs lack associated accessible labels
  (`app/src/renderer/features/settings/NotificationsSettings.sound.tsx:131`,
  `NotificationsSettings.tsx:318-334,383-390`).

### Recommended root-cause fix order

1. **COMPLETED 2026-07-25 — Repair the authoritative store/change-set protocol.** Collapse is now
   atomic and severity-safe; every changed row is emitted; versioned snapshots, cursor paging, and
   authoritative severity counts now drive renderer reconciliation and urgency. See the
   implementation-progress subsection above. This fixes the P0 loss, startup race, hidden summary,
   inaccessible history, and wrong bell urgency as one coherent contract.
2. **Repair delivery/window routing.** Isolate every window send, then run native/digest consumers
   independently. Make notification activation carry row/workspace/target identity, select the
   owning window/workspace, use real mounted-surface navigation, and give scoped windows a visible
   bell/toast surface.
3. **Repair native notifier state and packaging.** Workspace-scope throttle keys, commit throttle
   only after a successful native-show lifecycle, observe failure events, and package/resolve the
   icon correctly. Add installed/portable Windows, macOS, and Linux release smokes.
4. **Repair source/error semantics.** Keep notification writes off cleanup/error critical paths,
   distinguish preflight/approval/runtime tool failures, wire a normal swarm producer, and make
   shell-first dedup markers generation-scoped rather than session-lifetime state.
5. **Unify attention and finish-state product policy.** Preserve focused-pane noise suppression but
   make minimized/zero-window states recoverable, offer a durable/native away channel, and verify
   real Claude/Codex BEL/idle behavior before tuning heuristics.
6. **Close digest/toast/settings/accessibility debt.** Count `dup_count`, enforce once-per-local-day,
   coalesce persistent toasts, roll back/refetch failed optimistic writes, and make row actions/time/
   sound controls keyboard- and screen-reader-operable.

### Correctness gaps and missing coverage

- **No packaged end-to-end proof exists.** Unit/jsdom tests cannot show that an Electron notification
  entered macOS Notification Center, Windows Action Center, GNOME/KDE, or that an activation routed
  into a mounted source target. No packaged artifacts were present in this worktree. Test installed
  NSIS and portable Windows targets separately; Electron's Windows prerequisite depends on a Start
  Menu shortcut and matching AppUserModelID, which is configured for installed builds but unproven
  for portable (`app/electron/main.ts:41-45`, `app/electron-builder.yml:78-99`).
- **Native critical presentation is not actually critical.** App-level critical bypasses DND, but
  the Electron notification supplies neither Linux/Windows `urgency:'critical'` nor Windows
  `timeoutType:'never'`; platform notification centers therefore receive default presentation.
- **Attention detection is a heuristic, not semantic waiting-state proof.** Four seconds of output
  silence fires idle attention (`app/src/main/core/pty/idle-detector.ts:15-65`), so a quiet long
  computation can false-alert, while a TUI that continually repaints may never idle-alert. The
  approved spec accepted this tradeoff but also recorded BEL presence as unverified in live Claude/
  Codex streams (`docs/superpowers/specs/2026-06-14-agent-attention-notifications-design.md:126-139`).
- **Daily scheduler has no clock/timezone-change policy.** Sleep should cause overdue JS timers to
  run and re-arm, but timezone/manual-clock changes and multi-day catch-up are untested; no power
  monitor reschedule hook exists (`app/src/main/core/notifications/daily-scheduler.ts:103-139`).
- **Mutation RPC validation remains weak.** Snapshot/page inputs now have concrete enforced schemas,
  but notification mutation channels still use permissive stubs. Controllers check required IDs,
  so the remaining work is boundary-hardening debt rather than a proven injection issue.
- **The documented D3 tuple and SQL differ.** Comments/spec say
  `(workspace_id, kind, dedup_key)`, but lookup/index omit `kind`
  (`app/src/main/core/notifications/manager.ts:13-14,163-186`,
  `app/src/main/core/db/migrations/0018_notifications.ts:84-88`). Current producer keys are
  sufficiently namespaced, so no present cross-kind collision was proven.
- **OS delivery observability remains incomplete even after lifecycle-event handling.**
  `Notification.isSupported()` means API capability, not permission or actual visibility; OS Focus,
  permission state, Windows shell registration, and Linux notification-daemon state need platform
  probes. macOS notification bodies can also be truncated; unbounded tool-error/summary bodies need
  a content policy.
- **Historical context, revalidated rather than inherited blindly.** The archived 2026-07-02
  review already identified the hydration race, soft-cap delta omission, permanent-toast pile-up,
  dismiss-count drift, loaded-page-only bell tint, and the attention/OS design split
  (`docs/03-plan/archive/WISHLIST-pre-jorvis-cycle-2026-07-07.md:237-278`). The present audit is
  checking each against current production code and recording only survivors.

### Optimizations

- **Coalesce renderer preference reads per notification burst.** Every live delta currently reads
  three KV keys before toast/tone evaluation (`app/src/renderer/app/state-hooks/use-live-events.ts:643-665`).
  Reuse the sound preference cache or a shared snapshot after correctness fixes; this is not the
  current bottleneck.
- **Deduplicate BEL attention per session before IPC.** Every real BEL emits even within the idle
  dedupe window (`app/src/main/core/pty/attention-detector.ts:51-70`). Sound is globally throttled,
  but repeated BELs still churn IPC/state/glow.

### Future features

- **Unify “agent needs me” with a durable/native attention policy.** Persist enough state to survive
  zero-window periods and expose an operator choice for native banner/dock/taskbar attention. Keep
  per-session coalescing so a swarm completion is one useful alert, not a storm.
- **Build a real notification integration harness.** Package each supported artifact, fire one
  notification per severity, observe `show`/`failed`/activation, close all windows, click the OS
  entry, and assert workspace/room/target/read state. Treat manual screen confirmation as a release
  smoke until platform automation is practical.
- **Extend cursor-paginated history with server-side filters and search.** Cursor paging and an
  authoritative severity summary now exist; filter chips still operate over loaded pages only.
- **Expose delivery diagnostics** (last attempted/shown/failed reason, platform capability,
  permission/setup hints) so “Sent—check your screen” is not the only debugging surface.

### Investigated and ruled out

- Notification RPC/event channels are allowlisted through preload and listeners return cleanup
  functions; the transport is not simply absent.
- Live deltas reconcile synchronously before asynchronous sound/toast work, and `updated` rows do
  not re-alert. The normal post-hydration reducer path is coherent; the defect is the snapshot/live
  interleaving at startup.
- Notification migrations are registered and boot ordering is coherent; explicit OS-disabled `0`
  survives migration 0038. Default-on is an intentional later policy change, not an accidental
  reset (`app/src/main/core/db/migrations/0038_os_notify_default_on.ts:1-19`).
- Capability/master/severity/focus/DND/quiet/source gates otherwise evaluate consistently;
  cross-midnight quiet-hour math is tested, critical bypasses DND/quiet, and explicit source mute
  still wins. Native notifications are deliberately silent so the app soundscape owns audio.
- Direct PTY exits and shell-first sentinel completions both reach the source; deliberate pane close
  and router-shutdown exits are suppressed. Shutdown gating is armed before PTY teardown.
- Main-window-only tone/toast prevents duplicate audio across multiple renderers; read-state changes
  use `updated` and do not re-alert. These July round-2/round-3 fixes remain present.
- Installed Windows builds set the matching AppUserModelID and Start Menu shortcut. Dev icon assets
  are valid files; the problem is their packaged location, not corrupt source assets.
- The 30-day GC query uses `created_at` exactly as the locked design specifies
  (`docs/03-plan/v1.4.8-bundle/07-notifications-bell.md:57-71`); surprising “read today, old creation”
  expiry is policy, not a current implementation mismatch.
- The global hard cap intentionally soft-breaks above 500 when every remaining row is error/critical
  (`app/src/main/core/notifications/manager.ts:560-563`). That contract should be documented as a
  protected-retention ceiling exception, not “fixed” by silently dropping must-see rows.
- Daily-summary enable/time writes do live-rearm through `buildKvController.onSet`
  (`app/src/main/rpc-router.ts:2669-2684`). The prior “dead until restart” defect was fixed on
  2026-07-03 and was explicitly rejected during the adversarial pass.
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
