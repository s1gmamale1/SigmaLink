# V3 Frame Walk — Chapter A (frames 0001–0184, ~0–360s)

Walker: v3-walker-a
Source video: https://youtu.be/xKf0B6AEo9I
Frame range: `0001.jpg` … `0184.jpg`
Markers: **[V]** visual only, **[T]** transcript only, **[T+V]** both

## Narrative arc (≤200 words)

The chapter opens on the founder talking to camera (frames 0001–0010 ≈ 0–20s), then cuts straight into the BridgeSpace 3 app to demo the **new-workspace flow**. He clicks `+`, sees three workspace types — **BridgeSpace / BridgeSwarm / BridgeCanvas** (the last marked `ALPHA`) — and picks BridgeSpace. The wizard moves through three stops shown as a progress strip: **Start → Layout → Agents**. He sets a working folder via path field with a folder-picker icon, picks a terminal-count tile (1/2/4/6/8/10/12 with grid hint), and uses **presets** ("BridgeMind", "Test 3", "Test 2", "Test"). Step 3 shows an **agent provider matrix**: BridgeCode, Claude, Codex, Gemini, OpenCode, Cursor, Droid, Copilot, plus a **Custom Command** row, with quick-fill buttons "Enable all / One of each / Split evenly". He launches 1×Claude + 1×Codex, then opens the **right-hand utility dock** (tabs: Browser / Editor / Bridge). The new **Bridge agent** chat ("Hey, I'm here. What are we working on?") receives a voice prompt to spawn 8 more agents; it does so without further input. Bridge then orchestrates the React-Native-Expo build, dispatching per-pane prompts that reference real BridgeMind UI files. Chapter ends with the workspace-type picker reopened beside the BridgeSwarm web landing page, foreshadowing Chapter B.

## Confirmed BridgeSpace V3 features (mapped to current SigmaLink)

| # | Feature [marker] | V3 location | SigmaLink status | Build implication |
|---|------------------|-------------|------------------|-------------------|
| 1 | **Workspace-type picker** with 3 cards: BridgeSpace, BridgeSwarm, BridgeCanvas (`ALPHA` pill) [T+V] | frame 0020.jpg, 0180.jpg; transcript L19–25 | partial — `features/workspace-launcher/Launcher.tsx` exists; BridgeCanvas card not yet wired | Add Canvas card behind `alpha` flag and a routed empty room; keyboard hints `⌘T/⌘S/⌘K` shown by each card |
| 2 | **Top-right utility dock** with tabs Browser / Editor / Bridge [V] | frame 0080.jpg, 0090.jpg, 0100.jpg, 0150.jpg | missing or unverified — `BrowserRoom.tsx` exists as a *room*, not as a right-side resizable dock with sibling Editor + Bridge tabs | Introduce a persistent right dock with three tabs and resizable splitter (drag handle) |
| 3 | **"Bridge" autonomous agent panel** (chat with workspace-wide tools, can spawn other agents) [T+V] | frame 0080.jpg, 0090.jpg, 0100.jpg, 0150.jpg, 0160.jpg, 0170.jpg; transcript L76–96 | missing or unverified — no `bridge-agent` feature folder | New feature `features/bridge-agent/` with chat UI, workspace-context tools, and pane-prompting capability |
| 4 | **Workspace setup stepper** (Start → Layout → Agents) [V] | frame 0030, 0035, 0040, 0055 | partial — `Launcher.tsx` exists; need to verify three-step progress UI | Render explicit step pills with checkmarks; route forward/back |
| 5 | **Working-folder field with folder-picker icon + path autocomplete** [V] | frame 0030, 0035, 0040, 0050 | missing or unverified | Native `dialog.showOpenDialog` IPC + path text field |
| 6 | **Terminal-count tile picker (1/2/4/6/8/10/12)** with hover hint *"4 terminals · 2×2 grid layout"* [V] | frame 0040.jpg | missing or unverified | Tile grid; emit `(count, gridSpec)` |
| 7 | **Workspace presets row** (BridgeMind, Test 3, Test 2, Test, NEW) — one-click roster preset [T+V] | frame 0030, 0040; transcript L40–46 | missing or unverified | Persist presets per-user; one click pre-populates wizard |
| 8 | **Agent provider matrix** (BridgeCode, Claude, Codex, Gemini, OpenCode, Cursor, Droid, Copilot) with per-row +/- counters and a `0/N` total at top [T+V] | frame 0055.jpg; transcript L51–55 | missing or unverified | Add a per-provider counter wizard step distinct from current launcher |
| 9 | **Quick-fill buttons** "Enable all", "One of each", "Split evenly" on agent step [V] | frame 0055.jpg | missing | Three macros that mutate the counters |
| 10 | **Custom Command row** + "Add custom command" button on agent step [V] | frame 0055.jpg | missing | Free-form CLI per terminal |
| 11 | **Workspace tabs in left rail** with name + status dot + agent-count pill [V] | frame 0020 onward (BridgeMind/Workspace 9/10) | partial — `features/sidebar/Sidebar.tsx` exists | Verify pill + colored status dot rendering |
| 12 | **Multi-pane terminal grid** with each pane showing Claude/Codex splash header (`Claude Code v2.1.116`, `Opus 4.7 (1M context)`, `Claude Max`, working dir) [V] | frame 0045, 0070, 0100, 0150, 0160 | partial — `command-room/Terminal.tsx` is single pane; multi-pane grid not visible | Grid layout (1/2/4/6/8/10/12) and per-pane chrome with provider splash |
| 13 | **`auto mode on (shift+tab to cycle)`** footer hint inside Claude panes [V] | frame 0045, 0050, 0070, 0100 | missing | Display Claude's own footer; or our equivalent |
| 14 | **`bypass permissions on (shift+tab)`** footer hint on Codex/OpenCode panes [V] | frame 0100, 0140, 0150 | missing | Show provider mode; pass shift+tab through |
| 15 | **`gpt-5.4 high fast · ~/Desktop/bridgemind`** prompt-bar inside Codex pane (model + speed pill, cwd) [V] | frame 0070, 0080, 0140, 0150 | missing | Per-pane status strip showing model + cwd |
| 16 | **Bridge chat shows full conversation** (user prompt + Bridge replies "Done, two more codexes…") with rounded-pill speaker labels `BRIDGE` / `YOU` [V] | frame 0080, 0090, 0100, 0150, 0160 | missing | Chat transcript styling |
| 17 | **Bridge "STANDBY" / "RECEIVING" orb** + "Tap to activate" hint when idle [V] | frame 0080, 0090, 0100 | missing | Animated orb with state machine: STANDBY → LISTENING → RECEIVING |
| 18 | **Bridge dispatches per-agent prompts visible in each pane header** (e.g. *Implement {feature}*, *Find and fix a bug in @filename*, *Run /review on my current changes*, *Write tests for @filename*) [V] | frame 0100, 0120, 0140, 0150 | missing | Bridge tool that injects a prompt into a target pane |
| 19 | **Notification system** ("ding" + completion badge on agent tabs) [T] | transcript L122–137 | missing | OS-level notification + badge counter on pane chrome |
| 20 | **"Jump to pane"** action when an agent completes from another workspace [T] | transcript L132–137 | missing | Cross-workspace deeplink action |
| 21 | **OpenCode pane chrome** (big `opencode` ASCII title, `Build · Kimi K2.6 OpenRouter`, `tab agents · ctrl+p commands` footer) [V] | frame 0100, 0120, 0140, 0160, 0170 | missing | Provider variant for OpenCode pane chrome |
| 22 | **Per-pane top-bar buttons** (close `x`, branch `dev`, status dot) [V] | frame 0045 onward | partial — RoomChrome exists | Verify branch label + close button |
| 23 | **Top app chrome**: `BridgeSpace Dev` title, mac traffic-lights, workspace breadcrumb `Workspace 10 / matthewmiller` [V] | frame 0040, 0080, 0150 | partial — Electron app already mac-styled | Confirm breadcrumb format |
| 24 | **Provider model splash inline** ("Claude Code v2.1.116 · Opus 4.7 (1M context) · Claude Max · ~/Desktop/bridgemind") [V] | frame 0070, 0150, 0160 | missing | Splash component reading provider metadata |
| 25 | **Bridge agent prompts reference real files in repo** ("Match Bridge Mind UI Tailwind config, Bridge Mind UI lib theme file") [T] | transcript L147–158 | missing | Bridge tool resolves @file refs from indexed codebase |
| 26 | **BridgeSwarm "Build your roster" screen** with quick presets `5 Squad / 10 Team / 15 Platoon / 20 Battalion`, CLI-agent tabs (BridgeCode/Claude/Codex/Gemini/OpenCode/Cursor/Droid/Copilot), counter chips (`1 Coordinator`, `2 Builders`), agent cards with role icons [V] | frame 0184.jpg | partial — `swarm-room/PresetPicker.tsx`, `RoleRoster.tsx` exist; need to confirm 5/10/15/20 preset names | Verify preset numerics + names; add Battalion=20 if missing |
| 27 | **BridgeSwarm wizard tab strip**: Roster · Mission · Directory · Context · Name with `Step 1 of 5` footer + Cancel / Next [V] | frame 0184.jpg | partial — `SwarmCreate.tsx` exists | Verify five-step ordering and labels |

## Frame-by-frame log (sampled)

- **0001.jpg** [V] Talking-head intro, BridgeMind sign + whiteboard goals.
- **0010.jpg** [V] Pre-canned demo: 8-pane Claude grid (top half) + browser tab on right showing `bridgemind.ai/`. Lower right: a "Live demo" terminal log mentioning *"vibe mode activated · 16 agents ready"*. Establishes the 8/16-pane capacity headline.
- **0020.jpg** [T+V] Empty workspace; centered card titled *"Build the future."* with three stacked options: **BridgeSpace** (`⌘T`), **BridgeSwarm** (`⌘S`), **BridgeCanvas** `ALPHA` (`⌘K`). Bottom action row: `+ NEW TERMINAL`, `SPLIT RIGHT`, `SETTINGS`. Transcript L19–25 confirms.
- **0030.jpg** [V] Stepper appears: Start ✓ — **Layout** active — Agents pending. *"Set up your workspace"* + body *"Pick a folder to work in and choose how many terminals you want."* Working-folder field shows `/Users/matthewmiller`. Tile grid for terminal count (1/2/4/6/8/10/12) and presets row `BridgeMind | Test 3 | Test 2 | Test | NEW`.
- **0035.jpg** [V] Working-folder autocomplete dropdown at `/Users/matthewmiller/desktop/bridgemind` with folder icon to right of input.
- **0040.jpg** [V] Terminal tile picker hover state — caption *"4 terminals · 2×2 grid layout"* under the 4-tile.
- **0045.jpg** [V] After choosing the 4-terminal preset, four panes already populated; each top-left header reads `bridgemind` and command line `matthewmiller@Mac-Studio bridgemind % claude`.
- **0050.jpg** [V] Wizard reopened; user typing in working-folder field — single character `c` visible (start of `cd …`).
- **0055.jpg** [V] Step 3 *"Add AI coding agents"* — counter `0 / 2`, quick-fill row `Enable all · One of each · Split evenly`, eight provider rows each with -/+ and a count, plus a "Custom Command" row at bottom and `+ Add custom command` link. Footer buttons: `Back · Skip — no agents · Pick at least one agent`.
- **0060.jpg** [V] Single Claude pane running, user typed `codex` in second pane — first concrete confirmation of mixing providers in one workspace.
- **0070.jpg** [V] Codex splash: `OpenAI Codex (v0.121.0)`, `model: gpt-5.4 high fast /model to change`, `directory: ~/Desktop/bridgemind`, plus tip line `Try the Codex App. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true`. The pane's input bar shows ghost text `Implement {feature}`.
- **0080.jpg** [T+V] Right-side **Bridge** tab activated. Header pill `BRIDGE`. Body: animated orb glyph, label `STANDBY · Tap to activate`. Below, chat thread: `BRIDGE Hey, I'm here. What are we working on?` then `YOU hey there bridge i need you to help me i need to launch two more codex agents two more cloud code agents three open code agents` then `BRIDGE Done, two more codexes, two clauds, three opencodes up.` Transcript L86–96.
- **0090.jpg** [V] Same Bridge panel, orb in `RECEIVING` state (different label color).
- **0100.jpg** [V] Workspace fully loaded with 10-pane grid; top row Claude, middle row Codex, bottom row OpenCode (each with the giant `opencode` ASCII title and `Build · Kimi K2.6 OpenRouter` chip). Bridge sidebar shows the second prompt and reply *"All ten agents up and ready."*
- **0120.jpg** [V] Same layout; bottom-right OpenCode pane footer reads `Tip Tool definitions can invoke …`.
- **0140.jpg** [V] All ten panes mid-task: Codex panes show `Working (2m 0s · esc to interrupt)`, Claude pane shows `auto mode on (shift+tab to cycle)`. Bridge transcript now lists three exchanges including the React-Native build prompt and Bridge's reply *"Swarm task. Assigning tasks. They're planning and building Bridge Space principles now."*
- **0150.jpg** [V] Bridge agent has dispatched per-pane prompts; visible prompt slugs: `Implement {feature}`, `Find and fix a bug in @filename`, `Run /review on my current changes`, `Write tests for @filename`.
- **0160.jpg** [V] Same scene 8s later — file paths streaming in pane bodies (`bridge-space-app/src/screens/LoginScreen.tsx`, `tauri.conf.json`, `bridge-space-app-ui/src/App.tsx`).
- **0170.jpg** [V] Codex pane producing structured plan: numbered list ("1. Is this Expo managed or bare RN?"); confirms agents output reasoning text inline.
- **0180.jpg** [V] User has clicked `+`; workspace-type picker reopens and the right pane swaps to the **bridgemind.ai/bridgeswarm** marketing page. Transition into Chapter B.
- **0184.jpg** [V] **BridgeSwarm wizard** opened: tab strip *Roster · Mission · Directory · Context · Name*, big heading *"Build your roster"*, quick-preset row `5 Squad / 10 Team / 15 Platoon / 20 Battalion`, CLI-agent-for-all row (BridgeCode highlighted, then Claude/Codex/Gemini/OpenCode/Cursor/Droid/Copilot), `1 Coordinator`/`2 Builders` count chips, agent cards (Coordinator, Builder, Builder), `+ Add agent`. Footer: `Cancel · STEP 1 of 5 · SWARM ▸ · Next`.

## Open questions

1. **Canvas mode** — visible only as the third card in the picker (frame 0020/0180); no Canvas UI surfaces in this chapter. Defer to chapter B/C.
2. **Voice input** — the user "speaks" to Bridge per L86–96 but no mic UI is visible in frames 0080–0100 (the orb may itself be the mic affordance). Confirm in B.
3. **Notification "ding" + Jump-to-pane** — purely [T] in this chapter; no toast captured in samples. Watch for it in chapter B.
4. **Workspace breadcrumb** reads `Workspace 10 / matthewmiller` — unclear if `matthewmiller` is the user account or the working-folder leaf. Likely working-folder; verify.
5. **Bridge tool inventory** — transcript L82–86 says Bridge has *"tools we've built custom"*; no tool list visible. Will need to compile from later chapters and the Product Hunt page.
6. **Agent count pill colour mapping** — sidebar shows green pills (`BridgeMind • 1`, `Workspace 10 • 2`); not enough variation in this chapter to confirm semantic colors. Defer.
7. **Step-3 "Open without AI"** button on layout step (frame 0030/0040) — confirms a no-agent pure-terminal mode that we may be missing.

---
*Report written to `/Users/aisigma/projects/SigmaLink/docs/02-research/v3/v3-frames-chapter-a.md`*
