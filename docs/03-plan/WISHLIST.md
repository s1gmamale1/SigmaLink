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

- **Combined video + perf-trace review harness** (test tooling) — **agreed method for the NEXT review.** One instrumented Playwright/Electron interaction run emits BOTH a `video:'on'` recording AND a CDP `Tracing.start` DevTools-timeline perf trace over the same timeline (+ CPU-throttle to stretch transient frames). Perf trace = the DETECTOR (dropped frames / long tasks / CLS — thresholdable, can fail CI); video frames at the flagged timestamps = the EXPLAINER (agent views via the video-vision plugin). Correlate by timestamp: measurement says WHERE to look, video says WHAT it was. Layered above the v1.35 trace + duplicate-frame detector. First run doubles as the still-owed motion-confirmation of the v1.36 purple-flash fix. Static anti-pattern review (animating transform/opacity not width/top, compositor checks) is the cheap pre-test layer a code reviewer already does.

---

## 🔎 Open findings (raw — sequenced in ROADMAP.md)

Lightweight notes only; the actionable plan + priority + code pointers live in `ROADMAP.md`.

- **W-4 P8–P9 + win32 shell-first dogfood** — resume simplification + drop `external_session_id`; win32 un-dogfooded. → ROADMAP **P1** (blocked on win32 dogfood).
- **FE-4 a11y + voice (blocked)** — focus-trap, VoiceOver QA, reduced-transparency, breadcrumb contrast; PCM sample-rate, whisper.cpp v1.7.x port. → ROADMAP **P2**.
- **SF-12 migration `0026` (operator-owned)** — Tier1+Tier2 shipped v1.35.0; the data-repair migration stays dormant pending the operator running the diagnostic SQL on a real `agent_sessions` dump. On sign-off → register `0026` (drop `.pending`, import + append to `ALL_MIGRATIONS`) + follow-up release. Diagnostic SQL in `docs/09-release/release-notes-1.35.0.txt`.
- **SF-14 optional polish** — auto-trigger the lazy Ruflo install on first workspace open (today renderer-triggered via Settings → Ruflo); room-chunk prefetch on idle to drop even the load spinner. Low.

> Everything else (C-class M0–M5, FE-1…4, R-1/R-2, W-class, **H-class fully complete incl. H-7**, **SF-14 daemon offline-CLI tier ✅ v1.36.0**, SF-1…15, CI Node-24 + e2e flake) is **shipped** — see `CHANGELOG.md` + the master-memory project entries. **Cursor skill fan-out DROPPED** (operator: claude+codex priority; `cursor-agent` doesn't consume the SKILL.md format → no-op). Don't re-note shipped items here.

---

## 📌 Standing references (not findings — kept for quick lookup)

- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR (re-add Ubuntu CI lanes + a Linux release workflow + install docs).
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` (C-class source).
