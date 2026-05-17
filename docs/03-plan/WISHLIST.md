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

---

## 🔥 In progress

| ID | What | Branch / target | Plan |
|---|---|---|---|
| *(empty — all v1.4.2 packets shipped or deferred)* | | | |

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

| Item | Effort | Source |
|---|---|---|
| **Playwright e2e refresh** — `tests/e2e/smoke.spec.ts` stale v1.1.4 selectors | M (~1d) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.1.10 — Playwright e2e refresh" |

## 🟡 v1.2.x deferred polish

| Item | Effort | Source |
|---|---|---|
| **Terminal.tsx mount race** — attach live listener before snapshot await (closes v1.2.7 R-1.2.7-1 — 1-5ms IPC drop window) | XS (~5 min) | [`v1.2.7-multi-workspace-state-preservation.md`](v1.2.7-multi-workspace-state-preservation.md) "Open risks" |
| **Disk-scan provider scoping** — cross-reference cwd against project-hash to avoid capturing sessions from outside SigmaLink | S (~1hr) | [`v1.2.8-session-capture-rewrite.md`](v1.2.8-session-capture-rewrite.md) R-1.2.8-2 |
| **BUG-W7-015** — Launch button low-contrast in Parchment theme | XS (~30 min) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) BUG-W7-015 |
| **React-compiler lint wave** — 31 errors documented | M (~1d) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.1.9 — React-compiler lint wave" |
| **`swarms/factory.ts` (713 LOC) split** | M (~0.5d) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.1.9 — quality / file size" |
| **`runClaudeCliTurn.ts` (709 LOC) split** | M (~0.5d) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.1.9 — quality / file size" |
| **CI cache-dependency-path fix** | XS | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.1.9 — CI / test infra" |
| **vitest coverage thresholds** | S | same |
| **shellcheck step for install-macos.sh** | XS | same |

## 🟢 v1.3 — User-facing feature work

| Item | Effort | Source |
|---|---|---|
| **Pane Focus → true fullscreen** (currently honest-labeled as "Pin focus ring") | M (~1d) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "Pane Focus → true fullscreen"; v1.2.5 commit `e193943` rename |
| **Pane Split + Minimise** functional implementations | L (~3d) | BACKLOG.md "Tooltip text 'Coming in v1.2' on disabled pane icons" |
| **Notifications system + top-right bell** | M (~2d) | V3-W12 backlog row (deferred from v1.1.4) |
| **Native Windows SAPI5 voice binding** | L (~1wk + Windows prebuild matrix) | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) "v1.3 — platform / distribution" |
| **`windowsControlsOverlay` frameless chrome** | M (~1d) | same |
| **x64 macOS DMG via CI matrix** | S (~2hr) | same |
| **Windows auto-update verification flow** | S | [`docs/03-plan/v1.2.4-auto-update-without-signing.md`](v1.2.4-auto-update-without-signing.md) "Known limitations" |
| **Cross-machine session sync** | L | v1.2.8 "What's NOT in this scope" |
| **OpenCode SQLite direct read** (skip subprocess) | S | v1.2.8 "What's NOT in this scope" |
| **Provider auto-install** ("kimi not found → run pip install for me?") | M | v1.2.8 "What's NOT in this scope" |

## 🔵 v1.4+ — External dependencies / funding required

| Item | Cost |
|---|---|
| Apple Developer ID + notarisation | $99/yr |
| EV/OV Authenticode cert | $300-700/yr |
| Microsoft Store / WinGet distribution | M + Microsoft reviews |

## P3 — polish (open in backlog, low priority)

| Item | Effort | Source |
|---|---|---|
| **Gemini pane resume gap** | External dep on upstream `gemini --resume`; partially resolved by v1.2.8's `--resume latest` fallback | [`docs/08-bugs/BACKLOG.md`](../08-bugs/BACKLOG.md) P3 |

---

## Suggested grouping for next 3 releases

**v1.2.9 — CI + polish** (~1d): Playwright e2e refresh + Terminal.tsx mount race + disk-scan scoping + drop Ubuntu CI lanes. Pure debt clear. **Green CI on every PR going forward.**

**v1.3.0 — Session picker** (shipped 2026-05-16): W-1 shipped. W-3 (Ruflo auto-bind) deferred to v1.3.1 — see WISHLIST W-3 entry.

**v1.4.0 — Sigma Assistant orchestrator** (~3-5d): W-2 in isolation since it's the biggest behavioral change. Needs its own design doc + careful migration.

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
