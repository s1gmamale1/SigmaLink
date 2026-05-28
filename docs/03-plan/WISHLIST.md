# SigmaLink — Wishlist (quick capture)

> **Capture inbox.** Jot findings + new ideas here as they land — low ceremony.
> - **Execution sequence** (what we do next, priority-ordered) → `ROADMAP.md`
> - **Shipped record / archive** → `CHANGELOG.md` + `docs/09-release/` + the
>   master memory (`~/.claude/projects/.../memory/`) + Ruflo AgentDB
>
> Flow: capture here → triage into `ROADMAP.md` for the next phase → on ship,
> it moves to the archive (CHANGELOG + memory) and leaves both working docs.

---

## 🆕 New ideas (untriaged)

_(empty — add raw ideas here; promote to ROADMAP when scoped)_

---

## 🔎 Open findings (raw — sequenced in ROADMAP.md)

Lightweight notes only; the actionable plan + priority + code pointers live in `ROADMAP.md`.

- **SF-12** (Critical, IN FLIGHT) — panes/worktrees/registry get mixed up on a running build (operator 2026-05-28). Old latent defect (status-blind `MAX(started_at)` slot resolution + pane_index reuse; +Pane/swarm panes persist `pane_index=NULL`). → ROADMAP **P0**.
- **H-7** — migrations not transactional (`core/db/migrate.ts`); naive txn-wrap crashes fresh-DB (self-BEGIN migrations). → ROADMAP **P1**.
- **Bundle the `ruflo` daemon binary** — SF-14 uses an npx fallback; binary isn't shipped. Product decision. → ROADMAP **P2**.
- **Cursor skill fan-out** — `ProviderTarget` enum doesn't include cursor; skill dir unverified. → ROADMAP **P3**.
- **W-4 P8–P9 + win32 shell-first dogfood** — resume simplification + drop `external_session_id`; win32 un-dogfooded. → ROADMAP **P4**.
- **FE-4 a11y + voice (blocked)** — focus-trap, VoiceOver QA, reduced-transparency, breadcrumb contrast; PCM sample-rate, whisper.cpp v1.7.x port. → ROADMAP **P5**.

> Everything else (C-class M0–M5, FE-1…4, R-1/R-2, W-class, H-class 18/19, SF-1…11/13/14/15, CI Node-24 + e2e flake) is **shipped** — see `CHANGELOG.md` + the master-memory project entries. Don't re-note shipped items here.

---

## 📌 Standing references (not findings — kept for quick lookup)

- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR (re-add Ubuntu CI lanes + a Linux release workflow + install docs).
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` (C-class source).
