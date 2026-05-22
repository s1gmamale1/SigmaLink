# BridgeMind Day 181 — Workflow Analysis
## End-to-End Build Cycle: Idea → Prompt → Agents → Verified App

**Stream:** Day 181 | Duration: 3h 12m | ARR: $185,652  
**Streamer:** Matt Miller (BridgeMind founder)  
**Focus:** Bridge Orchestration Agent ("Jarvis") — make it so the user "never even has to prompt"

---

## Step-by-Step Workflow Breakdown

---

### STEP 0 — Workspace Setup & Goal Statement (~00:00–00:03)

**Tool:** BridgeSpace (multi-terminal grid) + Bridge agent chat panel  
**Screenshot:** `01_workspace-overview-and-initial-agent-dispatch_t100s.jpg` (~t=100s)

Matt opens BridgeSpace with an already-running multi-terminal grid: 4–8 Claude Code panes and 2–4 OpenAI Codex panes are visible at stream start. The Bridge agent panel occupies the right sidebar. The workspace label reads "BridgeMind Dev" — the production codebase. Goals are stated out loud to the stream chat before any agent is touched:

> "The sole mission of this agent is to make it so that you never even have to prompt."

**Key observation:** The goal is verbalized first, then translated into a Bridge chat message. There is no formal spec document. The verbal statement IS the spec.

---

### STEP 1 — Reconnaissance: Bridge Agent Surveys the Workspace (~00:03–00:10)

**Tool:** Bridge agent (Grok 4.1 fast for chat/tool-calling; Grok 4.2 reasoning for vision)  
**Screenshot:** `02_agent-output-review-and-codebase-survey_t900s.jpg` (~t=900s)

Matt types a natural-language prompt into the Bridge chat:

> "Do a quick overview of the bridge agents and all the tooling."

Bridge agent reads the workspace, enumerates running sessions, scans the BridgeMind codebase directory, and returns a structured summary of: all voice pipeline tools, config settings, safety layer, and agent harness architecture. This output becomes the shared context for every subsequent step.

**Context-passing mechanism:** The Bridge agent's response text stays visible in the chat log. Matt scrolls back to it repeatedly. There is no separate "briefing document" — the chat log IS the running context.

---

### STEP 2 — Sub-Agent Dispatch for Deep Investigation (~00:14–00:20)

**Tool:** Bridge agent spawning Claude Code + Codex agents via tool calls  
**Screenshot:** `03_goal-verbalized-new-agent-spawned-for-settings-ui_t1500s.jpg` (~t=1500s)

Pattern used: **Fan-out dispatch**. Matt types one Bridge prompt:

> "Launch two Claude Code agents and two Codex agents. Prompt all four to do a complete review of the bridge voice orchestration agent tooling."

Bridge responds: "Both up. Both CodeXes up. Now prompting one."

Each spawned agent gets an identical brief. They run in parallel, each in its own terminal pane. Matt does NOT wait — he immediately starts parallel work (BridgeBench kick-off for Qwen 3.7) while agents run.

**Model selection at dispatch:** Claude Code agents default to Claude Max (Opus tier). For a specific "extra high effort" review task, Matt explicitly selects "GBD 5.5 / GPT-5" in the Bridge agent's model picker — the only time during the stream he manually overrides the default model.

**Monitoring:** No active polling. Matt scrolls the Bridge task panel ("Tasks — In Progress") which auto-populates as agents report status. Visible task: "Multi-agent reviews of Bridge Jarvis architecture."

---

### STEP 3 — Agent Output Review & Goal Refinement (~00:20–00:25)

**Tool:** Bridge chat (reading agent output) + manual reading of terminal output  
**Screenshot:** `04_multi-agent-task-tracking-panel_t2000s.jpg` (~t=2000s)

When agents complete, Matt reads their terminal output directly — he scrolls individual panes. He also asks Bridge:

> "Give me a task list of what's being worked on."

Bridge: "Done. Four tasks tracking the streams."

Top agent recommendation drives the next goal: the codebase review agents unanimously surface that Bridge needs a settings UI for custom skills and system prompts. Matt accepts this as Goal #2 with zero deliberation — he types it back to Bridge as the next task.

**Iteration pattern:** Agent recommendation → Matt's verbal acceptance → new Bridge dispatch. Average deliberation time: under 60 seconds.

---

### STEP 4 — New Goal Dispatched via Bridge, Agents Spawned (~00:20–00:36)

**Tool:** Bridge agent dispatching 2 more Claude Code agents  
**Screenshot:** `05_wake-word-debug-agent-diagnoses-onyx_t2500s.jpg` (~t=2500s)

Matt's Bridge prompt for the new goal:

> "Build out settings for Bridge — review this and build a better system prompt so users can basically customize it with a system prompt and some skills."

Bridge confirms: "Solid plan. It's concrete, references the codebase. Sent. Claude's got the task."

Two "deep-dive brainstorm" agents also dispatched: "Launch two deep-dive agents and brainstorm how we could potentially improve this."

**Handoff mechanism:** Bridge auto-attaches the workspace snapshot (first 400 chars of each terminal's buffer, current agent roster, workspace tree) to every sub-agent prompt. Matt does not manually copy-paste context — it is automatic.

---

### STEP 5 — Organic Discovery: Drag-and-Drop Context Injection (~00:35–00:57)

**Tool:** BridgeSpace UI — drag terminal header into Bridge chat input  
**Screenshot:** `06_drag-drop-terminal-context-shipped-diff_t3600s.jpg` (~t=3600s)  
**Screenshot:** `07_drag-and-drop-in-use-bridge-sees-terminal_t5800s.jpg` (~t=5800s)

While reviewing agent output, Matt discovers he can drag a terminal's header tile into the Bridge chat input area. The terminal attaches as a context chip ("Files become @-references; terminals are linked by session ID"). Bridge can now see the full live content of that terminal.

He tests immediately:

> "I need you to tell me exactly what these two agents are working on." [drags two terminal chips in]

Bridge: "First one is a UI and SEO review for BridgeMind... Second one is a swarm builder agent, currently idle."

This drag-and-drop workflow becomes a first-class interaction primitive and is retroactively identified as a "very core goal" for BridgeSpace 4. The feature was not planned — it was discovered during normal work, shipped by a coding agent mid-stream, and immediately incorporated into Matt's working method for the remainder of the session.

The agent-produced diff visible in frame `06_drag-drop-terminal-context-shipped-diff_t3600s.jpg` shows the exact code changes: `lib/jarvis/attachments.ts` updated with `TerminalAttachmentKind`, `handlePaneDrop`/`handlePaneDragOver` helpers added, `BridgePanel.css` updated with `.jp-attach-chip-terminal` variant.

---

### STEP 6 — Plan-Handoff Capsule Architecture (~01:28–01:45)

**Tool:** Bridge agent + Claude Code agent producing a prompt engineering spec  
**Screenshot:** `08_plan-handoff-capsule-before-after-diagram_t6200s.jpg` (~t=6200s)  
**Screenshot:** `09_agent-prompt-best-practices-doc-in-terminal_t7400s.jpg` (~t=7400s)

An agent returns the "BEFORE vs AFTER" prompt architecture diagram (visible in frame 08):

```
BEFORE:
  voice --> Grok writes prose --> submit_prompt --> [hope]

AFTER:
  voice --> plan_handoff --> runtime renders --> submit_prompt --> verify
           (structured intent)  (template +        (deterministic)   (BRIDGE_STATUS)
            · goal               adapter +
            · verified paths     role +
            · success criteria   context capsule)
            · constraints
```

Verbatim from transcript (01:28:05):
> "Replace Grok's free-form prose authoring with a mandatory plan handoff tool that captures structured intent. Then have the runtime deterministically render that plan into a per-provider role-specified prompt with an autoattached context capsule and bridge status output — turning every prompt from 'hope Grok wrote it well' into 'runtime composed it from a verified...'"

Matt's reaction: he accepts the architecture in principle but pushes back on "out-of-scope" constraints being too restrictive. He edits the capsule spec by telling the agent which fields to relax — the agent updates the plan inline. No separate design doc is created.

**Verification standard established here:** "Success criteria" must be checkable (typecheck passes, no legacy tokens, etc.). The agent bakes this into the capsule schema.

---

### STEP 7 — Voice-Triggered Multi-Agent Spawn (~02:23–02:27)

**Tool:** BridgeVoice (XAI Whisper STT + Onyx WASM TTS) → Bridge agent tool call → 8x Claude Code spawn  
**Screenshot:** `11_cursor-composer-fix-and-repro-steps_t9200s.jpg` (~t=9200s)

After 6 failed debug rounds, the first confirmed working voice dispatch (02:27:12, verbatim):

> "Hey Microoft, I need you to open up eight Claude Code agents."  
> [Bridge]: "One sec. Done. Eight clouds up."  
> Matt: "It did just work, guys. It did just work."

**Failure pattern documented across the stream:**
1. Onyx WASM fails to load (HTML served instead of .wasm due to wrong API shape in wasmPaths config)
2. Bridge soft-disables wake detection on any parse failure
3. Microphone routing: stream capture mic conflicts with wake-word capture
4. ~5s initialization delay required after panel load before wake phrase is valid

**Tool used for debugging:** Cursor with Composer 2.5 (not Bridge/Claude Code). Matt opens Cursor separately, pastes the bug description into Composer 2.5 chat, and Composer runs autonomous file exploration, log analysis, and applies a targeted fix. The debugging context is transferred manually: Matt reads the Bridge/terminal logs, pastes the relevant excerpt into Cursor's chat. Cursor then finds the exact line: "ORT WASM fails because wasmPaths uses the wrong API shape — v1.26 expects `{wasm, mjs}`, not filename keys."

**Handoff pattern:** BridgeSpace logs → copy/paste → Cursor/Composer 2.5 → fix applied → back to BridgeSpace for retest. This cross-tool handoff is manual, not automated.

---

### STEP 8 — Benchmark as Parallel Background Workload (~00:04–02:41)

**Tool:** BridgeBench V2 (custom internal benchmark suite) + sub-agents per category  
**Screenshot:** `10_cursor-composer-debugging-wake-word_t8200s.jpg` (~t=8200s, Cursor session)

From the very first minutes, Matt kicks off a full BridgeBench V2 run for Qwen 3.7 Max by typing one Bridge prompt: "Launch sub-agents to benchmark this on each of the BridgeBench categories." Each category (design arena, debugging, refactoring, speed, reasoning, UI lava-lamp, game coding) gets its own agent. The benchmark runs for ~2h 37m in the background while all other work proceeds.

Results are reviewed at 02:41. Matt checks the BridgeBench front-end URL directly in the browser and narrates the scores live. The "post results to X" task is then delegated back to Bridge: "deployed and make a post on X." Frame `10_cursor-composer-debugging-wake-word_t8200s.jpg` captures the Cursor Composer 2.5 session — the only moment the workflow leaves BridgeSpace entirely.

---

### STEP 9 — Agent Quality Regression Detection & Revert (~02:33–02:58)

**Tool:** Claude Code agent (Opus 4.7) — negative example  
**Screenshot:** `12_final-multi-agent-grid-seo-task-and-drag-drop_t11400s.jpg` (~t=11400s)

When a Claude Code (Opus 4.7) agent is tasked with improving the Bridge system prompt, it returns a degraded result — strips formatting and codebase references. Matt recognizes this in under 30 seconds of reading:

> "That got worse. Look at this prompt — what we had before was better. It had references, it had formatting. Now that's not there."

**Revert flow attempted:** "I need you to undo the changes you made in this conversation." Claude Code reports "Nothing further to undo" — the rewind feature fails. Matt is forced to manually examine the diff and request a surgical revert to the specific changed lines. A separate agent (visible in frame 12) reads the current file state and re-applies the pre-change content.

**Key decision:** Matt does NOT discard the agent loop — he sends a correction prompt and re-dispatches. Total time to detect + revert + re-dispatch: ~8 minutes.

---

### STEP 10 — Final Feature Verification & Stream Close (~03:06–03:11)

**Tool:** BridgeSpace drag-and-drop + Bridge agent  
**Screenshot:** `12_final-multi-agent-grid-seo-task-and-drag-drop_t11400s.jpg` (~t=11400s)

Matt's closing demo is the drag-and-drop feature — the one organically discovered in Step 5 and now fully implemented. He performs it live:

1. Opens a Claude Code terminal working on SEO improvements
2. Drags the terminal header chip into Bridge chat
3. Types: "I need you to assist me in improving the SEO of the BridgeMind UI website."
4. Bridge sees the attached terminal, dispatches to the correct Claude Code session

> "Just drag and drop it. It attaches that agent and then it's able to work with it. That's like a very core goal that we have for BridgeSpace 4."

The dev server runs, the feature works end-to-end. Verification is live, manual, and visual — there is no automated test suite run on stream.

---

## Typical Build-Cycle Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MATT'S BUILD CYCLE (Day 181)                     │
│                                                                     │
│  [1] IDEA / PROBLEM                                                 │
│      Verbalized out loud to stream chat                             │
│      Average: ~30s from observation to articulation                 │
│         │                                                           │
│         ▼                                                           │
│  [2] BRIDGE CHAT PROMPT (natural language)                          │
│      Tool: Bridge agent (Grok 4.1 fast default)                     │
│      No formal spec; no doc; verbal → chat                          │
│         │                                                           │
│         ▼                                                           │
│  [3] BRIDGE DISPATCHES SUB-AGENTS                                   │
│      Tool: Bridge tool calls → Claude Code / Codex spawn            │
│      Fan-out: 2–8 agents per task, all parallel                     │
│      Context: workspace snapshot auto-attached                      │
│         │                    │                    │                 │
│         ▼                    ▼                    ▼                 │
│    Agent A              Agent B              Agent C                │
│  (review)            (implement)           (brainstorm)             │
│         │                    │                    │                 │
│         └──────────┬─────────┘                    │                 │
│                    ▼                              │                 │
│  [4] MONITOR VIA TASKS PANEL + TERMINAL READ      │                 │
│      Matt scrolls Bridge tasks panel              │                 │
│      Drags terminal chip → Bridge for status      │                 │
│      No polling; agents push completions          │                 │
│                    │                              │                 │
│                    ▼                              │                 │
│  [5] OUTPUT REVIEW (< 60s decision time)          │                 │
│      Read terminal output directly                │                 │
│      OR ask Bridge "what are these agents doing?" │                 │
│      Accepts recommendation → next goal           │                 │
│      Rejects → correction prompt → re-dispatch    │                 │
│                    │                              │                 │
│                    ▼                              │                 │
│  [6] VERIFICATION (manual / live / visual)        │                 │
│      Run dev server                               │                 │
│      Interact with the running feature            │                 │
│      No automated tests run on stream             │                 │
│                    │                              │                 │
│         ┌──────────┘                              │                 │
│         ▼                                         │                 │
│  [7] LOOP: new observation → back to [1]          ◄────────────────┘│
│                                                                     │
│  PARALLEL TRACK (always running):                                   │
│      BridgeBench agents → background benchmark                      │
│      Results reviewed when flagged complete                         │
│                                                                     │
│  ESCAPE HATCH (when Bridge/Claude fails):                           │
│      Switch to Cursor + Composer 2.5                                │
│      Manual copy/paste of logs as context                           │
│      Apply fix → return to BridgeSpace                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tool Usage Summary Per Stage

| Stage | Primary Tool | Model | How Context Passes |
|-------|-------------|-------|-------------------|
| Goal articulation | Voice / stream chat | — | Verbal → Bridge chat typed prompt |
| Codebase survey | Bridge agent | Grok 4.1 fast | Auto workspace snapshot |
| Sub-agent dispatch | Bridge tool calls | Claude Max (Opus) default | Auto-attached capsule |
| High-effort tasks | Bridge → Claude Code w/ GPT-5 | GPT-5 "extra high" | Manual model picker |
| Output monitoring | Tasks panel + terminal drag-drop | — | Drag chip → Bridge chat |
| Wake-word feature | BridgeVoice (XAI Whisper + Onyx WASM) | — | Audio → STT → Bridge |
| Voice dispatch confirmed | Bridge voice → tool call | — | Wake phrase → parsed intent → spawn |
| Bug debug (wake word) | Cursor + Composer 2.5 | Composer 2.5 Fast | Manual log copy/paste |
| Prompt engineering | Claude Code agent | Opus 4.7 | Plan-handoff capsule schema |
| Benchmark | BridgeBench sub-agents | Per-category routing | Bridge kick-off; background run |
| Verification | Manual in-app interaction | — | Live visual; dev server run |
| Revert | Claude Code rewind (failed) → manual | — | Diff review + correction prompt |

---

## Key Workflow Observations

**Cadence:** A typical build cycle on stream runs 15–25 minutes from idea to verified (or rejected) result. The Jarvis settings UI goal (00:20→00:36) is representative: idea verbalized, Bridge dispatched, 2 agents running, initial output reviewed, correction prompt sent, all within ~16 minutes.

**Context density:** The workspace snapshot auto-attachment is the most important invisible workflow step. Matt never manually assembles context for sub-agents — Bridge injects the terminal buffer state, agent roster, and workspace tree automatically into every dispatched prompt.

**No planning phase:** Matt does not write specs, tickets, or design docs before dispatching agents. The plan-handoff capsule architecture (Step 6) is proposed BY an agent and discussed, but it is not yet the default path — agents are still dispatched with free-form Bridge prompts throughout the stream.

**Failure handling:** When an agent regresses quality (Opus 4.7 system prompt worsening), Matt detects it in under 30 seconds of visual scan, does not retry blindly, and switches to a correction-prompt pattern. When the in-product rewind fails entirely, he escalates to manual diff review — a hard fallback that signals the rewind feature is not production-reliable.

**Voice as UI layer, not driver:** Voice dispatch works intermittently and is aspirational rather than primary. The confirmed working example (8 agents spawned by voice, 02:27) is celebrated specifically because it is rare. All reliable dispatches during the stream are via typed Bridge chat.

**Drag-and-drop as workflow inflection:** The organic discovery of terminal drag-and-drop context injection mid-stream immediately reshapes Matt's working method. Within minutes of discovering it, he is using it for every status check and task dispatch for the rest of the session. This pattern — discover a workflow primitive while working, immediately absorb it — is a signature of the livestream development style.

---

## Screenshots Index

| File | Timestamp | What It Shows |
|------|-----------|---------------|
| `01_workspace-overview-and-initial-agent-dispatch_t100s.jpg` | ~00:01:40 | Full BridgeSpace grid: 8 terminals, Bridge sidebar, "open 6 codex agents" prompt sent |
| `02_agent-output-review-and-codebase-survey_t900s.jpg` | ~00:15:00 | Agent returns full Bridge harness architecture review in terminal |
| `03_goal-verbalized-new-agent-spawned-for-settings-ui_t1500s.jpg` | ~00:25:00 | Bridge chat shows new goal dispatched; agent confirms "Sent. That agent's on the settings work." |
| `04_multi-agent-task-tracking-panel_t2000s.jpg` | ~00:33:20 | Tasks panel "In Progress" populates; Bridge chat log shows multi-step dispatch loop |
| `05_wake-word-debug-agent-diagnoses-onyx_t2500s.jpg` | ~00:41:40 | Agent output details Onyx WASM root causes and 5-point fix list; Whisper wake-word edge cases |
| `06_drag-drop-terminal-context-shipped-diff_t3600s.jpg` | ~01:00:00 | Claude Code terminal shows shipped diff: terminal chip drag-and-drop wired end-to-end |
| `07_drag-and-drop-in-use-bridge-sees-terminal_t5800s.jpg` | ~01:36:40 | Bridge chat: drag chip used live; Bridge summarizes two agents' active work |
| `08_plan-handoff-capsule-before-after-diagram_t6200s.jpg` | ~01:43:20 | BEFORE/AFTER prompt pipeline diagram in terminal; plan_handoff struct shown |
| `09_agent-prompt-best-practices-doc-in-terminal_t7400s.jpg` | ~02:03:20 | Agent-produced prompting best-practices: 4-step discipline, anti-hallucination guard, shape-matching rules |
| `10_cursor-composer-debugging-wake-word_t8200s.jpg` | ~02:16:40 | App switches to Cursor; Composer 2.5 debugging session shown with log analysis table |
| `11_cursor-composer-fix-and-repro-steps_t9200s.jpg` | ~02:33:20 | Composer 2.5 returns 7-step repro checklist; "Review +7702 -347, Create Branch & Commit" visible |
| `12_final-multi-agent-grid-seo-task-and-drag-drop_t11400s.jpg` | ~03:10:00 | Final state: 4 Claude Code panes active, Bridge "Listening for Hey Bridge", drag-drop SEO dispatch |
