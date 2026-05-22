# BridgeMind Day 181 — Functionality of Each Part Demonstrated

**Stream:** "Vibe Coding an App Until I Make $1,000,000 | Day 181"
**Duration:** 3h 12m  
**Analysis lens:** Feature-by-feature functional breakdown — what each component does, its mechanics, observed inputs/outputs, options visible, and limitations shown.

---

## Vision Check

Frame `uni_0001.jpg` confirmed readable: Matt doing push-ups on carpet with wooden-panel wall behind him. Vision available.

---

## Feature Inventory

### 1. BridgeSpace (Workspace Product)

**What it does:** Multi-pane workspace shell that hosts all sub-products. It is the primary ARR driver. Each workspace has a name (BridgeMind, BridgeMindDev, ViewCreator, Workspace 3–9 etc.) and is selected from a left-rail sidebar.

**Mechanics observed:**
- Left-rail sidebar lists all workspaces with colored dot indicators and numeric badges (counts of running agents/tasks).
- Each workspace opens a terminal-grid layout: terminals are arranged in a 3-column × 3-row or 2-column × 4-row grid depending on agent count.
- Terminal cells each show: a header bar (model info, terminal label), the live TTY scrollback, and controls (lock, split, close buttons).
- The Bridge chat panel occupies the right third of the screen at all times, always visible alongside the terminal grid.
- BridgeVoice logo appears as a persistent floating badge (bottom-left corner of workspace, labeled "BridgeVoice") when voice is active.
- Workspace badge count updates in real time as agents complete/start tasks.
- BridgeSpace 3 is the shipped version; BridgeSpace 4 is under active development with drag-and-drop terminal context as a core new feature.

**Evidence:** `01_bridgespace-workspace_t100s.jpg` (t=100s) — full workspace visible with 6 workspaces in left rail, 12 active agent count on BridgeMind workspace, Bridge chat panel on right.

**Maturity:** Shipped (BridgeSpace 3)

---

### 2. BridgeBench V2

**What it does:** In-house benchmark suite that evaluates LLM coding and reasoning capability across multiple categories. Used to rank models on a leaderboard (compared against Claude Opus, Qwen, Composer 2.5, etc.).

**Categories observed (V2):**
| Category | Test Format | What is Measured |
|---|---|---|
| Design Arena | Prompt → UI generation | Visual quality, layout accuracy |
| Debugging / "BS Bench" | Bug-finding tasks | Accuracy of bug identification and fix |
| Refactoring | Code refactor task | Quality of refactored output |
| Speed | Token throughput | Tokens per second via API |
| Reasoning | Structured reasoning task | Score on reasoning benchmark (e.g., 39.1/100 for Qwen 3.7) |
| Lava-lamp / UI Test | Generate: thunderstorm, lightning, ocean, open-sign | Visual generation accuracy; letter rendering noted as universal failure mode |
| Game Coding | Generate playable: Flappy Bird, Space Invaders, Breakout, Neon, Snake | Playability, visual quality, effects detail |
| Sweet Bench | Unspecified | Composite score |
| Hallucination | Factual accuracy test | Hallucination rate ranking |

**Mechanics observed:**
- A model is "dropped into" BridgeBench via the UI (OpenRouter model ID entered).
- Bridge agent spawns one sub-agent per benchmark category automatically: "Launch a sub agent to benchmark this on each of the Bridgebench categories."
- Results accumulate asynchronously; individual categories complete at different times.
- Results are displayed in a front-end web UI at `localhost:3005` / `bridgebench.ai`.
- Scores are displayed as numeric values on a ranked leaderboard.
- Game outputs can be full-screened for visual review.
- After run completes, agent is tasked to update the front-end and post results to X.

**Qwen 3.7 Max full results reviewed live (~02:41–02:57):**
- Speed: 120 tok/s (OpenRouter; early estimate was 45 tok/s, final corrected)
- Lava-lamp: passed thunderstorm and lightning well; ocean "interesting"; letters consistently broken
- Breakout: "really good effects" — strong performance
- Flappy Bird: "best output I've seen" — very strong
- Space Invaders: weak ("I don't like what it did")
- Music visual: "laggy"
- Snake/Neon: "actually did a pretty good job"
- BS Bench (debugging): strong
- Refactoring: weak
- Reasoning: 39.1 (rank 12 — weak)
- Hallucination: rank 10 (high hallucination rate)
- Sweet Bench: strong
- Verdict: strong on game coding and UI generation; weak on reasoning and refactoring; best Flappy Bird seen on bench

**Evidence:** `02_bridgebench-setup_t200s.jpg` (t=200s) — model queued and agents being dispatched. `17_bridgebench-snake-game-qwen_t10400s.jpg` (t=10400s) — Snake game output from Qwen 3.7 in browser at localhost/BridgeBench. `18_bridgebench-game-results_t10900s.jpg` (t=10900s) — BridgeBench results UI with score breakdown and Skills sidebar visible.

**Quote:** "What the heck? This is the best output I've seen for the Flappy Bird game. I mean, that literally is Flappy Bird." (~02:46)

**Maturity:** Shipped / live benchmark product

---

### 3. Bridge Orchestration Agent ("Jarvis" / "Bridge" / "Microoft")

**What it does:** Central AI agent embedded in the right-panel chat of BridgeSpace. It watches the workspace and autonomously dispatches tasks to coding agents (Claude Code, CodeX) without requiring manual terminal prompting.

**Mechanics observed:**

**Input methods:**
1. Text chat — type in the Bridge chat message box; prefix `@` to attach a file or terminal chip
2. Voice — wake-word trigger: "Hey Bridge" or "Hey Microoft" → Bridge enters listening mode → spoken instruction is transcribed (XAI Whisper STT) → sent to Bridge as if typed
3. Drag-and-drop terminal chip — drag a terminal's header into the chat input to inject that terminal's scrollback context as an attached chip

**Output / behavior:**
- Bridge responds in chat with a status message (e.g., "Done. Six codexes up.", "Sent. Claude's got the task.", "One sec. >> Sent.")
- Spawns Claude Code or CodeX agents directly in the workspace grid
- Sends typed prompts into specific terminal sessions on behalf of the user
- Reads terminal scrollback to summarize agent status
- Uses a **Tasks panel** (visible top-right of Bridge chat column, labeled "Tasks / IN PROGRESS") to track multi-step dispatches
- Transmission log panel sits below Tasks (visible but collapsed by default)

**Underlying model routing:**
- Default chat + tool calls: Grok 4.1 fast (non-reasoning)
- Vision tasks: Grok 4.2 reasoning
- High-effort review tasks: GPT-5 / "GBD 5.5" extra-high effort
- These are configured in BridgeMind settings, not exposed as user-facing controls

**Coordination tools confirmed working:**
- `spawn_agent` — opens new Claude Code or CodeX terminal panes
- `prompt_terminal` / `read_terminal` — submits a prompt to and reads output from a specific open terminal session
- `update_task` / `complete_task` — tracks work items in the Tasks panel
- `scroll_terminal` — fetches recent PTY buffer (confirmed via code review: 16KB cap, compacted)

**MCP:** Bridge uses a local MCP server for all tool calls; tools visible in architecture review output at t=1400s. Agent accesses CodeX and Claude Code via this local MCP.

**Limitations observed:**
- When too many terminals are open, agent occasionally fails to dispatch to the correct session
- Agent spawning intermittently fails: "Okay, it didn't open them. So, this is an issue." (~01:07)
- Voice dispatch unreliable (see BridgeVoice section)
- Prompt quality degraded when using Claude Opus 4.x to compose sub-agent prompts (see Opus regression section)

**Evidence:** `03_bridge-agent-overview_t800s.jpg` (t=800s) — Bridge chat showing multi-turn: "open 6 codex agents" → "Done, six codexes up." `04_bridge-agent-settings-plan_t1400s.jpg` (t=1400s) — Bridge chat with architecture review output; Jarvis voice orchestration architecture reviewed in detail. `08_bridge-agent-terminal-prompt_t4500s.jpg` (t=4500s) — agent prompted with "hello" successfully dispatched to attached Claude Code.

**Quote:** "So that you don't have to prompt. Okay? The sole mission of this agent is to make it so that you never even have to prompt." (~00:01:50)

**Maturity:** Shipped (BridgeSpace 3); voice dispatch in active development

---

### 4. BridgeVoice / Voice Pipeline (STT + TTS + Wake-Word)

**What it does:** Layered voice orchestration system that allows hands-free control of the Bridge agent via speech.

**Architecture (confirmed in stream):**

| Layer | Technology | Role |
|---|---|---|
| STT | XAI Whisper | Transcribes spoken input to text |
| TTS | Onyx WASM runtime | Converts Bridge text responses to audio playback |
| Wake-word detector | Custom (Whisper Flow or custom detector using BRIDGE_WAVE_STATS) | Listens continuously; triggers on phrase |
| Wake phrase | "Hey Bridge" / "Hey Microoft" | Activates listening mode |
| Activation indicator | "Listening..." badge on Bridge panel + Whisper Flow bottom bar | Shows state |

**Settings panel observed (frame `07_bridgevoice-settings-panel_t3400s.jpg`):**
The BridgeMind app settings → Bridge section exposes a "Voice Preferences" pane with the following controls:

| Setting | Value seen / Options |
|---|---|
| Voice (TTS voice) | "Rex — Male — confident, ideal for..." (currently selected) |
| Mute | Toggle — "Mute Bridge routine. Transcripts and brain still run; only TTS playback is suppressed. Toggle from the settings header any time." |
| Speaking speed | Slider: "1x — normal" (playback rate; faster speeds slightly raise pitch) |
| Speech recognition language | "Auto-detect" (primary language hint for STT; auto-detect works for most users) |
| Activation mode | Radio: "Push to talk" selected (Push-to-talk captures audio while the shortcut is held) |
| Push-to-talk key | "Not set" — user can set a key shortcut |
| Voice processing (echo/noise cancel) | Toggle — described as routing the mic through the system voice-processing unit |
| Connected indicator | Shown at bottom of settings panel |

**Whisper Flow integration:** A persistent horizontal indicator appears at the bottom of the BridgeSpace workspace when Whisper Flow is running. It has a settings toggle. The indicator shows activity state.

**Wake-word behavior (extensive debug observed across 6+ rounds):**

Intended flow:
1. User speaks wake phrase → detector fires → Bridge enters "Listening" state (badge updates)
2. User speaks command → Whisper transcribes → text sent to Bridge chat as if typed
3. Bridge agent executes command

Failure modes documented:
1. **Initialization delay (~5s):** Detector starts in a warm-up state; if user speaks immediately, the phrase is missed. Workaround: wait ~5 seconds after launching dev server before speaking.
2. **Onyx WASM soft-disable:** When TTS (Onyx runtime) fails to load or encounters a parse error, the system sets a "soft disabled" flag that prevents the detector from firing. Log: "Parsing failed. Soft disabled."
3. **Phrase conflict:** The word "bridge" in "Hey Bridge" may itself trigger the soft-disable logic in the parser. Switching to "Hey Microoft" did not fully resolve the issue.
4. **Microphone routing conflict:** Wake-word audio capture competed with the OBS stream microphone; the detector was picking up stream audio from the Studio Display microphone, causing noise. Adjusting input routing partially helped.
5. **Bug found by Composer 2.5 / Cursor:** A specific line of code in the wake-word module was identified as a bug; applying the fix introduced a second bug; neither was fully resolved during the stream.

**One confirmed successful example:** "Hey Microoft, I need you to open up eight Claude Code agents" → Bridge: "Done. Eight clouds up." (~02:27)

**Evidence:** `07_bridgevoice-settings-panel_t3400s.jpg` (t=3400s) — full Voice Preferences settings pane visible. `04_bridge-agent-settings-plan_t1400s.jpg` (t=1400s) — BridgeVoice badge floating in workspace. `14_voice-8agents-spawned_t8800s.jpg` (t=8800s) — Bridge chat showing Browser panel open with wake-word-triggered 8-agent spawn visible.

**Quote (settings description):** "Bridge keeps the mic active, Transcripts and brain still run; only TTS playback is suppressed." (~00:57:48 SRT)

**Maturity:** Beta / active development — fundamental reliability issues not resolved in stream

---

### 5. Wake-Word Feature ("Hey Bridge" / "Hey Microoft")

_(Detailed above in BridgeVoice section; additional specifics here)_

**What it does:** Hands-free trigger phrase that activates Bridge's listening mode without touching the keyboard.

**Current wake phrase:** "Hey Microoft" (changed from "Hey Bridge" during stream; "Microoft" is the name of the internal framework used by BridgeMind, not a Microsoft product reference).

**Observed input behavior:**
- User speaks phrase aloud at normal volume
- Indicator on Bridge panel switches from "Standby / Tap to activate" to "Listening..."
- A subsequent spoken command is transcribed and posted to Bridge chat

**Observed failure states (SRT-confirmed):**
- "Hey Bridge. Yeah, it's not working." (21934 SRT line)
- "Hey Microoft. Hey Bridge." — both attempted, neither fired (21914 SRT)
- "wake word just doesn't [work]" (22914 SRT)
- "parsing failed. Soft disabled." — logged multiple times

**Resolution status:** Intermittently working by ~02:27 after mic routing adjustment; not consistently reliable by stream end. Six separate debug rounds conducted. Root cause not fully fixed.

**Maturity:** Beta / broken as of stream end

---

### 6. Drag-and-Drop Terminal Context (BridgeSpace 4 Core Feature)

**What it does:** Allows a user to drag a terminal's header tile from the workspace grid and drop it into the Bridge chat input area. The terminal's scrollback content and agent identity are attached as a context chip ("chip") to the next Bridge message.

**Mechanics observed:**

**Drag target:** The header bar of any terminal pane in the workspace grid (the bar that shows terminal label, model info, and control buttons).

**Drop target:** The Bridge chat input area ("Message Bridge... type @ to attach a file").

**What happens on drop:**
- A chip is inserted into the chat input representing the terminal
- The chip carries: the terminal's recent PTY scrollback (up to 16KB, compacted), the agent session reference
- When Bridge sends the message, it can see what that terminal/agent is currently doing
- Bridge can then dispatch a specific instruction to that agent

**Pipeline (revealed by agent code review, frame `10_coding-agent-scrollback_t5700s.jpg`):**
1. Fetch: `FetchTerminalScrollback` — pulls up to 16KB from PTY buffer via `window.tauriAPI.terminal.getScrollback(sessionId, 16000)`, per-attachment, in parallel
2. Compact: strips CSI/OSC/control bytes, trims trailing whitespace, collapses blank runs, deduplicates repeated identical lines
3. Budget: keeps last 100 lines, then a hard 3500-char cap
4. Enrich: adds `scrollbackText`, `scrollbackLineCount`, `scrollbackOriginalLineCount`, `scrollbackTruncated` to each terminal entry
5. Embed: `formatAttachmentsPreamble` — under each terminal entry, a "recent activity (N of M compacted lines)" block is inserted
6. Model guidance: preamble includes instruction: "When any recent activity block is included under a terminal entry below, treat it as fresh context"
7. Hookup: `runtime.ts:composeUserMessageContent` — awaits `enrichTerminalAttachmentsWithScrollback` before building preamble; vision parts also get the enriched list

**Token cost:** ~3500 chars per terminal per turn (attachments consumed when sent, not replayed on every later turn). Single terminal adds ~875 tokens; three terminals dropped at once ~2500 tokens, vs ~10k for three round-trips.

**Graceful failure:** If terminal closed between drop and send, fetch returns null; preamble shows "no recent activity snippet available." Model can still invoke `submit_prompt/read_terminal` directly (which will fail with a helpful error).

**Demonstrated successfully:** "Tell me exactly what these two agents are working on" → Bridge correctly described both agents' current tasks after drag-drop. (~01:35)

**Roadmap position:** Explicitly named "a very core goal that we have for BridgeSpace 4" at stream close (~03:09). It was organically discovered during the stream (started as a workaround, became a centerpiece).

**Evidence:** `05_drag-drop-discovery_t2100s.jpg` (t=2100s) — multi-agent architecture review terminals open, drag-drop concept forming. `10_coding-agent-scrollback_t5700s.jpg` (t=5700s) — full code review output showing the 7-step scrollback pipeline in detail. `19_drag-drop-final-demo-bridgespace4_t11500s.jpg` (t=11500s) — final live demo showing Bridge chat with chip attached and SEO task dispatched.

**Quote:** "I'm just going to drag and drop this image in. And now it has the image." (~00:35:48); "That's like a very core goal that we have for BridgeSpace 4." (~03:09)

**Maturity:** Working prototype / BridgeSpace 4 core feature (not yet in BridgeSpace 3 release)

---

### 7. BridgeAgent Settings UI (Skills + System Prompt)

**What it does:** A settings pane (proposed to live inside the Bridge tab of BridgeSpace Settings) that allows users to customize their Bridge agent with: (a) custom skills, and (b) a custom system prompt.

**UI elements specified during stream:**
- Settings icon (gear icon) accessible from the Bridge panel
- "Bridge" tab inside the global Settings page
- **Custom skills section:** Drag-a-skill-into-a-terminal UI — a skills list with available skills (e.g., BridgeSecurity, BridgeSEO, BridgeGithub, BridgeMindMCP, BridgeObsidian) displayed in a right-rail "Skills" panel (visible at `16_skills-panel-bridgebench-running_t9700s.jpg`)
- **System prompt textarea:** Free-text field where users type a custom system prompt for their agent
- Placeholder examples given: "maybe it's like some security skills, some UI skills, etc., just as placeholders for now"

**Skills panel (observed in frame `16_skills-panel-bridgebench-running_t9700s.jpg`):**
- Header: "Skills" with count badge and "+ New" button
- Search bar: "Search skills..."
- Skills listed with category labels:
  - BridgeSecurity (SECURITY) — "Senior security-engineer instincts for any agent that reads, writes, or reviews code. OWASP Top 10, CWE Top 25, and supply-chain coverage."
  - BridgeSEO (GROWTH) — "2020/2026(A) SEO methodology for auditing and writing pages — title tags, meta, headings, structured data, Core Web Vitals, and AI-search optimization."
  - BridgeGithub (WORKFLOW) — "Universal commit-and-push methodology. Stages every local change in the current repo, writes a clean conventional commit, and pushes to the GitHub."
  - BridgeMindMCP (WORKFLOW) — "How to use the BridgeMind MCP (mcp:__bridgemind__*) effectively — projects, tasks, agents, knowledge, instructions, attachments, every task there is."
  - BridgeObsidian (visible, partially readable)
  - BridgeMemory (MEMORY)
  - User's own skills section below ("YOUR SKILLS")
  - Obsidian skill listed under user skills

- Skills can be dragged into a terminal (description: "Drag a skill into a terminal to paste it. Click to preview")

**Source of settings UI design:** Agent-proposed during the stream based on codebase review; Matt directed an agent to build it.

**Evidence:** `16_skills-panel-bridgebench-running_t9700s.jpg` (t=9700s) — Skills panel fully visible in right rail with all listed skills. `04_bridge-agent-settings-plan_t1400s.jpg` (t=1400s) — Workspace 9 active; settings architecture in Bridge chat.

**Quote:** "There should be a settings icon where users are able to click it and customize their bridge agent... custom skills, a text area for users to add their system prompt." (~00:23:42)

**Maturity:** Planned / UI prototype (Skills panel exists; custom-user system-prompt input not confirmed shipped)

---

### 8. Terminal Header Redesign

**What it does:** Cleaned up the terminal pane header bars from showing a cramped full filesystem path to a minimal "terminal" label, reducing visual noise.

**Before state (described):** Headers showed the full absolute directory path (e.g., `~/Desktop/bridgemind`) crammed into a narrow bar alongside model info, making the layout visually dense.

**After state (shown):** Header shows a short label (terminal name or just "terminal") with agent icon, model info (e.g., "Claude Code v2.1.146, Opus 4.7 (3M context) with xhigh effort, Claude Max, ~/Desktop/bridgemind"), and control icons. Visually cleaner.

**How it was built:** An agent was tasked via Bridge ("I want the [terminal to show] just terminal now") and the improvement was confirmed live in the stream.

**Evidence:** `09_terminal-header-redesign_t5000s.jpg` (t=5000s) — workspace showing updated terminal header styling with cleaner labels. Multiple terminal panes visible with "Claude Co... | bridgemind" label format.

**Quote:** "You guys see that this says it just says terminal now. That's way better. Way better styling." (~01:22)

**Maturity:** Shipped / merged during stream

---

### 9. Coding Agent Index / Live Status Display

**What it does:** A real-time status panel within BridgeSpace showing what each running coding agent is currently working on, by name and task description.

**Mechanics observed:**
- Visible in the Bridge chat's Tasks panel under "IN PROGRESS" section
- Each entry shows: agent name (e.g., "Luc") + short task description (e.g., "reviewing project — diffs across UI, admin, and web app")
- Updates in real time as agents complete tasks or start new ones
- User can drag-drop a terminal into Bridge chat and ask "Tell me exactly what these two agents are working on" to get a Bridge-generated summary

**What "Luc" represents:** Named agent worker. BridgeSpace architecture (confirmed via code review at ~00:56:53 in timeline): "Codex keeps a registry of named agent workers, each with its own thread. The UI lists them under [background tasks]. When you add an agent, the chat router sends your message to it."

**Evidence:** `10_coding-agent-scrollback_t5700s.jpg` (t=5700s) — Tasks panel visible on right side showing "IN PROGRESS: Multi-agent reviews of Bridge Jarvis architecture."

**Quote (SRT 24534):** "oh yeah, so check this out. So this is the coding agent index." (~01:35:16)

**Maturity:** Shipped (part of BridgeSpace 3)

---

### 10. Plan-Handoff Capsule (Prompt Engineering Architecture)

**What it does:** A structured prompt composition format that Bridge uses when dispatching tasks to coding agents. Replaces free-form Grok-written prose with a deterministic, runtime-composed capsule.

**Structure (agent-generated, confirmed live):**
```
goal → target files → success criteria → out of scope
```
In the agent's own words (frame `11_plan-handoff-capsule-diagram_t6100s.jpg`):
```
BEFORE:
voice → Grok writes prose → submit_prompt (one shot)

AFTER:
voice → plan_handoff (structured intent: goal, verified paths, success criteria, constraints)
      → runtime renders (template + adapter + role + context capsule)
      → submit_prompt (deterministic)
      → verify (BRIDGE_STATUS)

"The shift in one line: Grok fills a form, the runtime writes the prompt."
```

**Components:**
- `plan_handoff` tool: captures goal, ledger-verified file paths, success criteria, constraints
- Runtime: deterministically renders the plan into a per-provider, role-specialized prompt with an auto-attached context capsule and `BRIDGE_STATUS` output contract
- Context capsule: auto-attached workspace context (agent tools, codebase state, terminal contents)
- `BRIDGE_STATUS`: output contract — every agent prompt ends with a status token the runtime monitors

**Concern expressed by Matt:** "I don't want to be too specific. I don't want there to be out-of-scope restrictions." — worried over-constraining the prompt would hurt agent performance. The "out of scope" field was identified as potentially too limiting.

**Evidence:** `11_plan-handoff-capsule-diagram_t6100s.jpg` (t=6100s) — agent output showing BEFORE/AFTER diagram in terminal, Bridge Tasks panel showing 4 items IN PROGRESS. Full text of capsule spec visible.

**Quote (SRT 23384):** "authoring with a mandatory plan handoff — autoattached context capsule and bridge" (~01:41:37)

**Maturity:** Design / prototype (described as architectural direction for Bridge agent prompting in BridgeSpace 4, not yet fully wired in)

---

### 11. Terminal Info Bar (Model + Tokens)

**What it does:** Proposed feature — a horizontal or vertical information bar overlaid on each terminal pane showing the current model name and token count in use by that pane's agent.

**Source:** Proposed by a viewer ("Mute the app") in live chat at ~02:02. Matt evaluated it positively.

**Proposed specs (from stream):**
- Location: horizontal or vertical strip on each terminal pane
- Content: model name, tokens used
- Constraint: "it will not look overcrowded"
- Matt's refinement: "hover over it to show details — win space" — info hidden by default, exposed on hover

**Three-tier concept mentioned alongside:** Matt proposed that prompts should have complexity tiers, and that the terminal bar could reflect which tier is active.

**Current state:** In terminal headers as of the stream, the following IS already visible in small text: model name (e.g., "Claude Max"), version (e.g., "Claude Code v2.1.146"), context size ("Opus 4.7 (3M context)"), and effort level ("with xhigh effort"). The dedicated info bar is an enhancement of this.

**Evidence:** `13_bridge-settings-terminal-info-bar_t7300s.jpg` (t=7300s) — multi-terminal workspace showing terminal headers with model info; Bridge right panel with settings discussion. `09_terminal-header-redesign_t5000s.jpg` (t=5000s) — terminal headers showing Claude Max model name and token context detail.

**Quote (SRT 30944):** "horizontal and vertical info bar on each terminal to show all the features and it will not look overcrowded." (~02:02:15)

**Maturity:** Proposed / not built

---

### 12. BridgeSpace Architecture — Codex Agent Registry

**What it does:** Internal coordination mechanism: CodeX (the AI coding agent runtime) maintains a registry of named worker agents, each with their own thread. The Bridge chat router directs messages to registered agents by name.

**Confirmed details (~00:56:53):**
- Each agent worker: named, own thread, own context window
- UI location: "background tasks" panel (corresponds to Tasks/IN PROGRESS panel)
- Message routing: when a message is sent to Bridge mentioning an agent by name (or by chip reference), the chat router dispatches it to that agent's thread
- Supported agent types spawned: Claude Code, CodeX (OpenAI Codex), custom named agents

**Evidence:** `08_bridge-agent-terminal-prompt_t4500s.jpg` (t=4500s) — workspace with 6 Claude Code panes + 2 CodeX panes visible; Bridge chat confirming dispatch coordination.

**Maturity:** Shipped (internal architecture, not directly user-exposed)

---

### 13. Model Routing (Grok 4.1 / Grok 4.2 / GPT-5)

**What it does:** Bridge agent uses different underlying LLMs for different task types to optimize cost/quality.

**Routing table (confirmed in stream ~00:04):**
| Task Type | Model |
|---|---|
| Default chat + tool calling | Grok 4.1 fast (non-reasoning) |
| Vision tasks | Grok 4.2 reasoning |
| High-effort complex review | GPT-5 ("GBD 5.5") extra-high effort |

**User-facing control:** Not exposed directly; configured by BridgeMind developers in the Bridge harness config. Users cannot change model routing from the UI (as of stream).

**Evidence:** `03_bridge-agent-overview_t800s.jpg` (t=800s) — Bridge harness context review showing model routing config in a terminal.

**Maturity:** Shipped / internal config

---

### 14. MCP (Local) Integration

**What it does:** Bridge agent calls all its tools (spawn agent, prompt terminal, read terminal, Stripe check, etc.) via a local MCP server instance. No cloud-side tool execution.

**Confirmed behavior:**
- All CodeX and Claude Code agent access goes through local MCP
- Tools confirmed via code review include: `spawn_agent`, `prompt_terminal`, `read_terminal`, `update_task`, `complete_task`, `close_terminal`, `scroll_terminal`, `create_task`, `add_note`
- Safety/validation layer wraps tool calls before execution
- "Tool Choice Policy" (`toolChoicePolicy.ts`) determines per-turn whether to force tool use, skip it, or auto-decide

**Evidence:** `04_bridge-agent-settings-plan_t1400s.jpg` (t=1400s) — full harness architecture visible in terminal, showing local MCP binding and tool list.

**Maturity:** Shipped

---

### 15. Agent Prompt Quality Regression (Opus)

**What it does / what broke:** When Bridge uses Claude Opus 4.x to compose sub-agent prompts (generating a refined task prompt for a coding agent), the quality regressed in this stream — outputs lost structured formatting, codebase references, and specificity.

**Symptoms observed:**
- Before regression: "It would be formatted, and it had even references and stuff — and the codebase context was included."
- After regression: "Look at this prompt. What we had before was better... It's not even referencing the codebase when generating the prompt."
- Community confirmation: viewer "Lil Boots" — "Opus has been failing for me lately. It makes me sad."

**Context:** Matt attributed this to a recent Opus model update from Anthropic. The same prompts that produced structured, codebase-aware output previously now produce generic, unformatted prose.

**Impact:** Any bridge task that relies on Opus to compose a downstream agent's prompt would produce a lower-quality task prompt, reducing the effectiveness of the dispatched coding agent.

**Resolution:** Not resolved during stream. Considered switching to a different model for prompt composition.

**Evidence:** `15_opus-regression-wake-debug_t9300s.jpg` (t=9300s) — workspace with multiple Claude Max terminals showing wake-word debug output and Opus agent work.

**Quote:** "No, no, no, no, no. That got worse... I'm starting to get a little bit disappointed in Opus because this agent here, like something is not right with this." (~02:35)

**Maturity:** Known regression / unresolved

---

### 16. SEO Improvement Task (Agent-Driven)

**What it does:** Bridge agent is given a task to review the BridgeMind UI website and produce a structured SEO improvement plan.

**Mechanics:**
- Task dispatched via voice: "Hey Bridge — do a review of our SEO and create a structured plan for improvements"
- Bridge spawned an agent in "plan mode": "Done. Up in plan mode on the SEO deep dive."
- Agent reviewed the public BridgeMind website structure and generated a plan

**Issue observed:** The generated plan did not reference the codebase structure or existing implementation details. Matt rejected the output: "I am not a fan of what it did here... It's not using what we had."

**Root cause:** Same Opus prompt quality regression — agent was generating a generic SEO plan rather than a codebase-aware targeted plan.

**Evidence:** `19_drag-drop-final-demo-bridgespace4_t11500s.jpg` (t=11500s) — Bridge chat showing SEO task dispatched with Claude Code chip attached via drag-drop.

**Maturity:** Demo / work in progress

---

### 17. Claude Code Rewind Bug

**What it does (intended):** Claude Code's "rewind" / "undo" feature is intended to roll back code changes made within a conversation session, restoring files to a prior state.

**What broke:**
- Claude Opus 4.7 agent made unwanted changes ("jumbled" the code)
- User executed rewind: "I need you to undo the changes that you made in this conversation"
- Claude Code returned: "Nothing further to undo" — no changes were rolled back despite visible damage
- Developer confirmed: "I tried to rewind and it doesn't rewind. This is not — this can't happen."

**Technical behavior observed (SRT 43014):** "when I do a rewind it doesn't actually restore the code from the conversation"

**Severity:** High — described as "very frustrating"; the feature silently failed with a misleading success message.

**Resolution:** Not resolved; dev server was restarted to test state.

**Evidence:** `18_bridgebench-game-results_t10900s.jpg` (t=10900s) — approximately at the benchmark review stage, immediately before the rewind event.

**Quote (SRT 43024):** "restore the code from the conversation" — confirmed failure

**Maturity:** Confirmed bug in Claude Code (external tool, not BridgeMind code)

---

### 18. BridgeSpace 4 Roadmap (Preview)

**What it does:** The next major version of BridgeSpace, focused on making the drag-and-drop terminal context interaction the primary paradigm for agent coordination.

**Confirmed BridgeSpace 4 goals stated in stream:**
1. **Drag-and-drop terminal as context:** Drag any terminal chip into Bridge chat to inject that agent's context and dispatch tasks. (Demonstrated working in prototype during stream.)
2. **Better orchestration agent:** "Make this bridge orchestration agent way better for BridgeSpace 4."
3. **Improved prompt quality:** Fix the Opus regression; implement the plan-handoff capsule architecture as the standard dispatch method.
4. **Settings UI for Bridge:** Custom skills + custom system prompt per-user configuration.
5. **Terminal info bar:** Model name + token count per pane.
6. **Reliable wake-word:** Fix BridgeVoice reliability issues.

**Quote:** "That's like a very core goal that we have for BridgeSpace 4." (~03:09:11)

**Evidence:** `19_drag-drop-final-demo-bridgespace4_t11500s.jpg` (t=11500s) — final demo showing drag-drop working end-to-end with BridgeMind office background.

**Maturity:** Roadmap / in-progress development

---

## Summary Table

| Feature | First Demo | What It Does | Mechanics | Maturity |
|---|---|---|---|---|
| BridgeSpace (workspace) | 00:01:30 | Multi-pane workspace hosting all agents + Bridge chat | Left-rail workspaces, terminal grid, Bridge right panel | Shipped (v3) |
| BridgeBench V2 | 00:04:43 | Multi-category LLM benchmark suite | Sub-agent per category, async results, leaderboard web UI | Shipped |
| Bridge Orchestration Agent | 00:01:30 | Central AI agent that dispatches tasks to coding agents | Text/voice/drag input; spawns Claude Code/CodeX; reads/writes terminals via local MCP | Shipped (v3) |
| BridgeVoice pipeline | 00:06:36 | Voice layer: STT (Whisper) + TTS (Onyx WASM) + wake-word | Settings pane with voice, mute, speed, STT language, activation mode | Beta / broken |
| Wake-word | 00:14:44 | Hands-free trigger for Bridge agent | "Hey Microoft" → listening state → spoken command → transcribed | Beta / unreliable |
| Drag-and-drop terminal context | 00:35:30 | Inject terminal scrollback + agent ref into Bridge chat via drag | Header drag → chip in input → 7-step scrollback pipeline → Bridge-aware dispatch | Working prototype / BridgeSpace 4 core |
| BridgeAgent settings (skills + prompt) | 00:23:42 | User-customizable Bridge agent behavior | Skills panel (drag to terminal), system prompt textarea, gear icon in Bridge tab | Partial (skills panel exists; user prompt: planned) |
| Terminal header redesign | 01:22:52 | Cleaner minimal terminal label | Agent-driven UI change; header shows label + model + context info | Shipped (merged during stream) |
| Coding agent index | 01:35:18 | Real-time view of what each agent is doing | IN PROGRESS list in Bridge Tasks panel; named workers per thread | Shipped (v3) |
| Plan-handoff capsule | 01:41:37 | Deterministic structured prompt format for sub-agent dispatch | goal → target files → success criteria → out-of-scope; runtime composes from verified capsule | Design/prototype |
| Terminal info bar | 02:01:46 | Per-terminal model + token display | Horizontal/vertical strip; hover to expand; model + tokens visible | Proposed |
| Agent prompt quality (Opus regression) | 02:35:37 | Not a feature — a regression: Opus makes prompts worse after model update | Loss of formatting + codebase references in composed prompts | Known bug / unresolved |
| SEO improvement agent | 02:48:25 | Agent reviews BridgeMind website + produces SEO plan | Voice-dispatched, plan mode, codebase context expected | Demo / incomplete |
| Claude Code rewind | 03:04:11 | Not a feature — a bug: rewind fails to restore code changes | Returns "nothing to undo" silently despite visible code damage | Confirmed external bug |
| BridgeSpace 4 roadmap | 03:09:11 | Next major version focused on drag-drop coordination | Drag-drop terminal, plan-handoff, reliable voice, custom settings | Roadmap / in-progress |
| Model routing | 00:04:43 | Internal routing of different LLMs by task type | Grok 4.1 (chat), Grok 4.2 (vision), GPT-5 (high-effort) | Shipped / internal config |
| MCP local integration | 00:13:05 | Bridge tool calls go through local MCP server | All agent spawn/read/write ops via local MCP; no cloud tool exec | Shipped |
| Codex agent registry | 00:56:53 | Named worker registry with per-thread context | Chat router sends to named agent; listed in background tasks | Shipped (internal) |

---

## Screenshots Saved

All frames saved to `/tmp/bm-report/stream/screenshots/functionality/`:

| File | Timestamp | Feature |
|---|---|---|
| `01_bridgespace-workspace_t100s.jpg` | ~00:01:40 | BridgeSpace full workspace layout |
| `02_bridgebench-setup_t200s.jpg` | ~00:03:20 | BridgeBench V2 model queued, agents dispatching |
| `03_bridge-agent-overview_t800s.jpg` | ~00:13:20 | Bridge agent multi-turn: 6 CodeX spawned, Tasks panel |
| `04_bridge-agent-settings-plan_t1400s.jpg` | ~00:23:20 | Workspace 9 Bridge settings + voice architecture review |
| `05_drag-drop-discovery_t2100s.jpg` | ~00:35:00 | Drag-drop concept forming, multi-agent review terminals |
| `06_drag-drop-agents-spawned_t2200s.jpg` | ~00:36:40 | Drag-drop agents spawned, workspace with Bridge active |
| `07_bridgevoice-settings-panel_t3400s.jpg` | ~00:56:40 | BridgeVoice Settings pane — Voice Preferences fully visible |
| `08_bridge-agent-terminal-prompt_t4500s.jpg` | ~01:15:00 | Bridge chat with terminal chip attached; hello dispatched |
| `09_terminal-header-redesign_t5000s.jpg` | ~01:23:20 | Updated terminal headers showing cleaned-up labels |
| `10_coding-agent-scrollback_t5700s.jpg` | ~01:35:00 | Code review output: 7-step scrollback pipeline spec in full |
| `11_plan-handoff-capsule-diagram_t6100s.jpg` | ~01:41:40 | Plan-handoff BEFORE/AFTER diagram in agent terminal output |
| `12_bridge-voice-architecture_t7000s.jpg` | ~01:56:40 | Voice orchestration architecture detailed in terminal |
| `13_bridge-settings-terminal-info-bar_t7300s.jpg` | ~02:01:40 | Multi-terminal workspace; terminal headers + model info |
| `14_voice-8agents-spawned_t8800s.jpg` | ~02:26:40 | Browser panel + 8 Claude Code agents spawned via voice |
| `15_opus-regression-wake-debug_t9300s.jpg` | ~02:35:00 | Opus regression: wake-word debug + agent prompt output |
| `16_skills-panel-bridgebench-running_t9700s.jpg` | ~02:41:40 | Skills panel right-rail with all built-in skills listed |
| `17_bridgebench-snake-game-qwen_t10400s.jpg` | ~02:53:20 | BridgeBench Snake game output from Qwen 3.7 in browser |
| `18_bridgebench-game-results_t10900s.jpg` | ~03:01:40 | BridgeBench results UI with security benchmark running |
| `19_drag-drop-final-demo-bridgespace4_t11500s.jpg` | ~03:11:40 | Final drag-drop demo: SEO task dispatched with chip |
