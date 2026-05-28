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

- **Bundle the `ruflo` daemon binary** — SF-14 uses an npx fallback; binary isn't shipped. Product decision. → ROADMAP **P0**.
- **Cursor skill fan-out** — `ProviderTarget` enum doesn't include cursor; skill dir unverified. → ROADMAP **P1**.
- **W-4 P8–P9 + win32 shell-first dogfood** — resume simplification + drop `external_session_id`; win32 un-dogfooded. → ROADMAP **P2**.
- **FE-4 a11y + voice (blocked)** — focus-trap, VoiceOver QA, reduced-transparency, breadcrumb contrast; PCM sample-rate, whisper.cpp v1.7.x port. → ROADMAP **P3**.
- **SF-12 migration `0026` (operator-owned)** — Tier1+Tier2 shipped v1.35.0; the data-repair migration stays dormant pending the operator running the diagnostic SQL on a real `agent_sessions` dump. On sign-off → register `0026` (drop `.pending`, import + append to `ALL_MIGRATIONS`) + follow-up release. Diagnostic SQL in `docs/09-release/release-notes-1.35.0.txt`.

> Everything else (C-class M0–M5, FE-1…4, R-1/R-2, W-class, **H-class fully complete incl. H-7 transactional migrations**, SF-1…11/13/14/15, CI Node-24 + e2e flake) is **shipped** — see `CHANGELOG.md` + the master-memory project entries. Don't re-note shipped items here.

---

## 📌 Standing references (not findings — kept for quick lookup)

- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR (re-add Ubuntu CI lanes + a Linux release workflow + install docs).
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` (C-class source).
