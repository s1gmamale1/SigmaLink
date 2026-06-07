# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for what is **still pending**,
> derived from `WISHLIST.md`. A whiteboard — refreshed each cycle, **not permanent documentation**.
> Permanent record → `CHANGELOG.md` + `docs/09-release/` + master memory + Ruflo AgentDB.
>
> **State as of 2026-06-08. 🏷️ v2.0.0 is RELEASED** — tag `v2.0.0` (commit `4c11fc8`); `release-macos` /
> `release-windows` built the artifacts, GH release published. The first tagged major bundled the entire
> 6-phase roadmap + long-tail + the Phase 0 crisis fix + Phases 7–10 + Phase 9 (orchestration & memory
> surfacing) + the operator-found in-place resume fixes (#125–#128). **Full record → `CHANGELOG.md`
> [2.0.0] + `docs/09-release/release-notes-2.0.0.txt`.**
>
> **There is no remaining feature work on the roadmap.** This file is now a thin holder for the
> **deferred-XL big-bangs**, the **operator-owned** items, and the durable **ADRs** — until the next
> cycle builds a fresh phase plan from `WISHLIST.md`.

---

## How to read this
- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort:** S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Item codes (`DEV-*`, `BSP-*`, `PERF-*`) trace back to `WISHLIST.md`. Confirmed bugs are fixed before new feature phases.
- **Already-shipped competitor parity is NOT re-built** — see "Skip / market better" at the tail.

---

## 🧊 Deferred (XL / big-bang — held per the DDD small-per-packet rule)
Each is its own future cycle; none is started.
- **BSP-P4 — Canvas mode** (freeform draggable panes). XL — pane layout-engine rewrite. Leapfrog if shipped before BridgeCanvas.
- **BSP-P6 — multi-window / dual-window**. L–XL — multi-`BrowserWindow`. (Phase 10's B2 already delivered the browser-only detach slice.)
- **BSP-P5 — workspaces-as-tabs** top strip. S, but a layout-shell change — fold into a future shell pass.
- **Tauri/Rust platform migration.** Evaluated + rejected for now (ADR-006) — the disk leak was a logic bug, not a platform limit; a rewrite is months for zero benefit on it. Revisit only if idle-RAM/binary-size become a strategic priority, as its own cycle.

## 🚧 Blocked / operator-owned (parked — non-blocking for the shipped tag)

| # | Item | Status |
|---|------|--------|
| **rel** | v2.0.0 tag | ✅ TAGGED + RELEASED 2026-06-07 (`4c11fc8`) |
| **smk** | Post-release VISUAL eyeballs — N1 wizard across themes · N2 browser drag/no-reload · N3 Jorvis live reply · PERF-15 swarm-rail under live streaming · `npm run test:perf` | non-blocking; operator at leisure |
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | 🚧 needs an operator Windows device |
| **B2** | FE-4 voice items + device a11y QA | 🚧 behind unshipped native voice builds / needs the device |
| **op** | SF-12 migration `0026` register | operator sign-off — run diagnostic SQL on a real `agent_sessions` dump first (historical backfill; the status-aware index from Phase 0 is the recurring guard) |

## ✅ Skip / market better (already shipped — do NOT rebuild)
Session-resume modal ≈ **FEAT-1** · per-pane usage/cost ≈ **FEAT-3** · per-agent identity ≈ **FEAT-7** · effort control ≈ **FEAT-14** · browser-in-separate-window ≈ **C-8** · 30-sub-agent plan→review→build ≈ **C-7** · MCP autowrite per-CLI = **SF-7** · orchestrator panel + memory-graph surfacing = **Phase 9**. **WE LEAD & they lack:** worktree isolation, 6 providers, SigmaBench, Obsidian memory graph, voice **dispatch**, Telegram remote, agent rewind, sub-agent depth control. Positioning: **"ADE — Agent Development Environment"** + **"Context layer"**.

---

## Architecture decisions (ADRs)

> Durable decision log — kept even after the originating phase ships (the phases themselves move to `CHANGELOG.md`).

### ADR-003 — Defer Canvas mode + multi-window (XL) per the small-per-packet rule
**Decision.** Park BSP-P4 (Canvas) + BSP-P6 (multi-window); the browser-detach slice (B2) shipped in Phase 10. **Consequences.** (+) shippable increments. (−) a competitor canvas could ship first — accepted.

### ADR-005 — `agent_sessions` pane-slot uniqueness is status-aware
**Decision.** The partial unique index `agent_sessions_ws_pane_uq` includes `AND status IN ('running','starting')`, so the index's notion of "slot occupied" matches the allocator's. **Context.** The status-agnostic index (`migration 0020`) + a live-only allocator disagreed → permanent post-crash lockout. **Consequences.** (+) fresh spawns into a janitor-swept slot succeed; exited rows keep `pane_index` for resume. (−) dormant `0026` remains the one-shot historical backfill, not the recurring guard.

### ADR-006 — Stay on Electron; do NOT migrate to Tauri/Rust for this
**Decision.** Fix resource issues in-codebase; do not migrate to Tauri/Rust. **Context.** The "memory leak" was a **disk** leak from a logic bug — reproducible identically under any host language. **Consequences.** (+) hours-scale fixes vs a multi-month rewrite of the entire main process (better-sqlite3, node-pty, RPC router, voice natives). (−) we keep Electron's ~150–250 MB idle-RAM baseline; a Tauri eval stays a deferred, separate-cycle option if binary-size/idle-RAM become strategic.

### ADR-007 — Optional per-workspace in-place (no-worktree) mode
**Decision.** Offer a per-workspace `worktreeMode: 'worktree' | 'in-place'`; in-place reuses the existing `repoMode!=='git'` no-worktree path so agents run in the repo root. **Consequences.** (+) zero worktrees for users who opt in (disk win). (−) agents share one tree → concurrent-edit collisions AND a shared session-resolution cwd. Resume must validate the conversation JSONL exists even in-place and resume by an explicit id (never a continue-latest guess) or start fresh + capture the new id (#121 · #127 · #128).

*(ADR-001/002 theme-token decisions + ADR-004 disk-safety net are shipped and recorded in `CHANGELOG.md`.)*

---

## When the next cycle starts
Build a fresh phase plan here from `WISHLIST.md` (the lean inbox) — promote scoped items into `## Phase N` blocks (Goal · Deliverables · Why now · Scope · Findings · Risks · Definition of done), ordered by value/effort. On ship → move each to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB, and delete it from this whiteboard.
