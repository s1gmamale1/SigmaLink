# SigmaLink — Execution Roadmap (next-phase whiteboard)

> **Ephemeral working doc.** The priority-ordered execution sequence for the CURRENT cycle,
> derived from `WISHLIST.md`. A whiteboard — refreshed each cycle, **not permanent
> documentation**. Permanent record → `CHANGELOG.md` + master memory + Ruflo AgentDB.
>
> **This cycle (set 2026-06-04)** is driven by the **BridgeSpace competitor teardown** (6-agent
> `video-lens-review` of BridgeMind Day 187 + Day 188 streams — see `WISHLIST.md` "BridgeSpace
> competitor teardown — 2026-06-04"). **Operator headline: ship a flat "Clean/Clear" theme + more Glass variations FIRST** — ✅ **Phase 1
> shipped** (PR #104). **▶ NEXT = Phase 2: operator-smoke bugfix batch (SMK-1/2/3/3b) — confirmed bugs,
> fixed before features.** Then the feature phases: theme gallery (3) · FE polish (4) · premium Jorvis FE (5) ·
> worktree/git UI (6) · git diff panel (7) · orchestration (8) · browser/voice depth (9).
> *(Paused 2026-06-04 by operator — resume at Phase 2.)*

This ROADMAP is the single source of truth for what to build next.

---

## How to read this
- **Phases are ordered by value/effort**, with cross-phase prerequisites called out.
- **Effort:** S (≤½ day), M (1–2 days), L (3–5 days), XL (>1 week).
- Item codes (`BSP-*`, `FEAT-*`) trace back to `WISHLIST.md`. Confirmed bugs are fixed before new feature phases.
- **Already-shipped competitor parity is NOT re-built** — see "Skip / market better" at the tail.

---

## 🔓 Release carry-over (operator-owned — blocks nothing below)
**v2.0.0 is shipped to `main` (untagged).** The tag is a separate operator-authorized step via `/sigmalink-release`. Owed operator VISUAL smokes before/at the tag: N1 wizard across themes (esp. Glass/Parchment) · N2 browser drag + bounds-sync + no-reload-on-reopen · Jorvis live reply (run `claude` once for trust). These are operator-owned; new cycle work below proceeds in parallel.

## 🐞 Confirmed bugs to fix first (hotlist)

| # | Sev | Bug | Where | Effort |
|---|-----|-----|-------|--------|
| SMK-1 | high | Wizard auto-resumes a stale CROSS-PROJECT session onto fresh worktrees. ✅ root-caused: opencode never cwd-scoped (`session-disk-scanner.ts:848` drops `opts`; `:696` keeps no-`directory` rows) + `scoped=!!workspaceId` always-true → auto-resume newest (`SessionStep.tsx:251,259,269`) | `core/pty/session-disk-scanner.ts:642/696/848`, `SessionStep.tsx:259` | M |
| SMK-2 | high | Sessions-step buttons revert instantly. ✅ root-caused: smart-default `useEffect` re-fires every render b/c `rows=buildPaneRows(...)` is inline (new array) → clobbers the pick | `Launcher.tsx:564` (memoize) + `SessionStep.tsx:248-276` (init-once ref) | S |
| SMK-3 | high | Skills tab Superpowers-only. ✅ root-caused: `discoverInstalledSkills` hard-codes 2 cache paths + the ruflo branch is dir-depth-broken; must scan all providers (~580+ on disk) + carry provider/prefix | `core/skills/controller.ts:276-357` (+ new `discovery.ts`), `SkillsTab.tsx`, `shared/providers.ts` | M |
| SMK-3b | medium | Codex skill injection writes `/foo` not `$foo` (hardcoded `/` for all providers) | `renderer/command-room/insertSkillCommand.ts:38` | S |
| BSP-B4 | medium | Embedded-browser input/focus reliability — audit `WebContentsView` focus forwarding to form fields (BridgeSpace still fights this in v3.1 → differentiation chance) | `core/browser/{manager,controller}.ts`, `renderer/browser/BrowserViewMount.tsx` | M |

*(SMK-1/2/3 + SMK-3b root-caused by 2 opus debug agents 2026-06-04 — full evidence/fix-plans in `WISHLIST.md`. Test-blindness: `Launcher.test` stubs `SessionStep`; fixes must add an un-stubbed integration test. The v2.0.0 owed smokes are operator QA, not code bugs.)*

---

## Phase 1 — "Clean/Clear" theme + Glass variations  ·  ✅ **SHIPPED** (PR #104 · `f78c6e0`, 2026-06-04)

**Shipped:** 15 themes (was 5) — Clean family (`clean`/`clean-light`/`clean-violet`/`clean-blue`/`clean-rose`/`clean-emerald`, flat-opaque, zero-blur, single accent ring) + Glass Spectrum (`glass-teal`/`glass-violet`/`glass-slate`/`glass-frost`). `glass-material.css` parameterized to hue tokens + selectors broadened to `[data-theme^='glass']` (ADR-001); base `glass` byte-identical; drift-guard test. Opus-reviewed (H1 EditorTab Monaco, M1 clean-light contrast, M2 byte-identical, M3 drift-guard all folded). CI 4/4 green incl. both smoke e2e. **Operator visual smoke ✅ — confirmed working/liked.** Gallery card-picker = Phase 3. → promote to CHANGELOG/memory on wrap-up.

**Goal.** SigmaLink offers a flat, opaque "Clean/Clear" theme alongside Glass, plus a family of Glass variations, all selectable like the existing themes.

**Deliverables.**
- **BSP-T1** new `clean` theme (dark) + a `clean-light` variant — `ThemeDefinition` entries + `[data-theme="clean"]` / `[data-theme="clean-light"]` CSS-var blocks.
- **BSP-T2** Glass-variation tier: a `--surface-tint` + `--glass-image-opacity` layer over the glass base + 3–4 presets (`glass-teal` / `glass-violet` / `glass-slate` / `glass-frost`).

**Why now.** The user's explicit #1 ask. Cohesive, self-contained (theme layer only), and unblocks the gallery (Phase 3) having real content to show.

**Scope.**
- `src/renderer/lib/themes.ts:6` — extend `ThemeId` union (`'clean' | 'clean-light' | 'glass-teal' | …`); add `THEMES[]` entries with swatches. Keep `DEFAULT_THEME='glass'`.
- `src/index.css` — add the Clean palette as flat-opaque tokens (bg `#0c0d0f` / pane `#15171a` / raised `#1c1f23` / divider `#23262b` / text `#e6e8ea` / muted `#8a9099` / **accent/focus amber `#e8833a`**; light variant mirrors it); add a `--surface-tint`/`--glass-image-opacity` layer the glass blocks read so a tint preset = a few overrides, NOT a copied block (see ADR-001).
- Verify token consumers still resolve: `app/App.tsx`, `sidebar/Sidebar.tsx`, `command-room/PaneHeader.tsx`, the `.sl-glass` utility — Clean must set `--blur: 0` and flat surfaces (no translucency).

**Findings + recommendation.** themes.ts is a thin metadata layer (id/label/swatch/appearance); real tokens live per-`data-theme` in `src/index.css`. BridgeSpace ships 23 themes cheaply by varying *backdrop + accent* over one base (D187 00:33:08) — so model variations as a **tint/opacity layer**, not N hand-authored themes. Clean is the *opposite* of Glass depth (flat, zero-shadow, hairline dividers, single amber focus-ring) → it's a distinct family, not a glass tint.

**Risks.** Token drift — a variant that overrides too little looks identical, too much diverges. Mitigation: a small Vitest snapshot asserting each new `data-theme` sets `--background`/`--accent`/`--blur`. Glass `backdrop-filter` perf on tinted variants — reuse the existing glass blur budget.

**Definition of done.** Each new theme is selectable; Clean renders fully flat (no blur/shadow) with the amber focus-ring; a Glass tint preset changes hue via one `--surface-tint` swap; `tsc -b` + vitest green.

---

## Phase 2 — Operator-smoke bugfix batch (SMK-1/2/3/3b)  ·  ▶ **NEXT UP** (paused 2026-06-04)

**Goal.** New-workspace creation never silently resumes a stale cross-project session, the Sessions-step controls work, and the Skills tab shows every provider's installed skills with the right invocation prefix.

**Deliverables.**
- **SMK-1** opencode session listing cwd-scoped + the wizard defaults to **New session** for a fresh workspace.
- **SMK-2** Sessions-step controls (Resume newest / All new / Reset / per-pane Change…) actually stick.
- **SMK-3** per-provider skill discovery (`core/skills/discovery.ts`) feeding a provider-grouped Skills tab with the correct prefix.
- **SMK-3b** Codex skill injection uses `$` not `/`.
- An **un-stubbed Launcher↔SessionStep integration test** + an opencode-scoping unit test (closes the test-blindness).

**Why now.** Confirmed, root-caused bugs in the two most-used entry surfaces (workspace creation + the skills rail) — bugs before features, and before the Phase-3 gallery touches the same Appearance/launcher area. Full evidence + fix plans in `WISHLIST.md` "Phase-1 theme smoke — 2026-06-04".

**Scope.**
- *Sessions packet (SMK-1+2):* `core/pty/session-disk-scanner.ts:642/696/848` — pass `opts` to `listOpencodeSessions` + `workspaceAllowedIds`-filter + skip no-`directory` rows under an enforced cwd; `SessionStep.tsx:259` — default the smart-selection to `null` for a fresh workspace; `Launcher.tsx:564` — `useMemo` the `buildPaneRows(...)` so the smart-default `useEffect` (`SessionStep.tsx:248-276`) stops re-firing + an init-once `useRef` guard so an explicit pick is never clobbered. Sibling: `findOpencodeSession:288` fail-open.
- *Skills packet (SMK-3+3b):* new `core/skills/discovery.ts` (per-provider scanners — claude user/project/commands + manifest-resolved plugin skills excluding `temp_git_*`/`*.clone` + version-dir; codex `~/.codex/{skills,prompts}`; cursor; opencode; gemini) replacing the 2 hardcoded paths at `controller.ts:276-357`; widen `InstalledSkillEntry` (`controller.ts:24-28` + the duplicate in `SkillsTab.tsx:40-44` + the test mocks — all 3) to carry `provider/prefix/source/kind/sourcePath`; a central `INVOCATION_PREFIX` keyed on `shared/providers.ts`; group/filter `SkillsTab.tsx` by provider + show the prefix; fix `insertSkillCommand.ts:38` to inject `entry.prefix + name` keyed on the pane's providerId.

**Findings + recommendation.** Two opus debug agents (2026-06-04, `/systematic-debugging`) statically confirmed each root cause + adversarially disproved the obvious theories (it is NOT a missing `workspaceId`; the buttons DO fire but get clobbered by a re-firing effect; the skills tab is hardcoded-2-paths + a latent ruflo dir-depth bug). Lead spot-checked the load-bearing lines. Ship as **two file-disjoint lanes** (sessions vs skills) → integrate → gate → Opus review.

**Risks.** SMK-3's plugin-manifest walk + version-dir resolution is the only non-trivial part (cache pollution + multi-version) — read the installed-plugin manifest, never blind-glob. The 3 mirrored `InstalledSkillEntry` sites are the classic SigmaLink miss — change together. Do NOT widen the *fanout* target set (separate, larger change).

**Definition of done.** Creating a fresh workspace shows "New session" for every pane by default (no cross-project resume) and the Sessions-step buttons change + persist the selection; the Skills tab lists skills from ≥2 providers grouped with their prefix, and dropping a skill on a Codex pane types `$name`; the new integration + opencode-scoping tests fail before / pass after; `tsc -b` · vitest · lint · build green.

---

## Phase 3 — Appearance theme-gallery picker + per-workspace tint

**Goal.** Themes are chosen from a live card-gallery (like BridgeSpace's), and each workspace can carry its own tint.

**Deliverables.**
- **BSP-T3** `AppearanceTab` rebuilt as a card grid: each card = a live scaled-down pane preview (that theme's CSS vars) + label + muted taxonomy sub-label + accent bar; `All / Dark / Light` count-segmented filter; search; `✓ ACTIVE + accent-border` selected state; hero header with a one-line value-prop.
- **BSP-T4** per-workspace accent/tint (workspace KV → `--surface-tint`/`--accent`).

**Why now.** Makes Phase 1's new themes discoverable and sells breadth; reuses the selectable-preview-card pattern we'll want elsewhere.

**Scope.**
- `src/renderer/features/settings/AppearanceTab.tsx` (295 lines) — replace the current list with a responsive card grid; render each preview by scoping a mini-DOM under `data-theme={id}`; derive `All/Dark/Light` counts from `THEMES[].appearance`; wire search over label/description; mirror the pattern for the density control.
- Per-workspace tint: store `ui.<ws>.theme.tint` in workspace KV; apply on workspace open alongside the global theme (respect the GLOBAL boot reader — cf. the per-workspace-key migration lesson).

**Findings + recommendation.** AppearanceTab is already controlled-tab + search-aware (ONB-1). Live preview cards (not static swatches) are the high-value detail (D187 00:32:58); the `image @ N%` opacity tag (D187 00:33:08) is exactly our `--glass-image-opacity` token surfaced as UI.

**Risks.** N live previews = N themed sub-trees → render cost. Mitigation: render previews as lightweight static mock markup (titlebar + 3 lines + accent bar), not real panes; lazy-mount offscreen cards.

**Definition of done.** Gallery shows every theme as a live-ish preview card; filter + search narrow it; selecting sets the theme + `✓ ACTIVE`; a per-workspace tint persists across restart and doesn't leak across workspaces.

---

## Phase 4 — FE polish sweep (quick wins)

**Goal.** Land the cheap, high-visibility BridgeSpace UI steals in one coherent pass.

**Deliverables.** **BSP-F1** single-accent active-pane focus ring + header-as-pill · **BSP-F2** dim per-pane footer status line · **BSP-F3** benefit-led empty states + recents (browser + fresh-agent) · **BSP-F4** side-docked onboarding/promo · **BSP-F5** memory KPI big-number tiles · **BSP-F6** semantic action colors (git=green/review=amber) · **BSP-F7** detached-pane placeholder + re-dock · **BSP-F8** orchestrator orb idle "Standby/Tap to activate" · **BSP-F9** permission-chip onboarding card · **BSP-B1** browser URL bar · **BSP-V3** `/skills` + `@context` in the launch composer · **BSP-P2** branch pill on pane title · **BSP-P3** human-name alias + effort tier on header chip.

**Why now.** All S-effort, individually shippable, collectively a big perceived-quality jump; no architectural risk; good momentum after the theme work.

**Scope.**
- Panes: `command-room/{PaneHeader,PaneShell,PaneFooter}.tsx` — focus ring (F1), footer line (F2), branch pill (P2), alias/effort chip (P3 — extends FEAT-7/FEAT-14, surfacing only).
- Browser: `renderer/browser/BrowserRoom.tsx` — URL bar (B1), empty state + recents (F3).
- Launcher: `workspace-launcher/Launcher.tsx` — `/skills`+`@context` discovery (V3).
- Memory: `features/memory/*` — KPI tile row (F5). Orb: command-room/orchestrator orb idle (F8). Onboarding card (F9): `features/onboarding/*`.

**Findings + recommendation.** These map cleanly onto existing components; P2/P3 ride already-shipped identity/effort data. Batch as one PR with per-item commits.

**Risks.** Scope creep into Phase 1's theme tokens. Mitigation: this phase consumes tokens, never defines them; hard stop at behavior/markup.

**Definition of done.** Each item visible + reduced-motion-safe; `tsc -b` + vitest + lint green; no regression in pane grid e2e.

---

## Phase 5 — Premium Jorvis FE (N3, carry-over — now B3-unblocked)

**Goal.** The Jorvis assistant feels premium: streamed reveal, animated bubbles, inline tool chips.

**Deliverables.** rAF catch-up token reveal + in-flight `ChatMessageView`; spring bubble-enter (first-mount only); gated typewriter + caret (bypassed under reduce-motion); per-turn tool-chip rail; the backend token-stream change so text arrives incrementally (not whole blocks).

**Why now.** B3 (composer silent-latch) is fixed in v2.0.0, unblocking N3; FE quality is this cycle's through-line and the user re-flagged "improve the frontend of Jorvis".

**Scope.** Backend: `core/assistant/cli-envelope.ts` / `emit.ts` — emit incremental deltas (today whole blocks). Renderer: new `jorvis-assistant/use-jorvis-stream-reveal.ts` + `InlineToolChips.tsx`; `ChatTranscript.tsx` for spring enter. Apply `/apple-design` family.

**Findings + recommendation.** Today streaming is fake (whole-block emit) — the backend delta change is the prerequisite; do it first, then the reveal hook. First-mount-only spring (don't re-animate on every render — cf. the managed-focus React-19 lesson).

**Risks.** Re-render storms from per-token state. Mitigation: rAF-batch the reveal; gate under reduced-motion; cap typewriter rate.

**Definition of done.** A live Jorvis reply streams token-by-token with a caret, bubbles spring in once, tool calls render as chips; reduce-motion shows instant text; a B3-style hung turn still clears via the watchdog.

---

## Phase 6 — Worktree GUI (our moat, made one-click)

**Goal.** Creating/working in worktrees is GUI-driven, not CLI-only.

**Deliverables.** **BSP-G1** "Create Git Worktree" modal (source repo auto, branch name, path + browse, preview command, confirm) · **BSP-G3** "open in current pane" option (switch cwd vs spawn) · **BSP-P1** pane right-click context menu (Generate handoff / Create worktree / Open Git panel / Copy path / Copy output / Open dir).

**Why now.** We already own the worktree *engine*; the missing piece is UI. Highest-leverage gap on our differentiator (D187 00:04:45–00:05:26). The context menu (P1) is the natural host for these actions.

**Scope.** `core/git/worktree.ts` (engine — reuse) + a new modal in `renderer/command-room/*`; `workspaces.launch`/`+Pane` flow for the in-current-pane option; `command-room/PaneHeader.tsx`/PaneShell for the context menu. New RPC for modal-driven create if not already exposed.

**Findings + recommendation.** Worktree creation is CLI-only today; a thin modal over the existing engine + a context menu is mostly renderer + one RPC. "Open in current pane" needs a cwd-swap path distinct from spawn.

**Risks.** cwd-swap mid-session corrupting pane state. Mitigation: only offer it for idle panes; otherwise spawn. Validate branch/path at the boundary.

**Definition of done.** Right-click a pane → Create worktree → modal → new worktree+branch created (or current pane re-homed); context-menu actions all work; no base-branch mutation.

---

## Phase 7 — In-app Git diff / Review panel

**Goal.** Browse diffs and review changes inside SigmaLink without dropping to a CLI.

**Deliverables.** **BSP-G2** a first-class Git panel (Changes/History tabs, staged/unstaged, file list, inline diff, branch selector, pop-out window) · **BSP-G4** local-vs-remote ahead/behind · **BSP-G5** post-swarm auto-teardown policy (keep-all / keep-passing / destroy-failing).

**Why now.** We're worktree-native yet have no in-app diff viewer — the single biggest feature gap the teardown surfaced (D187 00:05:33–00:11:40). Spec-before-build (this is the cycle's one L feature).

**Scope.** Backend already has `core/git/git-ops.ts` (`gitStatus`/`gitDiff`/`mergePreview`) + `core/review/*` — surface them in a new `renderer/features/review/*` panel; ahead/behind via `git rev-list --count`; teardown policy hooks into the C-7 orchestrator post-gate. Reuse RSP-1 Resizable for the panel; pop-out reuses the (Phase 9) detach plumbing or a simple BrowserWindow.

**Findings + recommendation.** The data layer exists; this is mostly a renderer surface + 2 small RPCs. Write a short spec first (panel layout, diff virtualization for big files).

**Risks.** Large-diff render cost. Mitigation: virtualized file list + lazy per-file diff; cap inline hunks with "show more".

**Definition of done.** Open the panel for a worktree → see staged/unstaged + inline diff + ahead/behind; auto-teardown destroys only failing worktrees on a gate run; pop-out works.

---

## Phase 8 — Orchestration & memory surfacing

**Goal.** The Sigma orchestrator and Ruflo memory are first-class, persistent surfaces — not buried in a pane.

**Deliverables.** **BSP-O1** persistent chrome-level "Sigma" rail panel with a Canvas (numbered structured to-dos + live token delta `+509/-44`) + Review tab (extends C-7 from in-pane → right-rail) · **BSP-O2** live routing/orchestrator trace · **BSP-O3** "Automations" (scheduling/macros) nav · **BSP-O4** "Artifacts" memory type + per-conversation named-session history · **BSP-O5** make the Ruflo memory graph more prominent (BridgeBoard is announced-not-shipped — we lead).

**Why now.** BridgeSpace's "Bridge" panel + announced BridgeBoard target exactly our shipped strengths (Sigma-Agent C-7, MEM-1 graph). Surfacing them defends the lead before they ship.

**Scope.** `operator-console/OrchestratorPanel.tsx` → extract into `right-rail/*` as a persistent tab; Canvas from `shared/orchestrator-tasks.ts`/`plan-capsule.ts`; routing trace from Ruflo `hooks_route`/agentdb; Artifacts + named sessions in `core/memory/*` + `features/memory/*`; graph prominence in `features/memory/MemoryGraph.tsx`.

**Findings + recommendation.** C-7 + the merge-order/plan-capsule machinery already exist in-pane; O1 is a relocation + persistence packet, not a rebuild. O3/O4 are net-new but medium.

**Risks.** Right-rail real-estate contention with existing Swarm/Skills tabs. Mitigation: tabbed rail; collapse when narrow (RSP-1).

**Definition of done.** Sigma panel persists across pane layouts showing live to-dos + token delta; a routing decision is visible; the graph is reachable in ≤1 click from any room.

---

## Phase 9 — Voice / model & browser depth

**Goal.** Cloud STT choice, live cost/speed visibility, and a more capable embedded browser.

**Deliverables.** **BSP-V1** multi-provider STT picker (local / Fireworks / Groq) · **BSP-V2** live per-pane tok/s + cost in the header + a fast/balanced/deep dispatch preset (Haiku/Sonnet/Opus) · **BSP-B2** browser detach-to-monitor / reattach · **BSP-B3** agent-drivable headless-browser skill (`browser.navigate`/`browser.evaluate`) for self-testing · (BSP-B4 from the hotlist lands here if not already fixed).

**Why now.** Rounds out parity on voice/model transparency and opens the "agent-native testing" story (B3 — a gap for both products).

**Scope.** `resolveTranscriptionEngine` + voice settings (V1); pane header tok/s+cost off the SigmaBench foundation + `+Pane` preset (V2, extends FEAT-3/14); `core/browser/*` detach + a skill exposing browser RPCs to panes (B2/B3).

**Findings + recommendation.** V2 builds on the existing usage ledger + SigmaBench; B3 reuses the embedded browser + skills system. B2 detach overlaps Phase 7 pop-out plumbing — share it.

**Risks.** B3 gives agents a controllable browser → SSRF/abuse surface. Mitigation: route through the H-19 aidefence gate + same-origin/https allowlist; gate behind a setting.

**Definition of done.** STT provider switch works; a running pane shows live tok/s + $; an agent can navigate+evaluate the embedded browser under the security gate; browser detaches to a 2nd monitor and re-docks.

---

## 🧊 Deferred this cycle (XL / big-bang — held per the DDD small-per-packet rule)
- **BSP-P4 — Canvas mode** (freeform draggable/resizable panes + bottom voice bar; their BridgeCanvas direction). XL — pane layout-engine rewrite. Revisit as its own cycle; leapfrog if shipped before BridgeCanvas.
- **BSP-P6 — multi-window / dual-window** (detach a workspace/panel into its own OS window, multi-monitor). L–XL — multi-`BrowserWindow` architecture. (Phase 9 B2 delivers the browser-only slice.)
- **BSP-P5 — workspaces-as-tabs** top strip. S, but a layout-shell change — fold into a future shell pass.

## ✅ Skip / market better (already shipped — do NOT rebuild)
Session-resume modal ≈ **FEAT-1** · per-pane usage/cost ≈ **FEAT-3** · per-agent identity ≈ **FEAT-7** · effort control ≈ **FEAT-14** · browser-in-separate-window ≈ **C-8** · 30-sub-agent plan→review→build ≈ **C-7** (add a prominent named one-click mode = discoverability, not a rebuild) · MCP autowrite per-CLI = **SF-7** (answers their community's #1 swarm pain — *market it*). **WE LEAD & they lack:** worktree isolation, 6 providers, SigmaBench, Obsidian memory graph, voice **dispatch** (BridgeVoice = dictation-only), Telegram remote, agent rewind, sub-agent depth control. Positioning to adopt: **"ADE — Agent Development Environment"** + **"Context layer"**.

## 🚧 Blocked / operator-owned (parked — not actionable unblocked)

| # | Item | Status |
|---|------|--------|
| **rel** | v2.0.0 tag (`/sigmalink-release`) + 3 operator visual smokes | operator-owned — see Release carry-over above |
| **B1** | W-4 P8–P9 + win32 shell-first dogfood | 🚧 needs an operator Windows device (revert path `pty.spawnMode='direct'`). *SSH/RDP to a Windows box would unblock the headless half — build/ConPTY/native-link — but not the visual/audio smokes.* |
| **B2** | FE-4 voice items (PCM rate, whisper v1.7.x port, prebuildify, win `IsAvailable()` race) | 🚧 behind unshipped native voice builds |
| **op** | SF-12 migration `0026` register + ship | dormant — needs diagnostic-SQL sign-off on a real `agent_sessions` dump |
| **op** | FE-4 device a11y QA (VoiceOver/Switch-Control) | needs the device |

---

## Architecture decisions (ADRs)

### ADR-001 — Theme variations are a tint/opacity layer, not N hand-authored themes
**Decision.** Model Glass variations (and future families) as a small set of override tokens (`--surface-tint`, `--accent`, `--glass-image-opacity`) layered over a base `data-theme`, rather than copying a full CSS block per variant. **Context.** BridgeSpace ships 23 themes by varying backdrop+accent over one base (D187 00:33:08); `src/index.css` currently declares full token blocks per `data-theme`. **Consequences.** (+) one variable → N looks; cheap per-workspace tint; less drift. (−) the base theme's structure constrains variants; a radically different look (e.g. Clean) must still be its own family/block, not a tint.

### ADR-002 — "Clean/Clear" is its own flat-opaque family, separate from Glass
**Decision.** Clean is a distinct theme family (flat, opaque, zero-shadow, hairline dividers, single amber focus-ring), NOT a Glass tint. **Context.** It is the visual opposite of Glass's translucent-depth model. **Consequences.** (+) honest token semantics (`--blur:0`, opaque surfaces); a clean baseline for future flat themes. (−) two families to maintain; components must not assume translucency (audit `.sl-glass` consumers).

### ADR-003 — Defer Canvas mode + multi-window (XL) per the small-per-packet rule
**Decision.** Park BSP-P4 (Canvas) and BSP-P6 (multi-window) out of this cycle; ship the browser-detach slice (B2) only. **Context.** Both are layout-engine / multi-`BrowserWindow` rewrites; the DDD rule favors small per-packet wins at release cadence. **Consequences.** (+) cycle stays shippable in small increments. (−) BridgeCanvas could ship first — accept the risk; re-evaluate next cycle.

---

## Effort / impact table

| Item | Phase | Effort | Impact | Notes |
|------|-------|--------|--------|-------|
| BSP-T1 Clean theme | 1 | M | High | ✅ shipped (PR #104) |
| BSP-T2 Glass variations | 1 | M | High | ✅ shipped (ADR-001) |
| **Operator-smoke bugfix batch (SMK-1/2/3/3b)** | **2** | **M–L** | **High** | **Confirmed bugs — ▶ NEXT (resume here)** |
| BSP-T3 theme gallery | 3 | M | High | Live preview cards |
| BSP-T4 per-workspace tint | 3 | S | Med | Workspace KV |
| FE polish sweep (F1–F9,B1,V3,P2,P3) | 4 | M | High | Batch of S quick-wins |
| Premium Jorvis FE (N3) | 5 | L | High | Needs backend token-stream |
| Worktree GUI (G1,G3,P1) | 6 | M | High | Engine exists; UI gap |
| Git diff/Review panel (G2,G4,G5) | 7 | L | High | Biggest feature gap; spec first |
| Orchestration+memory (O1–O5) | 8 | L | Med-High | Relocate C-7 + surface graph |
| Voice/model+browser (V1,V2,B2,B3) | 9 | M-L | Med | B3 needs security gate |
| BSP-B4 browser focus | 9/hotlist | M | Med | Reliability audit |
| Canvas mode (P4) | deferred | XL | High | Layout rewrite |
| Multi-window (P6) | deferred | L-XL | Med | Multi-BrowserWindow |

## When an item ships
→ move its one-line note to `CHANGELOG.md` + the master-memory project entry + (reusable lessons) Ruflo AgentDB; mark it promoted/struck in `WISHLIST.md`; delete it from this whiteboard. Keep `WISHLIST.md` for new raw findings.
