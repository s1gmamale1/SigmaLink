# BridgeMind-Competitive Roadmap — Design

**Date:** 2026-05-22
**Status:** ✅ **ROADMAP COMPLETE — M0–M5 SHIPPED, C-1…C-13 live.** M1 v1.16.0 · M2 v1.17.0 · M3 v1.18.0 · M4 v1.19.0 · **M5 v1.20.0** (C-12 SigmaBench · C-13 element→pane · C-10c CLI voice). W-4 P8 shipped in M3; **P9 cancelled** (proven multi-pane conversation-resume regression). Final status 2026-05-25.
**Source:** `docs/02-research/bridgemind-review-2026-05-22/MASTER-BREAKDOWN.md` (BridgeVoice + BridgeSpace 3 + Day-181 stream) → C-class wishlist (`docs/03-plan/WISHLIST.md`).
**Scope:** Forward roadmap — 13 C-class competitive items + deferred debt, sequenced into 6 milestones (M0–M5), each ≈ one release on the existing v1.x cadence.

## Context & current state
Everything through **v1.15.0** is shipped; `BACKLOG.md`/`OPEN.md` show **no open bugs**. This is a forward roadmap, not firefighting. "Fixes" = the small deferred debt (M0).

## The thesis (what the roadmap optimizes for)
SigmaLink's **moat is per-pane git worktrees**; BridgeSpace's biggest structural weakness is that **all its agents share one directory** (confirmed in every pane header). The roadmap threads a **worktree-swarm differentiator** across M1→M3 — "swarm with no merge conflicts" — that BridgeSpace cannot match without a rebuild. Quick parity wins ride alongside each wave so every release shows visible progress.

Secondary edges leaned on: out-of-process Whisper (they burned 6 debug rounds on Onyx WASM voice), Ruflo MCP vector memory + typed SendMessage bus, W-8/W-5/hooks/shell-first/multi-CLI.

## Milestone overview
| Milestone | Theme | Items | Target |
|---|---|---|---|
| **M0** | Stabilize & derisk | upstream PR · win32 dogfood · AgentDB store automation | ~v1.15.1 |
| **M1** | Glanceable swarm | C-1 · C-2 · C-3 · C-4 | ~v1.16.0 |
| **M2** | Worktree-aware context | C-6 · C-5 · C-10a | ~v1.17.0 |
| **M3** | Sigma Agent (capstone) | C-7 · C-10b · **W-4 P8-9** | ~v1.18.0 |
| **M4** | New surfaces | C-8 · C-9 · C-11 | ~v1.19.0 |
| **M5** | Breadth & polish | C-13 · C-12 · C-10c | ~v1.20.0 |

Each milestone gets its **own** `writing-plans` plan when reached (YAGNI — not all six up front). **M0–M5 all shipped (v1.16.0–v1.20.0); roadmap complete.**

---

## M0 — Stabilize & derisk (~v1.15.1, mostly operator-led, parallel)
Clears deferred debt before the competitive build.
- **Fire the claude-flow upstream PR** — `docs/10-memory/upstream/claude-flow-default-namespace-issue.md` is drafted; operator submits on the third-party repo. *(operator action, no SigmaLink code)*
- **win32 shell-first dogfood** — v1.14.0 flipped `pty.spawnMode` default to `shell-first` on all platforms un-dogfooded on Windows. Operator runs a Windows build; confirm keep-on or revert to `'direct'` (one KV flip). *(operator-led; code change only if revert)*
- **AgentDB post-task store automation** — make v1.15.0's measurement real: a `post-task`/`session-end` hook auto-stores the task verdict to namespace `patterns` (key `verdict:<id>`), so the store actually accrues retrievable entries. *(small; `.claude` hook, re-gen-safe per the v1.15.0 pattern)*
- **Absorbs (prior backlog):** V3-W15-006 — the human-QA ≥30-min 4-pane-swarm (Claude+Codex+Gemini+OpenCode) dogfood folds in here alongside the win32 dogfood (both operator-led QA).
- **Success:** upstream issue filed; Windows shell-first decision recorded; the 4-pane-swarm dogfood run; a fresh `memory_search_unified` after a task returns that task's verdict.

## M1 — Glanceable swarm (~v1.16.0)
Quick wins + the first moat foundation (chat log). All renderer-side; low risk.
- **C-1 Per-pane info bar** *(S)* — pane header chrome shows `model · branch · uncommitted-count · token-count`. Branch + uncommitted come from the pane's worktree (`git`), surfacing our edge. Token count from PTY/provider where available (estimate otherwise). Module: `PaneShell`/pane header.
- **C-2 Coding-agent index** *(S)* — a panel listing every pane: provider, role, current task/status, live. Foundation for C-7. Module: SigmaSwarm roster view.
- **C-3 Pane drag-resize + density** *(S/M)* — their #1 UX gap (unreadable at 8+, no resize). `react-resizable-panels` is already a dependency. Add drag-resize + a density/zoom affordance. Module: Command Room grid.
- **C-4 Visible SigmaSwarm chat log** *(M)* — surface the existing swarm mailbox / Ruflo SendMessage bus in a readable, operator-injectable panel. Foundation for C-7. Module: SigmaSwarm UI + mailbox.
- **Success:** at a glance, every agent + its branch + their cross-talk is visible; panes are resizable.

## M2 — Worktree-aware context (~v1.17.0)
Moat foundations + a voice quick-win.
- **C-6 Worktree-aware drag-drop context** *(M)* — extend the v1.4.8 file→pane drag pattern: dragging a pane (or its header) into the swarm/agent input attaches its compacted scrollback **+ `git diff --stat` + branch name**. Leapfrog over BridgeSpace's text-only chip. Module: Command Room DnD + context pipeline.
- **C-5 Plan-handoff capsule** *(M)* — a structured prompt format (goal / target files / success criteria / out-of-scope) injected via W-5; **out-of-scope becomes a filesystem boundary** (the pane's worktree scope), enforced via hooks — not prose. Module: W-5 injection + hooks.
- **C-10a SigmaVoice dictionary + macros + dashboard** *(S)* — phrase→@mention/CLI-fix dictionary, verbal command macros ("new line"→`\n`), usage stats (words/WPM/history from existing whisper segment metadata). Module: SigmaVoice.
- **Success:** context dispatched to an agent carries its branch + diff; a handoff's out-of-scope files are write-blocked outside the worktree.

## M3 — Sigma Agent (~v1.18.0, capstone — bigger wave)
- **C-7 Sigma Agent meta-pane** *(L)* — a human-facing orchestrator pane that **composes M1+M2 pieces**: reads the agent index (C-2) + swarm chat (C-4), accepts a goal, spawns **worktree-isolated** panes, auto-prompts each with plan-handoff capsules (C-5) + worktree-aware context (C-6), and **proposes cross-pane merge order** by file-conflict probability. This is the "swarm with no merge conflicts" differentiator. Module: new orchestrator pane + Ruflo + SigmaSwarm. **Absorbs (prior backlog):** V3-W13-013 `dispatchBulk/refResolve` (bulk pane spawn from one prompt) is subsumed by the meta-pane's spawn-N capability.
- **C-10b SigmaVoice inline push-to-talk → focused pane** *(M)* — global hotkey + in-process Whisper injects into the focused PTY pane (no alt-tab). Module: pane prompt bar + SigmaVoice.
- **W-4 P8-9 (threaded here)** *(M/L)* — resume simplification + drop `external_session_id` (~150 refs). Threaded into M3 because the meta-pane touches spawn/resume anyway; refactor the PTY core **once**, on the clean post-shell-first base. **Risk-gated:** its own sub-plan + Opus review (PTY core). Module: pty/resume-launcher, registry, schema migration.
- **Success:** one goal → N worktree-isolated agents → coordinated merge; no shared-dir conflicts.

## M4 — New surfaces (~v1.19.0)
- **C-8 Embedded browser pane** *(M)* — Electron `WebContentsView`/webview pane; terminal links open inline. Module: new pane type. **Absorbs (prior backlog):** V3-W13-002 (click-link-in-pane → built-in browser, OSC8 hyperlink) + its recents panel.
- **C-9 Skills/guardrail matrix** *(M)* — Skills-tab toggles (Test-Driven / Security-Audit / CI-Green / DRY …) that inject the corresponding guardrails as **per-worktree CLAUDE.md / hook** entries at dispatch. Module: Skills tab (W-5) + hooks.
- **C-11 Wake-word dispatch** *(M)* — hands-free agent dispatch; first-mover (BridgeMind failed it over 6 debug rounds — our out-of-process Whisper avoids the WASM init race). Module: SigmaVoice.
- **Success:** browse + click-through in-app; one toggle adds a guardrail to a pane's worktree; "Hey Jorvis" dispatches.

## M5 — Breadth & polish (✅ SHIPPED v1.20.0)
- **C-13 Click-element→agent design tool** *(L, needs C-8)* — ✅ **shipped as operator-pick:** the W14 design tool's "Send to existing pane" mode injects the captured element + prompt into a chosen live pane's PTY (`pty.write`) and renders that pane's worktree `git.diff` inline. The leapfrog "route to the worktree that *owns* the file" was **dropped — infeasible** (no reverse element→file map / sourcemaps). Module: `design/controller.ts` + `DesignDock.tsx` + `shared/element-dispatch.ts`.
- **C-12 SigmaBench** *(L)* — ✅ **shipped as the conflict-category MVP:** runs the same task across N providers, each in its own worktree, scoring file-overlap via `scoreConflicts` (reuses C-7 merge-order). The multi-agent-conflict leaderboard a shared-dir competitor structurally can't produce. Latency/code-quality categories deferred. Module: `SigmaBenchRoom` + `core/sigmabench/{harness,store}.ts` + migration 0023 + `sigmabench.*` RPC. Required threading per-agent `initialPrompt` through the swarm factory (agents would otherwise spawn idle).
- **C-10c SigmaVoice local/cloud toggle + model selector** *(M)* — ✅ **shipped as CLI-based:** a Gemini-CLI transcription engine behind the `WhisperEngine` interface (audio→WAV→`gemini`) + a Claude/Codex/Gemini voice-dispatch-target selector, both KV-gated. Defaults unchanged (local Whisper `base.en-q5_1` / claude). Cloud-HTTP STT (Groq/OpenAI) was NOT taken — CLI-based per operator decision. Module: `voice-core/{wav-encode,cli-transcribe-engine,whisper-engine,global-capture,output-router}.ts` + `VoiceTab.tsx`.

---

## Cross-cutting
- **Cadence:** one milestone ≈ one release; balanced waves (quick wins + moat each wave). Each milestone = its own writing-plans plan, parallel-coder dispatch (isolated worktrees, `isolation:"worktree"`), lead-merge + full gate (tsc -b / eslint 0 / vitest / build / electron:compile / smoke) in main — per the established v1.x flow.
- **Quality bar:** unchanged. Agents never push/tag/release; lead ships.
- **Dependencies:** C-7 (M3) requires C-2+C-4 (M1) + C-5+C-6 (M2). C-13 (M5) requires C-8 (M4). Everything else is independent.

## Prior-backlog reconciliation (2026-05-23)
**Absorbed into this roadmap** (struck from their source lists): V3-W13-013 dispatchBulk → C-7/M3 · V3-W15-006 4-pane dogfood → M0 · V3-W13-002 OSC8 link-in-pane → C-8/M4. **Left as standalone low-priority backlog** (deliberately NOT in this roadmap): sample-rate PCM tap, HMR voice-win race, whisper.cpp v1.7.x port, prebuildify silent no-output (CI/native-build convenience), and DOGFOOD-V1.4.2-01 hyp.2 split-button (UX call). **No open bugs.**

## Risks
- **W-4 P8-9** is a risky PTY-core refactor — isolate as its own sub-plan within M3 + Opus review; ship behind the existing shell-first base.
- **C-7 meta-pane** is the largest single item — keep M3 light on extras; consider splitting C-7 into "orchestrator UI" + "cross-pane merge" if it overruns.
- **win32** remains the standing risk until M0 dogfood resolves it.
- **Token cost** of competitive parallel-coder waves — bounded by the per-milestone plan + isolated worktrees.

## References
- Review + 101 screenshots: `docs/02-research/bridgemind-review-2026-05-22/`
- Wishlist C-class: `docs/03-plan/WISHLIST.md` (🆚 C-class section)
- Memory: `project-bridgemind-competitive-review`

## Out of scope
- Signed distribution / store listings (internal-use posture unchanged).
- Anything requiring forking claude-flow (our-level + upstream PR only).
- Speccing M2–M5 in implementation detail now (each gets its own plan when reached).

---

## Post-roadmap — what's next (this roadmap is COMPLETE)

The BridgeMind C-class roadmap (M0–M5, C-1…C-13) **and** the W-class (W-1…W-8) are fully shipped. New work is **not** part of this roadmap; it is tracked in `docs/03-plan/WISHLIST.md`. As of 2026-05-25 the live backlog is **three named items + a hardening packet** — none scheduled yet. Each gets its own spec/plan when picked up.

### Feature backlog
- **R-1 — Jorvis Remote (Telegram bridge)** *(designed 2026-05-25, not yet built)* — full remote control of the Jorvis assistant from Telegram, **confirm-on-dangerous**, driving the worktree-isolated swarm remotely (the leapfrog vs shared-dir bots like OpenClaw/Hermes). grammY long-poll in the Electron main process → existing `assistantCtl.send` seam; mandatory safety floor (CredentialStore token + single-operator allowlist + aidefence in/out + `read_files`/`open_url` hardening + `/lock`). First mandated consumer of H-19. Full design + decisions in the WISHLIST R-1 entry → own spec + writing-plans when scheduled.
- **R-2 — Native Cursor CLI provider** *(requested 2026-05-25, not yet built)* — first-class `cursor-agent` provider (worktree pane, session resume, Ruflo MCP auto-bind, skill provider-compat badges, dispatch-target selection, info bar) rather than a generic `shell` pane. Add `cursor` to `ProviderId`/`AGENT_PROVIDERS` + thread through launcher/factory-spawn/skill fan-out. **Verify Cursor's non-interactive/resume CLI contract at build time** (flags not pinned at design); mark dispatch-only on any platform lacking a clean contract. WISHLIST R-2 entry.
- **FE-1 — Glass theme (neon glassmorphism)** *(✅ landed on main 2026-05-25, rides next release, untagged)* — opt-in selectable theme: translucent `backdrop-blur` panel chrome over a dark cyan/violet/magenta neon glow; terminals stay opaque/legible by design. Built as a `themes.ts` registry entry + an unlayered `index.css` block (zero component markup changed). Not yet visually verified; tunable knobs + candidate-default noted in the WISHLIST FE-1 entry.

### Hardening backlog — H-class (external review 2026-05-25, code-verified)
A 19-item hardening packet distilled from an external LLM repo review, **every claim verified against the code by 3 read-only agents** (file:line + fix in the WISHLIST H-class table). Threat model = a compromised renderer → these are defense-in-depth, not open holes today (`contextIsolation:true`/`nodeIntegration:false` are set). Highest-leverage first:
- **P0 (boundaries + CI drift):** H-1 electron/main not typechecked *(this is the gap that hid the v1.20.0→.1 model-registry break)* · H-2/H-3 fs trusts renderer-supplied paths · H-4 git/pty renderer-supplied cwd · H-5 no central `assertAllowedPath`.
- **P1 (correctness + drift):** H-6 win32 shell-first sentinel bug · H-7 non-transactional migrations · H-8 IPC schemas warn-only · H-9 alt-command fallback dead in shell-first · H-10 dup-pane PTY leak · H-11 readFile-before-truncate · **H-19 aidefence/AIMDS wired nowhere** (the runtime-input defense layer — orthogonal to the code-level items; R-1 is its first mandated consumer).
- **P2 (polish + drift):** H-12 shell leaks into provider list · H-13 fire-and-forget daemon stop · H-14 comment rot · H-15 git.diff silent truncation · H-16 dirSize follows symlinks · H-17 stale README · H-18 local pack skips compile.
- **Reviewer-aligned fix order:** H-1 → H-5 (closes H-2/H-3/H-4) → H-8 → H-6 → H-7 → cheap drift (H-12/H-14/H-17) → remainder. Could be one "hardening" packet or folded into the next feature wave.
