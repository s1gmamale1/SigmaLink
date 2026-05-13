# SigmaLink — Memory Index

Compact index of every orchestration task. Detailed narrative lives in [`master_memory.md`](master_memory.md).
Per-wave engineering reports live under [`../06-build/`](../06-build/) and visual testing under [`../07-test/`](../07-test/). Bug ledger at [`../08-bugs/OPEN.md`](../08-bugs/OPEN.md).

| task_index | task_title | result | trials |
|---|---|---|---|
| T-01 | Phase 1 foundation build (Electron + Vite + React + Tailwind, PTY, Git worktrees, providers, SQLite, RPC) | shipped | 1 |
| T-02 | Initialise git repo + push initial state to github.com/s1gmamale1/SigmaLink | shipped | 1 |
| T-03 | GitHub repo metadata (description, 20 topics, issues on, wiki off) via `gh repo edit` | shipped | 1 |
| T-04 | Repo decoration docs — README, LICENSE, CONTRIBUTING, SECURITY, CHANGELOG (first agent) | shipped (5 of 14) | 1 |
| T-05 | Repo decoration docs — finish remaining 9 files (CODE_OF_CONDUCT, ATTRIBUTIONS, .editorconfig, docs/README.md, app/README.md, REBUILD_PLAN banner, .github templates, W-DOCS report) | shipped | 1 |
| T-06 | Wave 1A — bug audit of Phase 1 build (Windows .cmd shim P0 root cause, 41-bug sweep) | shipped (P0=1, P1=14, P2=17, P3=9) | 1 |
| T-07 | Wave 1B — YouTube + video research (4 videos mined, 37-step glossary, visual spec, workflows) | shipped | 1 |
| T-08 | Wave 1C — exhaustive web crawl (39 BridgeMind pages, feature matrix, MCP catalog, skills/browser specs) | shipped | 1 |
| T-09 | Wave 1D — consolidate prior project docs into REQUIREMENTS_MASTER, DESIGN_DECISIONS_LOG, CONFLICTS | shipped | 1 |
| T-10 | Wave 2 — synthesise PRODUCT_SPEC, BUILD_BLUEPRINT, UI_SPEC (~14k words) | shipped | 1 |
| T-11 | Wave 3A — architecture critique (5 critical, 7 high, 4 medium) | shipped | 1 |
| T-12 | Wave 3B — UX/UI critique (6 critical, 9 high, 9 medium, 3 low) | shipped | 1 |
| T-13 | Wave 3C — engineering-risk critique (5 critical, 7 high, 6 medium, 4 low; 12-flow Definition of Done) | shipped | 1 |
| T-14 | Wave 4 — reconciliation into FINAL_BLUEPRINT.md | deferred (downstream waves used W2 specs + critique reports directly) | 1 |
| T-15 | Wave 5 — foundation patches (Windows PATH+PATHEXT resolver, IPC channel allowlist, PTY graceful exit + killAll, launcher try/catch + worktree rollback, REMOVE_SESSION reducer, shell tokenizer rewrite, boot janitor, graceful DB close, 8-char branch suffix, pwsh→powershell→cmd default shell). All P0 + critical P1s closed | shipped | 1 |
| T-16 | Wave 6a — Swarm Room (Coordinator/Builder/Scout/Reviewer roles, Squad/Team/Platoon/Legion presets, SQLite-backed mailbox + JSONL mirror, side chat, broadcast, roll-call) | shipped | 1 |
| T-17 | Wave 6b — In-app browser (Electron `WebContentsView` + tab strip + `@playwright/mcp` supervisor in separate-Chromium mode; agent-driving lock; per-provider `.mcp.json` fan-out) | shipped | 1 |
| T-18 | Wave 6c — Skills drag-drop (HTML5 `webkitGetAsEntry` + `webUtils.getPathForFile`; sha256 content hash; atomic temp+rename copies; per-provider fan-out to `~/.claude`, `~/.codex`, synthesised Gemini extension) | shipped | 1 |
| T-19 | Wave 6d — SigmaMemory (12 MCP tools over hand-rolled stdio JSON-RPC; `.sigmamemory/<note>.md` atomic writes; DB-first transactional rollback; canvas force-directed graph; backlinks panel) | shipped | 1 |
| T-20 | Wave 6e — Review Room + Tasks/Kanban (Diff/Tests/Notes/Conflicts tabs, hand-rolled split diff, batch commit-and-merge; dnd-kit Kanban; drag-onto-roster assignment writes `SIGMA::TASK`) | shipped | 1 |
| T-21 | Wave 6f — UI polish (first attempt) | refused (sub-agent misread harness malware-warning Read reminders as a no-write directive) | 1 |
| T-22 | Wave 6f — UI polish (relaunch with explicit framing): 4 themes (obsidian/parchment/nord/synthwave), Cmd+K command palette via `cmdk`, 3-step onboarding, EmptyState/ErrorBanner/RoomChrome shared primitives, Σ monogram + uppercase wordmark, sidebar collapse < 1100px, motion tokens + keyframes | shipped | 2 |
| T-23 | Wave 7 — Playwright `@electron` end-to-end smoke (37-step capture across every room + every theme; 0 console errors, 0 crashes, 29.4s) | shipped (15 bugs filed: 3 P1, 6 P2, 6 P3) | 1 |
| T-24 | Wave 8 — close all P1 + P2 bugs (workspace activation, sonner global error toaster, swarms.create race vs workspaces.open via WAL checkpoint, sidebar a11y, theme defaulting + Reset, sidebar token retheme audit, Tasks drawer leak, double-state collapse) | shipped (9 fixed, 6 P3 deferred) | 1 |
| T-25 | Wave 9 — acceptance re-smoke against W8 fixes; promote 7/9 bugs to verified; CHANGELOG cut `[0.1.0-alpha] - 2026-05-09`; README status table flipped to Shipped; ACCEPTANCE_REPORT (12-flow Definition of Done: 7 Pass / 4 Partial / 1 Not exercised / 0 Fail); `v0.1.0-alpha` annotated tag created | shipped (verdict: alpha-ready) | 1 |
| T-26 | Push every wave commit + tag `v0.1.0-alpha` to GitHub | shipped | 1 |
| T-27 | Write `master_memory.md` + `memory_index.md` and push | shipped | 1 |
| T-28 | Phase 2 — Wave 10 (boot self-check + Diagnostics tab) → Wave 16 (release docs) — 45 V3 parity tickets across 25 parallel agents | shipped | 1 |
| T-29 | Phase 3 Step 1 — P1 emergency fixes: migration 0002 `id`→`name` registered; Gemini MCP `httpUrl`→`url`; 2 new test files (6 tests) | shipped | 1 |
| T-30 | Phase 3 Step 2 — Operator Console rescue (orphan W13 code wired into `RoomId`+`RoomSwitch`+Sidebar+CommandPalette+smoke) | shipped | 1 |
| T-31 | Phase 3 Step 3 — Brand sweep + CI guard (`scripts/check-brand.sh` blocks PR drift) | shipped | 1 |
| T-32 | Phase 3 Step 4 — P2 fix sweep (PaneSplash z-index, BridgeCode splash, Playwright supervisor race, regex robustness, model defaults, react-hooks in TaskDetailDrawer) | shipped | 1 |
| T-33 | Phase 3 Step 5 — Phase 2 atomic commit + lint hygiene (124 files → 13 commits, `_legacy/` deleted -2,791 LoC, lint 79→54) | shipped | 1 |
| T-34 | Phase 3 Step 6 — Differentiator #1: Persistent Swarm Replay (migration 0008, ReplayManager, ReplayScrubber, Replays tab) | shipped | 1 |
| T-35 | Phase 3 Step 7 — Differentiator #2: Bridge Assistant cross-session persistence (DB-backed tool-tracer, Conversations panel, migration 0009 swarm_origins, OriginLink) | shipped | 1 |
| T-36 | Phase 3 Step 8 — Smoke pass 40/40 + vite manualChunks (main 1025 KB → 311 KB; 6 vendor chunks; Monaco lazy 14.57 KB) | shipped | 1 |
| T-37 | Phase 3 Step 9 — Automated dogfood: `dogfood.spec.ts` (3 tests) + manual W7-003/006 verified; GREENLIGHT-FOR-RELEASE | shipped | 1 |
| T-38 | Phase 3 Step 10 — `v1.0.0` annotated tag + push + GitHub release (DMG + zip attached, unsigned, notarisation deferred) | shipped (⚠ DMG has known runtime defect) | 1 |
| T-39 | Post-release launch-doctor: diagnose + fix Electron `path.txt` missing via pnpm-stash symlinks; write `RUNNING.md` (131 lines) | shipped | 1 |
| T-40 | Store 6 lessons to AgentDB via `agentdb_pattern-store` (Node 26 trap, pnpm exec trap, symlink fix, DMG defect, sub-agent inbox limitation, project state) | shipped | 1 |
| T-41 | Append Phase 3 narrative to `master_memory.md` + Phase 3 rows to `memory_index.md` | shipped | 1 |
| T-42 | Phase 4 Step 1 — v1.0.1 hotfix: 5 fixes (DMG asar:false + boot self-check + UI Bug 1 sidebar 28px spacer + UI Bug 2 ResizeObserver + zod schemas + dataroom React.memo cascade) + repo cleanup (4 .DS_Store, 3 one-shot scripts, package-lock.json, info.md, broken v1.0.0 release artefacts) + extended app/.gitignore | shipped | 1 |
| T-43 | Phase 4 Step 1 release: `v1.0.1` annotated tag + push + GitHub release with 4 binaries (mac arm64+x64, both DMG + zip; 121-139 MB each); v1.0.0 broken DMG superseded | shipped | 1 |
| T-44 | Phase 4 research wave (3 background agents): voice-researcher (macOS Speech Framework + NAPI path), wake-researcher (Porcupine licensing — BYO-AccessKey blocker), ruflo-researcher (@claude-flow/cli embed; +250-350MB; tool name corrections) | shipped | 1 |
| T-45 | Phase 4 testing wave (3 background agents): e2e-runner (Playwright suite — Node 26 race surfaced), ipc-auditor (12 IPC bugs found), provider-prober (9 provider bugs found) | shipped | 1 |
| T-46 | Phase 4 architecture wave (2 background agents): voice-architect (SigmaVoice native module design doc), ruflo-architect (Ruflo embed architecture — Option B lazy-download chosen) | shipped | 1 |
| T-47 | Phase 4 fix wave (4 background agents): fixer-ipc-mailbox (group recipients + cross-swarm leak + dead-PTY error_report), fixer-provider-launcher (façade + 5 PROV bugs), fixer-providereffective (migration 0010), fixer-pane-sync (cross-pane focus auto-sync) — 9 bugs closed | shipped | 1 |
| T-48 | Phase 4 lead direct fixes: macOS PATH bootstrap in electron/main.ts (BUG-V1.1-03-PROV), Playwright spec defenses (smoke + dogfood for Node 26 loader race), CHANGELOG + release notes for v1.1.0-rc1 | shipped | 1 |
| T-49 | Phase 4 Track B coding (voice-coder, 1 background agent): SigmaVoice native macOS module — 12 new files in app/native/voice-mac + dispatcher + adapter extension + RPC channels + electron-builder hardened-runtime config; 17/17 dispatcher tests pass; native module compiled locally arm64 | shipped | 1 |
| T-50 | Phase 4 Track C coding (ruflo-coder, 1 background agent): Ruflo MCP supervisor + 3 user-facing features (semantic memory search, Bridge pattern surfacing, Command Palette autopilot) + Settings panel; lazy-download Option B; 14/14 proxy tests pass | shipped | 1 |
| T-51 | Phase 4 release: v1.1.0-rc1 annotated tag + push + GitHub prerelease with 4 binaries (mac arm64+x64, DMG + zip, 131-139 MB each); unsigned; verified DMG launches past boot self-check | shipped | 1 |
| T-52 | Phase 4 Step 5 — SigmaSkills marketplace live install (marketplace-coder, 1 background agent): new `core/skills/marketplace.ts` (~400 LoC) installs from GitHub URL via tarball stream + tar extract + existing manager.ingestFolder pipeline; 21/21 tests; MarketplaceTab Install button now functional (replacing the v1.0.1 toast stub); skills.json expanded from 8 to 20 entries (6 real anthropics/skills + 14 placeholders) | shipped | 1 |
| T-53 | Phase 4 release iteration: v1.1.0-rc2 annotated tag + push + GitHub prerelease bundling Tracks A+B+C+Step 5 into one downloadable; 4 binaries; supersedes rc1 (which lacked Step 5 marketplace) | shipped | 1 |
| T-54 | Phase 5 — v1.1.1 UX hotfix: window drag + Bridge→Sigma rebrand + Claude CLI streaming + voice diagnostics + single-instance lock | shipped | 1 |
| T-55 | Phase 6 — v1.1.2 Sigma Assistant Parity: tool dispatch parity + live tools + mcp autowrite + mailbox group broadcast (Codex/Gemini collaboration via PR #1) | shipped (awaiting merge + smoke confirmation) | 1 |
| T-56 | Phase 6 follow-up — v1.1.2-rev2/rev3: arm64 native module rebuild + single-instance lock + MCP host server (BUG-V1.1.2-01) + session-restore minimum (BUG-V1.1.2-02) | shipped | 3 |
| T-57 | Phase 7 — v1.1.3 plan-mode review: 3 Explore agents (multi-workspace state / pane resume / Ruflo bootstrap) + design questions locked; plan snapshotted to docs/10-memory/v1.1.3-plan.md | planning | 1 |
| T-58 | Phase 7 implementation (queued — awaits user authorization): multi-workspace + pane resume + add-pane + Ruflo pre-flight + multi-workspace session-restore + per-CLI skills verify + chat label rebrand | queued | 0 |

## Counts

- Tasks total: 53
- Shipped: 52
- In progress: 0
- Deferred: 1 (T-14 reconciliation)
- Multi-trial: 2 (T-22 with 2 trials, T-42 with 4 trials due to asarUnpack pattern misses)
- Bugs filed: 38 (17 prior + 21 from Phase 4 testing wave: 3 P1-IPC, 4 P2-IPC, 5 P3-IPC, 3 P1-PROV, 5 P2-PROV, 1 P3-PROV)
- Bugs fixed: 24 (13 prior + 11 in Phase 4 v1.1.0-rc1)
- Bugs verified: 9 (W8 7-of-9 + Phase 3 promoted W7-003 + W7-006). Phase 4 fixes pending real-world v1.1.0 dogfood verification.
- Bugs deferred: 16 (6 P3 W7 + 10 v1.2 follow-ups: wake-word legal, Ruflo HTTP Range, V3 envelope producers, kill-path consolidation, Bridge tools dual-delivery, Playwright 1.60 bump, 5 P3 IPC, 1 P3 PROV)

## Latest commit + tag

- `v1.2.0` HEAD: pending push (tag created in Step 6 of Phase 18; CI workflow `release-windows.yml` builds NSIS EXE on `windows-latest` and uploads to the GitHub Release on push).
- `main` HEAD: pending Phase 18 commit (5 implementation steps + this docs sweep).
- Phase 18 commits (v1.2.0): release-windows.yml CI, electron-builder.yml ia32 drop + NSIS welcome page, install-windows.ps1 PowerShell installer, renderer polish (preload platform + lib/platform.ts + Breadcrumb pad + Cascadia + VoiceTab copy), docs sweep (windows-port.md design + RESOLVED close-out + BACKLOG restructure + release notes + CHANGELOG).
- Tags pushed (history): `v0.1.0-alpha`, `v1.0.0` (superseded), `v1.0.1`, `v1.1.0-rc1` (superseded), `v1.1.0-rc2` (superseded), `v1.1.0-rc3` (last shipped rc), `v1.1.1` (UX hotfix), `v1.1.2-final` (Sigma Assistant parity), `v1.1.3`..`v1.1.11` (multi-workspace + V3 visual parity + Gatekeeper hotfix + curl-bash + 5-coder optimization + perf paired refactor + Gemini P1 reliability + Kimi P1 + state-hook fixes). v1.2.0 is the next push.
- GitHub release: pending — first dual-platform (macOS arm64 DMG + Windows x64 NSIS EXE) release once `v1.2.0` is pushed.
- Repo: https://github.com/s1gmamale1/SigmaLink

## Phase 4 plan reference

- Plan file: `~/.claude/plans/download-a-skill-plugin-that-lexical-pinwheel.md`
- 7-step plan executed autonomously. Step 1 ✅ (v1.0.1 shipped). Steps 3 (SigmaVoice) + 6 (Ruflo embed) ✅ (in v1.1.0-rc1). Step 5 (Skills marketplace live install) ✅ (commit 4ef2f19, on main, post-rc1). Step 4 (wake-word) DEFERRED v1.2 (Porcupine licensing). Step 2 (V3 visual parity) DEFERRED awaiting user direction. Step 7 (final v1.1.0 tag) PENDING dogfood verification on rc1 + decision whether to roll Step 5 into v1.1.0 or hold for rc2.

## Next session restart point

SigmaLink is at v1.1.0-rc1 on main. Real-world dogfood + visual recording validates → tag v1.1.0 final on the same SHA. Run `agentdb_pattern-search` query "phase4" to recall the 14-agent autonomous overnight run details. v1.2 backlog catalogued in `docs/07-bugs/OPEN.md` Phase 4 section + plan file's "Deferred to v1.2" list.
| T-54 | Phase 6 — v1.1.2 Sigma Assistant parity: tool dispatch parity + live state tools + mailbox fanout fix + MCP autowrite | shipped | 1 |
| T-55 | Environment fix: resolve better-sqlite3 Node 26 mismatch via manual node-gyp rebuild | shipped | 1 |
| T-56 | Verification: 28/28 tests pass + production build success | shipped | 1 |
| T-57 | Phase 7 — v1.1.3 multi-workspace support + Sidebar tab strip + overflow drawer | shipped | 1 |
| T-58 | Pane resume: migration 0011 + session-id-extractor + resume-launcher | shipped | 1 |
| T-59 | Swarm growth: swarms.addAgent RPC + add_agent Sigma tool + 20-agent grid layouts | shipped | 1 |
| T-60 | Ruflo hardening: ensureStarted() + readiness pre-flight + Breadcrumb readiness pill | shipped | 1 |
| T-61 | Multi-workspace session-restore + skills content-hash verification sweep | shipped | 1 |
| T-62 | Environment fix: resolve better-sqlite3 Node 26 mismatch + convert test suite to Vitest | shipped | 1 |
| T-66 | Phase 8 — v1.1.4 V3 visual parity sweep: WorkspacesPanel + workspace-color util + Sidebar refactor (~500→147 lines) | shipped | 1 |
| T-67 | Top-left RoomsMenuButton dropdown with all 11 RoomIds + disabled-state mirror of v1.1.3 sidebar | shipped | 1 |
| T-68 | Top-right RightRailSwitcher segmented control + Settings gear + RightRailContext state lift | shipped | 1 |
| T-69 | Pane header collapse: h-7+h-6 → single h-7 with 4 icons + tooltip + right-click Stop context menu; PaneStatusStrip deleted | shipped | 1 |
| T-70 | GridLayout 9-pane 3×3 fix + PaneHeader.test.tsx Element.prototype tsc narrowing fix | shipped | 1 |
| T-71 | Phase 9 — v1.1.5 Gatekeeper "damaged" hotfix: investigate root cause + adhoc-sign.cjs afterSign hook | shipped | 1 |
| T-72 | electron-builder.yml: identity null + hardenedRuntime false; v1.1.4 release page xattr workaround note | shipped | 1 |
| T-73 | Phase 10 — v1.1.6 DMG ships first-launch README explaining Sequoia/Tahoe Gatekeeper workarounds | shipped | 1 |
| T-74 | Phase 11 — v1.1.7 curl-bash install script bypassing Gatekeeper entirely for internal distribution | shipped | 1 |
| T-75 | Phase 12 — v1.1.8 5-coder optimization swarm: bundle -61% gzip, 32→1 pty listeners, NMV tests recovered | shipped | 5 |
| T-76 | state.tsx 996→553 split into types/reducer/hook siblings + 3 stub schemas promoted to real zod | shipped | 1 |
| T-77 | Lint baseline 60→32 errors via dead utils.ts delete + 8 .data.ts splits + state.tsx refactor | shipped | 1 |
| T-78 | Phase 13 — v1.1.9 release: PR #3 (Codex perf+lint) + 3-coder file-size sweep (factory/runClaudeCliTurn/state.tsx) | shipped | 3 |
| T-79 | useAppStateSelector + sessionsByWorkspace/swarmsByWorkspace precomputed slices + 4 hot-consumer migrations | shipped | 1 |
| T-80 | Lint 32→0: setState-in-effect deferred, deterministic sidebar skeleton, narrow immutability disables, .claude ignored | shipped | 1 |
| T-78 | Codex v1.1.9 backlog branch setup: new worktree `/Users/aisigma/projects/SigmaLink-bug-backlog-codex`, branch `codex/bug-backlog-pr`, Ruflo task `task-1778545436963-gtb750` | in progress | 1 |
| T-79 | v1.1.9 runtime perf work: `useAppStateSelector`, `useAppDispatch`, reducer-maintained `sessionsByWorkspace` / `swarmsByWorkspace`, first consumer wave converted, reducer tests added | implemented, uncommitted | 1 |
| T-80 | v1.1.9 CI/test infra: cache path fix, Electron binary install in CI, coverage script + baseline thresholds, ShellCheck step for `app/scripts/install-macos.sh`, `app/coverage/` ignored | implemented, uncommitted | 1 |
| T-81 | v1.1.9 React compiler lint wave: current branch lint clean; fixed set-state-in-effect/purity/exhaustive-deps/no-explicit-any; kept narrow canvas physics immutability disables | implemented, uncommitted | 1 |
| T-82 | v1.1.9 verification: lint, typecheck, Vitest 130/130, coverage, build, and installer syntax pass; local ShellCheck unavailable; Playwright smoke launches after `node scripts/build-electron.cjs` but still fails stale Bridge conversations panel assertion | partial, needs e2e cleanup before PR | 1 |

## Current Codex PR Restart Point — 2026-05-12

- Continue in worktree: `/Users/aisigma/projects/SigmaLink-bug-backlog-codex`
- Branch: `codex/bug-backlog-pr`
- Detailed handoff: [`../08-bugs/CODEX-BACKLOG-HANDOFF-2026-05-12.md`](../08-bugs/CODEX-BACKLOG-HANDOFF-2026-05-12.md)
- No commit, push, or PR yet.
- Main remaining blocker: update or document stale Playwright visual-sweep selectors; decide fate of untracked `docs/06-test/` artifacts.

## v1.1.10 Phase 14+15 — Gemini audit + reliability hotfix (May 12, 2026)

| task_index | task_title | result | trials |
|---|---|---|---|
| T-83 | Phase 14 — Gemini codebase audit (3 backend bugs + 3 orchestration bugs + 4 perf wins + 2 dead code) | investigated | 1 |
| T-84 | Phase 15 — v1.1.10 reliability hotfix: 4-coder Ruflo swarm closes Gemini audit findings | shipped | 4 |
| T-85 | Backend reliability: resolveAndSpawn fallback + pty.forget kills + killAll single-timer + execCmd maxBuffer kill | shipped | 1 |
| T-86 | Orchestration reliability: mailbox no-abort + addAgentToSwarm atomic role index + StdinWriter timeout | shipped | 1 |
| T-87 | Frontend perf: Terminal/Sidebar/Launcher selector migration + Constellation visibility gate | shipped | 1 |
| T-88 | Dead code: PhasePlaceholder + placeholders/ + RoomChrome inlined (net -82 LOC) | shipped | 1 |
| T-89 | Phase 16 — Kimi codebase audit (129 issues, 5 critical, 52 warning, 72 suggestion) | investigated | 1 |
| T-90 | Phase 17 — v1.1.11 Kimi audit P1 fix wave: 2-coder swarm closes 4 critical + 6 state-hook warnings | shipped | 2 |
| T-91 | Native voice-mac C++ exceptions enabled + try/catch around ThreadSafeFunction::New | shipped | 1 |
| T-92 | State hooks: useWorkspaceMirror desync fix + useExitedSessionGc timer guard + MissionStep voiceHandleRef | shipped | 1 |
| T-93 | Reducer: per-workspace roomByWorkspace + SET_ACTIVE_WORKSPACE_ID warn + REMOVE_SESSION live-filter + UPSERT_SWARM first-arrival | shipped | 1 |
| T-94 | parseSwarmMessage runtime kind validation + use-live-events review churn fix | shipped | 1 |
| T-95 | Kimi audit false positives verified: C5 No CI/CD (3 workflows exist) + Fix 5 voice.diagnostics.run (handler registered) | investigated | 1 |

## v1.2.0 Phase 18 — Windows platform port (May 12, 2026)

| task_index | task_title | result | trials |
|---|---|---|---|
| T-96 | Phase 18 research — 3 Explore agents survey Windows-readiness across PTY / MCP / voice / chrome / native modules; ~80% pre-existing platform-awareness confirmed | investigated | 1 |
| T-97 | Phase 18 plan — v1.2.0 Windows port plan: NSIS EXE + PowerShell installer + Web Speech fallback + WCO clearance + ia32 drop; SAPI5 + EV cert + WCO frameless deferred | shipped | 1 |
| T-98 | Step 1 — CI: `.github/workflows/release-windows.yml` (70 LOC) on `windows-latest`, tag-triggered `v*` + workflow_dispatch, uploads via `softprops/action-gh-release@v2` | shipped | 1 |
| T-99 | Step 2 — Installer plumbing: `app/electron-builder.yml` ia32 drop, `nsis.installerIcon`/`uninstallerIcon`/`installerHeaderIcon` wired, `nsis.license` welcome page; `app/build/nsis/README — First launch.txt` (72 lines) | shipped | 1 |
| T-100 | Step 3 — PowerShell installer: `app/scripts/install-windows.ps1` (234 lines / ~180 LOC); MOTW strip via `Unblock-File`; params `-Version`/`-Quiet`/`-KeepInstaller`; mirrors `install-macos.sh` | shipped | 1 |
| T-101 | Step 4 — Renderer polish: `preload.ts` exposes platform; new `lib/platform.ts` (12 LOC) with `IS_WIN32`; Breadcrumb 140px WCO pad; Terminal Cascadia Mono prepend; VoiceTab platform-aware copy + grey dot; 2 new test files + 9 new cases; 196 → 205/205 | shipped | 1 |
| T-102 | Step 5 — Docs sweep: root `README.md` (platform badge + Supported platforms table + Windows first-launch); `app/README.md` (Windows install + Distribution row + "building locally"); `docs/04-design/windows-port.md` (NEW ~150 lines); `01-known-bug-windows-pty.md` marked RESOLVED; `08-bugs/BACKLOG.md` Phase 18 closes + v1.3 platform section; `master_memory.md` Phase 18 narrative; `09-release/release-notes-1.2.0.txt` (NEW); `CHANGELOG.md` `[1.2.0]` entry | shipped | 1 |
| T-103 | Step 6 — Release: `v1.2.0` annotated tag + push; CI workflow builds NSIS EXE on `windows-latest` and uploads to GitHub Release; macOS DMG continues from existing pipeline | shipped | 1 |

## v1.2.6 Phase 20 — Browser MCP stdio switch (May 13, 2026)

| task_index | task_title | result | trials |
|---|---|---|---|
| T-109 | v1.2.6 backend: rewrite `mcp-config-writer.ts` to emit stdio `command`/`args` instead of HTTP `url` for Claude/Codex/Gemini; pin `@playwright/mcp@0.0.75` | shipped | 1 |
| T-110 | v1.2.6 backend: delete `playwright-supervisor.ts` (~400 LOC); remove from `rpc-router.ts`, `launcher.ts`, `manager.ts`, `controller.ts`, `router-shape.ts`, `rpc-channels.ts`, `schemas.ts` | shipped | 1 |
| T-111 | v1.2.6 frontend: remove `app:browser-mcp-failed` subscription from `RufloReadinessPill.tsx`; update `McpServersTab.tsx` to show static stdio command | shipped | 1 |
| T-112 | v1.2.6 deps: move `@playwright/mcp` from `dependencies` to `devDependencies`; update lockfile | shipped | 1 |
| T-113 | v1.2.6 tests: rewrite `mcp-config-writer.spec.ts` for stdio output shape (Claude JSON, Codex TOML, Gemini extension) | shipped | 1 |
| T-114 | v1.2.6 docs: `docs/04-design/browser-mcp-stdio.md` (NEW); `CHANGELOG.md` v1.2.6 entry; `docs/08-bugs/BACKLOG.md` snapshot update; `master_memory.md` Phase 20; `memory_index.md` T-109…T-114; `release-notes-1.2.6.txt` (NEW); `README.md` Playwright note | shipped | 1 |
| T-115 | Phase 21 — v1.2.7 plan imported into Codex worktree; Ruflo MCP healthy; branch `v1.2.7-multi-workspace-state` created for PR work | implemented | 1 |
| T-116 | v1.2.7 ring-buffer replay: `pty.snapshot` RPC + schema/channel/router typing; Terminal remount writes snapshot before live PTY bus subscription | implemented | 1 |
| T-117 | v1.2.7 resume reliability: session-id scan 100→500 lines; missing `external_session_id` rows return failed resume results; renderer toast surfaces failures | implemented | 1 |
| T-118 | v1.2.7 sidebar + verification: every workspace row has hover close-X; persisted dropdown tested; reducer/registry/resume tests and Playwright pid-stability spec added | implemented | 1 |
