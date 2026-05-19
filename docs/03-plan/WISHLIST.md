# SigmaLink — Plans wishlist (consolidated)

> Single source of truth for what's queued. Updated 2026-05-16 after the v1.2.4 → v1.2.8 release wave. Each row points at the original spec / backlog / plan file it was extracted from.

## Recently shipped ✅

| Release | What | Plan file |
|---|---|---|
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

---

## 🔥 In progress

| ID | What | Branch / target | Plan |
|---|---|---|---|
| *(empty — v1.4.7 shipped 2026-05-19)* | | | |

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

## 🟢 v1.4.8 bundle — Sessions A+B shipped; Session C remaining

Sessions A + B shipped as **v1.4.8** + **v1.4.9** (2026-05-20). 6 of 9 packets landed (01 browser-cleanup, 02 sidebar-resize, 03 drag-drop, 04 voice-mac, 05 win-autoupdate, 06 provider-install, 07 notifications). Remaining: Session C v1.5.0 platform tier — packets 04 voice fan-out (Win+Linux), 08 SAPI5, 09 cross-machine sync. See [**`v1.4.8-bundle/00-INDEX.md`**](v1.4.8-bundle/00-INDEX.md) for the full plan with 6 remaining lead questions on packet 09 cross-sync threat model.

### Session C — v1.5.0 (needs Windows VM + threat-model signoff, ~10-12d)

| # | Packet | Effort | Plan |
|---|---|---|---|
| 04 | Voice capture Windows + Linux (after mac validates lazy-download UX) | ~3-5d remainder of L+ | [v1.4.8-bundle/04-global-voice-capture.md](v1.4.8-bundle/04-global-voice-capture.md) |
| 08 | Windows SAPI5 voice (COM threading + STA + node-gyp prebuild matrix) | L (~3-5d) | [v1.4.8-bundle/08-windows-sapi5-voice.md](v1.4.8-bundle/08-windows-sapi5-voice.md) |
| 09 | Cross-machine session sync — libsodium + HLC + LWW + isomorphic-git | L+1d (~5-7d) — 6 lead Q's + security signoff | [v1.4.8-bundle/09-cross-machine-sync.md](v1.4.8-bundle/09-cross-machine-sync.md) |

## 🔵 Funded-only / won't-do

| Item | Cost | Status |
|---|---|---|
| ~~Apple Developer ID + notarisation~~ | ~~$99/yr~~ | **Dropped 2026-05-18** — not selling, won't pay. Ad-hoc signing + Gatekeeper README workaround remain canonical |
| EV/OV Authenticode cert | $300-700/yr | Open — Windows SmartScreen workaround documented |
| Microsoft Store / WinGet distribution | M + Microsoft reviews | Open — gated on EV cert |

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
