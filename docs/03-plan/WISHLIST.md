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

All remaining findings are BLOCKED or operator-owned — nothing an agent can pick up unblocked. Add new findings above.

- **W-4 P8–P9 + win32 shell-first dogfood** — resume simplification + drop `external_session_id`; win32 un-dogfooded. → ROADMAP **B1** (BLOCKED on operator win32 dogfood).
- **FE-4 voice (blocked) + device a11y QA** — PCM sample-rate, whisper.cpp v1.7.x port, voice prebuildify (all behind unshipped native builds); device VoiceOver/Switch-Control QA needs hardware. → ROADMAP **B2** / operator. *(FE-4 a11y code — focus-trap, reduced-transparency, room prefetch — ✅ shipped `dbce7e6`; breadcrumb contrast = verified no-op.)*
- **SF-12 migration `0026` (operator-owned)** — data-repair migration dormant pending the operator running the diagnostic SQL on a real `agent_sessions` dump. On sign-off → register `0026` + follow-up release. SQL in `docs/09-release/release-notes-1.35.0.txt`.
- **SF-14 optional polish (low)** — auto-trigger the lazy Ruflo install on first workspace open (renderer-triggered today). *(Room-chunk prefetch half ✅ shipped `dbce7e6`.)*

> Everything else (C-class M0–M5, FE-1…4 incl. **a11y subset**, R-1/R-2, W-class, **H-class fully complete incl. H-7**, **SF-14 daemon offline-CLI tier**, SF-1…15, CI Node-24 + e2e flake, **video+perf review harness**) is **shipped** — see `CHANGELOG.md` + master-memory. **Cursor skill fan-out DROPPED** (no-op). Don't re-note shipped items here.

---

## 📌 Standing references (not findings — kept for quick lookup)

- **Distribution posture:** internal use only. No signed-distribution paths (EV cert, MS Store, WinGet, Apple Developer, wake-word licensing). Canonical: `app/build/nsis/README — First launch.txt` + `scripts/install-macos.sh`.
- **ADR 2026-05-16 — Linux not supported:** macOS arm64 + Windows x64 only; no Linux CI/smoke/installer/docs. Reversal needs a new ADR (re-add Ubuntu CI lanes + a Linux release workflow + install docs).
- **Source ledgers:** `docs/08-bugs/BACKLOG.md` (bugs/optimizations) · `docs/03-plan/V3_PARITY_BACKLOG.md` (V3 parity — resolved v1.5.1, historical) · `docs/02-research/bridgemind-review-2026-05-22/` (C-class source).
