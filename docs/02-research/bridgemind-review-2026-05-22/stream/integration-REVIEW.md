# SigmaLink — Day 181 Integration Opportunities & Competitive Edge Analysis

**Source:** BridgeMind Day 181 livestream (3h12m)  
**Lens:** SigmaLink integration / competitive positioning  
**Screenshots:** `/tmp/bm-report/stream/screenshots/integration/`  

---

## INTEGRATE — Ranked Feature Opportunities

Features new or substantially evolved in Day 181 (beyond prior BridgeVoice/BridgeSpace overview videos).

| # | Feature | SigmaLink module | Value | Effort | Screenshot + timestamp |
|---|---------|-----------------|-------|--------|------------------------|
| 1 | **Drag-and-drop pane → SigmaSwarm chat as live context** | Command Room (pane header DnD) + SigmaSwarm orchestrator | CRITICAL — this became BridgeSpace 4's headline feature; enables "show me what this agent is doing right now" without copy-paste | M | `11_final-drag-drop-demo-bs4-centerpiece_t11300s.jpg` (T=11300s), `05_drag-drop-terminal-scrollback-pipeline_t5700s.jpg` (T=5700s) |
| 2 | **Plan-handoff capsule: goal → target files → success criteria → out-of-scope** | Skills tab / slash-command injection (W-5) | HIGH — structured prompt envelope eliminates "Opus forgetting codebase" regression; verified capsule + runtime compose | M | `06_plan-handoff-capsule-diagram_t6100s.jpg` (T=6100s), `04_plan-handoff-capsule-before-after_t5400s.jpg` (T=5400s) |
| 3 | **Coding agent index — live status panel per agent** | SigmaSwarm roster panel | HIGH — shows what each pane's agent is doing at a glance ("Luc reviewing diffs across UI, admin, web app"); directly maps to our role-tagged roster | S | `08_coding-agent-index-live-status_t7300s.jpg` (T=7300s), `01_multi-agent-dispatch-orchestration_t2100s.jpg` (T=2100s) |
| 4 | **Per-pane terminal info bar: model name + tokens used** | Pane header / pane chrome | HIGH — low-effort; viewer-suggested, Matt endorsed; "horizontal bar showing model name and tokens used"; maps to our per-pane CLI agent headers | S | `08_coding-agent-index-live-status_t7300s.jpg` (T=7300s) |
| 5 | **Bridge agent settings UI: custom skills + system prompt** | Skills tab (W-5) — extend to per-pane overrides | MEDIUM-HIGH — gives users custom skill injection and per-role system prompt; we already have slash-command injection, add a settings panel | M | `09_agent-settings-ui-skills-sysprompt_t1500s.jpg` (T=1500s) |
| 6 | **BridgeBench — in-house multi-category model benchmark** | New standalone tool or integrated SigmaSwarm eval mode | MEDIUM — design arena + debugging + refactoring + speed + game coding; differentiates platform credibility and drives content/social | L | `07_prompt-architecture-per-provider-envelope_t7200s.jpg` (T=7200s) |
| 7 | **Wake-word / hands-free agent dispatch** | SigmaVoice (whisper already bundled) | MEDIUM — "Hey Sigma, open 4 Claude agents" → panes spawn; SigmaVoice has Whisper STT; add wake-word detector layer + Onyx WASM TTS for response | M | `03_wake-word-voice-architecture-details_t4100s.jpg` (T=4100s), `09_agent-settings-ui-skills-sysprompt_t1500s.jpg` (T=1500s) |
| 8 | **Per-provider prompt envelope (XML for Claude, Goal/Done-when for Codex, brevity for Gemini)** | Slash-command injection pipeline (W-5) | MEDIUM — today our injection is single-format; per-provider envelope improves Opus/Codex/Gemini dispatch quality measurably; combats the prompt regression Matt observed | M | `07_prompt-architecture-per-provider-envelope_t7200s.jpg` (T=7200s) |
| 9 | **Scrollback compaction on drag-drop attach (strip ANSI, cap to 3500 chars, dedup blank lines)** | Pane context pipeline | MEDIUM — Day 181 showed exact pipeline: fetch 16KB PTY buffer → compact → budget → enrich → embed in preamble; prevents context blowout when attaching panes | S | `05_drag-drop-terminal-scrollback-pipeline_t5700s.jpg` (T=5700s) |
| 10 | **Model routing: fast/non-reasoning for chat+tools, reasoning model for vision tasks** | SigmaSwarm agent-dispatch router | LOW-MEDIUM — Grok 4.1 fast for text dispatch, Grok 4.2 reasoning for screenshot/vision; we can map this to our existing multi-CLI routing layer | S | `02_terminal-grid-bridge-chat-standby_t3500s.jpg` (T=3500s) |

---

## EDGES — Where SigmaLink Already Leads

| Edge | BridgeSpace gap | SigmaLink advantage |
|------|----------------|---------------------|
| **Per-pane git worktrees (W-8)** | BridgeSpace runs all agents in ONE shared working directory — the most significant architectural gap. Matt has no concept of per-agent branch isolation. | Every SigmaLink pane gets its own git worktree. Agents on different panes work on different branches simultaneously, merge cleanly, never stomp each other. This is a qualitative safety guarantee BridgeSpace cannot currently offer. |
| **Multi-CLI heterogeneity** | BridgeSpace orchestrates primarily Claude Code + Codex agents within its own harness. Limited cross-provider treatment. | SigmaLink runs claude, codex, gemini, kimi, opencode each in a real PTY. The orchestrator is CLI-agnostic by design. Drag-drop context and plan-handoff capsules can be per-provider formatted. |
| **SigmaVoice bundled (Whisper native)** | BridgeSpace has a voice layer but Matt spent 6+ debug rounds fighting Onyx WASM initialization failures, mic routing conflicts, and soft-disables. Wake-word was unreliable by stream end. | SigmaVoice uses bundled Whisper (native, no WASM init race). We can offer a more stable wake-word implementation because the STT is out-of-process and not entangled with the renderer's Onyx WASM runtime. |
| **Ruflo MCP shared cross-pane memory + SendMessage bus** | BridgeSpace has an agent registry and task panel, but no cross-agent structured memory bus with semantic search. Context sharing is via drag-drop image injection. | Ruflo MCP provides vector-indexed memory (HNSW), hierarchical recall, and typed SendMessage routing. Agents genuinely share structured findings, not just screenshots. |
| **IDE pane with worktree browsing (W-8)** | No per-agent file browser tied to that agent's isolated branch. | Our IDE pane opens on the specific worktree of its pane, so the file tree matches what that agent is editing. |
| **Hooks infra (pre/post edit, pre/post task, session)** | BridgeSpace has no equivalent hooks layer visible in Day 181. Automation triggered entirely by bridge agent prompts. | Hooks allow local automation (linting, test runs, memory store) on every edit, without occupying an agent turn. |

---

## LEAPFROG — Ideas Combining Their Features with Our Per-Pane-Worktree Architecture

These are concrete ideas that are _impossible or significantly harder_ for BridgeSpace to ship because of the shared-directory constraint.

### 1. Worktree-Aware Drag-Drop Context Injection
When the user drags a pane header into SigmaSwarm chat, attach not just scrollback but also: (a) current git branch name, (b) `git diff --stat HEAD` summary, (c) list of files modified in this worktree. The orchestrator sees exactly what this agent changed, not just what it printed. BridgeSpace cannot do this — all agents share one branch, so `git diff` is meaningless per-pane.

**Module:** Command Room DnD + git worktree API + Ruflo MCP context-synthesize  
**Effort:** M

### 2. Plan-Handoff Capsule with Worktree Scope Lock
Extend the plan-handoff capsule (goal → files → success criteria → out-of-scope) to auto-populate the "target files" field from the pane's worktree diff. The agent literally cannot touch files outside its branch. "Out-of-scope" becomes a hard filesystem boundary, not a prose instruction. Eliminates the "Opus forgetting codebase" regression by giving it a git-grounded file list it cannot ignore.

**Module:** W-5 slash-command injection pipeline + worktree file scope  
**Effort:** M

### 3. Cross-Pane Merge Orchestration
Extend SigmaSwarm to see the git status of all active worktrees simultaneously. When multiple panes finish their tasks, the orchestrator auto-proposes a merge order based on file conflict probability (files modified in common). The user gets a one-click merge sequence. BridgeSpace has no concept of this — it would need to rebase a single shared branch.

**Module:** SigmaSwarm roster + git worktree status polling + Ruflo memory  
**Effort:** L

### 4. Per-Pane Terminal Info Bar with Branch + Token Count
Ship the terminal info bar Matt proposed (model name + tokens), but add: active git branch and uncommitted file count. This turns the pane header into a full situational awareness strip: `[claude/opus] branch: feat/auth | 3 files | 42K tokens`. BridgeSpace cannot show per-agent branch because there is none.

**Module:** Pane header chrome  
**Effort:** S (lowest-effort leapfrog)

### 5. SigmaBench — In-House Benchmark Tied to Worktree Isolation
Ship our own benchmark suite modeled on BridgeBench V2 categories but add a category BridgeSpace cannot test: "multi-agent conflict resolution" — two agents given conflicting tasks on separate worktrees, scored on how cleanly the orchestrator detects and resolves the conflict. Differentiates SigmaLink's core architectural advantage in benchmark content.

**Module:** New SigmaBench tool (new, but leverages existing multi-pane + worktree infra)  
**Effort:** L

### 6. Wake-Word → Worktree-Scoped Spawn
Extend SigmaVoice wake-word dispatch so voice commands can include branch targets: "Hey Sigma, open a Claude agent on feat/payments" → spawns pane + creates worktree from that branch. BridgeSpace wake-word spawns agents into the same directory regardless.

**Module:** SigmaVoice wake-word + worktree provisioning  
**Effort:** M

### 7. Coding Agent Index with Git Activity Heatmap
The BridgeMind coding agent index shows what each agent is "currently doing" via prompt summary. Extend ours to show a live git-activity heatmap per pane: files touched in the last N commits on that worktree branch, colour-coded by churn rate. Gives a real-time view of where code is changing across all panes simultaneously.

**Module:** SigmaSwarm roster panel  
**Effort:** M

---

## Key Observations

- **BridgeSpace 4 centerpiece = drag-drop terminal context.** Day 181 confirmed this explicitly at T=11300s. We should ship a version of this before BS4 lands — our per-pane worktree makes it strictly better.
- **Prompt quality regression (Opus 4.x)** is a real pain point Matt surfaced. Per-provider envelope format (leapfrog #2 / integrate #8) is a near-term win that visibly improves agent output quality.
- **Wake-word was unreliable throughout the entire stream** (6 debug rounds, never fully resolved). Our bundled Whisper gives us a more stable STT base; this is a concrete reliability edge.
- **BridgeBench / SigmaBench** is a content + credibility flywheel. Matt gets 5.4M-view retweets from benchmark posts. Worth the L effort.
- **Day 181 goals whiteboard** (frame 12) lists: "1. 3h Sprint, 2. Hey Bridge, 3. Terminal Reference, 4. Better System Prompting" — all four are now mapped to SigmaLink modules above.

---

## Screenshot Index

| File | Feature | Timestamp |
|------|---------|-----------|
| `01_multi-agent-dispatch-orchestration_t2100s.jpg` | Bridge agent dispatching 5 named sub-agents; coding agent index live | T=2100s |
| `02_terminal-grid-bridge-chat-standby_t3500s.jpg` | 4-pane terminal grid + Bridge chat panel architecture | T=3500s |
| `03_wake-word-voice-architecture-details_t4100s.jpg` | Wake-word + voice pipeline details in plan-handoff code | T=4100s |
| `04_plan-handoff-capsule-before-after_t5400s.jpg` | Plan-handoff BEFORE/AFTER flow diagram | T=5400s |
| `05_drag-drop-terminal-scrollback-pipeline_t5700s.jpg` | Terminal scrollback compaction pipeline (7-step table) | T=5700s |
| `06_plan-handoff-capsule-diagram_t6100s.jpg` | Voice → plan_handoff → runtime renders → submit → verify flow | T=6100s |
| `07_prompt-architecture-per-provider-envelope_t7200s.jpg` | Per-provider prompt envelope architecture (claude.ts, codex.ts, gemini.ts list) | T=7200s |
| `08_coding-agent-index-live-status_t7300s.jpg` | 6-pane workspace with agent index panel; terminal info bar discussion | T=7300s |
| `09_agent-settings-ui-skills-sysprompt_t1500s.jpg` | Bridge agent settings UI spec; skills + system prompt; wake-word "Listening" state | T=1500s |
| `10_bridgespace-workspace-browser-pane_t8100s.jpg` | BridgeSpace in-app browser pane (preview URL, recently opened) | T=8100s |
| `11_final-drag-drop-demo-bs4-centerpiece_t11300s.jpg` | Final drag-drop context demo; BS4 centerpiece confirmed | T=11300s |
| `12_day181-goals-whiteboard_t11200s.jpg` | Day 181 goals whiteboard: 3h Sprint / Hey Bridge / Terminal Reference / Better System Prompting | T=11200s |
