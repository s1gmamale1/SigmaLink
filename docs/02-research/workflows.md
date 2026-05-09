# BridgeSpace / BridgeSwarm — End-to-End User Workflows

Step-by-step workflows extracted from the four BridgeMind videos. Each step lists the implied UI element name (from the glossary) and cites the source video. Sources: **L** (launch), **V3** (BridgeSpace 3), **G54** (GPT 5.4 swarm test), **AT** (Agent Teams).

Notation: `[click]` = mouse, `[type]` = keyboard text entry, `[voice]` = BridgeVoice / BridgeJarvis dictation, `[drag]` = drag-and-drop, `[wait]` = passive observation.

---

## W1. Launching a Bridge Space (multi-pane isolated agents) — V2 launch flow

Source: L 01:24 → 01:55, with V3 refinements at V3 00:34 → 02:00.

1. `[click]` the **`+` button** in the workspace tab strip → "Start a new workspace" dialog appears.
2. (V3 only) Choose workspace type: **Bridge Space** | **Bridge Swarm** | **Bridge Canvas**. Pick **Bridge Space**.
3. **Set the project directory.** Two options:
   - `[type]` shell path: `cd ~/Desktop/bridgemind` (or similar).
   - `[click]` the directory picker button to navigate via the OS file dialog.
4. **Choose the number of terminal sessions** (1–16). Cap is **16** [L 01:38].
5. **(Optional) Apply a workspace preset.** Example preset: "4 Claude code agents", which fills the roster with 4 Claude panes in the chosen directory in a single click [V3 00:48].
6. For each pane, **assign a provider** from the picker: `Codex | Claude | Gemini | OpenCode | Cursor | Droid | Copilot | (custom command)`.
7. `[click]` **Launch this workspace** → the workspace tab boots, each pane runs its provider's CLI splash and waits for input.

Result: a workspace tab that contains *N* independent terminal panes, each running a different agent in the same directory. Each pane has its own header with status dot · folder icon · agent label · branch indicator (`branch dev`) · close `x`.

---

## W2. Launching a BridgeSwarm — original (V2) flow

Source: L 02:30 → 03:50.

1. (Same entry: `[click] +` then pick **Bridge Swarm**, or use **`⌘T`**.)
2. **Give the swarm a mission prompt.** [voice] or [type], e.g.: *"I want this swarm to be able to identify any security vulnerabilities and fix them."*
3. **(Optional) Upload supporting context** to the swarm's brain: PDFs, images, any files. [L 02:35] Demonstrated as skippable.
4. **Set up the Agent Roster.**
   - Pick a **preset**: `Squad (5)` | `Team (~10)` | `Platoon (15)` | … up to `50 agents`.
   - Or provision manually.
5. **Per-role provider assignment.** For each role pool, pick a provider:
   - `Coordinator → Codex` (recommended in L)
   - `Builder → Claude` (recommended in L)
   - `Scout → Gemini` (recommended in L)
   - `Reviewer → Codex` (recommended in L)
6. `[click]` **Launch swarm** → swarm boots; the **Operator Console** (right panel) shows agents already messaging each other.

Result: a Bridge Swarm workspace tab with N agents wired together. The right-hand chat panel shows live agent-to-agent traffic; the operator can DM any agent or all agents.

---

## W3. Launching a BridgeSwarm — V3 flow (additional fields)

Source: V3 05:48 → 08:00, G54 03:36 → 06:20.

1. `[click]` `+` or `[key]` `⌘T` → choose **Bridge Swarm**.
2. **Swarm name.** [type], e.g. *"marketing video"*, *"flight simulator"*, *"chat app"*, *"D3 chat"*.
3. **Goal / mission prompt.** [voice or type]. Supports `@` mentions to bind a target project (e.g. `@BridgeSpace Tauri`).
4. `[click]` **Next** → **Agent Roster** screen.
5. Choose roster (preset or custom). For each role assign a provider; default model varies (e.g. Codex defaults to `GPT 5.4 fast` in G54).
6. `[click]` **Next** → **Directory** screen. `cd` (or pick) the project folder for the swarm.
7. (Optional) Add **Supporting Context** (URLs, GitHub repo, PDFs).
8. `[click]` **Launch swarm**.

Result: same as W2, plus per-role message-count totals are visible later in the Operator Console.

---

## W4. Driving a swarm from the Operator Console

Source: L 00:36 → 01:15, V3 09:00 → 11:13, G54 12:50 → 14:15.

1. Once the swarm is running, the **Operator Console** appears in the right panel (or as a tab).
2. The console exposes:
   - Per-agent address-book lanes: `coordinator 1`, `builder 1`, `builder 2`, `scout 1`, `reviewer`, etc.
   - A global "all agents" lane.
   - Live inter-agent message stream.
   - Per-role message-count totals (e.g. *"112 messages — coordinator 47 / reviewer 3 / builder 22"*).
3. **Send a directive to one agent**:
   - `[click]` agent lane → `[type]` message → submit. Example: *"What is your current status? Make sure you finish up. I am ready to test."*
   - The target's pane shows `Operator to <agent>: …` and the agent reacts.
4. **Send a directive to coordinator** for whole-swarm orchestration. Example used: *"Check with all agents to confirm the job is complete."* The coordinator then issues a roll call to every agent and aggregates statuses back to the operator.
5. **Iterative correction**: in V3, the operator DMed coordinator 1 with style feedback (*"not a fan of the unprofessional gradients … review the theme and styling … make it more modern and darker themed … copy the video over to my downloads"*); the coordinator re-dispatched to builders.

---

## W5. Using the Bridge agent (V3) for autonomous orchestration

Source: V3 02:00 → 05:48.

1. Open a **Bridge Space** workspace (some agents already launched).
2. `[click]` the right-hand side-panel tab labelled **Bridge** (sits beside Browser and IDE tabs).
3. `[voice or type]` prompt directly to Bridge. Example: *"Hey there, Bridge. I want you to launch four more Codex agents, four more Claude code agents, and two Open Code agents."*
4. Bridge launches the requested agents in the same workspace (no further user clicks).
5. Issue a higher-level engineering prompt. Example used in V3: *"I now need you to orchestrate these agents to all work together so that they are able to build a new app called Bridge Space app, which is going to be a React Native Expo app that uses Native Wind … This app needs to interface with the Bridge Mind API … help me build out the initial UI and functionality … initial styling, branding, welcome screen, login flow, dashboard."*
6. Bridge **per-agent prompts** the workers automatically, **with file references** discovered from the workspace (e.g. *"Match Bridge Mind UI Tailwind config and Bridge Mind UI lib theme file."*). The user does not write per-agent prompts.
7. Agents work in parallel; the **notification ding** plays as each completes; **Jump to pane** focuses the relevant pane.

---

## W6. Using the Visual Design Tool (V3)

Source: V3 11:30 → 13:24.

1. Open the right-hand **Browser** tab; navigate to a rendered page (e.g. `bridgemind.ai`).
2. Activate the **Design Tool** mode.
3. `[click]` an HTML element on the rendered page (marquee/hit-test overlay highlights it).
4. In the prompt box, choose target provider (`Claude | Codex | Gemini | OpenCode`).
5. `[type or voice]` a prompt scoped to the selected element. Example: *"Review this and gain a complete understanding of the div element here in the animation that's inside of it."*
6. `[click]` Submit → a new agent instance spawns with the element's context.
7. (Optional) `[drag]` an asset (e.g. `.mp4`) onto the selected element + prompt: *"Replace that animation with this marketing video in the project."* The agent edits the codebase and the live page updates.
8. Re-select another element and submit a removal prompt: *"Remove this."*

---

## W7. Reading source files via the integrated IDE (V3)

Source: V3 13:24 → 14:21.

1. Run an agent in any pane (Bridge Space or Bridge Swarm).
2. When the agent prints a file path in its terminal output, `[click]` the path.
3. The file opens in the **right-hand IDE tab** (a slim editor inside BridgeSpace).
4. Navigate other files by clicking other paths or by browsing in the editor.
5. Create new files via the editor's "new file" affordance to keep the operator out of VS Code / Cursor.

---

## W8. Running multiple swarms in parallel

Source: G54 03:36 → 12:35.

1. Repeat W2/W3 several times — each `⌘T` opens a new BridgeSwarm tab.
2. Demonstrated tabs: 5 concurrent swarms (`Next.js SaaS`, `Browser FPS game`, `Flight simulator`, `Chat app`, `D3`).
3. Switch between them via the workspace tab strip at the top of BridgeSpace.
4. The agent count pill on each tab updates with that swarm's roster size (visible pattern in launch thumbnail).
5. Operator Console for each is independent.

---

## W9. Voice-driven workflow (BridgeVoice + BridgeJarvis)

Source: V3 throughout, G54 implied.

1. Hold/press the BridgeVoice trigger and speak the prompt (works in any prompt input — Bridge agent, swarm mission, Design Tool, Operator Console DM).
2. Voice transcribes into the active prompt box.
3. Submit normally.

(Distinction between BridgeVoice and BridgeJarvis isn't fully clarified verbally; current best understanding: **BridgeVoice = STT engine** (Pro), **BridgeJarvis = a higher-level voice assistant that takes actions** (Basic+). Both are mentioned together with no separation of UI in the videos pulled.)

---

## W10. Adjusting Claude Code effort inside a BridgeSpace pane

Source: AT 02:25 → 03:30.

1. In a Claude pane, type `/model` (Claude Code's own slash command).
2. Pick **Opus 4.6** (default recommended).
3. Choose effort: **low | medium | high**.
4. The pane displays `Opus 4.6 with high effort` in the splash on next start. (Visible verbatim in launch thumbnail.)

(This is Claude Code's UX, not BridgeSpace's, but it's how the visible splash strings are produced.)

---

## W11. Pricing / sign-up workflow

Source: L 04:08 → 04:35, V3 16:16 → 18:00.

1. Visit `bridgemind.ai`.
2. Pick **Basic ($20/mo)** or **Pro**.
3. At checkout, enter coupon `launch20` (20% off, original launch) or `V3` (50% off forever, V3 launch).
4. Download BridgeSpace (macOS stable; Windows beta).
5. Sign in with the BridgeMind account.

---

## Relationship cheatsheet

```
BridgeMind (account / billing)
  └── BridgeSpace (desktop ADE app)
        ├── Workspace tab — Bridge Space   (N panes, isolated agents)
        ├── Workspace tab — Bridge Swarm   (N agents, coordinated, roles)
        │     └── Operator Console (DM lanes, message totals, swarm chat)
        ├── Workspace tab — Bridge Canvas  (V3, scope unclear)
        ├── Right-hand panel tabs: Bridge agent | Browser | IDE
        └── Voice surfaces: BridgeVoice (STT) + BridgeJarvis (assistant)
```
