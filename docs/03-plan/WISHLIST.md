# SigmaLink — Wishlist (quick capture)

> **Capture inbox.** Jot findings + new ideas here as they land — low ceremony.
> - **Execution sequence** (what we build next, priority-ordered) → `ROADMAP.md`
> - **Shipped record / archive** → `CHANGELOG.md` + `docs/09-release/` + the master
>   memory (`~/.claude/projects/.../memory/`) + Ruflo AgentDB
>
> Flow: capture here → triage into `ROADMAP.md` → on ship, it moves to the archive and
> leaves both working docs.
>
> **Reset 2026-06-08 after v2.0.0 shipped.** The entire v2.0.0 cycle's findings (the whole
> 6-phase roadmap + long-tail + Phases 7–10 + Phase 9 + the resume fixes — **all shipped**)
> were archived to `docs/03-plan/archive/WISHLIST-v2.0.0-cycle.md`; the full record is in
> `CHANGELOG.md` [2.0.0]. Only genuinely-open / forward-looking items are carried below.

---

## 🧊 Deferred XL (held — each is its own cycle; see ROADMAP ADR-003/006)
- **BSP-P4 — Canvas mode** (freeform draggable/resizable panes). XL — pane layout-engine rewrite. Leapfrog if shipped before BridgeCanvas.
- **BSP-P6 — multi-window / dual-window** (detach to its own OS window, multi-monitor). L–XL — multi-`BrowserWindow`. (Phase 10's B2 already shipped the browser-only detach slice.)
- **BSP-P5 — workspaces-as-tabs** (top tab-strip variant of the workspace switcher). S, but a layout-shell change — fold into a future shell pass.
- **Tauri/Rust platform migration.** Evaluated + rejected for now (ADR-006) — the disk leak was a logic bug, not a platform limit. Revisit only if idle-RAM / binary-size become a strategic priority, as its own cycle.

## 🔭 Open follow-ups (post-v2.0.0)
- **[resume] Deterministic codex session capture** — scrape codex's stdout `Session: <uuid>` banner so codex panes resume their OWN session. Today codex panes start fresh each reopen (safe; their cwd disk-scan races in a shared in-place cwd). Claude already resumes via the ghost-heal. See `feedback_inplace_resume_must_be_id_or_fresh`. Effort: M.
- **[resume] CRIT-fU-A — resume self-heal: recreate-if-missing worktree before spawn.** A `running` pane can reference a `worktree_path` that's gone; resume re-spawns without recreating it (recovered live in retest, so deferred). `resume-launcher.ts` recreate-if-missing before spawn. Effort: S.
- **[jorvis] `turnId` on the `ToolTrace` payload** — airtight per-turn inline-chip scoping (today `conversationId`-scoped, bounded by mount lifecycle). Effort: S.
- **[orch] B3 review nits** — SIGKILL escalation, sub-second adopt window, conversation-switch busy-clear. Effort: S.
- **[arch] N1 — `Launcher.tsx` > 500 lines → extract `launch-plan.ts`.** Effort: S.
- **[browser] BSP-B4 — `WebContentsView` input/focus reliability audit** (esp. form fields). Effort: M.
- *(capture new findings here)*

## 🚧 Operator-owned (blocked on a human / device — non-blocking for the shipped tag)
- **v2.0.0 post-release VISUAL eyeballs:** N1 wizard across themes · N2 browser drag + no-reload-on-reopen · N3 Jorvis live reply (run `claude` once for trust) · PERF-15 swarm-rail under live multi-agent streaming · `npm run test:perf` jank/IPC-rate delta.
- **SF-12 migration `0026`** — data-repair migration dormant pending the operator running diagnostic SQL on a real `agent_sessions` dump first. SQL in `docs/09-release/release-notes-1.35.0.txt`.
- **W-4** — win32 shell-first dogfood (P8–P9). Needs an operator Windows device.
- **FE-4** — voice items + device a11y QA. Behind native voice builds / needs the device.

## 📌 Standing references (not findings — kept for quick lookup)
- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR.
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` + `docs/02-research/videos/0NU7O7u-yfM-REVIEW.md` (competitive source) · the full v2.0.0-cycle wishlist → `docs/03-plan/archive/WISHLIST-v2.0.0-cycle.md`.
