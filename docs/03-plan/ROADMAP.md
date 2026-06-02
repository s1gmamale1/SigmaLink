# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the CURRENT phase,
> derived from findings in `WISHLIST.md`. A whiteboard — refreshed each phase, **not permanent
> documentation**. Permanent record → `CHANGELOG.md` + master memory + Ruflo AgentDB.
>
> **Shipped baseline:** SigmaLink v1.36.0 (+ on-main-untagged video+perf harness & FE-4 a11y `dbce7e6`);
> SigmaVoice standalone v0.3.2 (own repo, macOS arm64 DMG).
>
> **✅ P1 (#70) · ✅ P2 (#72) · ✅ P3 (#73) · ✅ P4 (#75+#76) · ✅ P5 (#78+#79) SHIPPED — all untagged → ride the next release.**
> **ACTIVE PHASE → P6 (Competitive features & leapfrogs; `FEAT-*` + worktree leapfrogs).** ARCH-1 (main-process tsconfig) still owed. Deferred follow-ups (P4.2 memory items, PERF-7/8/9/12, density scale) parked in WISHLIST. Owed pre-tag: the P5 perf-harness + resize live smokes.
>
> **Phase goal (operator's 6-pillar vision):** **(a)** Apple-grade visuals · **(b)** responsive layouts ·
> **(c)** smooth animations/popups · **(d)** polished notifications · **(e)** tasteful sound ·
> **(f)** persistent DB + agent memory that **mirrors Obsidian** (graph/backlinks/daily-notes/Ruflo).
>
> **Ordering principle (critic-enforced): reliability spine + motion foundation BEFORE sparkle, then
> the headline obsidian-memory, then perf/responsive, then competitive features.** A single uncaught
> render throw blanks the window today (ERR-1) and swarm crashes are silently swallowed (BUG-1) — those
> land first. `MOT-1` is the load-bearing prerequisite every animation/notification item assumes, so it
> opens P2. Full backlog (75 items + evidence + proposals) lives in `WISHLIST.md`.

---

## 🎯 Phase sequence (priority order — set 2026-05-31)

| Phase | Theme (pillar) | Ships as¹ | Headline items (priority order) | Why here |
|------|----------------|-----------|----------------|----------|
| ✅ **P1** | Reliability & correctness spine | ✅ **merged PR #70** (`37f94a0`) | **DONE** — BUG-1/2/3/4/5/6/7/8/13/14 · DB-1 · ERR-1 · ARCH-10 + commitAndMerge `--abort` fix. *(ARCH-1 split to its own follow-up — still owed.)* | Shipped 2026-05-31. |
| ✅ **P2** | Apple-grade motion & overlays (a/c) | ✅ **merged PR #72** | **DONE** — MOT-1, UX-1/2/3/4/5/6/7/8/9/10, ANIM-2, PERF-13/MEM-10 | Shipped. One motion language; native modals + dark-pinned toaster gone. |
| ✅ **P3** | Notifications + sound (d/e) | ✅ **merged PR #73** | **DONE** — NTF-1, NTF-2, NTF-3(=UX-9), SND-1, ANIM-3 | Shipped. DND/quiet-hours/per-source + restrained soundscape + toast↔bell handoff + pane aliveness. |
| ✅ **P4** | Obsidian memory + agent-memory unification (f) — **HEADLINE** | ✅ **merged PRs #75+#76** | **DONE** — MEM-1, MEM-4, MEM-2, MEM-3, MEM-6, DB-2, BUG-10/11/12. *(MEM-5/7/8/9, PERF-14, causal edges, global ⌘O → P4.2/WISHLIST.)* | Shipped. Ruflo-as-graph + ⌘O + daily notes + tags + orphans + DB backup. |
| ✅ **P5** | Responsiveness & performance (b) | ✅ **merged #78+#79** | **DONE** — PERF-1/11 (pty:data+broadcast), PERF-3 (selectors), PERF-5/6 (dedup polling), PERF-2/4/10, RSP-1 (resizable + per-ws sizes). *(PERF-7/8/9/12 + density → WISHLIST.)* | Shipped. Hottest IPC + re-render paths tamed; resizable layout-remembering surfaces. |
| ◀ **P6** | Competitive features & leapfrogs — **ACTIVE** | `v1.42.0`+ | FEAT-1, FEAT-3, FEAT-7, FEAT-11, FEAT-13, FEAT-2/5/6/8/9/4/10/12/14, ONB-1 | Parity surfaces + worktree leapfrogs (agent rewind, merge-orchestration, git heatmap). |
| **×** | Cross-cutting (every phase) | within each release | SEC-1, ARCH-2/3/4/5/6/7/8/9, RES-1 | Security re-gate + opportunistic decompositions when touching those files. |
| **B** | Blocked / operator-owned (parked) | when unblocked | SV1, SV2, B1, B2, op-0026, op-smokes | Not actionable unblocked — see tail. |

> ¹ **Ships as** = suggested release tag per phase, operator-authorized at ship time (not a commitment). A phase may split across point releases; P6 spans several.

---

### ▶ P1 — Reliability & correctness spine · ✅ SHIPPED 2026-05-31 (PR #70 · `37f94a0`, untagged)
**Delivered (13 fixes):** BUG-1 (shared `isPtyCrash` in new dep-free `pty/crash.ts`, both exit paths persist `isCrash`) · BUG-2 (daemon `wireChildIo` drains stdout on both spawn paths) · BUG-3 (sync push-retry full `_pullCycle` reconcile + re-encode — closes a cross-device data-loss window) · BUG-4 (all side-band IPC validated via shared `registerIpcHandler`, incl. destructive `cleanup.*`) · BUG-5/6/7/8 (lifecycle / GC revival / truncated download / quit-persist log) · BUG-13 (dedup `AddAgentToSwarmInput`) · BUG-14 (commitAndMerge behavior tests **+ found & fixed a real HIGH: `git merge --abort` on conflict so the base branch is restored**) · DB-1 (SQLite `quick_check` + quarantine-and-recreate) · ERR-1 (root + per-room error boundaries + renderer error sink) · ARCH-10 (29 stale worktrees swept, 5.8 GB→0).
**Gate:** `tsc -b` clean · 2000 vitest pass · e2e 9/3-skip · Opus review (no critical/high; the one MEDIUM — launcher DB-status parity — folded). Detail → `CHANGELOG.md` [Unreleased] + master memory.
**Still owed from P1 scope:** **ARCH-1** — `tsconfig.main.json` so `src/main` is type-checked as Node (split to its own follow-up; expected to surface a latent main-process type-error backlog).

### ▶ P2 — Apple-grade motion & overlays (pillars a, c) · ✅ SHIPPED (PR #72, untagged)
**Goal:** one cohesive Apple motion language across every overlay, zero native OS modals, theme-correct transient surfaces.
**Deliverables:** `MOT-1` motion tokens + `useSpringPresence` with all `components/ui/*` overlays migrated; a themed Toaster; a Radix-based notification dropdown; themed Prompt/Alert dialogs replacing all native calls.
**Work (priority — MOT-1 FIRST):**
- **MOT-1** motion-token foundation **(prereq for P2/P3 animation)**: Apple spring easings as CSS+tailwind tokens (smooth/snappy/bouncy, 150/250/350ms, reduced-motion-aware) + `useSpringPresence`; migrate `components/ui/*`.
- **UX-1** themed Toaster (kill the hard-pinned dark). **UX-2** rebuild notification dropdown on Radix Popover (focus-trap/Escape/spring). **UX-3** replace native `prompt/confirm/alert` with themed dialogs (destructive → AlertDialog first). **UX-4** dialog max-height + scroll. **UX-7** single root TooltipProvider.
- **ANIM-2** Orb `prefers-reduced-motion` (quick win). **UX-5** room-switch transitions. **UX-6** dnd drop animation. **UX-8** keyboard pane-resize. **UX-9** notification non-color severity cue. **UX-10** `focus-visible:` sweep. **PERF-13 + MEM-10** MemoryGraph RAF-settle + theme colors + reduced-motion.
**Exit criteria:** no `window.prompt/confirm/alert` remain (grep clean); toasts track the active theme; every Radix overlay uses the spring tokens; `prefers-reduced-motion` honored app-wide incl. Orb + MemoryGraph.

### ▶ P3 — Notifications + sound (pillars d, e) · ✅ SHIPPED (PR #73, untagged)
**Delivered:** NTF-1 (DND/quiet-hours/per-source via shared `notification-prefs.ts` + `os-notify.ts` gating) · SND-1 (`lib/sounds.ts` 12-cue soundscape + volume + per-cue mute matrix + preview; `notifications.ts` → back-compat shim) · NTF-2 (collapsible per-source dropdown grouping + max-severity tone + themed toast↔bell handoff) · ANIM-3 (PaneFooter rotating-verb + elapsed aliveness). NTF-3 = P2's UX-9. **Deferred → WISHLIST:** optional daily-summary digest. Detail → `CHANGELOG.md` [Unreleased].
**Goal:** a calm, controllable notification + sound experience — tasteful where it adds value, silent where it doesn't.
**Deliverables:** DND/quiet-hours/per-source mute UI, a grouped/animated notification dropdown, and a `lib/sounds.ts` soundscape module with a volume + per-event mute matrix in NotificationsSettings. Built on P2 springs; backend (`manager.ts`) is already mature.
**Work (priority order):**
- **NTF-1** DND / quiet-hours / per-source mute (wire the scaffolded `KV_OS_PER_SOURCE`) + optional daily summary.
- **NTF-2** grouped/animated dropdown + mark-all-read + coherent toast↔bell handoff. **NTF-3** = UX-9.
- **SND-1** central soundscape (event→cue, per-severity tones, volume + per-event mute matrix, gated by reduced-motion/DND/hidden, record-start/stop, CSP-safe optional assets, synth fallback). Restraint default: no per-PTY-data sound.
- **ANIM-3** whimsical progress verbs + elapsed/token aliveness on running panes.
**Exit criteria:** DND silences OS + sound; per-source mute works; sound is suppressed under reduced-motion / DND / hidden-window; distinct severity tones; volume persists.

### ▶ P4 — Obsidian memory + agent-memory unification (pillar f) — **HEADLINE** · ✅ SHIPPED (PRs #75 + #76, untagged)
**Delivered:** MEM-1 (Ruflo AgentDB as a read-only graph node class via `ruflo.entries.list`/`neighbors` + `useRufloGraphOverlay` + `MemoryGraph` legend + read-only virtual notes) · MEM-4 (⌘O quick switcher) · MEM-2 (daily notes) · MEM-3 (tags pane filtering list+graph) · MEM-6 (orphans/suggestions UI) · DB-2 (backup/restore, main-side dialog) · BUG-10/11/12. **Operator smoke owed pre-tag:** DB-2 backup→restore→identical round-trip (no vitest coverage — better-sqlite3 ABI). **→ P4.2/WISHLIST:** causal edges, global ⌘O, graph tag-dim, MEM-5/7/8/9, PERF-14, daily-note digest. Detail → `CHANGELOG.md`.
**Goal:** the Ruflo agent memory is browsable the Obsidian way, and the Memory room feels like a real PKM (graph/backlinks/daily-notes/tags/quick-switcher).
**Deliverables:** Ruflo patterns as a distinct graph node class with backlinks (read-only), a ⌘O quick switcher, Daily Notes, a tags pane, the orphans/suggestions UI, and DB backup/restore.
**Work (priority — MEM-1 is the anchor):**
- **MEM-1** **surface the Ruflo AgentDB the Obsidian way** (graph nodes + backlinks + read-only linked notes; causal-edges/similarity edges; namespace tag facets; node sizing by time-decay). Start read-only; write-linking fast-follow.
- **MEM-4** global Quick Switcher (⌘O) unified memory+pattern search in the command palette. **MEM-2** Daily Notes (+ self-populating agent-activity digest). **MEM-3** Tags pane + tag filters. **MEM-6** orphans + suggested-connections UI (shipped-but-hidden quick win). **MEM-5** aliases → **MEM-7** unlinked mentions. **DB-2** DB backup/export-import. **BUG-10** populate `frontmatter_json` → **MEM-9** properties/outline editor; **MEM-8** templates. **BUG-11/12** editor staleness + case-uniqueness. **PERF-14** FTS5 search (when vaults grow).
**Exit criteria:** Ruflo patterns appear as a distinct node class with similarity/causal edges + backlinks; ⌘O jumps to any note from anywhere; a "Today" note auto-creates; tag-click filters the list + graph; DB backup round-trips (backup → restore → identical state).

### ▶ P5 — Responsiveness & performance (pillar b) · ✅ SHIPPED (PRs #78 + #79, untagged)
**Delivered:** PERF-1 (`pty:data` coalescer) · PERF-11 (single-window broadcast) · PERF-3 (granular selectors for the 5 hottest consumers) · PERF-5/6 (refcounted Ruflo-health + shared per-repo git-status pollers, pause-when-hidden) · PERF-4 (incremental sessionsByWorkspace) · PERF-10 (binary-insert deltas) · PERF-2 (main-side link-detect gate) · RSP-1 (`useBreakpoint` + per-workspace UI kv; resizable Memory tri-column; per-workspace rail widths + narrow auto-collapse). **Owed pre-tag:** `npm run test:perf` jank-delta + `pty:data` IPC-rate live measurement; resize/collapse live smoke. **→ WISHLIST:** PERF-7/8/9/12, density scale. Detail → `CHANGELOG.md`.
**Goal:** resizable, layout-remembering surfaces that stay smooth under live multi-agent load.
**Deliverables:** the Resizable primitive adopted for rail/main/right-rail + Memory (sizes persisted per workspace), `pty:data` coalescing, granular state selectors, per-pane polling dedup — with before/after perf-harness deltas recorded.
**Work (priority order):**
- **RSP-1** adopt the bundled-but-dead Resizable primitive for rail/main/right-rail + Memory tri-column, **persist sizes per workspace**; shared `useBreakpoint` + density scale; narrow-width collapse.
- **PERF-1** coalesce `pty:data` (hottest path) + **PERF-11** single-window broadcast. **PERF-3** migrate `useAppState()`→granular selectors (25 components). **PERF-2** gate link-detection. **PERF-4** incremental `sessionsByWorkspace`. **PERF-5** refcounted per-workspace Ruflo-health poll. **PERF-6** batch per-pane git-status. **PERF-8** async disk-scan off the main thread. **PERF-7/9/10/12** (Constellation settle, exit-listener bus, delta re-sort, JSONL bounded read).
**Exit criteria:** panel sizes persist per workspace across restart; `npm run test:perf` shows reduced jank windows under CPU throttle; no per-pane duplicate Ruflo/git polling; `pty:data` IPC message-rate drops materially under streaming output.

### ▶ P6 — Competitive features & leapfrogs · ships as `v1.42.0`+ (spans several releases)
**Goal:** close v3.0.74 parity and ship the worktree-only differentiators a shared-dir competitor can't match.
**Deliverables:** per-feature increments — resume modal, per-pane usage/cost, per-agent identity, agent rewind, merge-orchestration UI, MCP diagnostics, swarm phase tree, etc. Each non-trivial feature (FEAT-4/6/11/13) gets its own spec before build.
**Work (priority — leapfrogs first):**
- **FEAT-1** Resume-agents relaunch modal. **FEAT-3** per-pane usage/cost panel (session/week budget bars). **FEAT-7** per-agent visual identity (color + ID). **FEAT-11** agent undo/rewind via worktree checkpoints (**leapfrog**). **FEAT-13** cross-pane merge-orchestration UI (surface `scoreConflicts`, **leapfrog**). **FEAT-8** per-worktree git-activity heatmap (**leapfrog**).
- **FEAT-2** focused-pane Context/MCP/LSP sidebar. **FEAT-5** MCP Config Diagnostics. **FEAT-6** SigmaSwarm phase tree. **FEAT-9** swarm-chat search/filter/pin. **FEAT-4** interactive in-terminal prompt cards. **FEAT-10** launch + distribution presets. **FEAT-12** discoverable drag-affordance. **FEAT-14** compact per-pane effort control (avoid the all-panes-glow). **ONB-1** first-run tour + settings search.
**Exit criteria:** each feature ships behind its own acceptance test; specifically — rewind reliably restores a worktree to a prior checkpoint, and the merge-order action merges N panes conflict-aware without touching the base branch on conflict.

### ▶ × Cross-cutting (apply within every phase)
- **SEC-1** phase security re-gate — daily-note digest + Ruflo-pattern rendering + sound assets reopen H-19-class surfaces; run snitch/semgrep + Opus review on each phase that adds ingestion/render.
- **Decompositions (opportunistic, when already touching the file):** ARCH-2 (rpc-router 2101 → controllers + side-band maps), ARCH-3 (router-shape split), ARCH-4 (VoiceTab), ARCH-5 (assistant controller/tools), ARCH-9 (RPC output validation wave). **ARCH-6** delete dead `core/voice/whisper-engine.ts`; **ARCH-7** consolidate voice-stats/model-registry; **ARCH-8** `swarm`/`swarms` namespace clarity.
- **RES-1** provision whisper GGML / auto-subs before the next competitor-video review.

---

## 🚧 Blocked / operator-owned (parked — not actionable unblocked)

| # | Item | Status |
|---|------|--------|
| **SV1** | SigmaVoice W-SV1 — Windows NSIS build (`voice-whisper` MSVC `LNK1120`) | 🚧 binding.gyp surgery + Windows-runner CI (engine repo) |
| **SV2** | SigmaVoice W-SV2 — quit-time TSFN SIGABRT | quit-only; `tsfn_bridge` release-semantics fix (also affects in-app voice) |
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | 🚧 BLOCKED — needs an operator Windows dogfood (revert path `pty.spawnMode='direct'`) |
| **B2** | FE-4 voice items (PCM rate, whisper v1.7.x port, prebuildify, win `IsAvailable()` race) | 🚧 BLOCKED — behind unshipped native voice builds |
| **op** | SF-12 migration `0026` register + ship | dormant — needs diagnostic-SQL sign-off on a real `agent_sessions` dump |
| **op** | SigmaVoice live mic/permission smoke · FE-4 device a11y QA (VoiceOver/Switch-Control) | needs the device |

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; delete it from this whiteboard and from `WISHLIST.md`. Keep `WISHLIST.md` for new raw findings/ideas.
