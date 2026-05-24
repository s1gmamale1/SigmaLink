# SigmaLink — Bounded Contexts (DDD domain map)

Maintained per the `wrap-up` skill. Each context = one clear responsibility, its key modules, and its RPC namespace. The **moat** is per-pane git worktrees: every agent works in an isolated worktree, and the Orchestrator merges by conflict probability.

| Context | Responsibility | Key modules | RPC namespace |
|---|---|---|---|
| **Workspaces** | Open/launch a repo or dir; allocate per-pane worktrees; autowrite MCP + convention/scope/guardrail CLAUDE.md blocks | `core/workspaces/{factory,launcher,lifecycle,mcp-autowrite,scope-block,guardrail-block}.ts`, `core/git/worktree.ts` | `workspaces.*` |
| **Panes & PTY** | Spawn/resume CLI panes (shell-first default); ring-buffer scrollback; terminal render + link detection | `core/pty/{registry,local-pty,resume-launcher,ring-buffer,link-detector}.ts`, renderer `command-room/*`, `lib/terminal-cache.ts` | `pty.*`, `panes.*` |
| **Swarms** | Multi-agent roster (per-agent `initialPrompt`), typed mailbox/SIGMA protocol, roll-call, spawn N worktree panes in one call | `core/swarms/{factory,factory-spawn,controller,mailbox,protocol}.ts`, renderer `swarm-room/*`, `right-rail/SwarmRailTab.tsx` | `swarms.*` |
| **Orchestrator (Sigma Agent)** | Goal→N tasks→spawn worktree swarm→capsule-brief each→conflict-aware merge order | renderer `operator-console/OrchestratorPanel.tsx`, `shared/{merge-order,orchestrator-tasks,plan-capsule}.ts` | (composes `swarms`/`panes`/`git`/`review`) |
| **Benchmark (SigmaBench)** | Run one task across N providers, each in its own worktree; score by changed-file overlap (the conflict leaderboard a shared-dir competitor can't run) | renderer `sigmabench-room/SigmaBenchRoom.tsx`, `core/sigmabench/{harness,store}.ts`, `shared/bench-scoring.ts`, migration `0023_benchmark_runs` | `sigmabench.*` |
| **Voice** | Global capture (hotkey + "Hey Sigma" wake-word), dictionary/macros, focused-pane routing, usage stats, local-Whisper-or-Gemini-CLI transcription + dispatch-target selector | **`packages/voice-core/src/*`** (LIVE: `{global-capture,output-router,whisper-engine,cli-transcribe-engine,wav-encode,model-registry,voice-stats}`), `core/voice/{adapter,dispatcher,native-mac,native-win,diagnostics}.ts`, native `voice-whisper`/`voice-mac`/`voice-win`, `shared/{voice-dictionary,pcm-ring,audio-energy,wake-word}.ts` | `voice.*`, `voice.globalCapture.*` |
| **Browser & Design** | Embedded `WebContentsView` tabs, recents, terminal link-through; element-pick → dispatch to a new or operator-picked existing pane + inline worktree diff | `core/browser/{manager,controller}.ts`, `core/design/{controller,picker,staging}.ts`, renderer `browser/*` (incl. `DesignDock.tsx`), `shared/element-dispatch.ts` | `browser.*`, `design.*` |
| **Skills & Guardrails** | Skill discovery/bindings (W-5), guardrail matrix → per-worktree CLAUDE.md | renderer `skills/SkillsTab.tsx`, `shared/guardrails.ts`, `core/skills/*` | `skills.*` |
| **Review & Merge** | Per-pane diff/conflict preview, ordered batch commit-and-merge | `core/review/*`, `core/git/git-ops.ts` (`gitStatus`/`gitDiff`/`mergePreview`/`commitAndMerge`) | `review.*`, `git.*` |
| **Memory / Ruflo** | MCP autowrite, namespace convention, AgentDB/vector recall | `core/memory/*`, `core/ruflo/*`, `core/workspaces/mcp-autowrite.ts` | `memory.*` |
| **Assistant (Jorvis)** | Conversational dispatch, bulk pane dispatch, @ref resolve | `core/assistant/{controller,tools}.ts`, renderer `jorvis-assistant/*` | `assistant.*` |
| **Shell (UI)** | Room router, right-rail dock + switcher, command room grid/density | renderer `app/App.tsx`, `right-rail/*`, `command-room/{GridLayout,PaneHeader,PaneShell}.tsx` | (renderer-only) |

## Cross-cutting invariants
- **Worktree isolation per pane** — distinct `session.worktreePath`/`branch`; the Orchestrator merge order is computed from per-worktree `git.status` overlap.
- **RPC allowlist** — every renderer-invokable channel is in `shared/rpc-channels.ts` `CHANNELS`; a cross-ref test (`rpc-channels.test.ts`) enforces router↔allowlist parity.
- **CLAUDE.md as the agent-instruction boundary** — scope (C-5) + guardrails (C-9) are written as idempotent marker-delimited blocks into each worktree's CLAUDE.md (guidance-level; no settings/hook mutation).
- **voice-core is the single live voice module** — the dead duplicates under `src/main/core/voice/` were removed incrementally (`global-capture`/`output-router` v1.19.0; `model-registry` v1.20.0). `core/voice/{adapter,dispatcher,native-mac,native-win,diagnostics}` remain LIVE (the adapter is wired in `rpc-router`). See `reference_voice_core_dead_tree`.
- **Transcription engine is pluggable behind `WhisperEngine`** — `resolveTranscriptionEngine(kv['voice.transcriptionMode'])` returns local Whisper (default, `base.en-q5_1`) or the Gemini-CLI engine; failures fall back to local. Claude/Codex are dispatch targets only (no audio modality).
