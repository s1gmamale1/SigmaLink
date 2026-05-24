# SigmaLink — Bounded Contexts (DDD domain map)

Maintained per `sigmalink-milestone-consolidation`. Each context = one clear responsibility, its key modules, and its RPC namespace. The **moat** is per-pane git worktrees: every agent works in an isolated worktree, and the Orchestrator merges by conflict probability.

| Context | Responsibility | Key modules | RPC namespace |
|---|---|---|---|
| **Workspaces** | Open/launch a repo or dir; allocate per-pane worktrees; autowrite MCP + convention/scope/guardrail CLAUDE.md blocks | `core/workspaces/{factory,launcher,lifecycle,mcp-autowrite,scope-block,guardrail-block}.ts`, `core/git/worktree.ts` | `workspaces.*` |
| **Panes & PTY** | Spawn/resume CLI panes (shell-first default); ring-buffer scrollback; terminal render + link detection | `core/pty/{registry,local-pty,resume-launcher,ring-buffer,link-detector}.ts`, renderer `command-room/*`, `lib/terminal-cache.ts` | `pty.*`, `panes.*` |
| **Swarms** | Multi-agent roster, typed mailbox/SIGMA protocol, roll-call, spawn N worktree panes in one call | `core/swarms/{factory,factory-spawn,controller,mailbox,protocol}.ts`, renderer `swarm-room/*`, `right-rail/SwarmRailTab.tsx` | `swarms.*` |
| **Orchestrator (Sigma Agent)** | Goal→N tasks→spawn worktree swarm→capsule-brief each→conflict-aware merge order | renderer `operator-console/OrchestratorPanel.tsx`, `shared/{merge-order,orchestrator-tasks,plan-capsule}.ts` | (composes `swarms`/`panes`/`git`/`review`) |
| **Voice** | Global capture (hotkey + "Hey Sigma" wake-word), dictionary/macros, focused-pane routing, usage stats | **`packages/voice-core/src/*`** (LIVE), `core/voice/{adapter,dispatcher,native-mac,native-win,diagnostics,voice-stats,model-registry}.ts`, native `voice-whisper`/`voice-mac`/`voice-win`, `shared/{voice-dictionary,pcm-ring,audio-energy,wake-word}.ts` | `voice.*`, `voice.globalCapture.*` |
| **Browser** | Embedded `WebContentsView` tabs, recents, terminal link-through, design overlay | `core/browser/{manager,controller}.ts`, renderer `browser/*` | `browser.*` |
| **Skills & Guardrails** | Skill discovery/bindings (W-5), guardrail matrix → per-worktree CLAUDE.md | renderer `skills/SkillsTab.tsx`, `shared/guardrails.ts`, `core/skills/*` | `skills.*` |
| **Review & Merge** | Per-pane diff/conflict preview, ordered batch commit-and-merge | `core/review/*`, `core/git/git-ops.ts` (`gitStatus`/`gitDiff`/`mergePreview`/`commitAndMerge`) | `review.*`, `git.*` |
| **Memory / Ruflo** | MCP autowrite, namespace convention, AgentDB/vector recall | `core/memory/*`, `core/ruflo/*`, `core/workspaces/mcp-autowrite.ts` | `memory.*` |
| **Assistant (Jorvis)** | Conversational dispatch, bulk pane dispatch, @ref resolve | `core/assistant/{controller,tools}.ts`, renderer `jorvis-assistant/*` | `assistant.*` |
| **Shell (UI)** | Room router, right-rail dock + switcher, command room grid/density | renderer `app/App.tsx`, `right-rail/*`, `command-room/{GridLayout,PaneHeader,PaneShell}.tsx` | (renderer-only) |

## Cross-cutting invariants
- **Worktree isolation per pane** — distinct `session.worktreePath`/`branch`; the Orchestrator merge order is computed from per-worktree `git.status` overlap.
- **RPC allowlist** — every renderer-invokable channel is in `shared/rpc-channels.ts` `CHANNELS`; a cross-ref test (`rpc-channels.test.ts`) enforces router↔allowlist parity.
- **CLAUDE.md as the agent-instruction boundary** — scope (C-5) + guardrails (C-9) are written as idempotent marker-delimited blocks into each worktree's CLAUDE.md (guidance-level; no settings/hook mutation).
- **voice-core is the single live voice module** — `src/main/core/voice/global-capture|output-router` were dead duplicates (removed v1.19.0); see `reference_voice_core_dead_tree`.
