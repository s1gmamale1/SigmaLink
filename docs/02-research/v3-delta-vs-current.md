# V3 Delta vs Current SigmaLink — master backlog

Status **shipped/partial/missing/divergent**. Effort S ≤ 1 day, M ≤ 3, L > 3. Frames at
`docs/02-research/frames/v3/<NNNN>.jpg`.

## Bridge Assistant Verdict — **BUILD, do not defer**

`master_memory.md` lists Bridge Canvas as deferred; V3 makes both Bridge Assistant and
Canvas **core surfaces**. Walker A sees Bridge as a right-rail **chat orb** with **per-pane
prompt injection** and **workspace tools** (0080, 0090, 0100, 0150; transcript L82-96,
L147-158): voice prompt → spawn 8 agents → dispatch `Implement {feature}` / `Find and fix
a bug in @filename` / `Run /review on my current changes` / `Write tests for @filename`
(0150). Walker C sees Bridge as a **first-class tile** on the mobile dashboard (0455,
"Assistant side panel"). Same agent, two surfaces. **W13 builds Bridge Assistant fully**
(chat UI, orb state machine, ten tools in PRODUCT_SPEC §3.10, new `assistant.*` RPC from
`v3-protocol-delta.md` §3, right-rail tab, per-pane dispatch echo). Bridge Canvas → **W14**
off the same Browser foundation.

## Workspace launcher
Path: `features/workspace-launcher/`, `features/sidebar/`, `electron/main.ts`. All **W12**.

| V3 affordance | Source | Status | Effort |
|---|---|---|---|
| 3-card picker BridgeSpace/BridgeSwarm/**BridgeCanvas `ALPHA`** + `⌘T`/`⌘S`/`⌘K` | 0020, 0180 | partial | S |
| Stepper Start → Layout → Agents | 0030, 0040, 0055 | partial | S |
| Folder field + picker + autocomplete; tile grid 1/2/4/6/8/10/12 (hover *"4 terminals · 2×2 grid"*); preset row (BridgeMind / Test 3 / Test 2 / Test / NEW) | 0030, 0035, 0040 | missing | M |
| Provider matrix (BridgeCode → Copilot, -/+ counters, `0/N`) + quick-fills *Enable all/One of each/Split evenly* + Custom Command row | 0055 | missing | M |
| *Skip — no agents* / *Open without AI* | 0030, 0055 | missing | S |
| Sidebar tabs (name + status dot + agent-count pill) + app breadcrumb `Workspace 10 / matthewmiller` | 0020+, 0080, 0185 | partial | S |

## Swarm
Path: `features/swarm-room/`, `main/core/swarms/`.

| V3 affordance | Source | Status | Effort | Wave |
|---|---|---|---|---|
| Wizard 5-step *Roster · Mission · Directory · Context · Name* | 0184, 0220 | partial | S | 12 |
| Presets **5/10/15/20** Squad/Team/Platoon/Battalion (Legion-50 dropped); Battalion split `3/11/3/3` `[INFERRED]` | 0184, 0185 | partial | S | 12 |
| Role colour tokens (Coord blue / Builder violet / Scout green / Reviewer amber) | 0205 | missing | S | 12 |
| Per-row provider strip + Auto-approve + count -/+ + colour stripe | 0205 | partial | M | 12-13 |
| CLI-agent-for-all global provider strip above role rows | 0205 | missing | S | 12 |
| Mission `@<workspaceSlug>` mention autocomplete | 0210, 0235 | missing | M | 13 |
| Swarm Skills 12-tile grid with on/off pills | 0210, 0220 | missing | M | 13 |
| Operator Console — constellation graph (drag/zoom) | 0250, 0295 | missing | L | 13 |
| Top-bar tabs `TERMINALS · CHAT · ACTIVITY` + unread badge + **STOP ALL** red pill + group filter chips + mission chip | 0250, 0265, 0295 | missing | M | 12 |
| Status counters `ESCALATIONS · REVIEW · QUIET · ERRORS` + bottom-bar ledger | 0295 | missing | M | 12 |
| Activity-feed sidebar (per-agent timeline) | 0250 | missing | M | 13 |
| Coordinator structured task brief (markdown, `URGENT` chip, links) | 0265 | partial | M | 13 |
| Per-agent **board** namespace | 0280; L247 | missing | M | 13 |
| Composer `@all` chip + per-agent target + status pills `MSG/DONE/ACK/ESCALATE` | 0250, 0265, 0310 | partial | S | 12 |
| Operator → agent DM echo into PTY (`[Operator → Role N] …`) | 0325; L296-301 | missing | M | 13 |

## Browser + Editor + Bridge dock
Path: new `features/right-rail/` / `features/editor/` / `features/bridge-agent/`; existing
`features/browser/`, `command-room/`.

| V3 affordance | Source | Status | Effort | Wave |
|---|---|---|---|---|
| Right-rail with **Browser · Editor · Bridge** tabs + resizable splitter | 0080, 0340, 0410 | missing | M | 13 |
| Browser recents panel + click-link-in-pane → built-in browser | 0340; L209 | partial | M | 13 |
| **Editor** tab with file tree + Monaco/CodeMirror; click-path → focus | 0420, 0430; L380-403 | missing | L | 14 |
| Per-pane top-bar (close, branch `dev`, status dot) + provider splash variants (Claude/Codex/OpenCode) + prompt-bar `gpt-5.4 high fast · cwd` + `auto mode on (shift+tab)` / `bypass permissions on` footers | 0045, 0070, 0100, 0140 | partial | M | 12-13 |
| Multi-pane terminal grid (single-pane today) | 0045, 0100, 0150 | partial | M | 13 |

## Bridge Canvas
Path: new `features/browser/DesignOverlay.tsx`, `main/core/design/`.

| V3 affordance | Source | Status | Effort | Wave |
|---|---|---|---|---|
| BridgeCanvas card `ALPHA` in workspace picker | 0020, 0180 | missing | S | 12 |
| Element-picker overlay (`Click an element in the preview`) | 0368, 0369 | missing | L | 14 |
| Captured-element source paste in left dock | 0368, 0380 | missing | M | 14 |
| Per-prompt provider picker (Claude / Codex / Gemini / OpenCode) + Shift/Alt multi-select | 0380 | missing | M | 14 |
| Drag-and-drop asset → absolute path in prompt buffer | 0398, 0405 | missing | M | 14 |
| Live-DOM patch propagates to dev server (HMR poke) | 0405 | missing | L | 14 |

## Bridge Assistant
Path: new `features/bridge-agent/`, `main/core/assistant/`. All **missing**, **W13** unless
noted.

| V3 affordance | Source | Effort |
|---|---|---|
| Right-rail Bridge tab + chat panel | 0080, 0410 | L |
| Orb state machine STANDBY / LISTENING / RECEIVING / THINKING | 0080, 0090 | M |
| Voice intake (tap orb → mic) — **W15** | L86-96 | M |
| Chat transcript `BRIDGE` / `YOU` rounded-pill labels | 0080, 0100, 0150 | S |
| Spawn N panes from one prompt (`assistant.dispatch-bulk`) | 0080, 0100 | M |
| Per-pane dispatch (`Implement {feature}`, etc.) | 0150 | M |
| `@filename` resolution against indexed codebase | 0160; L147-158 | M |
| Tool-call inspector (auditable trace) | PRODUCT_SPEC §3.10 | M |
| Notification "ding" + completion badge | L122-137 | S |
| Cross-workspace **Jump to pane** | L132-137 | S |

## Mobile + Pricing + Auth (out of desktop scope, all **divergent**)

iOS welcome / Start Shipping (0440), sign-in Google/Apple/email (0445), dashboard 6 tiles
(0455), `/pricing` 3-tier grid Basic/Pro/Ultra $20/$50/$100 (0500-0515), Monthly/Annual
toggle, `code V3 at checkout` (L461-466). **One in-app concern**: plan feature lists
(0500, 0510) → capability matrix for plan gating in **W15**.

## Voice / SKUs / Provider chrome

**W12** BridgeCode provider stub w/ `comingSoon` fallback to Claude (0055, 0184, 0510);
OpenCode → Kimi-K2.6 model option (0100, 0140); hide `aider`/`continue` behind Settings
toggle. **W15** voice intake → mission/Bridge orb/palette (0235; L86-96, L190).
**Divergent / out of scope**: BridgeJarvis wake-word (L472-475), BridgeVoice desktop sibling
app (0520), BridgeMCP entitlement UI (0510, undefined).
