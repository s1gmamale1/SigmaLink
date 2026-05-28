# SigmaLink — Plans wishlist (consolidated)

> **Single source of truth for what's queued.** Updated **2026-05-28**.
> The big roadmaps are DONE — BridgeMind C-class (M0–M5, C-1…C-13), W-class
> (W-1…W-8), Apple-grade frontend (FE-1…FE-4), R-1 Telegram, R-2 Cursor,
> H-class hardening (18 of 19), and operator smoke findings SF-1…SF-11/13/14/15.
> Full detail for everything shipped lives in `CHANGELOG.md` + `docs/09-release/`
> and is collapsed into the **"✅ Shipped — historical index"** at the bottom.
>
> **The live coordination list is "🎯 OPEN — priority ordered" directly below.**
> Work top-down. When an item ships, move it to the historical index with a
> CHANGELOG/release-notes pointer.

---

## 🎯 OPEN — priority ordered (the live backlog)

Current shipped baseline: **v1.34.0**. Priority set by the operator 2026-05-28.

| # | Item | Type | Status |
|---|------|------|--------|
| **P0** | SF-12 — pane/worktree/registry confusion | Critical bug | IN FLIGHT (read-path fix ready; repair migration needs sign-off) |
| **P1** | H-7 — transactional migrations | hardening | deferred-hard (DB; pair with P0) |
| **P2** | SF-14 follow-up — bundle the `ruflo` daemon binary | product decision | open |
| **P3** | R-2 follow-up — cursor skill fan-out | small feature | open |
| **P4** | W-4 P8–P9 + win32 shell-first dogfood | cleanup | deferred (needs operator win32 dogfood) |
| **P5** | FE-4 a11y follow-ups + blocked voice items | polish / blocked | low |

---

### P0 — SF-12 (CRITICAL) — panes/worktrees/registry get mixed up  ·  IN FLIGHT

Operator-reported on a running build (2026-05-28). **New finding, old latent defect** — the bugs predate the recent SF waves (migration 0020 partial-unique index + the long-standing `listForWorkspace` query), not a regression. Two defects (full root-cause report captured in session memory `project_sf11_15_breakage_batch`):

- **Defect A — wrong/stale session resolves into a pane slot.** `pane_index` is allocated position-based `0..N-1` and never reconciled against live rows → re-launch/+Pane reuses an occupied slot. `panes.listForWorkspace` / `lastResumePlan` (`rpc-router.ts`) resolve a `(workspace_id, pane_index)` slot by **status-blind `MAX(started_at)`**, and `started_at` is **mutated on resume** (`markResumeRunning`, `pty/resume-launcher.ts`) → an exited/older session can outrank the live one; ties return two rows for one slot. The launcher's UNIQUE-violation branch (`workspaces/launcher.ts`) suppresses the insert but leaves the PTY spawned → live terminal with no DB row, showing a stale identity.
- **Defect B — panes vanish/reshuffle on reopen.** `+Pane`/swarm panes are inserted with `pane_index = NULL` (`swarms/factory-spawn.ts` insert omits it) → filtered out by `listForWorkspace` (`WHERE pane_index IS NOT NULL`).

**Fix plan (two tiers):**
- **Tier 1 — low-risk, NO sign-off, do first:** (a) make the read-path **status-aware + deterministic** (prefer live row, tiebreak `started_at DESC, id DESC`, dedup to exactly one row/slot); (b) launcher UNIQUE-suppression → **kill+forget the orphan PTY** (mirror `factory-spawn`). Pure code, no data mutation, no schema change. **Note:** overlaps `launcher.ts`/`factory-spawn.ts` (now carrying SF-15 edits) — apply on top.
- **Tier 2 — needs OPERATOR SIGN-OFF:** `pane_index` allocation reconciliation (assign lowest-free / `MAX+1` in a txn) + persist `pane_index` for `+Pane`/swarm panes (Defect B) + a **reversible, no-blind-delete data-repair migration** (preimage backup → re-slot live rows, null terminal slots). Read-only diagnostic SQL is in the agent report.

---

### P1 — H-7 — transactional migrations  ·  deferred-hard

`core/db/migrate.ts` runs `m.up()` then the `schema_migrations` insert with **no wrapping transaction** → a half-applied migration that throws re-runs against a dirty schema. **Known-hard:** a naive outer `db.transaction()` wrap CRASHES fresh-DB startup — migrations 0003/0006/0015/0018 self-manage `BEGIN`/`COMMIT`, and better-sqlite3 throws on the nested BEGIN (this was tried + reverted; MockDb can't model it, only full fresh-profile e2e caught it). Proper fix = strip every migration's own BEGIN/COMMIT so the runner owns one txn, + add SQLite `busy_timeout`. Real-DB-tested refactor. DB-adjacent to P0 — sensible to pair.

---

### P2 — SF-14 follow-up — bundle the `ruflo` daemon binary  ·  product decision

SF-14 (v1.34.0) made the HTTP daemon resolve `ruflo` on PATH → else `npx -y @claude-flow/cli@latest`, with a loud "DAEMON UNAVAILABLE" when neither exists. But the binary **isn't bundled** — first-run depends on npx/network/cache. Decision: (a) bundle `ruflo` on PATH with the app, or (b) point the daemon at the lazy-installed CLI (`<userData>/ruflo/...`) — needs verifying that install's HTTP-capable bin name + `-t http` support. Until then panes work via npx-daemon + per-worktree stdio config.

---

### P3 — R-2 follow-up — cursor skill fan-out  ·  small

Skill provider-compat fan-out is NOT extended to cursor — `skills/types.ts` `ProviderTarget` is a fixed `'claude'|'codex'|'gemini'` enum with an exhaustive `never` in `fanout.ts::targetDirFor`. To add: verify cursor's on-disk skill/command layout (`.cursor/rules/` vs a Claude-style skill dir — UNVERIFIED; may be a no-op if cursor doesn't consume the skill format), then extend `ProviderTarget` + `PROVIDER_TARGETS` + `isProviderTarget` + a cursor `targetDirFor` branch + the renderer badge maps.

---

### P4 — W-4 P8–P9 + win32 shell-first dogfood  ·  deferred

Shell-first pane architecture is the DEFAULT since the v1.14.0 P7 flip. Remaining: **P8** (resume simplification) + **P9** (drop the `external_session_id` tracking surface, ~150 refs) — both held until post-flip stability is confirmed. **win32 shell-first is un-dogfooded** (P5 shipped flagged; H-6 win32 sentinel fixed v1.27.0) — needs an operator Windows dogfood before trusting win32 shell-first end-to-end. Revert path = `pty.spawnMode='direct'`.

---

### P5 — FE-4 a11y follow-ups + blocked voice items  ·  low

- **FE-4 a11y (deferred polish):** full Tab-containment focus-trap on the hand-rolled Task drawers (`TODO(a11y)`); device VoiceOver/Switch-Control testing (operator QA); `prefers-reduced-transparency` for non-glass alpha surfaces; parchment breadcrumb ~4.3:1 → AA contrast nudge.
- **Voice (blocked behind unshipped builds):** PCM sample-rate mismatch (mic 44.1/48 kHz vs whisper 16 kHz); whisper.cpp v1.7.x `ggml-cpu/` binding.gyp port (Windows prebuild soft-fail); voice-{mac,win} prebuildify silent-no-output under CI; HMR-only race in voice-win `IsAvailable()`.
- **Operator-owned smokes:** real-bot/real-phone (R-1), `cursor-agent` login (R-2), H-19 ingestion-redaction, SF-12 repro + DB dump, win32 dogfood (P4).

---

## 🛠️ H-class hardening — 18 of 19 SHIPPED; only H-7 open

The 19-item external-review backlog (2026-05-25) is essentially complete. **Only H-7 remains (→ P1 above).**
- **H-1** ✅ v1.23.0 (electron/** typecheck) · **H-19** ✅ v1.32.0 (ingestion scan + PII scrub)
- **Wave 1** ✅ v1.26.0 (`af78a21`): H-2, H-3, H-4, H-5 (central `assertAllowedPath`), H-8, H-11, H-16 + H-19-partial
- **Wave 2** ✅ v1.27.0 (`5a43ca0`): H-6, H-9, H-10, H-12, H-13, H-14, H-15, H-17, H-18
- **H-7** 🔴 deferred — transactional migrations (see P1).
- *Accepted/not-actionable (not findings):* `sandbox:false` (supported pattern w/ contextIsolation), single inbound/outbound EVENTS set (main re-checks each payload), `fs.exists` existence-oracle (needed for provider-CLI detection).

---

## ✅ Shipped — historical index

One line per shipped initiative; full detail in `CHANGELOG.md` + `docs/09-release/release-notes-<v>.txt`.

**Operator smoke findings (SF-*)**
- **SF-1…SF-6** ✅ v1.29.0 — Telegram dup-send · Claude-resume cwd-slug · `1;2c`-on-focus · glass-notif · notif-sound-all-severities · Jorvis-rail padding
- **SF-8** ✅ v1.30.0 — Yolo/Bypass CLI launch toggle (per-launch + per-ws default, survives resume; migration 0024)
- **SF-7** ✅ v1.31.0 — Ruflo MCP auto-trust + pane health dot + stdio-fallback notice (2 lanes + Opus security-review)
- **SF-9 / SF-10** ✅ v1.33.0 — +Pane/Yolo regression fix · pane CLI-label (display-only, migration 0025)
- **SF-11 / SF-13 / SF-14 / SF-15** ✅ v1.34.0 — sidebar `min-w-0` · Settings→Maintenance cleanup · daemon npx-fallback · per-worktree MCP write (5-agent investigation + Opus security-review)
- CI Node-24 opt-in + chronic macOS e2e ENOTEMPTY teardown flake ✅ v1.34.0

**Roadmaps**
- **C-class (BridgeMind) M0–M5, C-1…C-13** ✅ v1.16.0→v1.20.0 — info bar · swarm roster · density · plan-capsule · drag-context · Sigma Agent orchestrator · browser pane · guardrail matrix · SigmaVoice · wake-word · SigmaBench · element→pane. Spec: `docs/superpowers/specs/2026-05-22-bridgemind-competitive-roadmap-design.md`
- **Apple-grade frontend FE-1…FE-4** ✅ v1.21.0→v1.24.0 — Liquid Glass (default theme) · chrome/window polish · component kit · per-room + a11y
- **R-1 Telegram** ✅ v1.25.0 (default-OFF; hand-rolled long-poll; safety floor; Opus security-review) · **R-2 Cursor provider** ✅ v1.28.0 (`cursor-agent` first-class)

**Earlier (v1.3.x–v1.12.x)** — see CHANGELOG: W-2 orchestrator+resume (v1.4.0/.1) · W-3 Ruflo MCP autobind (v1.3.5) · W-4 shell-first P1–P7 (v1.10.0→v1.14.0, default-flipped) · W-5 Skills tab + slash-injection (v1.7.0/v1.9.0/v1.12.0) · W-6 Jorvis rename (v1.8.0/v1.11.0/v1.12.1) · W-8 IDE per-pane worktree browsing (v1.12.0) · Sigma→Sigma rebrand (v1.13.0) · v1.4.8 bundle (paper-cuts + sync + voice Win/Linux + SAPI5, v1.4.8→v1.5.0) · v1.5.1 cleanup packet · v1.5.3/.4 reviewer backlog · pane-crash fixes (v1.14.0) · Ruflo HTTP daemon (v1.6.0) · Ruflo MCP fix (v1.15.0).

---

## Distribution posture (internal use)

SigmaLink is developed for **internal use only** — not sold/distributed globally. Signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer Program, third-party wake-word licensing) are NOT on the roadmap. The SmartScreen-first-launch + Gatekeeper-ad-hoc-signing workflows in `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh` are canonical.

## Architectural decisions

### 2026-05-16 — Linux is not a supported platform
Ships for macOS arm64 (primary) + Windows x64 only. `electron-builder` still emits AppImage/.deb for completeness, but: no Linux CI, no Linux smoke tests, no Linux installer scripts, no Linux install docs. To revisit: write a new ADR (re-add Ubuntu CI lanes, a Linux release workflow mirroring `release-macos.yml`, install docs).

## Sources cross-referenced
- `CHANGELOG.md` + `docs/09-release/` — authoritative shipped record
- `docs/08-bugs/BACKLOG.md` / `OPEN.md` — bug + optimization ledger
- `docs/03-plan/V3_PARITY_BACKLOG.md` — V3 parity (resolved v1.5.1; historical)
- `docs/02-research/bridgemind-review-2026-05-22/MASTER-BREAKDOWN.md` — C-class source (101 screenshots)
- Active plan files: `sf7-ruflo-mcp-auto-trust-plan.md`, `sf8-yolo-bypass-launch-plan.md`, `h19-ingestion-scan-pii-scrub-plan.md` (shipped); archived version docs in `docs/03-plan/archive/`
