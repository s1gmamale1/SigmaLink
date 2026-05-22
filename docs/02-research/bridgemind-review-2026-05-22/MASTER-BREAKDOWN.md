# BridgeMind — Full Competitive Breakdown (for SigmaLink)

Reviewed 2026-05-22 via frames+transcript→Claude sub-agents. Sources: BridgeVoice launch (4:15), "Vibe Coding With BridgeSpace 3" (18:05), **Day-181 livestream (3h11m, ARR $185,652)**.

## Index
| Report | Lines | Screenshots |
|---|---|---|
| `bridgevoice/REVIEW.md` | 211 | `bridgevoice/screenshots/` (13) |
| `bridgespace/REVIEW.md` | 248 | `bridgespace/screenshots/` (20) |
| `stream/workflow-REVIEW.md` | 324 | `stream/screenshots/workflow/` (12) |
| `stream/uiux-REVIEW.md` | 364 | `stream/screenshots/uiux/` (19) |
| `stream/functionality-REVIEW.md` | 574 | `stream/screenshots/functionality/` (19) |
| `stream/ideas-REVIEW.md` | 410 | `stream/screenshots/ideas/` (6) |
| `stream/integration-REVIEW.md` | 114 | `stream/screenshots/integration/` (12) |
| `/tmp/bms/timeline.md` | 616 | — (condensed 3h transcript) |
**101 screenshots, 9.2M total.**

## Their product (current state)
- **BridgeSpace 3** (shipped) — ADE: 3-col layout, terminal grid (1→12+ panes), persistent **Bridge orchestration agent** panel, Skills rail, floating BridgeVoice badge. **BridgeSpace 4** in active dev.
- **Bridge Agent** (shipped) — meta-orchestrator: chat / wake-word / drag-drop inputs; spawns panes, auto-attaches workspace context, dispatches to specific panes, tracks Tasks. Routing: **Grok 4.1-fast default, Grok 4.2 vision, GPT-5 high-effort** (NOT Claude/GPT-5 by default). Spawns fail silently when too many terminals open.
- **BridgeBench V2** (shipped) — 9-category model benchmark, one sub-agent/category, `bridgebench.ai`.
- **BridgeVoice** (BETA/**broken**) — XAI Whisper + Onyx WASM TTS + wake-word; 6 debug rounds, never reliably fixed (WASM init delay, soft-disable, mic routing, "bridge" wake-word conflict).
- **Drag-drop terminal context** (working proto, **BS4 core**) — drag pane header → Bridge chat; compacts scrollback (16KB→100 lines→3500 chars, ~875 tok/turn).
- **Plan-handoff capsule** (design) — goal→files→criteria→out-of-scope.
- Shipped mid-stream: terminal-header redesign, coding-agent index (Tasks panel). Proposed: per-pane info bar (model+tokens), system-prompt/skills settings UI.

## Integration roadmap for SigmaLink (ranked, deduped across all 7 agents)
| # | Feature | SigmaLink module | Value | Effort |
|---|---|---|---|---|
| 1 | **Per-pane info bar** — `[claude/opus] feat/auth ⋯ 3 files ⋯ 42K tok` (model + branch + uncommitted + tokens) | pane header chrome | HIGH | **S** |
| 2 | **Coding-agent index** — live "what each agent is doing" panel | SigmaSwarm roster | HIGH | **S** |
| 3 | **Pane drag-resize + density mitigation** (their #1 UX gap: unreadable at 8+, no resize) | Command Room grid | HIGH | S/M |
| 4 | **Visible SigmaSwarm inter-agent chat log** (read + inject into the Ruflo SendMessage bus) | SigmaSwarm UI | HIGH | M |
| 5 | **Plan-handoff capsule** (goal/files/criteria/out-of-scope) | W-5 injection | HIGH | M |
| 6 | **Drag-drop pane → swarm chat as live context** | Command Room DnD | HIGH | M |
| 7 | **Sigma Agent meta-pane** (human-facing orchestrator: spawns panes, auto-prompts with context) | new pane + Ruflo | CRITICAL | L |
| 8 | **Embedded browser pane** (terminal links open inline) | new pane | MED-HIGH | M |
| 9 | **Skills/guardrail matrix** (Test-Driven/Security/CI-Green toggles → per-worktree CLAUDE.md hook injection) | Skills tab (W-5) + hooks | MED-HIGH | M |
| 10 | **SigmaVoice: dictionary** (spoken phrase → @mention / CLI fixes) | SigmaVoice | HIGH | S |
| 11 | SigmaVoice: verbal command macros ("new line"→`\n`) | SigmaVoice | MED | S |
| 12 | SigmaVoice: usage dashboard (words/WPM/history) | SigmaVoice | MED | S |
| 13 | SigmaVoice: inline push-to-talk → focused pane | pane prompt bar | MED | M |
| 14 | SigmaVoice: local/cloud toggle + model selector | SigmaVoice settings | MED | M |
| 15 | Wake-word dispatch (they couldn't ship it — first-mover win) | SigmaVoice | MED | M |
| 16 | SigmaBench (BridgeBench equivalent, + a multi-agent-conflict category they can't run) | new tool | MED | L |
| 17 | Click-element→agent design tool | new tool | MED | L |

## Our defensible edges
- **Per-pane git worktrees** — BridgeSpace runs ALL agents in ONE shared dir (confirmed in every pane header). Structural race/conflict risk at scale; they'd have to rebuild to match. **This is the moat.**
- **Out-of-process Whisper** — Matt burned 6 debug rounds on Onyx WASM init races; ours sidesteps the whole class.
- **Ruflo MCP** — vector-indexed hierarchical memory + typed SendMessage bus vs their screenshot/drag context injection.
- **W-8 IDE worktree browser, W-5 skill injection, hooks layer, shell-first PTY, multi-CLI heterogeneity** (claude/codex/gemini/kimi/opencode in real PTYs) — no BridgeSpace equivalent.

## Leapfrogs (all enabled by per-pane worktrees — impossible for BridgeSpace)
1. **Worktree-aware drag-drop** — attach scrollback + `git diff --stat` + branch, not just printed output.
2. **Plan-handoff with filesystem-enforced scope** — "out-of-scope" = a real boundary, not prose.
3. **Cross-pane merge orchestration** — SigmaSwarm proposes merge order by file-conflict probability.
4. **Wake-word → branch-scoped spawn** — "open a Claude agent on feat/payments" creates worktree + pane in one command.
5. **Agent index with git-activity heatmap** — files touched per worktree, churn-colored.

## Strategic intel (from spoken ideas)
- **Thesis:** "zero-prompt orchestration" — the whole product exists to make you not prompt.
- **Model stance:** Composer 2.5 is their favorite (200 tok/s, found the wake-word bug). **Actively distrusts Opus 4.7** ("no longer referencing the codebase… made it worse"). GPT-5 niche/overhyped. Qwen 3.7 Max surprised them (best Flappy Bird, weak reasoning). Kimi K2.6 unusable at consumer tier. **Eval criterion = tool-calling reliability, not leaderboard rank.**
- **Business:** $185K ARR, **zero marketing spend**, anti-acquisition ("they'd have to aqua-hire"), ~3 months coding experience. Elon retweet = 5.4M views but ~$0 revenue.
- **Their unmet needs (our opportunities):** reliable wake-word, working agent undo/rewind (Claude Code's is broken for him), honest token-speed display, non-Opus default orchestration.
