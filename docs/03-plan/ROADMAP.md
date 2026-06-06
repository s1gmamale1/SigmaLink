# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for what is **still pending**,
> derived from `WISHLIST.md`. A whiteboard — refreshed each cycle, **not permanent documentation**.
> Permanent record → `CHANGELOG.md` + master memory + Ruflo AgentDB.
>
> **State as of 2026-06-07.** The entire v2.0.0 feature arc is **✅ SHIPPED to `main` (untagged)**:
> Phases 0–8 + 10, the 15-theme gallery (#104), per-workspace colors (#113), Windows hardening (#110),
> pane-switch-jank (#118). **Shipped since the last refresh:** RAM-brake slice 1 (#117) + **remainder
> (#120)** — admission control, per-pane RSS badge, lane allowlists; **SMK-1 + DEV-7 HMR script (#119)**;
> and a **boot-restore reliability hotfix (#121)** — the black-panes race + in-place stale-session
> fallback, found during operator testing. Per this doc's convention, shipped work is deleted from the
> whiteboard (full record → `CHANGELOG.md`).
>
> **What's left (this file):** ① the low-sev hotlist — **DEV-6 + DEV-8 IN PROGRESS** (unblocked now that
> the RAM PR landed), DEV-7 log-noise residual, PERF-RAM-2 verify · ② the one remaining feature phase,
> **Phase 9 — Orchestration & memory surfacing** · ③ the **deferred XL** big-bangs (Canvas, multi-window,
> Tauri eval). **v2.0.0 tag** awaits only the operator visual smokes (N1 · N2 · N3).

This ROADMAP is the single source of truth for what to build next.

---

## How to read this
- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort:** S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Item codes (`DEV-*`, `BSP-*`, `PERF-*`) trace back to `WISHLIST.md`. Confirmed bugs are fixed before new feature phases.
- **Already-shipped competitor parity is NOT re-built** — see "Skip / market better" at the tail.

---

## ✅ Shipped since last refresh (full record → `CHANGELOG.md`)
- **#117 + #120 — P0 RAM Brake (complete).** Lean `ruflo-core` default profile + opt-in Browser tools; admission control (total / per-workspace / MCP-heavy caps) at the spawn siblings; per-pane runtime-profile badge + live RSS readout; lane allowlists; cleanup process-tree telemetry/stop. The 69–70 GB fill class is now capped — the RAM hard-cap is no longer a tag blocker.
- **#119 — SMK-1 + DEV-7 (HMR).** opencode session scoping joins the Option-B whitelist; opt-in `pnpm electron:dev:hmr` real dev-server/HMR launcher (the known-good `electron:dev` left intact).
- **#121 — boot-restore reliability hotfix.** Black-panes **race** (restore IPC arriving after `state.ready`; a `restoreTick` nonce re-runs the drain) + in-place **stale-session** fallback (`prepareClaudeResume` now stats the JSONL even in-place → falls back to `--continue` instead of `claude --resume <ghost-id>`). +2 regression tests. Latent race exposed by Phase-0's awaited boot-sweep — affected every install.
- **#123 — DEV-6 + DEV-8.** zod input schemas for all 49 un-schemed IPC channels (boot "no zod schema entry" warning → 0; conservative, so live `enforce` mode never rejects valid IPC; +2 coverage tests) + bundle hygiene (static `SkillsTab` import, `ease-smooth` token, chunk-limit → **warning-free build**).

---

## 🔓 Release carry-over (operator-owned)
**v2.0.0 is on `main` (untagged)** and CI-green. The tag awaits **only the owed operator VISUAL smokes**: **N1** wizard across themes · **N2** browser drag / no-reload-on-reopen · **N3** Jorvis live reply (run `claude` once for trust). Soft-owed eyeballs: PERF-15 swarm-rail under live multi-agent streaming · DB-2 backup→restore round-trip · FEAT-11 rewind on a real worktree · `npm run test:perf` jank/IPC-rate delta. *(The P0 RAM hard-cap is no longer an open tag decision — shipped via #120.)* Tag via `/sigmalink-release`.

---

## 🐞 Leftover low-sev bug hotlist — ✅ CLEARED

All four items resolved. **DEV-6** + **DEV-8** shipped (#123); the remaining two were investigated and need **no code change**:
- **PERF-RAM-2 — ✅ verified no-op.** `pty.kill()` → `stop({tree:true})` → `stopProcessTree`, which walks the **full descendant tree** (recursive `ppid→children` DFS), so the agent's MCP-server children are killed on **both** pane-close (`rpc-router` `pty.kill`) and swarm-stop (`factory-spawn` `pty.kill`). The ruflo HTTP daemon is per-workspace (stopped on workspace close / `stopAll`), not a per-pane leak. No accumulation.
- **DEV-7 (residual) — ✅ verified no console noise.** `probeHealth` recurses **silently** while `status==='starting'` and stops once `running`; logs are once-each ("daemon ready" / a single round-trip-fail warn / the not-installed notice). Boot logs confirm zero ruflo-http spam. Re-open only if live noise is observed.

*(Non-blocking follow-ups parked in `WISHLIST.md`: closed-tabs table has no GC (`listRecents` bounded but rows accumulate); the SMK-2 loop test fails via a 5s timeout rather than a fast message assertion; add `turnId` to the `ToolTrace` payload for airtight per-turn chip scoping.)*

---

## Phase 9 — Orchestration & memory surfacing
**Goal.** The Sigma orchestrator + Ruflo memory are first-class persistent surfaces.
**Deliverables.** **BSP-O1** persistent chrome-level "Sigma" rail panel (Canvas: numbered to-dos + live token delta + Review tab) · **BSP-O2** live routing trace · **BSP-O3** "Automations" nav · **BSP-O4** "Artifacts" + per-conversation named sessions · **BSP-O5** surface the Ruflo graph prominently.
**Why now.** The sole remaining feature phase; defends our shipped strengths (C-7, MEM-1 graph) before competitors ship the equivalent.
**Scope.** Extract `operator-console/OrchestratorPanel.tsx` → `right-rail/*` persistent tab; Canvas from `shared/orchestrator-tasks.ts`/`plan-capsule.ts`; routing trace from Ruflo `hooks_route`; Artifacts in `core/memory/*`.
**Findings + recommendation.** O1 is a relocation+persistence packet, not a rebuild; O3/O4 net-new medium.
**Risks.** Right-rail real-estate contention → tabbed rail + collapse when narrow.
**Definition of done.** Sigma panel persists across layouts with live to-dos + token delta; a routing decision is visible; the graph is ≤1 click from any room; `tsc -b` · vitest · lint · build green.

---

## 🧊 Deferred (XL / big-bang — held per the DDD small-per-packet rule)
- **BSP-P4 — Canvas mode** (freeform draggable panes). XL — layout-engine rewrite. Leapfrog if shipped before BridgeCanvas.
- **BSP-P6 — multi-window / dual-window**. L–XL — multi-`BrowserWindow`. (Phase 10's B2 already delivered the browser-only detach slice.)
- **BSP-P5 — workspaces-as-tabs** top strip. S, but a layout-shell change — fold into a future shell pass.
- **Tauri/Rust platform migration.** Evaluated + rejected for now (ADR-006) — the disk leak was a logic bug, not a platform limit; a rewrite is months for zero benefit on it. Revisit only if idle-RAM/binary-size become a strategic priority, as its own cycle.

## ✅ Skip / market better (already shipped — do NOT rebuild)
Session-resume modal ≈ **FEAT-1** · per-pane usage/cost ≈ **FEAT-3** · per-agent identity ≈ **FEAT-7** · effort control ≈ **FEAT-14** · browser-in-separate-window ≈ **C-8** · 30-sub-agent plan→review→build ≈ **C-7** · MCP autowrite per-CLI = **SF-7**. **WE LEAD & they lack:** worktree isolation, 6 providers, SigmaBench, Obsidian memory graph, voice **dispatch**, Telegram remote, agent rewind, sub-agent depth control. Positioning: **"ADE — Agent Development Environment"** + **"Context layer"**.

## 🚧 Blocked / operator-owned (parked)

| # | Item | Status |
|---|------|--------|
| **rel** | v2.0.0 tag — gated on the N1/N2/N3 visual smokes | operator-owned |
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | 🚧 needs an operator Windows device |
| **B2** | FE-4 voice items | 🚧 behind unshipped native voice builds |
| **op** | SF-12 migration `0026` register | operator sign-off — run diagnostic SQL on a real `agent_sessions` dump first (historical data backfill; the status-aware index from Phase 0 is the recurring guard) |
| **op** | FE-4 device a11y QA | needs the device |

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
**Decision.** Offer a per-workspace `worktreeMode: 'worktree' | 'in-place'`; in-place reuses the existing `repoMode!=='git'` no-worktree path so agents run in the repo root. **Consequences.** (+) zero worktrees for users who opt in (disk win). (−) agents share one tree → concurrent-edit collisions; surfaced in the UI; both worktree gates honor it (sibling twins). Resume must validate the conversation JSONL exists even in-place (#121).

*(ADR-001/002 theme-token decisions + ADR-004 disk-safety net are shipped and recorded in `CHANGELOG.md`.)*

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| Orchestration + memory (O1–O5) | 9 | L | Med-High | Relocate C-7 + surface graph; **sole remaining feature work** |
| Canvas mode (P4) / Multi-window (P6) / Tauri eval | deferred | XL | — | Big-bang, separate cycles |

*(Hotlist cleared: DEV-6/DEV-8 shipped #123; PERF-RAM-2 + DEV-7-residual verified no-op.)*

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; mark it promoted/struck in `WISHLIST.md`; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings.
