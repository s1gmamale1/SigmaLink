# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the
> CURRENT phase, derived from findings captured in `WISHLIST.md`. This is a
> whiteboard — refreshed each phase, **not permanent documentation**. The
> permanent record lives in `CHANGELOG.md`, the master memory
> (`~/.claude/projects/.../memory/`), and the Ruflo AgentDB.
>
> **Shipped baseline: v1.36.0 (2026-05-29) — H-7 transactional migrations + SF-14 offline Ruflo daemon + page-change flash fix.** Work top-down.
>
> **The backlog is nearly drained.** Everything remaining is either blocked (win32 dogfood, unshipped voice builds), operator-owned (SF-12 `0026`, dogfoods), or low-priority polish. The most actionable NET-NEW work is the combined video+perf review harness (WISHLIST → P0 candidate).

---

## 🎯 Sequence (priority order — refreshed 2026-05-29 post-v1.36.0; operator to confirm)

| # | Item | Type | Status |
|---|------|------|--------|
| **P0** | Combined video + perf-trace review harness | test tooling | agreed for next review (net-new) |
| **P1** | W-4 P8–P9 + win32 shell-first dogfood | cleanup | blocked (needs win32 dogfood) |
| **P2** | FE-4 a11y follow-ups + blocked voice items | polish | low |
| (opt)  | SF-14 polish — auto-install-trigger / room prefetch | polish | optional, low |
| (op)   | SF-12 migration `0026` register + ship | operator-owned | dormant pending diagnostic-SQL sign-off |

---

### ▶ P0 — Combined video + perf-trace review harness  ·  test tooling (net-new)

One instrumented Playwright/Electron interaction run emits a `video:'on'` recording AND a CDP `Tracing.start` DevTools-timeline perf trace over the same timeline (+ CPU-throttle to stretch transient frames). Perf trace = detector (dropped frames / long tasks / CLS — thresholdable, can fail CI); video frames at flagged timestamps = explainer (agent views via the video-vision plugin), correlated by timestamp. Layered above the v1.35 trace + duplicate-frame detector. First run = the still-owed motion-confirmation of the v1.36 purple-flash fix (fresh-profile room-change flow). **Agreed as the method for the next review.**

### ▶ P1 — W-4 P8–P9 + win32 shell-first dogfood  ·  deferred

Shell-first is the default since v1.14.0. Remaining: **P8** resume simplification + **P9** drop `external_session_id` (~150 refs) — held until post-flip stability confirmed. **win32 shell-first un-dogfooded** (P5 shipped flagged; H-6 win32 sentinel fixed v1.27.0) — needs an operator Windows dogfood before trusting it. Revert path = `pty.spawnMode='direct'`.

### ▶ P2 — FE-4 a11y follow-ups + blocked voice  ·  low

FE-4 a11y: Tab-containment focus-trap on Task drawers (`TODO(a11y)`); device VoiceOver/Switch-Control QA; `prefers-reduced-transparency` for non-glass surfaces; breadcrumb ~4.3:1 → AA. Voice (blocked behind unshipped builds): PCM sample-rate mismatch; whisper.cpp v1.7.x port; voice-{mac,win} prebuildify silent-no-output; voice-win `IsAvailable()` HMR race.

---

## Operator-owned smokes (parallel, human-QA)
SF-12 diagnostic SQL on real `agent_sessions` dump (unblocks migration `0026` registration; SQL in `docs/09-release/release-notes-1.35.0.txt`) · win32 shell-first dogfood (unblocks P3) · real-bot/real-phone (R-1) · `cursor-agent` login (R-2) · H-19 ingestion-redaction.

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings/ideas.
