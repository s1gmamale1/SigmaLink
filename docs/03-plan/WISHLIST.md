# SigmaLink — Plans wishlist (consolidated)

> Single source of truth for what's queued. Updated 2026-05-16 after the v1.2.4 → v1.2.8 release wave. Each row points at the original spec / backlog / plan file it was extracted from.

## Recently shipped ✅

| Release | What | Plan file |
|---|---|---|
| v1.10.4 | 2026-05-21 | **W-4 shell-first — Phase 4/7: Cmd+T scratch sub-tabs**. Ephemeral scratch-shell sub-tabs via Cmd+T / Ctrl+Shift+T (quick ls/git diff/testing) without touching the main CLI session. `pty.spawnScratch`/`killScratch` (providerId:'shell', no agent_session) + PaneTabStrip + per-pane state + scoped keybind + per-tab switching. Additive (strip hidden at 0 sub-tabs). Lead-caught + fixed an empty-pane regression (unconditional terminal wrapper) via zero-subtab fast-path + display:contents. +13 tests. Commit c0534dc. | [`v1.6.0-shell-first-pane-architecture.md`](v1.6.0-shell-first-pane-architecture.md) |
| v1.10.3 | 2026-05-21 | **Terminal scrollback persistence** (v1.9-backlog item; flagged default-off). KV `pty.scrollbackPersistence` → persist RingBuffer to `<userData>/scrollback/<sessionId>.log` (atomic, 256KiB cap) on PTY-exit + app-quit; restore into resumed session's buffer with a dim separator; boot gc. `scrollback-store.ts` + `RingBuffer.restore()` + flag-gated wiring + Settings toggle. Zero regression at default-off (sensitive session-restore zone). +27 tests. Commit 7140e76. | inline in CHANGELOG |
| v1.10.2 | 2026-05-21 | **W-4 shell-first — Phase 3/7: dispatch correctness** (flagged, default-off). 3 prompt-delivery mechanisms handled: initialPromptFlag (gemini) + oneshotArgs (claude/codex) = prompt-as-arg → Phase 1 injection, stays shell-first; Path B stdin (kimi/opencode) → clean per-pane direct fallback via `effectivePaneSpawnMode()` (avoids post-spawn-write race; documented degradation). CLI-ready-signal enhancement deferred. +10 tests. Zero regression at default. Commit 9b877d3. | [`v1.6.0-shell-first-pane-architecture.md`](v1.6.0-shell-first-pane-architecture.md) |
| v1.10.1 | 2026-05-21 | **W-4 shell-first — Phase 2/7: CLI-exit detection** (flagged, default-off). Sentinel-based: shell-first injection appends `__SIGMALINK_CLI_EXIT_<code>__` printf; `registry.ts` scans shell-first onData → strips marker from renderer stream → fires additive `onCliExited` sink (distinct from PTY onExit; pane stays alive) → same "agent done" notification as direct mode. Status-repr = separate callback (no `sigma_pane_events` enum change / migration). Zero regression at default. +37 tests. Plan re-ordered (external_session_id removal → post-flip). Commit 2f151f0. | [`v1.6.0-shell-first-pane-architecture.md`](v1.6.0-shell-first-pane-architecture.md) |
| v1.10.0 | 2026-05-21 | **W-4 shell-first pane architecture — Phase 1/7** (flagged, default-off). KV `pty.spawnMode` ∈ 'direct' (DEFAULT, byte-for-byte today) \| 'shell-first' (spawns defaultShell + injects POSIX-quoted command after prompt-ready). `spawnLocalPty` branch + parseSpawnMode + posixQuoteArg + Settings "Shell-first panes (experimental)" toggle. Resume-arg machinery untouched (Phase 2); win32 stays direct (later phase). Zero regression at default (3-condition guard, smoke-verified). Also: SessionStep coverage-flake root-caused + fixed. Commit fad5f2c. Phases 2-7 (resume simplification, schema drop, exit-detection, dispatch rewrite, Cmd+T, flip default) = future sessions behind same flag. | [`v1.6.0-shell-first-pane-architecture.md`](v1.6.0-shell-first-pane-architecture.md) |
| v1.9.1 | 2026-05-21 | `isResume` explicit registry field (v1.5.5 reviewer item, deferred → closed). Behavior-equivalent clarity+efficiency refactor in the PTY-resume core: `PtyRegistry.create` + `ResolveAndSpawnOpts` gain `isResume?: boolean`; `const isResume = input.isResume ?? (input.sessionId !== undefined)` preserves prior behavior for non-passing callers (zero change). resume-launcher passes `isResume:true`; executeLaunchPlan + factory-spawn pass `isResume:false`. onPostSpawnCapture gate + shouldPreAssign + sessionId sentinel untouched. Gate incl. smoke e2e. Commit f5acfff. | inline in CHANGELOG |
| v1.9.0 | 2026-05-21 | Skills tab Phase 2 — drag-drop skill bindings + persistence (INFORMATIONAL mode). 1 Sonnet coder cluster, lead-merged. Migration 0021 `skill_bindings` (workspace_id + nullable pane_session_id for pane-vs-workspace scope + skill_name/source/attached_at); RPC skills.attach/detach/listBindings (allowlisted + typed + CHANNELS cross-ref test); drag-drop UI (draggable SkillsTab rows + PaneShell/CommandRoom drop targets reusing v1.4.8 file→pane pattern + dismissible SkillBindingChip + useSkillBindings persistence hook). INFORMATIONAL only — binding is a persisted visual association, does NOT alter agent dispatch/context. Behavioral activation deferred. Commit bd8fefd. | inline in CHANGELOG |
| v1.8.0 | 2026-05-21 | BridgeVoice unsigned installers + Jorvis UI label rename (2 parallel Sonnet coder clusters, lead-merged) — Cluster 1: BridgeVoice standalone app real unsigned installers: scripts/build.cjs (esbuild bundle), electron-builder.yml (appId ai.sigma.bridgevoice, ad-hoc identity null, mac DMG arm64+x64 + win NSIS, voice .node asarUnpack, afterSign ad-hoc codesign), build/entitlements.mac.plist (mic/speech/audio-input/apple-events), build/installer.nsh + dmg README (Gatekeeper/SmartScreen bypass instructions), NEW .github/workflows/release-bridge-voice.yml (triggers on bridgevoice-v* tags only — separate lane from SigmaLink release workflows). Internal-use unsigned model; local --mac dir + ad-hoc sign validated; full DMG/NSIS on new CI lane. Completes the "make SigmaVoice a separate app like BridgeVoice" deliverable. Also tagged bridgevoice-v0.1.0 (first standalone app installer). Cluster 2: Jorvis UI label rename (LABEL-ONLY) — 20 user-facing display strings across 11 renderer files (tab, JORVIS speaker, Ask Jorvis placeholders, notification copy, dispatch toasts, voice pill). "Sigma Canvas" + Ruflo strings unchanged. IPC channels/DB tables/file names/identifiers/test-ids UNCHANGED — full W-6 identifier sweep deferred. Commit 2045691. | inline in CHANGELOG |
| v1.7.1 | 2026-05-21 | Build hotfix — v1.7.0 CI release lane failed because @sigmalink/voice-core native devDeps were not promoted correctly to the CI install path. Fixed by adding voice-core native devDeps to the CI install step. No functional code changes. | inline in CHANGELOG |
| v1.7.0 | 2026-05-21 | "finish open items" bundle (3 parallel Sonnet coder clusters, lead-merged) — A1: @sigmalink/voice-core package (global-capture+output-router+whisper-engine+model-registry with DI); native packages promoted to pnpm workspace members; SigmaLink consumes voice-core via electron/main.ts; NEW @sigmalink/bridge-voice standalone Electron app scaffold (Tray+hotkey+settings window); A1 hardware sample-rate detection (macOS native onPcm reports real rate); pnpm-workspace.yaml now tracked (was gitignored). A2: migration 0020 dedupe + partial UNIQUE index on agent_sessions(workspace_id, pane_index) WHERE pane_index IS NOT NULL + spawn-path UNIQUE-violation guards. A5: use-session-restore.ts exhaustive-deps fixed via useMemo+wsId dep; repo now passes eslint --max-warnings 0. B2: supervisor.list() + ruflo.daemonStatus/restartDaemon RPCs + RufloSettings table. B3 (Skills Phase 1): skills.listInstalled() + right-rail Skills tab + searchable list + Copy /name. Commit 5e22a3a. Deferred: W-4 shell-first, W-5 Phase 2, W-6 Jorvis rename, BridgeVoice production installers, V3-W15-006 dogfood. | inline in CHANGELOG |
| v1.6.0 | Ruflo MCP HTTP daemon mode (W-7 from v1.5.6 architectural backlog) — per-workspace `RufloHttpDaemonSupervisor` (~280 LOC) spawned at workspace open; all 5 CLI clients point at one shared `http://127.0.0.1:<port>/mcp` endpoint; live in-memory shared state (HNSW, pattern cache, swarm consensus) across all panes. Restart UX routes through existing v1.4.9 NotificationsManager (bell drawer). Commit `f36b7be`. Deferred to v1.7: upstream write-mutex PR to claude-flow. Deferred to v1.6.1+: daemon Settings UI + global multi-workspace daemon mode. | inline in CHANGELOG |
| v1.5.6 | PTY exit grace window hotfix (200ms → 3000ms) — unmasks fast-exit binary errors (ENOENT/PATH/flag) | inline in CHANGELOG |
| v1.2.0 | Windows platform port — NSIS installer + PowerShell one-liner | `docs/03-plan/` (none — implementation only) |
| v1.2.1 | Windows CI hotfix — npmRebuild=false to skip node-pty re-rebuild | inline in CHANGELOG |
| v1.2.2 | Windows install-script asset regex + native-module hoist (`.npmrc`) | inline in CHANGELOG |
| v1.2.3 | Re-tag for macOS workflow so `latest-mac.yml` ships | inline in CHANGELOG |
| v1.2.4 | Auto-update without code-signing certs | [`v1.2.4-auto-update-without-signing.md`](v1.2.4-auto-update-without-signing.md) |
| v1.2.5 | Post-install regression sweep + macOS spawn-helper chmod + provider trim | [`v1.2.5-postinstall-regressions.md`](v1.2.5-postinstall-regressions.md) |
| v1.2.6 | Stdio MCP switch (deleted ~400 LOC HTTP supervisor) | inline in CHANGELOG (plan file consumed at merge) |
| v1.2.7 | Multi-workspace state preservation (ring-buffer replay) | [`v1.2.7-multi-workspace-state-preservation.md`](v1.2.7-multi-workspace-state-preservation.md) |
| v1.2.8 | Session capture rewrite (pre-assign UUID + disk-scan + --continue) | [`v1.2.8-session-capture-rewrite.md`](v1.2.8-session-capture-rewrite.md) |
| v1.3.0 | Session picker in Workspace Launcher (W-1) — per-pane chip, smart default, bulk bar, Scenario B pre-population | [`v1.3.0-session-picker.md`](v1.3.0-session-picker.md) · [CHANGELOG v1.3.0](../../CHANGELOG.md) |
| v1.3.1 | Session picker hotfix — `pane_index` migration 0012 deduplicates `lastResumePlan` rows + Launcher emits top-level `paneResumePlan` array so resume args actually thread to the spawn | inline in [CHANGELOG v1.3.1](../../CHANGELOG.md) · [release-notes-1.3.1.txt](../09-release/release-notes-1.3.1.txt) |
| v1.3.2 | Claude pane hotfix — `claude-resume-bridge` symlinks workspace-slug JSONL into worktree-slug dir so `claude --resume <id>` works across worktrees; pre-creates project dir so fresh `--session-id` spawns no longer silently exit | inline in [CHANGELOG v1.3.2](../../CHANGELOG.md) · [release-notes-1.3.2.txt](../09-release/release-notes-1.3.2.txt) |
| v1.3.3 | Workspace switching from sidebar / launcher now routes to Command Room (reducer-level per-workspace room recall, defaults to `'command'`); Claude blank panes now surface as visible error UI within 1.5s instead of staying silently dark; session-restore snapshot timer no longer cancels on no-op re-renders | inline in [CHANGELOG v1.3.3](../../CHANGELOG.md) |
| v1.3.4 | Claude resume spawn fix — panes launch from the workspace subdir inside worktrees, ignored `CLAUDE.md` / `.claude/` context is bridged, boot restore uses the Claude bridge, and resume args no longer collide with fresh `--session-id` | inline in [CHANGELOG v1.3.4](../../CHANGELOG.md) · [release-notes-1.3.4.txt](../09-release/release-notes-1.3.4.txt) |
| v1.3.5 | W-3 Ruflo MCP auto-bind for 5 CLIs (Claude/Codex/Gemini/Kimi/OpenCode) + canonical-args fix (`mcp-stdio` was invalid; correct form `-y @claude-flow/cli@latest mcp start`). Pre-existing user configs self-heal on next openWorkspace(). 5-CLI readiness pill with vacuous-pass for undetected binaries. | inline in [CHANGELOG v1.3.5](../../CHANGELOG.md) · [release-notes-1.3.5.txt](../09-release/release-notes-1.3.5.txt) · [plan](W-3-ruflo-mcp-autobind-v1.3.5.md) |
| v1.4.0 | Sigma Assistant orchestrator resume — captures Claude `system.init` session ids, resumes later turns with retry-once fallback, and surfaces resumable/interrupted-turn state in the right rail | [`archive/W-2-sigma-assistant-orchestrator-v1.4.0.md`](archive/W-2-sigma-assistant-orchestrator-v1.4.0.md) · [release-notes-1.4.0.txt](../09-release/release-notes-1.4.0.txt) |
| v1.4.1 | Bridge → Sigma rename sweep + Pane→Sigma mailbox back-channel (`sigma_pane_events` table, `monitor_pane` tool, `assistant:pane-event` IPC) + SigmaRoom.tsx 922→283 LOC split (9 hooks + 5 sub-components). Pre-merge swarm closed H1 (voice dispatcher regex orphan), M1 (autoFocus kv migration), M2 (kv migration tests) before merge. | inline in [CHANGELOG v1.4.1](../../CHANGELOG.md) · [release-notes-1.4.1.txt](../09-release/release-notes-1.4.1.txt) |
| v1.4.2 | Stability + Windows compat hardening: Windows spawn ENOENT fix (#01), Settings-blocks-workspace routing fix (#02), xterm preservation (#03), worktree location UX (#06), disk-scan workspace scoping (#10), NSIS welcome page (#11), Pane Focus fullscreen (#12), rAF resize coalesce (#07). Backlog hygiene: state.tsx verify-close (#08), 4-item sweep (#09), shellcheck CI fix (#24). Packets #04/#05/#13 deferred to v1.4.3. | inline in [CHANGELOG v1.4.2](../../CHANGELOG.md) · [release-notes-1.4.2.txt](../09-release/release-notes-1.4.2.txt) |
| v1.4.3 | Gemini resume bridge — `projects.json` alias unblocks gemini in per-pane worktrees (#01). Workspace pane state now persists across app restart — new `panes.listForWorkspace` RPC + ADD_SESSIONS dispatch from 3 sites (#02). Migration 0016 marks stale `status=running` rows older than 24h as exited (#03). Orphan worktree cleanup on workspace open (#04). Inline "+ Add first pane" in CommandRoom EmptyState (#05). Pane Split (H/V) + Pane Minimise functional (#06). | inline in [CHANGELOG v1.4.3](../../CHANGELOG.md) · [release-notes-1.4.3.txt](../09-release/release-notes-1.4.3.txt) · [bundle](archive/v1.4.3-bundle/00-INDEX.md) |
| v1.4.4 | Paper-cut cleanup release. 7 reviewer followups closed: comment wording (PR27 F-1), projects.json race + schema JSDoc (PR27 F-2), atomic-write fault tests (PR27 F-3), cross-platform path containment (PR27 F-4), SessionStep flakiness mitigation (PR28 INFO), EmptyState console.warn → useEffect (PR29 LOW). Playwright smoke suite navTo() refreshed for v1.1.4+ Rooms dropdown. | inline in [CHANGELOG v1.4.4](../../CHANGELOG.md) · [release-notes-1.4.4.txt](../09-release/release-notes-1.4.4.txt) |
| v1.4.5 | Tech-debt cleanup. proper-lockfile race fix (PR27 F-2 v1.4.5 followup); SessionStep full flake closure via vi.resetModules (PR28/29 INFO v1.4.5 followup); factory.ts 443→271 LOC + new factory-add-agent.ts sibling; runClaudeCliTurn.ts 426→324 LOC + new runClaudeCliTurn.args.ts sibling. React-compiler lint wave found already closed by v1.1.9 work — no action needed. | inline in [CHANGELOG v1.4.5](../../CHANGELOG.md) · [release-notes-1.4.5.txt](../09-release/release-notes-1.4.5.txt) |
| v1.4.6 | Cross-platform frameless chrome + Intel-Mac voice fix + CI hardening. 15 commits between v1.4.5 and PR #36 captured under v1.4.7 tag (no separate v1.4.6 tag): titleBarStyle:'hidden' everywhere with WCO insets (#33), x64 macOS Speech.framework binding ships in the Intel DMG (#34), Electron-ABI rebuild in all CI lanes (was rebuilding host Node ABI, root cause of CI red since v1.4.3), pnpm cache-dep-path fix, parchment contrast verify (BUG-W7-015 closed), terminal snapshot race regression test (R-1.2.7-1 closed), vitest coverage thresholds verified-and-closed, Playwright smoke refresh (4 navTo selector fixes + 1 stale-args assertion). | inline in [CHANGELOG v1.4.6](../../CHANGELOG.md) · [release-notes-1.4.6.txt](../09-release/release-notes-1.4.6.txt) |
| v1.4.7 | CI fully green again. 5 e2e tests closed (3 deferred from PR #36 Followup-2 + 2 pre-existing timeouts). Production regression fix: `panes.listForWorkspace` channel allowlist gap silently broke pane rehydration on workspace reopen since v1.4.3 (#37). OpenCode SQLite direct read drops session picker cold-start from ~400ms to <100ms (#39). opencode-Qwen secondary silent-fail mode documented (orchestrator skill). Feature-tier packets (notifications, Windows SAPI5 voice, cross-machine sync, Windows auto-update, provider auto-install) deferred to v1.4.8. | inline in [CHANGELOG v1.4.7](../../CHANGELOG.md) · [release-notes-1.4.7.txt](../09-release/release-notes-1.4.7.txt) · [bundle](archive/v1.4.7-bundle/00-INDEX.md) |
| v1.4.8 | Session A paper-cuts: drag-drop file → pane `@-mention` (#48), sidebar resize handles for IDE Editor + main Sidebar with kv persistence (#47), Browser EmptyState + `about:` normalization (#46), Windows auto-update UAC denied fallback + warning copy (#45). 4 parallel Sonnet sub-agents in git worktrees, 4 Opus 4.7 reviewers, ~45min dispatch-to-tag wall-clock. Sessions B (v1.4.9) and C (v1.5.0) planned for remaining 5 packets. | inline in [CHANGELOG v1.4.8](../../CHANGELOG.md) · [release-notes-1.4.8.txt](../09-release/release-notes-1.4.8.txt) · [bundle](v1.4.8-bundle/00-INDEX.md) |
| v1.4.9 | Session B feature cluster: global voice capture macOS (#50) — `Cmd+Option+Space` hotkey + Tray + pane-focus-aware output via NSWorkspace check, whisper.cpp scaffolded with Apple Speech.framework as active engine; provider auto-install prompt with consent gating (#49) — new `providers.spawnInstall` RPC + `ProviderInstallModal`; notifications + top-right bell (#51) — migration 0018 + 4-level severity + dedup 30s + IPC delta + Opus reviewer on the irreversible schema. 3 parallel agents (2 Sonnet + 1 Opus), 3 Opus reviewers, ~70min dispatch-to-tag wall-clock in autonomous mode. **ZERO REQUEST-CHANGES** on the irreversible 0018 migration. Session C (v1.5.0) remains for the platform tier (Win+Linux voice fan-out, SAPI5, cross-sync). | inline in [CHANGELOG v1.4.9](../../CHANGELOG.md) · [release-notes-1.4.9.txt](../09-release/release-notes-1.4.9.txt) · [bundle](v1.4.8-bundle/00-INDEX.md) |
| v1.5.0 | Session C platform tier — closes the v1.4.8 bundle: cross-machine session sync (#54, migration 0019, libsodium XChaCha20-Poly1305 + AAD, HLC + LWW, BIP-39 mnemonic via existing CredentialStore, isomorphic-git transport, `credentials` HARD-DENY); voice capture Windows + Linux fan-out (#52, `Ctrl+Alt+Space` hotkey + Tray + clipboard-only output policy); native Windows SAPI5 voice (#53, `@sigmalink/voice-win` module via `CLSID_SpSharedRecognizer` + STA worker + Win32 message pump). 3 parallel Sonnet agents in autonomous mode, 3 Opus reviewers (MANDATORY security review on packet 09). **ZERO REQUEST-CHANGES on crypto/threat-model/AAD/BIP-39/credentials-HARD-DENY/0019 migration**; ONE REQUEST-CHANGES on SAPI5 double-Release on `ISpRecoResult` (folded inline). Plus 2 CI hotfixes (release-macos whisper.cpp gating + native-win.test.ts lint). ~3.3hr dispatch-to-tag. ~28 caveats backlogged for v1.5.1 cleanup. | inline in [CHANGELOG v1.5.0](../../CHANGELOG.md) · [release-notes-1.5.0.txt](../09-release/release-notes-1.5.0.txt) · [user doc](../09-release/cross-machine-sync.md) · [bundle](v1.4.8-bundle/00-INDEX.md) |
| v1.5.1 | Cleanup packet (closes the wishlist as defined) — 28 deferred caveats from Sessions A/B/C cleared across 3 parallel Sonnet sub-agent clusters (#55 frontend, #56 native+voice, #57 sync+notifications), reviewed by 3 Opus 4.7 reviewers, lead-merged in autonomous mode (~2hr). Plus V3 parity audit (45 tickets: 35 shipped + 4 obsoleted + 3 partial + 1 human-QA-only) confirming no v1.6.0 V3 packet warranted. V3-W13-015 ding Settings toggle folded inline. Plus 3 CI prebuild workflow soft-fails (whisper.cpp v1.7.x source-drift + voice-{mac,win} prebuildify silent-no-output, all aligned with documented "convenience-only" intent). **ZERO REQUEST-CHANGES across all 3 PRs.** | inline in [CHANGELOG v1.5.1](../../CHANGELOG.md) · [release-notes-1.5.1.txt](../09-release/release-notes-1.5.1.txt) · [cleanup packet brief](v1.5.1-cleanup-packet.md) |
| v1.5.2 | Cleanup packet + **CRITICAL v1.5.0 cross-sync renderer hotfix** — 3 parallel Sonnet sub-agent clusters (#58 code paper-cuts, #59 dogfood UX, #60 sync test + UI polish) reviewed by 3 Opus 4.7 reviewers. **DISCOVERY**: 8 `sync.*` IPC channels absent from CHANNELS allowlist since v1.5.0 packet 09 shipped → preload hard-rejected with error banners → entire cross-sync renderer surface (Settings → Sync, SetupWizard, badge) was UNREACHABLE for ~14hr. Fixed in PR #60. Plus DOGFOOD-V1.4.2-01 +Pane defensive UX (hypotheses 1+3); DOGFOOD-V1.4.2-02 confirmed already shipped v1.4.2 packet-07 (BACKLOG stale); v1 legacy decrypt round-trip test (irreversible wire format coverage gap); STAThreadState heap-leak guard; engine integration tests (real crypto + MockDb); allowlist drift detector (0 drift). **ZERO REQUEST-CHANGES across all 3 PRs.** | inline in [CHANGELOG v1.5.2](../../CHANGELOG.md) · [release-notes-1.5.2.txt](../09-release/release-notes-1.5.2.txt) |

---

## 🔥 In progress

| ID | What | Branch / target | Plan |
|---|---|---|---|
| *(empty — v1.4.7 shipped 2026-05-19)* | | | |

## 🔮 Planned (v1.6+ — documented, not yet scheduled)

| ID | What | Trigger | Plan |
|---|---|---|---|
| W-4 | **Shell-first pane architecture** — IN PROGRESS (multi-session, 7 phases, flag-gated `pty.spawnMode`). Pivot from PTY-direct-CLI to PTY-shell-with-auto-inject: PTY parent becomes the user's shell; the CLI is injected as its child, so the pane survives CLI exit. Removes the `external_session_id` tracking surface (~150 refs) once complete. Resolves the v1.5.6 empty-pane root cause. **Phases 1-4/7 SHIPPED** (v1.10.0 spawn · v1.10.1 exit-detection · v1.10.2 dispatch · v1.10.4 Cmd+T sub-tabs, default 'direct'=zero regression). Phases 5-7 remain: resume simplification, drop external_session_id schema, exit-detection rework, Sigma/Jorvis dispatch rewrite, Cmd+T sub-tabs, flip default. NEVER flip default before Phase 7. | Started 2026-05-21 (operator pick). Phase 1 shipped v1.10.0. | [`v1.6.0-shell-first-pane-architecture.md`](v1.6.0-shell-first-pane-architecture.md) |
| W-5 | **Skills tab in right panel** — PARTIAL: Phase 1 (v1.7.0, read-only discovery) + Phase 2 INFORMATIONAL binding (v1.9.0, drag-drop SkillsTab→PaneShell/CommandRoom + SkillBindingChip + useSkillBindings persistence + migration 0021 skill_bindings + skills.attach/detach/listBindings RPCs) shipped. Phase 3 / behavioral activation (a bound skill actually altering agent dispatch/context) DEFERRED — needs an activation-semantics design decision before implementation. | Phase 1 v1.7.0; Phase 2 INFORMATIONAL v1.9.0; Phase 3 behavioral deferred. | [`v1.6.0-skills-tab.md`](v1.6.0-skills-tab.md) (stub) |
| W-6 | **Rename Sigma Assistant → Jorvis** — PARTIAL: label-only rename shipped v1.8.0 (20 display strings across 11 renderer files). Full identifier sweep deferred: IPC channels (`assistant:*` → `jorvis:*`?), DB tables (`sigma_pane_events`?), file/folder names (`sigma-assistant/`, `SigmaRoom.tsx`, `use-sigma-dispatch-echo.ts`, etc.), code identifiers. The label path is done; the full sweep (medium, ~3-5 days) touches CHANNELS allowlist + cross-sync wire format and is a hard cutover. | Operator request 2026-05-21. Label-only shipped v1.8.0; full sweep needs scheduling. | TBD — scope locked to label-only for v1.8.0; full identifier sweep needs its own release |

## 🆕 W-class — User wishlist additions (this session, 2026-05-16)

### W-2 — Sigma Assistant as orchestrator + session resume — SHIPPED v1.4.0 + v1.4.1 (2026-05-16/17)
- v1.4.0 shipped session resume (Claude `system.init` capture, `--resume` chaining, retry-once stale-id fallback, right-rail resumable pill + interrupted-turn banner).
- v1.4.1 completed the W-2 vision with the pane → Sigma mailbox back-channel (`sigma_pane_events` table, `monitor_pane` tool, `assistant:pane-event` IPC, `PaneEventCard` transcript card) — Sigma can now observe pane lifecycle events without polling.
- See [archived W-2 plan](archive/W-2-sigma-assistant-orchestrator-v1.4.0.md) + [CHANGELOG v1.4.0](../../CHANGELOG.md) + [CHANGELOG v1.4.1](../../CHANGELOG.md).

### W-3 — Auto-bind Ruflo MCP for every agent — SHIPPED v1.3.5 (2026-05-16)
- See [archived W-3 plan](archive/W-3-ruflo-mcp-autobind-v1.3.5.md) + [CHANGELOG v1.3.5](../../CHANGELOG.md) + [release notes](../09-release/release-notes-1.3.5.txt).

---

## ✅ v1.3.4 — Claude resume spawn investigation (shipped)

Confirmed root cause was cwd/context drift, not PTY death: SigmaLink created git worktrees at the repository root while the selected workspace was the `app/` subdirectory. Claude panes therefore launched from `<worktree-root>` instead of `<worktree-root>/app`, losing workspace-local `CLAUDE.md`, `.claude/`, and the cwd identity used by the session picker. v1.3.4 maps provider cwd to the workspace-relative path inside the worktree, symlinks ignored Claude context files into that cwd, applies the same bridge during boot restore, and suppresses fresh `--session-id` preassignment whenever resume/continue args are present.

## 🔴 P1 — CI is currently red (blocks all future PR reviews)

*(empty — closed in v1.4.6 (smoke suite) + v1.4.7 (5 remaining tests). 11 e2e tests / 0 fail / 3 documented skips.)*

## 🟡 v1.2.x deferred polish

*(empty — all 4 items closed in v1.4.6: terminal mount race verified-and-closed via regression test, BUG-W7-015 verified-and-closed via WCAG AA contrast check, CI cache-dep-path corrected, vitest coverage thresholds verified-and-closed.)*

## ✅ v1.4.8 bundle — COMPLETE (all 9 packets shipped)

The 9-packet v1.4.8 bundle shipped across 3 releases on 2026-05-20: **v1.4.8** (Session A paper-cuts), **v1.4.9** (Session B feature cluster), **v1.5.0** (Session C platform tier — cross-machine sync, voice Win+Linux, SAPI5). Plan reference preserved at [`v1.4.8-bundle/00-INDEX.md`](v1.4.8-bundle/00-INDEX.md) for historical traceability.

### ✅ v1.5.1 cleanup packet — SHIPPED 2026-05-20

All ~28 deferred caveats cleared. See `v1.5.1-cleanup-packet.md` brief + the v1.5.1 row in "Recently shipped" above.

## ✅ v1.5.3 backlog — RESOLVED (all items shipped in v1.5.3/v1.5.4; V3-W15-006 dogfood remains deferred as human-QA-only)

Non-blocking observations from the v1.5.2 Opus 4.7 reviewer round + carry-over from v1.5.1. None ship-critical.

**Newly added in v1.5.2 reviewer round**:
- **Extract `AddPaneButton.tsx`** sub-component (pill + chip + button + addPane state) — CommandRoom.tsx now at 544 LOC (>500 ceiling). Hot-fold not appropriate; needs its own packet.
- **RTL test coverage** for `data-testid="add-pane-disabled-reason"` + `data-testid="add-pane-error-chip"` (visible/hidden, dismiss, timer reset on subsequent error, unmount-during-window).
- **`sync:status` event in EVENTS allowlist** — no current renderer subscriber (SyncTab polls), benign but worth adding for forward-compat.
- **`CHANNELS`-vs-`AppRouter` cross-reference test** — would have caught the v1.5.0 sync regression at ship time. Iterates AppRouter shape keys, asserts each `namespace.method` is in CHANNELS set. **HIGH ROI defensive infrastructure** — the comment in rpc-channels.ts:2-3 about this test referred to a test that does not actually exist; make it real.
- **E2E sync smoke test** — 1-test addition opening Settings → Sync and asserting no "IPC channel not allowed" text. Prevents recurrence of the v1.5.0-class regression.
- **Vitest flake investigation** — engine-integration.test.ts flaked once on combined-main (1 fail / 838 pass first run; all-pass subsequent). Most likely file-system timing race. Pin down + fix.

**Carry-over from v1.5.1 (none shipped in v1.5.2)**:
- **Sample-rate mismatch in PCM tap** — mic 44.1/48 kHz vs whisper 16 kHz. Gated behind unshipped whisper.cpp build.
- **HMR-only race** in voice-win `IsAvailable()` probe.
- **whisper.cpp v1.7.x ggml-cpu/ binding.gyp port** — root cause of Windows whisper prebuild soft-fail.
- **voice-{mac,win} prebuildify silent no-output** under CI — root cause investigation queued.
- **V3-W13-013 `assistant.*` dispatchBulk/refResolve** — bulk pane spawn from a single Sigma prompt; feature enhancement (NOT parity gap; core dispatchPane + send/cancel/tools shipped).
- **V3-W15-006 dogfood exercise** — human QA, ≥30 min 4-pane swarm (Claude+Codex+Gemini+OpenCode) against a real repo. Not code-generatable; queued for operator-led session.

## Distribution posture (internal use)

SigmaLink is currently developed for **internal use only**. Not selling, not distributing globally. Signed distribution paths (EV cert, Microsoft Store, WinGet, Apple Developer Program, third-party wake-word licensing) are NOT on the roadmap — the SmartScreen-on-first-launch + Gatekeeper-ad-hoc-signing workflows in `app/build/nsis/README — First launch.txt` and `scripts/install-macos.sh` are canonical for internal distribution.

## P3 — polish (open in backlog, low priority)

*(empty — Gemini pane resume closed by v1.4.3 #01 via `projects.json` alias bridge)*

---

## Sources cross-referenced

This wishlist consolidates rows from:
- [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) — full bug + optimization ledger
- [`docs/08-bugs/OPEN.md`](../08-bugs/OPEN.md) — pointer to BACKLOG
- [`docs/03-plan/V3_PARITY_BACKLOG.md`](V3_PARITY_BACKLOG.md) — V3 BridgeMind parity items
- [`docs/03-plan/v1.2.4-auto-update-without-signing.md`](v1.2.4-auto-update-without-signing.md) — auto-update limitations
- [`docs/03-plan/v1.2.5-postinstall-regressions.md`](v1.2.5-postinstall-regressions.md) — sweep notes
- [`docs/03-plan/v1.2.7-multi-workspace-state-preservation.md`](v1.2.7-multi-workspace-state-preservation.md) — open risks
- [`docs/03-plan/v1.2.8-session-capture-rewrite.md`](v1.2.8-session-capture-rewrite.md) — open risks + out-of-scope
- [`CHANGELOG.md`](../../CHANGELOG.md) — historical context

When you ship a wishlist item, move it to "Recently shipped" with a pointer back to the implementation commit + CHANGELOG entry.

## Architectural decisions

### 2026-05-16 — Linux is not a supported platform

SigmaLink ships for macOS arm64 (primary) and Windows x64 only. Local `electron-builder` still emits
AppImage + .deb artefacts for completeness, but:

- No CI runs on Linux
- No smoke tests on Linux
- No installer scripts for Linux
- No docs mention Linux as a supported install path

To revisit this decision: write a new ADR. Reversal requires re-introducing the Ubuntu CI lanes (see
`.github/workflows/`), adding a Linux release workflow (mirror `release-macos.yml`), and writing
install docs.
