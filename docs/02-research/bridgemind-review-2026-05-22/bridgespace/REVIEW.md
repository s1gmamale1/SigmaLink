# BridgeSpace 3 — Full Competitive Review
**Source**: "Vibe Coding With BridgeSpace 3" (18:05), BridgeMind YouTube channel
**Reviewed by**: SigmaLink research agent
**Date**: 2026-05-22

---

## Product Summary

BridgeSpace 3 is a macOS/Windows/Linux Electron app from BridgeMind — the direct competitor to SigmaLink. It is a multi-pane, multi-agent coding environment marketed as an "ADE" (Agent Development Environment). Version 3 is their biggest release to date (claimed) and shipped with a Product Hunt launch. The creator reports $90k ARR at time of filming, 167 days into public building.

**Headline workflow**: One workspace → pick N terminals → assign a model per terminal → optionally orchestrate via Bridge Agent (side panel) or launch a structured BridgeSwarm (role-based multi-agent). Everything runs in a SINGLE shared directory. No per-pane isolation. The workspace has three embedded panels beyond terminals: an in-app browser, an IDE/file tree, and the new BridgeDesign click-element tool.

---

## Per-Feature Breakdown

---

### 1. Workspace Launcher — Three Modes

**Screenshot**: `01_workspace-launcher-3modes_t265s.jpg` (~t265s)

**What's shown**: A modal "Build the future" chooser with three options: BridgeSpace (traditional pane grid), BridgeSwarm (structured multi-agent with roles), and BridgeCanvas (alpha, not shown in detail).

**Integration note (SigmaLink — Command Room)**: SigmaLink's workspace launch is already a PTY-per-pane flow. The three-mode concept maps cleanly onto SigmaLink: Command Room = BridgeSpace, SigmaSwarm = BridgeSwarm, no Canvas equivalent exists. Consider surfacing this three-way choice as a first-screen modal on workspace creation instead of always landing in Command Room. Effort: **S** (UI modal only).

---

### 2. Workspace Setup Wizard (Folder + Terminal Count Picker)

**Screenshot**: `02_workspace-setup-wizard_t266s.jpg` (~t266s)

**What's shown**: Step 1 of 3 wizard: working folder path selector, terminal count slider (1/2/4/6/8/10/12 options), and preset buttons (e.g., "BridgeMind", "Test 2", etc.). The presenter notes: "no other ADE does this" (quick presets).

**Integration note (SigmaLink — Command Room)**: SigmaLink already has a workspace concept. The gap is the **preset system**: a named workspace template (e.g., "8 Claude agents on my-project") that can be one-click re-launched. This is purely a UX add on top of the existing workspace model. Effort: **S**.

---

### 3. Agent Picker Per Terminal

**Screenshot**: `03_agent-picker-per-terminal_t282s.jpg` (~t282s)

**What's shown**: Step 2 of 3 wizard: for 2 terminals, a table listing BridgeCode, Claude, Codex, Gemini, OpenCode, Cursor, Droid, Copilot — each with a count selector per terminal plus distribution modes (Enable all / One of each / Split evenly / Clear). Also a "Custom Command" row.

**Integration note (SigmaLink — Command Room)**: SigmaLink already supports this exactly — pane-level agent selection (claude/codex/gemini/kimi/opencode). The "distribution mode" presets (one-of-each, split-evenly) are a small UX touch SigmaLink lacks. Effort: **S**.

---

### 4. Pane Grid — Agent Headers

**Screenshot**: `04_pane-grid-agents-headers_t262s.jpg` (~t262s)

**What's shown**: A 2x2 grid of Claude Code panes. Each pane header shows: agent name ("Claude Code v2.1.116"), model tier ("Opus 4.7 (1M context) with high effort — Claude Max"), and working directory ("~/Desktop/bridgemind"). Below each pane, a status bar shows a colored badge and "auto mode on".

**Integration note (SigmaLink — pane header)**: SigmaLink pane headers already show agent + worktree path. The missing piece is surfacing the **model tier / context size** string in the header (e.g., "Opus 4.7 · 1M · high"). This is purely a display string from the agent process. Effort: **S**.

---

### 5. Bridge Agent (NEW in V3) — Workspace Orchestrator Panel

**Screenshot**: `06_bridge-agent-panel_t269s.jpg` (~t269s)

**What's shown**: A right-side panel titled "BRIDGE" with a chat interface. The user types (or voice-dictates): "Hey there Bridge, I want you to launch four more Codex agents, four more Claude code agents, and two Open Code agents." Bridge replies confirming 10 agents are up. It then receives a second prompt to orchestrate all agents to build a React Native Expo app, and Bridge autonomously writes individual prompts to each terminal — referencing actual codebase files — without the user typing into any terminal.

Key capability: Bridge Agent has codebase context + workspace tool access. It can:
- Spawn new terminals
- Write prompts into each agent
- Monitor agent output
- Respond to follow-up user instructions

**Integration note (SigmaLink — new "Sigma Agent" meta-pane)**: This is the single biggest gap. SigmaLink has Ruflo MCP and hooks infra, but no human-facing orchestrator chat panel embedded in the Command Room. Implementing a "Sigma Agent" pane that:
1. Has read access to all pane output streams
2. Can inject prompts into any pane via existing hooks infra
3. Provides a chat UI similar to Bridge Agent

...would close this gap. The backend hooks are already there (hooks_worker-dispatch, hooks_route). The work is building the frontend panel and wiring it to pane input APIs. Effort: **L**.

---

### 6. Notification System (NEW in V3)

**Screenshot**: `04_pane-grid-agents-headers_t262s.jpg` (visible as completed pane badge)

**What's shown**: When an agent pane completes, a sound plays ("little ding") and a badge lights up on the pane. The user can also "jump to pane" from a different workspace via a notification shortcut.

**Integration note (SigmaLink — notifications)**: SigmaLink already ships notifications with sound (v1.13.1). The "jump to pane" deeplink from notification is a small addition — clicking the notification should focus the specific pane that completed, not just the workspace window. Effort: **S**.

---

### 7. BridgeSwarm V3 — Roster Wizard

**Screenshots**: `07_swarm-roster-wizard-step1_t323s.jpg`, `08_swarm-roster-5agents_t324s.jpg` (~t323-324s)

**What's shown**: A multi-step wizard:
- **Step 1 (Roster)**: Quick-preset buttons (5=Squad/10=Platoon/15=Division/20=Max). Then a per-role table: Coordinator (1), Builder (2), Scout (1), Reviewer (1). Each role has a model selector (BridgeCode/Claude/Codex/Gemini/OpenCode/Cursor/Droid/Copilot) and a count. Roles can be added/removed.
- **Step 2 (Mission)**: Plain text mission description box — "Describe what you want this swarm to build or fix. This is shared with all agents as their mission brief."
- **Step 3 (Skills/Rules matrix)**: A grid of toggles organized by category — WORKFLOW (Incremental Commits, Minimum Aware, Refactor Only), QUALITY (Test-Driven, Code Review, Documentation, Security Audit, DIY Principle, Accessibility), OPS (Keep CI Green, Migration Safe), ANALYSIS (Performance). These are behavioral guardrails injected into agent context.
- **Step 4 (Directory)**: Choose working directory for the swarm.

**Integration note (SigmaLink — SigmaSwarm roster)**: SigmaSwarm is SigmaLink's roster concept. The gap is the **wizard UX**: SigmaLink likely spawns agents without a guided wizard. Copying the roster preset system (Squad/Platoon etc.) and the skills-matrix toggles would elevate SigmaSwarm UX significantly. The skills matrix is especially useful — those toggles translate to CLAUDE.md / system prompt injections. Effort: **M**.

---

### 8. BridgeSwarm Agent-to-Agent Chat (Visible Log)

**Screenshots**: `11_swarm-agent-to-agent-chat_t330s.jpg`, `12_swarm-task-complete-msg_t330s.jpg` (~t330s)

**What's shown**: A CHAT tab in the swarm view showing all agent-to-agent messages in a feed. Coordinator 1 → Scout 1 (assign task), Scout 1 → Coordinator 1 (task complete, findings posted), Builder 1 → Coordinator 1 (task complete, assets created), etc. The user can also message any specific agent or "All Agents" from a dropdown at the bottom.

**Integration note (SigmaLink — SigmaSwarm)**: SigmaLink's agent comms happen via Ruflo MCP SendMessage. The gap is **visibility** — users cannot see the inter-agent message stream. A SigmaSwarm "Chat" tab showing the message bus in real-time would be valuable. The underlying data exists in Ruflo's memory/messaging layer. Effort: **M**.

---

### 9. BridgeVoice — "Jarvis" Voice Commands

**Screenshot**: `13_bridgevoice-jarvis-command_t363s.jpg` (~t363s)

**What's shown**: A full-screen branded card (dark blue gradient) showing: `"Jarvis, spin up a 4-terminal workspace with Claude."` with an audio waveform and caption "Command by voice." Voice commands can spawn workspaces, write swarm missions, and message coordinators. Used throughout the video to dictate all prompts.

**Integration note (SigmaLink — SigmaVoice)**: SigmaLink ships SigmaVoice (bundled Whisper, v0.2.0). The gap is **named-agent / wake-word routing**: BridgeVoice routes voice to workspace actions (spawn terminals, start swarm) and to specific agents. SigmaVoice is transcription-only today. Adding a voice action router — "Sigma, open 4 panes with Claude" → triggers Command Room pane spawn — would close this gap. The transcription layer is already built. Effort: **M**.

---

### 10. Embedded Browser Panel

**Screenshot**: `14_embedded-browser_t297s.jpg` (~t297s)

**What's shown**: A resizable browser panel (right side of workspace) showing OpenRouter.ai. The presenter clicks a terminal link and it opens directly in the in-app browser. Multiple browser tabs supported (BridgeMind.ai, OpenRouter, localhost:3000, etc.). The browser panel is collapsible/expandable.

**Integration note (SigmaLink — new embedded-browser pane)**: SigmaLink has no embedded browser. This is a significant quality-of-life gap. When agents output localhost URLs (dev servers), users currently alt-tab to an external browser. An embedded Chromium webview pane (Electron's `<webview>` or BrowserView) that intercepts terminal link clicks would close this gap. Effort: **M**.

---

### 11. BridgeDesign — Click-to-Select HTML Element Tool (NEW in V3)

**Screenshots**: `15_bridgedesign-select-element_t390s.jpg`, `16_bridgedesign-html-analysis_t391s.jpg` (~t390s)

**What's shown**: In the browser panel, a "Design" mode enables click-to-select on any DOM element. Clicking an element captures its HTML + CSS context. A prompt panel appears: user types "I want you to review this and gain a complete understanding of the div element here in the animation." On submit, the element HTML is sent to a new Claude instance. The agent can also receive drag-and-dropped files (e.g., the generated MP4 video) with "replace that animation with this video." A model selector dropdown lets the user target Claude, Codex, Gemini, or OpenCode.

**Integration note (SigmaLink — new design-pane feature)**: SigmaLink has no equivalent. This is a "BridgeDesign-lite" that SigmaLink could implement as an optional mode on the embedded browser pane: enable a DevTools overlay, select element → auto-capture selector + outerHTML + computed styles → append to the active pane's next prompt. No separate pane needed, just a mode toggle. Effort: **L**.

---

### 12. Embedded IDE Pane — File Tree + Code Viewer

**Screenshot**: `17_embedded-ide-pane_t393s.jpg` (~t393s)

**What's shown**: A full IDE panel with a file tree on the left (showing the bridgemind-ui project structure), a code editor on the right (RouteGuard.tsx open). Clicking a filename reference in a terminal output opens that file directly in the IDE. Users can create/edit files. The presenter notes he hates context-switching to VS Code or Cursor.

**Integration note (SigmaLink — IDE pane, W-8)**: SigmaLink shipped the IDE/editor pane with per-pane worktree file browsing (W-8). This is DIRECTLY equivalent. SigmaLink's W-8 is feature-parity or ahead here, with the critical advantage that each SigmaLink IDE pane browses its OWN worktree branch — BridgeSpace shows a single shared codebase. This is a **SigmaLink edge**.

---

### 13. Built Mobile App — React Native Expo (Agentic Output Demo)

**Screenshots**: `18_mobile-app-welcome_t393s.jpg`, `19_mobile-app-dashboard_t393s.jpg` (~t393s)

**What's shown**: iOS Simulator showing the BridgeMind mobile app built entirely by Bridge Agent in one session. Welcome screen: "Build the future" with BridgeMind logo, "Start Shipping" CTA. Dashboard: "Welcome back" / Pro plan badge / Actions grid (Terminal, Kanban, Workspace, Swarm, Canvas, Bridge). Auth worked with real API. The presenter notes actions aren't wired yet — planned for V4.

**Context**: The app was built in a SINGLE shared directory by Bridge Agent orchestrating multiple Claude/Codex instances. No per-agent branch isolation — all agents wrote to the same directory simultaneously.

---

### 14. Pricing

**Screenshot**: `20_pricing-page_t397s.jpg` (~t397s)

**What's shown**: Basic $16/mo · Pro $40/mo · Ultra $80/mo (annual, 20% off). V3 launch promo: code "V3" = 50% off forever → Pro effectively $25/mo. Pro includes BridgeMCP, BridgeVoice, BridgeCode (coming soon). Ultra adds 25k credits/mo, priority AI routing, dedicated support, team seats (coming soon).

---

## Edges Table: SigmaLink vs BridgeSpace

| Dimension | SigmaLink | BridgeSpace 3 | Verdict |
|---|---|---|---|
| **Per-agent isolation** | Per-pane git worktree (branch per pane) | Single shared directory for all agents | **SigmaLink wins** — zero merge conflicts, safe parallel work |
| **Agent CLI coverage** | Claude / Codex / Gemini / Kimi / opencode | Claude / Codex / Gemini / OpenCode / Cursor / Droid / Copilot | Slight BS edge (Cursor, Droid, Copilot) |
| **Shell-first PTY (W-4)** | Yes — crashed agent → live shell, no orphaned pane | No equivalent shown | **SigmaLink wins** |
| **IDE pane + worktree browsing** | Yes — W-8, per-pane worktree | Single shared project file tree | **SigmaLink wins** on isolation; BS parity on feature |
| **Slash-command injection (W-5)** | Yes — skills tab injects prompts | No equivalent shown | **SigmaLink edge** |
| **Embedded browser** | No | Yes — full in-app Chromium browser | BS wins |
| **Orchestrator meta-agent (chat panel)** | No (Ruflo MCP infra exists, no UI) | Yes — Bridge Agent with codebase context + spawn tool | BS wins |
| **Agent-to-agent visible chat log** | No visible log | Yes — BridgeSwarm CHAT tab | BS wins |
| **Swarm roster wizard** | SigmaSwarm roster (no wizard UX) | Guided wizard with presets + skills matrix | BS wins on UX |
| **Voice commands** | SigmaVoice transcription (Whisper, bundled) | BridgeVoice with workspace action routing ("Jarvis, spin up…") | BS wins on routing; SigmaLink wins on bundled/offline |
| **Click-to-select design tool** | No | Yes — BridgeDesign HTML element picker | BS wins |
| **Notification + jump-to-pane** | Sound + notification (v1.13.1) | Sound + jump-to-pane deeplink | BS slight edge |
| **Pricing** | (internal) | Basic $16 / Pro $40 / Ultra $80 annual | — |

---

## Leapfrog Ideas: Worktree-Aware Swarm

### SigmaSwarm + Per-Pane Worktrees = No Merge Conflicts

BridgeSpace's fatal architectural flaw: all agents in BridgeSwarm write to the **same directory**. In the video, Builder 1 and Builder 2 both work on the same codebase simultaneously. This is a race condition — two agents can write conflicting changes to the same file, corrupting work or producing broken merges silently.

SigmaLink's per-pane worktree architecture eliminates this entirely:

```
SigmaSwarm run:
  Coordinator (pane 1, worktree: main)
  Builder A   (pane 2, worktree: feat/component-X)
  Builder B   (pane 3, worktree: feat/api-auth)
  Scout       (pane 4, worktree: research/readonly)
  Reviewer    (pane 5, worktree: review/merge-check)
```

Each agent owns its branch. When done, the Coordinator (or the user) does a structured merge/PR. No file-system conflicts possible during parallel work. This is architecturally impossible in BridgeSpace without a fundamental rewrite.

**Marketing angle**: "SigmaSwarm: the only multi-agent system where agents can't step on each other's code." This is a durable, un-copyable edge (BridgeSpace would need to rebuild their workspace model to match).

**Implementation detail**: The SigmaSwarm wizard should, at swarm launch time:
1. Create a git worktree per builder/scout role (coordinator stays on main)
2. Store worktree path in each pane's metadata
3. Auto-inject the branch assignment into each agent's initial prompt
4. Provide a "merge to main" action in the Coordinator pane context menu

Effort: **M** (worktrees already created per pane; needs swarm-aware auto-assignment logic).

---

## Top 7 Integration Recommendations (Value/Effort Ranked)

| Rank | Feature | SigmaLink Module | Effort | Value |
|---|---|---|---|---|
| 1 | **Sigma Agent meta-pane** (orchestrator chat panel with codebase context + pane-prompt injection) | New panel in Command Room | L | Critical — closes biggest competitive gap |
| 2 | **Visible inter-agent message log** (SigmaSwarm CHAT tab showing Ruflo MCP SendMessage stream) | SigmaSwarm UI | M | High — makes swarm activity transparent and debuggable |
| 3 | **Embedded browser pane** (Electron BrowserView/webview, intercepts terminal link clicks) | New pane type | M | High — daily friction for all users with dev servers |
| 4 | **SigmaSwarm wizard UX** (roster presets + skills-rules matrix → CLAUDE.md injections) | SigmaSwarm roster | M | High — lowers barrier to swarm adoption |
| 5 | **Voice action routing** ("Sigma, spawn 4 panes with Claude" → Command Room action) | SigmaVoice | M | Medium-high — SigmaVoice transcription already built; routing layer is incremental |
| 6 | **Workspace launch presets** (named one-click workspace templates) | Command Room | S | Medium — pure UX win, low effort |
| 7 | **BridgeDesign-lite** (browser pane DevTools overlay → click element → append to active pane prompt) | Embedded browser pane (depends on #3) | L | Medium — impressive demo feature; requires #3 first |

---

## Confidence Notes

- All feature observations sourced from direct frame inspection (55 frames reviewed) + transcript (full 18:05).
- Agent header model strings ("Opus 4.7, 1M context, high effort") read from uni_004.jpg / uni_005.jpg pane headers.
- Skills matrix toggles (Test-Driven, Code Review, Security Audit, etc.) read from uni_017.jpg/uni_018.jpg/uni_019.jpg.
- BridgeDesign element-picking behavior confirmed by transcript (t692-730) + frames uni_030/uni_031.
- Mobile app dashboard actions (Terminal/Kanban/Workspace/Swarm/Canvas/Bridge) read from uni_036.jpg.
- Pricing confirmed from both uni_040.jpg (annual: Basic $16/Pro $40/Ultra $80) and uni_040.jpg showing V3 launch promo (50% off, Pro = $25).
- "Single shared directory" architectural finding: confirmed by transcript ("Bridge Space app in workspace root" — single root for all agents), corroborated by the workspace setup wizard showing one folder for N terminals. No evidence of per-agent branches at any point.
- BridgeCanvas: only glimpsed in the mode picker (uni_002/uni_003); labeled "Alpha" — not demonstrated in video.
- BridgeCode (mentioned as "coming soon" on Pro plan pricing page): not demonstrated.
