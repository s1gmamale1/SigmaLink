# BridgeMind / BridgeSpace / BridgeSwarm — Video Frames Log

Chronological inventory of every visible UI state captured from public BridgeMind videos and thumbnails. Source-of-truth markers:
- **[V]** = visually confirmed from a video frame, screenshot, or thumbnail rendered in this pass
- **[T]** = stated in spoken transcript only (not visually confirmed here)
- **[T+V]** = both transcript + visual confirmation

The body of the videos themselves was not pulled (yt-dlp produced caption + thumbnail only — no frame extraction without ffmpeg in this environment). Visual claims marked **[V]** come from thumbnails saved under `docs/02-research/thumbnails/` and from the small storyboard tile embedded in yt-dlp's metadata. Where a UI state is described in the transcript but no thumbnail covers it, only **[T]** is given.

---

## Video 1 — "Introducing BridgeSpace | The Agentic Development Environment of the Future"

- **URL**: https://youtu.be/RG38jA-DFeM
- **Channel**: BridgeMind  (https://www.youtube.com/channel/UCwaTGE53GLGC3fDClVl_7TA)
- **Title (full)**: Introducing BridgeSpace | The Agentic Development Environment of the Future
- **Length**: 275 s (4 min 35 s)
- **Upload date**: 2026-03-10
- **Views (capture time)**: 18,870 / Likes 324
- **Transcript files**:
  - `docs/02-research/transcripts/launch-video-RG38jA-DFeM.txt` (clean prose)
  - `docs/02-research/transcripts/launch-video-RG38jA-DFeM.en.vtt` (timestamped VTT)
  - `docs/02-research/transcripts/launch-video-RG38jA-DFeM.en-orig.vtt` (auto-cap original)
  - `docs/02-research/transcripts/launch-video-RG38jA-DFeM.info.json` (yt-dlp metadata)
  - `docs/02-research/transcripts/launch-video-description.txt`
- **Thumbnail files**: `thumbnails/launch-video-RG38jA-DFeM.webp`, `thumbnails/launch-video-RG38jA-DFeM-1080p.jpg`
- **YouTube chapters** (from JSON):
  - 00:00–00:20 Officially Launching BridgeSpace
  - 00:20–01:12 BridgeSwarm Live: Agents Coordinating in Real Time
  - 01:12–01:23 I Built BridgeSpace Using BridgeSpace
  - 01:23–02:03 BridgeSpace Workspaces: Mix Claude, Codex and Gemini
  - 02:03–02:28 BridgeSwarm Deep Dive: Coordinators, Builders, Scouts and Reviewers
  - 02:28–03:03 Real-World Demo: Security Vulnerability Swarm Task
  - 03:03–03:52 Setting Up Your Agent Roster
  - 03:52–04:03 Watching the Swarm Come to Life
  - 04:03–04:35 Pricing, Launch Discount and How to Get Started

### Frames / UI states

**Thumbnail (key art) — composited promo, but contains real UI elements [V]**
- macOS-style window, traffic-light buttons (red / yellow / green) at extreme top-left.
- Top tab strip across the window. Three tabs visible left-to-right:
  - `[folder-icon] Workspace 1   [pill]5[/pill]`
  - `[folder-icon] Workspace 2`
  - `[folder-icon] Workspace 3   [pill]12[/pill]   [x close]`
  - Followed by a `+` button to create a new tab.
  - Active tab uses lighter-grey fill; inactive tabs are darker.
  - The number pills (5, 12) appear to indicate *agent count in that workspace*.
- Right end of top bar: settings/gear icon, then a stylised lightning-bolt monogram (the BridgeMind brand mark, blue/cyan over dark).
- Below the tab bar, the canvas is a **4-column terminal grid**. Each cell has its own header bar with:
  - Left: a small status dot, a folder icon, and an agent label such as `Agent X`, `Agent 2`, `Agent 3`, `Agent 4`. The first row uses these short labels; later rows in the grid use the full path `/Users/matthewmiller/Desktop/br…` truncated.
  - Right of header: a `branch` glyph (`ⵎ` style) with the text `dev`, then a small `x` to close that pane.
- Each terminal pane shows a Claude Code splash:
  - Pixel-art crab/critter icon (orange-pink) in the left margin.
  - Right of icon, text: `Claude Code v2.1.72` (bold), `Opus 4.6 with high effort`, `Claude Max`, `~/Desktop/bridgemind`.
  - Prompt line below: `matthewmiller@Mac-Studio bridgemind % cl` then wrapped `aude` (the user is typing the command `claude`).
- Middle of frame is occupied by a portrait of the founder ("Matthew Miller" per the path) and a glowing "4-pane app icon" (rounded-square dark icon with four white panels arranged 2×2, each panel showing 2-3 horizontal bars — this is the official BridgeSpace product icon). The glow behind the icon is amber/gold + cyan/blue.
- Burned-in title text "BRIDGESPACE IS LIVE" in a bold sans-serif, with "BRIDGESPACE" in a cyan→blue gradient and "IS LIVE" in white with black outline.

**00:00 – 00:20 — Officially Launching BridgeSpace [T]**
- VO: "Bridgepace is the agentic development environment of the future. After 145 days of vibe coding an app until I make a million dollars, Bridgemind is officially launching Bridgepace."
- Claim: BridgeSpace lets builders "ship code at the speed of thought".
- (No new UI described in this segment beyond the hero shot.)

**00:20 – 01:12 — BridgeSwarm Live demo [T+V partially via thumbnail glow]**
- Narration explicitly enumerates the active swarm composition:
  - **2 coordinators**, **5 builders**, **1 reviewer**, **2 scouts** — total 10 agents.
- A **"side chat"** panel is on screen showing inter-agent messages:
  - Quoted message: "My coordinator 10 sent a message to builder 3."
  - User can type into the chat to address the swarm or any specific agent.
  - Demonstrated by sending coordinator 1 the message: *"Check with all agents to confirm the job is complete."*
  - Coordinator 1 then replies in the chat with a roll-call line: *"Operator wants confirmation from all agents that the job is complete. Please reply with your status."*
  - After collecting responses coordinator 1 reports: *"This job is now complete."*
- Implied UI: an **Operator Console** chat sidebar with the current user labelled **operator**, a per-agent message log, and the ability to direct-message any role/index pair (e.g. `coordinator 1`, `builder 3`).

**01:12 – 01:23 — "I built BridgeSpace using BridgeSpace" interstitial [T]**
- Verbal claim only.

**01:23 – 02:03 — Creating a BridgeSpace workspace [T]**
- The presenter walks through the workspace-creation flow:
  1. "Navigate into whatever project directory I want" — the dialog has a directory picker. Demoed by `cd`-ing into `bridgemind`.
  2. "Pick how many clawed agents or codeex agents I want."
  3. **Hard cap stated: "you can launch up to 16 terminal sessions"**.
  4. "Select which agents you actually want to use inside of this workspace."
  5. Picks the mix: **2 codecs (Codex), 1 Gemini, 1 Cursor agent** (4 panes total).
  6. Clicks **Launch this workspace**.
- BridgeSpace = workspace of *isolated* agents (each in its own terminal pane).

**02:03 – 02:28 — BridgeSwarm intro [T]**
- Verbal contrast: "with bridespace you're working with isolated agents whereas with bridgewarm you're actually creating a swarm of AI agents that are able to coordinate with one another."

**02:28 – 03:03 — Real-world swarm demo prompt [T]**
- Voice prompt to the swarm: *"I want this swarm to be able to identify any security vulnerabilities and fix them."*
- New panel: **support / knowledge upload** — "you can upload PDFs, images, anything that you want in the swarm's brain." (Skipped in demo.) → suggests a "Swarm Brain" / context-pack uploader.

**03:03 – 03:52 — Agent Roster setup [T]**
- A roster screen is opened.
- **Roster presets** stated: "you can choose presets between 5 agents or 50 agents."
- Per-role provider assignment:
  - Coordinators → Codex ("codex has very good coordinator capabilities").
  - Builders → Claude ("Claude is able to write code incredibly well").
  - Scouts → Gemini.
  - Reviewers → Codex.
- Click **Launch swarm** → swarm of 5 boots.

**03:52 – 04:03 — Watching the swarm come to life [T]**
- A **right-hand panel** shows the agents already coordinating with each other.
- Quoted in-swarm message: *"this builder 2 asks the operator, 'How are you feeling?'"* (agents can address the operator unprompted).
- Narration: "you can actually see what's going on in the behind the scenes here."
- Implied UI: same Operator Console chat as in the launch swarm.

**04:03 – 04:35 — Pricing CTA [T]**
- Basic plan = **$20 / month** to BridgeMind, includes BridgeSpace.
- Launch coupon: **`launch20`** for **20% off** ("for a limited time").
- CTA: `bridgemind.ai`.

---

## Video 2 — "Vibe Coding With BridgeSpace 3"

- **URL**: https://www.youtube.com/watch?v=xKf0B6AEo9I
- **Title**: Vibe Coding With BridgeSpace 3
- **Length**: 1085 s (≈ 18 min 5 s)
- **Upload date**: 2026-04-22
- **Transcript files**:
  - `transcripts/vibe-coding-bridgespace-3-xKf0B6AEo9I.clean.txt`
  - `transcripts/vibe-coding-bridgespace-3-xKf0B6AEo9I.en.vtt`
  - `transcripts/vibe-coding-bridgespace-3-xKf0B6AEo9I.info.json`
- **Thumbnail files**: `thumbnails/vibe-coding-bridgespace-3-xKf0B6AEo9I.webp` and `…-1080p.jpg`
- **YouTube chapters**:
  - 00:00–00:34 Intro: BridgeSpace 3 is Live on Product Hunt
  - 00:34–02:00 Setting Up a Workspace & Launching Claude Code/Codex Presets
  - 02:00–03:00 Meet "Bridge": The Autonomous Orchestration Agent
  - 03:00–05:48 Building a React Native App with OpenCode & Nativewind
  - 05:48–08:00 Bridge Swarm V3: Multi-Agent Marketing Video Generation
  - 08:00–11:13 Watching AI Agents Communicate & Delegate Tasks
  - 11:13–13:24 The New Built-In Browser & Visual Design Tool
  - 13:24–14:21 Seamless Workflow: The New Integrated IDE
  - 14:21–15:34 Live Test: The AI-Generated BridgeSpace Mobile App
  - 15:34–16:16 Milestone: Hitting $90,000 ARR in 167 Days of #BuildInPublic
  - 16:16–18:05 Pricing, Plans & Exclusive 50% Off Code (V3)

### Frames / UI states

**Thumbnail [V]**
- Two visual elements:
  1. **The BridgeSpace product icon (left)**: dark rounded-square icon, four white panels in a 2×2 grid, each panel showing 2–3 horizontal bars. Strong amber-orange glow on the left side of the icon, deep blue glow on the right side. Radial dark background.
  2. **Swarm grid panel (right)**: a wide dark "macOS-window-style" rectangle (rounded 8–12 px corners, thin amber/orange-to-blue glow border). Contents: a **4-column × 4-row grid of small agent cards**. Each card has a header line (~6-8 chars: "Agent…" + version number) and a small pixel-art crab icon (Claude Code mascot) plus 2-3 lines of dim grey text. Below each card is a 1-line status/log line. This is *the BridgeSwarm Operator Console / Command Room view* showing 12+ agents at once.
- Burned-in copy: "VIBE CODING WITH" (white) and "BRIDGESPACE 3" with letter-by-letter gradient (B-R-I-D-G-E in amber/orange → S-P-A-C-E in steel-blue → "3" in vivid blue).
- Founder hoodie has a small lightning-bolt monogram badge (cyan→amber gradient) on the chest — same mark as in the launch video's top-right corner.

**00:00 – 00:34 — Intro: V3 on Product Hunt [T]**
- "Bridge Space 3 is now live on Product Hunt." Daily-driver claim.

**00:34 – 02:00 — Workspace creation flow (V3) [T]**
- Click the **`+` button** in the top tab bar → "start a new workspace".
- New-workspace dialog now offers **THREE workspace types**:
  1. **Bridge Space** (multi-terminal isolated agents)
  2. **Bridge Swarm** (coordinated agents)
  3. **Bridge Canvas** (new in v3, not deeply explored in this video)
- Picks Bridge Space.
- Workspace setup pane:
  - Either type a `cd` path or **use the UI to navigate** to a folder (file-picker).
  - Number-of-terminals slider/selector.
  - "Presets" button — "no other ADE does this." Example preset: **"4 Claude Code agents"** in chosen directory, one click to launch.
- Agent provider picker for each pane. Confirmed providers (V3):
  **Codex, Claude, Gemini, OpenCode, Cursor, Droid, Copilot**, plus "custom commands".
- Demoes mix: **1 Codex + 1 Claude** in the `bridgemind` directory.

**02:00 – 03:00 — "Bridge" agent + right-hand utility tab [T]**
- A **right-hand tab** in the workspace contains three things, switchable by tab:
  1. A **browser** ("anytime I can just collapse this or expand this … you can also drag it" → resizable splitter).
  2. An **IDE** ("see what's going on in the code base").
  3. The **Bridge agent** (NEW in V3): "this agent has complete access to your workspace. It has context to your code base, it has context to what's going on inside of each agent, and it also has tools which we've built custom into the bridge agent so that it's actually able to take actions on your behalf, and it can even prompt agents for you."
- Voice prompt to Bridge: *"Hey there, Bridge. I want you to launch four more Codex agents, four more Claude code agents, and two Open Code agents."* → Bridge goes off and launches all 10 agents in the workspace without further user input.

**03:00 – 05:48 — Building a React Native app via Bridge orchestration [T]**
- Voice prompt expanded to ~10 lines: build a React Native Expo app with NativeWind, follow BridgeMind UI theme/styling, integrate with BridgeMind API and dispatch to BridgeSpace Tauri desktop app, build welcome + login + dashboard.
- Bridge dispatches per-agent prompts ("Assigning tasks. Swarm task. They're planning and building Bridge Space principles now.").
- New V3 feature shown: **notification system** — a "ding" sound when an agent finishes; a toast/badge.
- New V3 feature: **"Jump to pane"** action — when you're in another workspace, you can jump straight to the pane that just finished.
- Bridge prompts the agents *with file references*. Quoted prompt issued by Bridge to one Codex agent: "create new React Native Expo app called Bridge Space app in workspace root. Match Bridge Mind UI, Bridge Mind UI Tailwind config, and then the Bridge Mind UI lib theme file. Use Native Wind in it with welcome screen."

**05:48 – 08:00 — Bridge Swarm V3 (new harness) [T]**
- Used to build a marketing video using Hyper Frames (a Remotion-like framework).
- Roster: launches a **squad (5 agents)** = "a coordinator, a builder, a scout, and a reviewer" (1 coordinator + 2 builders + 1 scout + 1 reviewer assumed from later messaging UI).
- Per-role provider assignment for this swarm:
  - Coordinator → Claude
  - Builder → Codex
  - Scout → Codex
  - Reviewer → Claude
- "Next" button → **Swarm Mission** input page.
  - Voice-prompt the mission via BridgeVoice (`@BridgeSpace Tauri` mention syntax for the target project).
  - Stated "supporting context" upload step (links, GitHub repo URLs, PDFs).
- "Next" → directory `cd` for the swarm.
- Swarm name field. Demo names: *"marketing video"*, *"chat app"*, *"flight simulator"*, *"D3 chat"*, *"browser FPS game"*.
- **Launch swarm** button.

**08:00 – 11:13 — Operator Console / chat-with-swarm view [T+V (via thumbnail panel)]**
- Once swarm launches: the **Operator Console** UI appears.
- "You can message the coordinator, builder one, builder two, scout one, or the reviewer." → there is a **per-agent address book** in the console (each agent has its own chat lane plus a global "Operator → all" lane).
- A **chat tab** shows behind-the-scenes inter-agent messaging.
- Coordinator-1 issues sub-tasks (one per agent) e.g. "Task one: review the Hyper Frames framework" to scout 1. Confirm-on-completion messages flow back: scout 1 → coordinator 1 "task one is complete. It posted a code base report in scout one board section."
- Each agent has a "**board section**" — a dedicated artefact drop zone. Example phrase: "scout one board section."
- Quoted swarm output: builder 1 created `Bridge Space Tauri marketing video Hyper Frames assets directory with the logo and screenshots folder`.
- **Direct intervention**: user can DM coordinator 1 with revisions ("not a fan of the unprofessional gradients … review the theme and styling … make it more modern and darker themed … copy the video over to my downloads"). The coordinator's terminal then shows `Operator to coordinator one: …` and re-dispatches to the rest of the swarm.

**11:13 – 13:24 — Built-in browser + Visual Design Tool [T]**
- Any link in any agent terminal is **clickable** → opens inside a BridgeSpace-internal browser tab (multiple browser tabs supported in parallel, demoed `bridgemind.ai`, `openrouter.com`, X).
- New **Design Tool** (V3): on a rendered web page, you can **select an HTML element** with a marquee/click overlay, then issue a prompt about it; the prompt routes to a chosen agent.
  - Per-prompt agent picker: choose **Claude / Codex / Gemini / OpenCode** as the executor.
  - Prompt example issued via Design Tool: *"I want you to review this and gain a complete understanding of the div element here in the animation that's inside of it."*
  - **Drag-and-drop** asset support: drop an MP4 into the chat to associate it with the previously selected div ("now want you to replace that animation with this marketing video in the project").
  - Demoed deletion ("I need you to remove this") removes a UI element from the live page after the agent edit completes.

**13:24 – 14:21 — Built-in IDE [T]**
- The right-hand "IDE" tab is wired into terminal output: when an agent prints a file path, you can **click the path** and the file opens in the BridgeSpace editor.
- File tabs across the editor; ability to create/add files. Functions like a slim VS Code/Cursor.
- Stated motivation: avoid context-switching out to VS Code/Cursor.

**14:21 – 15:34 — Test of the AI-generated mobile app [T]**
- Welcome screen copy demonstrated: *"Build the future, the Vibe coding platform for builders who ship at the speed of thought."*
- Sign-in screen → email continue → dashboard showing the user's BridgeMind plan ("pro plan rendered in") and *available actions* (`Swarm`, others). Some actions are non-functional "shipping in V4."
- App was built using the integrated Bridge agent.

**15:34 – 16:16 — Milestone callout [T]**
- ARR claim: **$90,000 ARR**, day 167.

**16:16 – 18:05 — Pricing screen (V3) [T]**
- Plan list shown:
  - **Basic plan** — 5,000 credits/month; BridgeMind account; access to BridgeSpace; access to multi-agent swarms; access to the **BridgeJarvis voice assistant**.
  - **Pro plan** — 12,500 credits/month; everything in Basic + **BridgeMind MCP** + **BridgeVoice** (voice-to-text).
- Coupon code **`V3`** = **50% off forever** at checkout (limited).
- Net price example: $10/mo for first 3 months on basic.

---

## Video 3 — "Testing GPT 5.4 With Agent Swarms In BridgeSpace"

- **URL**: https://www.youtube.com/watch?v=0UDqnhsy4GA
- **Length**: 1385 s (≈ 23 min)
- **Upload date**: 2026-03-06 (4 days *before* the official launch video — i.e. swarms predated the launch announcement; this video calls them an existing feature shipped "yesterday")
- **Transcript files**:
  - `transcripts/swarm-test-gpt54-0UDqnhsy4GA.clean.txt`
  - `transcripts/swarm-test-gpt54-0UDqnhsy4GA.en.vtt`
  - `transcripts/swarm-test-gpt54-0UDqnhsy4GA.info.json`
- **Thumbnail files**: `thumbnails/swarm-test-gpt54-0UDqnhsy4GA.webp` and `…-1080p.jpg`
- **YouTube chapters**:
  - 00:00–02:40 Intro: GPT 5.4 Release & Benchmark Breakdown
  - 02:40–03:36 The Game Changer: GPT 5.4 "Fast Mode" Explained
  - 03:36–04:30 Launching Agent Swarms in BridgeSpace
  - 04:30–06:20 Swarm Test 1: Building a Next.js SaaS Dashboard
  - 06:20–09:12 Swarm Test 2 & 3: Browser FPS Game & Flight Simulator
  - 09:12–09:50 Swarm Test 4: Real-Time Chat App ("The Legion" Swarm)
  - 09:50–12:35 Swarm Test 5: Interactive D3.js Data Dashboard
  - 12:35–14:15 Reviewing the Agent Operator Console & Intervening
  - 14:15–16:50 Why I Am Switching Back to GPT for Vibe Coding
  - 16:50–23:05 The Final Results: UI Generation & SaaS Review

### Frames / UI states

**Thumbnail [V]** (composite — partly illustrative, but the agent topology graphic is on-brand)
- Black background.
- Left: stylised OpenAI flower mark (white outline).
- Right: **agent-graph diagram** — central hexagonal node labelled `COORDINATOR — Lead Agent` with a small crown glyph; connected by glowing teal/mint lines (with bright dot endpoints) to **eight peripheral hexagonal nodes**, each labelled `BUILDER — Swarm Agent` with a hammer glyph. The hexagonal node fills are dark navy with mint-green stroke; lines glow turquoise. **This is the on-brand BridgeSwarm topology illustration.**
- Burned-in copy: "Testing GPT 5.4 With Agent Swarms" in white sans-serif.

**00:00 – 02:40 — Benchmark intro [T]**
- (No BridgeSpace UI in this segment — talking-head + browser benchmarks.)

**03:36 – 04:30 — Launching Agent Swarms (Operator Console reveal) [T]**
- Quoted: "I am now over inside of Bridgepace … where you are able to manage AI coding agents at scale."
- Stability note: "shipped on Mac OS … there's a couple of bugs with Windows that will be fixed soon."
- New-swarm flow:
  1. Click **`+`** or hit **`⌘T`** ("command T") to launch a new BridgeSpace OR a new BridgeSwarm.
  2. Pick BridgeSwarm.
  3. Type **swarm name** (e.g. *"next SAS dashboard"*).
  4. **`cd` into directory** (`cd desktop` → `cd bridgemind` → `cd GPT54 test`).
  5. Drop a **goal prompt** into the swarm.
  6. Click **Agent roster** tab.
  7. Choose **preset OR provision manually**.
  8. Click **Launch swarm**.

**04:30 – 06:20 — Roster preset: "team" [T]**
- Demoed roster is a **"team"** preset:
  - 2× coordinator (1 lead + 1 secondary), 5× builder, 2× scout, 1× reviewer = **10 agents**.
  - All Codex, default model **GPT-5.4 fast**.
- Roster page shows hex-card UI per agent, mirroring the thumbnail's hex topology.

**06:20 – 09:12 — Swarms 2 & 3 [T]**
- **Squad** preset confirmed = **5 agents**: 1 coordinator + 2 builders + 1 scout + 1 reviewer.
- Smaller manual roster used for the flight simulator: 1 coordinator + 1 builder + 1 reviewer = 3 agents.

**09:12 – 09:50 — "Legion" preset [T]**
- **Legion** preset = **15 agents**: 2 coordinators + 7 builders + 3 scouts + 2 reviewers + (plus 1 more builder for 15).
- Quoted: "let's launch a platoon. 15 agents."
- Implication: there is also a **platoon** label (15 agents). "Legion" used colloquially for the very-large swarm. Cross-referencing the launch video's "5 or 50 agents" presets implies BridgeSpace ships at least these named tiers (verified visible: **Squad 5**, **Team ≈10**, **Platoon 15**, **Legion (≈30+ implied)**, **50-agent preset (mentioned only)**).

**09:50 – 12:35 — Multiple swarms in parallel [T]**
- Five swarms running concurrently in different tabs of BridgeSpace:
  1. *Next.js SaaS dashboard* (10-agent team, all Codex)
  2. *Browser FPS game* (squad of 5)
  3. *Flight simulator* (3 agents, custom)
  4. *Chat app / monorepo* (legion / 15 agents)
  5. *D3 chat / dashboard* (squad of 5)
- The user navigates by tab to monitor each.

**12:35 – 14:15 — Operator Console & inter-agent messaging [T]**
- Quoted message counts visible at end of each swarm run:
  - Next.js SaaS swarm: **161 messages** in ~15 min.
  - Browser FPS: not stated.
  - Flight simulator: **112 messages** total — coordinator 47 / reviewer 3 / builder 22 (+ operator messages).
  - Legion / chat-app: **157 messages** ongoing.
  - D3: **126 messages**.
- Confirms the console exposes **per-agent message totals**, with breakdown by role.
- Direct DM example to a single agent: typed *"What is your current status? Make sure you finish up. I am ready to test."* — appears in target builder's pane prefixed `Operator …`.
- Quoted target builder message back: "builder 2 hit a live overwrite on own build files after I patch package config" → shows agents send **status snippets** that the console renders.

**14:15 – 16:50 — Classic BridgeSpace layout (terminals only) [T]**
- "Let's just launch four sessions and create a new bridge space" → BridgeSpace (non-Swarm) is described as "the classic layout" — 2×2 / 4-pane terminals.
- All providers selectable: **Claude / OpenCode / Cursor / Codex** (Gemini elsewhere).
- Demoed **fast mode toggle** for Codex / GPT 5.4 right inside a terminal pane (toggle pill probably on terminal header — exact location not visible from thumbnails).

**16:50 – 23:05 — Final results review [T]**
- The user ships output by *clicking through* each generated app from inside BridgeSpace's built-in browser.
- Mentions a separate **bug bounty program** that pays in Bitcoin for reporting BridgeSpace bugs.
- Pricing: 50% off → $20→$10/mo for first 3 months.

---

## Video 4 — "Vibe Coding With Claude Opus 4.6 And Agent Teams"

- **URL**: https://www.youtube.com/watch?v=e7qct51HXpc
- **Length**: 1910 s (≈ 31 min 50 s)
- **Transcript files**: `transcripts/agent-teams-opus46-e7qct51HXpc.clean.txt` (and .vtt, .info.json)
- **Thumbnail file**: `thumbnails/agent-teams-opus46-e7qct51HXpc.webp` (uniform peach/skin-orange background, no UI shown — talking-head only).

### Frames / UI states (BridgeSpace-relevant fragments only)

- 00:24 [T]: "Right here I'm using BridgeSpace and as you can see I have **six Claude Opus 4.6 terminals** opened up in BridgeSpace. This is actually an ADE product that we are working on right now …"
- 02:25 [T]: Demonstrates `Ctrl-T` (likely `⌘-T` on Mac) opens a new workspace dialog. Picks "single" → 1-pane BridgeSpace with 1 Claude Code instance. → confirms the single-pane workspace mode in V2.
- (Most of this video is *not* about BridgeSpace; it's about Anthropic's new "agent teams" feature inside Claude Code itself. Useful only to confirm that BridgeSpace was being used as a daily driver for 6 parallel Opus terminals before V3.)

---

## Video 5 — context-only references

The clean transcript for `openclaw-strategy-141n8k-5K14.clean.txt` ("My OpenClaw Strategy Starts Today") mentions BridgeMind / BridgeMind hoodies / Mac mention but contains no new BridgeSpace UI surface; not material for this log.

Other channel videos that *probably* contain more BridgeSpace footage but were not pulled this pass (saving on rate-limit budget): "Vibe Coding With Cursor 3", "Vibe Coding With Claude Sonnet 4.6", "Vibe Coding With Opencode", "Vibe Coding With Composer 2", "Vibe Coding With Cursor Cloud Agents", "Vibe Coding With Grok 4.3 in a Full Self Driving Tesla", "5 Things I've Learned After 154 Days …", "Vibe Coding With Claude Code Desktop App", "How Claude Code Stopped A DDoS Attack", "Testing The New Claude Code Rate Limits", "Vibe Coding With Obsidian", "Vibe Coding With BridgeSpace 3" (already done), "Officially Launching BridgeVoice". A complete pull is queued in `open-video-questions.md`.
