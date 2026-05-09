# BridgeMind / BridgeSpace / BridgeSwarm Glossary

Every product noun, label, button, role name, mode name, and feature name encountered in the public videos. Each entry cites the source video and timestamp (or chapter window) where the term appears. Sources:

- **L** = "Introducing BridgeSpace" launch video — `RG38jA-DFeM` (275 s)
- **V3** = "Vibe Coding With BridgeSpace 3" — `xKf0B6AEo9I` (1085 s)
- **G54** = "Testing GPT 5.4 With Agent Swarms In BridgeSpace" — `0UDqnhsy4GA` (1385 s)
- **AT** = "Vibe Coding With Claude Opus 4.6 And Agent Teams" — `e7qct51HXpc` (1910 s)
- **D** = launch-video YouTube description (also from L's metadata)

Timestamps in `mm:ss`. When an exact second isn't recoverable from the auto-VTT, the YouTube chapter window is given.

---

## Brand & products

| Term | Definition | Source |
|---|---|---|
| **BridgeMind** | Parent brand / company. Domain: `bridgemind.ai`. Discord at `bridgemind.ai/discord`. | L 00:09, D, V3 16:30 |
| **BridgeSpace** | The Agentic Development Environment (ADE) desktop app. Cross-platform; "shipped on Mac OS, stable on Mac, Windows has bugs being fixed." Built with Tauri ("BridgeSpace Tauri" referenced in V3 03:30+). | L 00:09, V3 03:30, G54 03:36 |
| **BridgeSwarm** | The multi-agent coordination product *inside* BridgeSpace. Lets agents communicate with each other and with the operator. Different from BridgeSpace which has *isolated* agents. | L 02:03, V3 05:48 |
| **Bridge Canvas** | A third workspace type added in V3. Not deeply demoed. | V3 00:42 |
| **Bridge** (a.k.a. **Bridge agent**) | The autonomous orchestration agent introduced in V3. Has full workspace context, tools to launch/prompt other agents on behalf of the operator. | V3 02:02 |
| **BridgeVoice** | Voice-to-text tool used to dictate prompts directly into BridgeSpace. Pro-plan feature. | V3 16:35 |
| **BridgeJarvis** | A voice assistant that orchestrates agents (named separately from BridgeVoice). Basic-plan feature. Possibly an alias for the same voice stack — distinct names suggest two layers. | V3 16:30 |
| **BridgeMind MCP** | An MCP (Model Context Protocol) server included with the Pro plan. | V3 16:35 |
| **BridgeSpace V3** / **V3** | Major release marketed at the BridgeSpace 3 launch on Product Hunt. Coupon code `V3` for 50% off. | V3 entire video |
| **BridgeSpace Tauri** | Internal name for the desktop application binary; appears as a referenced project name when prompting Bridge. | V3 03:30 |
| **BridgeSpace app** | A React Native Expo mobile companion app, *built during* the V3 demo. Will dispatch actions (e.g. swarms) to the desktop BridgeSpace at V4 release. | V3 02:38 |
| **BridgeBench** | A benchmark BridgeMind publishes for ranking coding LLMs. | G54 02:35 |

---

## Workspace concepts

| Term | Definition | Source |
|---|---|---|
| **Workspace** | A top-level tab in BridgeSpace. Can be a Bridge Space, Bridge Swarm, or Bridge Canvas instance. Tabs visible in launch thumbnail: `Workspace 1`, `Workspace 2`, `Workspace 3`. | L 01:24, V3 thumbnail |
| **Agent count pill** | The numeric badge on a workspace tab (e.g. `5`, `12`) showing how many agents that workspace contains. | L thumbnail [V-confirmed] |
| **Pane** / **terminal pane** / **terminal session** | A single agent's terminal view inside a Bridge Space workspace. Up to **16 per workspace**. | L 01:38 |
| **Agent X / Agent 2 / Agent 3 / Agent 4** | Default per-pane labels in the launch thumbnail. ("Agent X" suggests a "wildcard" or "first" pane and may be the active/focused pane label.) | L thumbnail [V-confirmed] |
| **Single** | A workspace preset = 1 pane / 1 agent. | AT 02:25 |
| **Squad** | A swarm preset = 5 agents (1 coordinator + 2 builders + 1 scout + 1 reviewer). | V3 06:00, G54 chapter "squad" |
| **Team** | A swarm preset = ≈ 10 agents (2 coordinators + 5 builders + 2 scouts + 1 reviewer). | G54 04:35 |
| **Platoon** | A swarm preset = 15 agents. | G54 09:12 ("let's launch a platoon. 15 agents.") |
| **Legion** | A larger preset (or colloquial term for 15+ swarm). Likely the max named tier. | G54 09:25 |
| **50 agents** | Largest preset mentioned in the launch video. | L 03:08 |
| **Bridge Space** (workspace type, lowercase "Space") | Multi-pane workspace of *isolated* agents. Each pane runs its own CLI with no inter-agent messaging. | L 01:23, V3 00:42 |
| **Bridge Swarm** (workspace type) | Multi-agent workspace where agents *can communicate*. Each agent has a role; coordinators dispatch to others. | L 02:03, V3 05:48 |
| **Bridge Canvas** | Third workspace type, V3 only. Not deeply explained. | V3 00:42 |

---

## Roles inside a swarm

| Term | Definition / responsibility | Source |
|---|---|---|
| **Operator** | The human user. Appears as `operator` in inter-agent chat headers (e.g. *"Operator wants confirmation from all agents…"*; *"Operator to coordinator one"*). | L 01:00, V3 09:42, G54 12:50 |
| **Coordinator** | Lead agent that decomposes the swarm mission into sub-tasks and dispatches them. Identified in topology art with a **crown** glyph. Recommended provider: **Codex**. ("codex has very good coordinator capabilities" — L 03:25). Numeric naming: `coordinator 1`, `coordinator 10`, etc. | L 00:23, V3 06:05, G54 thumbnail |
| **Builder** | Worker agent that writes code. Identified with a **hammer** glyph. Recommended provider: **Claude**. Numeric naming: `builder 1`, `builder 2`, …. | L 00:25, V3 06:05, G54 thumbnail |
| **Scout** | Worker agent that does research / fact-finding / repo reconnaissance. Recommended provider: **Gemini** (L) or Codex (V3 demo). Numeric naming: `scout 1`, `scout 7`. | L 00:26, V3 06:05 |
| **Reviewer** | Worker agent that audits builders' work. Recommended provider: **Codex**. Numeric naming: `reviewer 9`. | L 00:25, V3 06:08 |
| **Lead Agent** | Subtitle on the coordinator card in the GPT 5.4 thumbnail topology graphic. | G54 thumbnail |
| **Swarm Agent** | Subtitle on the builder cards in the GPT 5.4 thumbnail. | G54 thumbnail |

---

## Operator Console & messaging

| Term | Definition | Source |
|---|---|---|
| **Operator Console** | The right-hand panel/tab where the operator chats with the swarm. Has per-agent address-book lanes plus a global "Operator → all" lane. | L 00:36, G54 12:30, V3 09:00 |
| **Side chat** | Synonym for the Operator Console chat used in the launch video. | L 00:36 |
| **Roll call** | A coordinator action: messages all agents to confirm task status. Quoted line: *"Operator wants confirmation from all agents that the job is complete. Please reply with your status."* | L 00:59 |
| **Board section** | Per-agent artefact / report drop zone. Example: *"It posted a code base report in scout one board section."* | V3 09:30 |
| **Swarm mission** | The high-level goal prompt for a swarm; entered after picking the roster. | V3 06:48 |
| **Supporting context** | Files (PDFs, images, anything) uploaded to the swarm's "brain" / knowledge pool before launch. | L 02:35, V3 07:18 |
| **Swarm's brain** | The implicit shared-context store fed by Supporting Context uploads. | L 02:35 |
| **Agent Roster** | The setup screen where roles are assigned to providers, before launching a swarm. Tab name: "agent roster". | L 02:50, V3 06:00, G54 04:30 |
| **Launch Swarm** | Button at end of roster setup. | L 03:30, G54 04:25 |
| **Launch Workspace** | Button at end of Bridge Space setup. | L 01:53 |

---

## Providers / agent backends

(Listed verbatim from the V3 provider picker.)

| Provider | Notes | Source |
|---|---|---|
| **Claude** (Claude Code) | Default mascot pixel-art crab in panes. Versions seen: `v2.1.72`. Models seen: `Opus 4.6 with high effort`, `Claude Max`. | L 03:25, AT 00:24, L thumbnail |
| **Codex** | Spelled "Codeex" / "Codex" / "codecs" by transcript ASR. Models: GPT 5.3 Codex, GPT 5.4. | L 01:36, G54 entire video |
| **Gemini** | Models referenced: Gemini 3 Flash, Gemini 3 Pro, Gemini 3.1 Pro. | L 01:48, V3 11:52 |
| **OpenCode** | Standalone CLI agent. | V3 00:50 |
| **Cursor** ("cursor agent" / "Cursor CLI") | Available as an agent in BridgeSpace. | L 01:50, V3 00:51 |
| **Droid** (Factory CLI Droid agent) | V3 00:51 |
| **Copilot** (GitHub Copilot CLI) | V3 00:52 |
| **Custom commands** | "You can also enter custom commands as well." | V3 00:53 |

---

## V3 features (introduced in `xKf0B6AEo9I`)

| Term | Definition | Source |
|---|---|---|
| **Bridge agent** | (See "Brand & products" above.) Autonomous in-workspace orchestrator. | V3 02:02 |
| **Workspace presets** | One-click presets that launch N agents of a chosen provider in a chosen directory. Example: "4 Claude code agents". | V3 00:48 |
| **Right-hand side panel** | Resizable / draggable / collapsible. Houses Browser, IDE, and the Bridge agent. | V3 02:00 |
| **Built-in browser** | Multiple browser tabs inside BridgeSpace. Any link printed by an agent is clickable to open inside this browser. | V3 11:13 |
| **Visual Design Tool** | Element-picker overlay on a rendered web page. Select an HTML element → submit a prompt → choose target provider (Claude / Codex / Gemini / OpenCode) → agent edits live. Drag-and-drop MP4/asset support onto a selected element. | V3 11:30 |
| **Built-in IDE** | Click any file path printed in a terminal pane to open it in BridgeSpace's editor. Create/add files inline. | V3 13:24 |
| **Notification system** | "Ding" sound + toast when an agent completes. | V3 03:44 |
| **Jump to pane** | Action that scrolls/focuses to the pane that just notified, even across workspaces. | V3 03:48 |
| **BridgeSwarm V3 harness** | New harness underpinning V3 swarms. | V3 05:50 |
| **Operator console** (V3 phrasing) | Same concept; the V3 console exposes per-agent DMs plus per-role message-count totals. | V3 09:00, G54 12:50 |
| **`@` mention syntax** | In-prompt mention (e.g. `@BridgeSpace Tauri`) to bind a target project to a swarm prompt. | V3 06:48 |
| **Operator → coordinator one** prefix | Prefix that appears in coordinator's pane when the operator sends them a directive. | V3 09:42 |

---

## Keyboard shortcuts

| Shortcut | Action | Source |
|---|---|---|
| `⌘T` ("command T") | Open new-workspace dialog (Bridge Space or Bridge Swarm). | G54 03:50 |
| `Ctrl T` | Same on Windows variant or used interchangeably in transcript. | AT 02:25 |

---

## Pricing

| Term | Definition | Source |
|---|---|---|
| **Basic plan** | $20/mo. 5,000 credits. BridgeMind account, BridgeSpace, multi-agent swarms, BridgeJarvis voice assistant. | L 04:08, V3 16:30 |
| **Pro plan** | (price not stated in these clips). 12,500 credits. Adds BridgeMind MCP and BridgeVoice. | V3 16:34 |
| **`launch20`** | Coupon code at launch (March 2026): 20% off. | L 04:21 |
| **`V3`** | Coupon code at V3 launch (April 2026): 50% off forever. | V3 16:24 |
| **Bug bounty (Bitcoin)** | Pays Bitcoin for reported BridgeSpace bugs. | G54 16:45 |

---

## Misc product nouns

| Term | Definition | Source |
|---|---|---|
| **ADE** | "Agentic Development Environment" — BridgeSpace's product category. | G54 03:38, AT 00:28 |
| **Vibe coding** | The narrator's preferred name for AI-assisted coding. Channel calls itself "the vibe coding movement". | L 00:06, all |
| **Agentic engineer** | A practitioner who orchestrates AI agents to build software. | L 02:55 |
| **Fast mode** | A toggle (on Codex / GPT 5.4 panes) that uses 2× usage but runs ~1.5× faster. Activated with `/fast`. | G54 02:55 |
| **Bug bounty program** | Bitcoin-paying program for reporting BridgeSpace bugs. | G54 16:45 |
| **Build in public** | Marketing posture; channel narrative arc is "vibe coding an app until I make a million dollars" (Day 145 at launch, Day 167 at V3). | L 00:05, V3 15:35 |
