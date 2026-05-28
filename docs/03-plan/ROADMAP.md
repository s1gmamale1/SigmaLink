# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the
> CURRENT phase, derived from findings captured in `WISHLIST.md`. This is a
> whiteboard — refreshed each phase, **not permanent documentation**. The
> permanent record lives in `CHANGELOG.md`, the master memory
> (`~/.claude/projects/.../memory/`), and the Ruflo AgentDB.
>
> **Shipped baseline: v1.36.0 (2026-05-29) + on-main-untagged: video+perf harness & FE-4 a11y subset (`dbce7e6`).**
>
> **🟢 The backlog is DRAINED of actionable, unblocked work.** Nothing here can be picked up by an agent right now without an operator first unblocking it — every remaining item is **blocked** (needs win32 dogfood / unshipped voice builds), **operator-owned** (SF-12 sign-off, manual QA smokes), or **low optional polish**. New work starts in `WISHLIST.md` (currently empty).

---

## 🎯 Sequence (priority order — refreshed 2026-05-29 post-v1.36.0)

| # | Item | Type | Status |
|---|------|------|--------|
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | cleanup | 🚧 BLOCKED — needs an operator Windows dogfood |
| **B2** | FE-4 voice items | polish | 🚧 BLOCKED — unshipped native voice builds |
| **op** | SF-12 migration `0026` register + ship | operator-owned | dormant — needs diagnostic-SQL sign-off |
| **op** | FE-4 device a11y QA (VoiceOver/Switch-Control) | polish | operator-owned — needs a device |
| **opt** | SF-14 auto-trigger lazy Ruflo install on first open | small | optional, low (renderer-triggered today) |

*(FE-4 a11y code subset — focus-trap, reduced-transparency, room prefetch — shipped `dbce7e6`. Breadcrumb contrast was a verified no-op. The video+perf review harness shipped `dbce7e6`.)*

---

### ▶ B1 — W-4 P8–P9 + win32 shell-first dogfood  ·  BLOCKED

Shell-first is the default since v1.14.0. Remaining: **P8** resume simplification + **P9** drop `external_session_id` (~150 refs) — held until post-flip stability confirmed. **win32 shell-first un-dogfooded** (P5 shipped flagged; H-6 win32 sentinel fixed v1.27.0) — needs an operator Windows dogfood before trusting it. Revert path = `pty.spawnMode='direct'`.

### ▶ B2 — FE-4 voice items  ·  BLOCKED (unshipped native builds)

PCM sample-rate mismatch; whisper.cpp v1.7.x port; voice-{mac,win} prebuildify silent-no-output; voice-win `IsAvailable()` HMR race. All behind native voice builds that aren't shipping.

---

## Operator-owned smokes (parallel, human-QA)
SF-12 diagnostic SQL on real `agent_sessions` dump (unblocks migration `0026`; SQL in `docs/09-release/release-notes-1.35.0.txt`) · win32 shell-first dogfood (unblocks B1) · FE-4 device VoiceOver/Switch-Control QA · real-bot/real-phone (R-1) · `cursor-agent` login (R-2) · H-19 ingestion-redaction.

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings/ideas.
