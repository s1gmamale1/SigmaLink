# BridgeSpace / BridgeSwarm — Visual Style Spec

Distilled visual style guide derived from the saved thumbnails (1080p) and from the transcripts. Every claim is annotated:

- **[V-confirmed]** — observed directly from a saved thumbnail in `docs/02-research/thumbnails/`
- **[T-only]** — only from spoken narration; visual not directly confirmed in this pass
- **[INF]** — inferred (best-guess from context, e.g. macOS conventions or brand norms)

When a hex value is given without a colour-picker measurement, it is an **estimated** match (~ within visual range) and is marked **[V-est]**.

---

## 1. Brand identity

| Element | Spec | Confidence |
|---|---|---|
| Brand name | **BridgeMind** (parent), **BridgeSpace** (the desktop ADE), **BridgeSwarm** (multi-agent coordination product inside BridgeSpace), **Bridge Canvas** (V3, third workspace type), **Bridge** (in-app autonomous orchestrator agent), **BridgeVoice** (voice-to-text), **BridgeJarvis** (voice assistant), **BridgeMemory** (knowledge graph; mentioned in supporting research), **BridgeMind MCP** (MCP server tooling). | T+V |
| Wordmark | "BRIDGESPACE" set in a heavy condensed sans (looks like Inter/Plus Jakarta-style geometric sans, all-caps, tight tracking) with a **left-to-right horizontal gradient** — amber/orange on the left letters, fading through neutral, into steel/electric blue on the right letters. | V-confirmed |
| Logo glyph (window-corner monogram) | A stylised lightning-bolt "Z" glyph, tilted ≈75°, set inside a soft rounded square. Two-tone gradient: cyan/teal in the top half, amber/gold in the bottom half. Appears at the **top-right of the BridgeSpace window** (where you'd put a help icon) and embroidered on the founder's hoodie. | V-confirmed |
| Product app icon | Rounded-square icon (macOS-style, ≈22% corner radius). Background dark navy/black with subtle radial gradient. Foreground is **four white stroked panels arranged in a 2 × 2 grid**, each panel showing 2–3 short horizontal bars (representing agent panes / lines of code / chat bubbles). Strong dual glow behind the icon: **amber** on the left edge, **electric blue** on the right edge — exactly mirroring the wordmark gradient. | V-confirmed |
| Mascot | None of BridgeSpace's own. The pixel-art crab/critter shown in the panes is **Claude Code's own mascot** rendered by the embedded `claude` CLI, not BridgeMind's. | V-confirmed |

The amber-to-blue gradient is the brand's primary visual signature and appears on: wordmark, app icon glow, swarm-window border (BridgeSpace 3 thumbnail), and hoodie monogram.

---

## 2. Colour palette

Hex values estimated from the 1080p thumbnails.

### 2.1 Surfaces (dark-mode default)

| Token | Estimated hex | Where seen | Notes |
|---|---|---|---|
| `bg/canvas` | `#0A0A0C` – `#0E0F12` [V-est] | full-window background, behind tabs | near-black with cool tint |
| `bg/pane` | `#101216` – `#13161B` [V-est] | individual terminal pane interior | very slight blue undertone |
| `bg/pane-header` | `#16191F` [V-est] | pane title strip | one notch lighter than pane body |
| `bg/tab-active` | `#1B1E24` [V-est] | the foreground workspace tab | |
| `bg/tab-inactive` | `#0E1014` [V-est] | background workspace tabs | |
| `border/subtle` | `#1F2229` [V-est] | hairline pane separators | 1 px |
| `border/glow-warm` | `#E6A23A → rgba(230,162,58,0)` [V-est] | left side of swarm window border + app icon | radial blur ≈ 30–60 px |
| `border/glow-cool` | `#3FA9F5 → rgba(63,169,245,0)` [V-est] | right side of swarm window border + app icon | radial blur ≈ 30–60 px |

### 2.2 Foreground / text

| Token | Estimated hex | Use |
|---|---|---|
| `text/primary` | `#E6E8EC` [V-est] | terminal text, headers |
| `text/secondary` | `#9AA0A6` [V-est] | metadata, e.g. "Opus 4.6 with high effort" |
| `text/muted` | `#5C6068` [V-est] | path strings, timestamps |
| `text/accent-cyan` | `#7FE5FF` [V-est] (matches wordmark) | brand accents, the lightning monogram |
| `text/accent-warm` | `#F4B73A` [V-est] (matches wordmark) | brand accents, app icon glow |

### 2.3 Status / role

| Token | Estimated hex | Use |
|---|---|---|
| `role/coordinator` | `#7FA9FF` blue/violet [V-est, from hex node fill in GPT5.4 thumbnail] | crown glyph |
| `role/builder` | `#7FE6C0` mint/teal [V-est, lines connecting builder hexes] | hammer glyph |
| `role/scout` | not visible in thumbnails [INF: green family] | scope/eye glyph (inferred) |
| `role/reviewer` | not visible in thumbnails [INF: amber family] | check-mark glyph (inferred) |
| `status/done` | mint-green (from glow on completed builder nodes) [V-est] | "done" / "task complete" badge |
| `status/active` | warm amber pulse [INF] | running agent |
| `notification/ding` | colour TBD; an **audio cue** ("ding") is confirmed in transcript | toast notification |

### 2.4 Window chrome (macOS native)

| Token | Hex | Notes |
|---|---|---|
| `chrome/red` | `#FF5F57` | macOS close |
| `chrome/yellow` | `#FEBC2E` | macOS minimise |
| `chrome/green` | `#27C840` | macOS zoom |

These are macOS system colours, visible at the extreme top-left of the launch thumbnail.

---

## 3. Typography

| Surface | Family | Weight | Size hint | Confidence |
|---|---|---|---|---|
| Pane terminal body | **Monospace** (looks like SF Mono or JetBrains Mono — tight, no slab; "$" and `%` glyphs match SF Mono/Menlo more than JetBrains) | 400 / regular | ≈ 12-13 pt | V-confirmed |
| Pane header agent label ("Agent X", "Agent 2") | Sans-serif, looks like **SF Pro / Inter** | 500 medium | ≈ 12 pt | V-confirmed |
| Workspace tab label | Same sans, 500 medium | ≈ 13 pt | V-confirmed |
| Top-bar title strip | Same sans | 400 regular | ≈ 12 pt | V-confirmed |
| Wordmark / marketing display | A **heavy / black** geometric sans, condensed, all caps, tight tracking. Closest matches: Druk / Anton / Bebas-style display. Used only in promo art. | 900 black | display | V-confirmed |
| Inline code in pane content (e.g. `Claude Code v2.1.72`) | Same monospace, slightly bolder run for the product name | 600 semibold | ≈ 13 pt | V-confirmed |

No serif faces visible anywhere.

---

## 4. Layout & grid

### 4.1 Top-level window

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [• • •]  [📁 Workspace 1 (5)] [📁 Workspace 2] [📁 Workspace 3 (12) x] [+]   ⚙ ⚡│   ← top bar height ≈ 40 px
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌──── pane ────┬──── pane ────┬──── pane ────┬──── pane ────┐  ┌────────┐    │
│ │ • Agent X    │ • Agent 2    │ • Agent 3    │ • Agent 4    │  │ side   │    │
│ │              │              │              │              │  │ panel  │    │
│ │   terminal   │   terminal   │   terminal   │   terminal   │  │ (V3:   │    │
│ │              │              │              │              │  │ Bridge │    │
│ ├───────────...├──────────...├──────────...├──────────...│   │ /Browser│    │
│ │ next row     │              │              │              │  │ /IDE)  │    │
│ │ ...          │              │              │              │  │        │    │
│ └──────────────┴──────────────┴──────────────┴──────────────┘  └────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

[V-confirmed for: tab strip, pane headers, 4-column grid, gear + monogram in top-right.]
[T-only for: right-hand collapsible side panel containing Browser / IDE / Bridge agent — V3.]

### 4.2 Pane grid behaviour

- **Column count** scales with agent count. Visible thumbnail shows 4 columns × 3 visible rows = up to 12 panes simultaneously visible without scroll. Up to **16 total panes** are supported in one workspace [T-confirmed cap].
- Each pane has its own **header strip** (≈24-28 px tall) showing: status dot · folder icon · agent label · branch indicator (`branch dev`) · close `x`.
- Every pane appears equal-size; no obvious focused/zoomed pane state observed in the thumbnails (V3 may add zoom-into-pane — implied by "jump to pane").
- Resizable splitters between panes implied by V3 narration about a draggable side-panel.

### 4.3 BridgeSwarm Operator Console grid

(From the BridgeSpace 3 thumbnail: a separate window/panel showing the swarm.)

- **4 columns × 4 rows = 16 cells** of small "agent cards" within a single rounded-rectangle window.
- Each card ≈ 1/16 of the window area, ≈ 130 × 70 px at thumbnail scale.
- Card layout per agent:
  - top-left small role badge / icon (Claude crab, Codex, etc.)
  - agent label + version on right
  - 2–3 lines of dim grey log/status under the header
- A single-line status line below each card (looks like a separator indicating "now doing: X").
- Border of the swarm window: dark with **amber-glow on left, blue-glow on right** (mirrors brand gradient).

### 4.4 Agent topology illustration

(Promo / marketing graphic — also used as a thumbnail composition.)

- Central hex node (coordinator) → radial fan-out of edges to peripheral hex nodes (builders / scouts / reviewers).
- Hex nodes use a navy/dark fill with a coloured stroke and inner glyph (crown for coordinator, hammer for builder, etc.).
- Edges are mint/turquoise with bright dot terminators; carry implicit "messaging" semantics.

This may or may not appear inside the live app; treat as **brand graphic** for now [INF].

### 4.5 Spacing / radii

| Token | Value | Confidence |
|---|---|---|
| Window corner radius | `12 px` for child windows (swarm console) [V-est] | V |
| Tab corner radius | `6 px` top-only [V-est] | V |
| Pane outer radius | `4–6 px` [V-est] | V |
| Hairline | `1 px` `#1F2229` [V-est] | V |
| Pane header padding | `≈ 8 px` horizontal, `4 px` vertical [V-est] | V |
| Tab horizontal padding | `≈ 12 px` [V-est] | V |
| Glow blur on brand surfaces | `30–60 px` radial [V-est] | V |

---

## 5. Iconography

Confirmed glyph set (from thumbnails + transcript):

- **Folder** (📁) on each workspace tab and pane header — used to denote a project directory binding.
- **Pill counter** on workspace tab — shows "5", "12" — agent count in that workspace [V-confirmed].
- **`x`** close button on tabs and panes [V-confirmed].
- **`+`** to create a new workspace tab [V-confirmed].
- **`⚙` settings gear** in top-right [V-confirmed].
- **Lightning-bolt monogram** in extreme top-right (BridgeMind brand) [V-confirmed].
- **Branch indicator** with text `dev` in pane header — implies the pane is bound to a git worktree on branch `dev` [V-confirmed]. The glyph itself looks like the macOS branch glyph (small fork shape).
- **Status dot** at left of pane header — colour likely encodes idle / running / done [V-est colour, role mapping inferred].
- **Crown** glyph on coordinator node (topology art) [V-confirmed].
- **Hammer** glyph on builder node (topology art) [V-confirmed].
- **Eye / scope** for scout (referenced in transcript only) [T-only].
- **Check / shield** for reviewer (referenced in transcript only) [T-only].
- **Pixel-art crab** = Claude Code's own mascot, not BridgeSpace's. Several panes show it because every fresh `claude` invocation prints its splash. Same for Codex, Gemini, etc.

---

## 6. Motion / animation (transcript-only unless noted)

| Cue | Description | Source |
|---|---|---|
| Pane "ding" notification | Audio "ding" plays when an agent completes a task; on-screen toast / badge implied. | T-only |
| Jump-to-pane | An action that scrolls/animates to the pane that just finished, even from a different workspace. | T-only |
| Glow pulses on brand surfaces | The amber/blue glows on the app icon and swarm-window border are likely animated pulses (industry-standard for hero shots), but the thumbnails are static. | INF |
| Inter-agent message stream | Operator-Console chat updates live as messages arrive (~every few seconds during a run). Animations: scrolling chat, possibly fade-in. | T-only |

---

## 7. Density & information hierarchy

- Default mode is **dense**. The launch thumbnail visibly fits **at least 12 simultaneous Claude Code splashes** in one window without scroll. This is the product's bragging right.
- Pane content is allowed to truncate aggressively (`/Users/matthewmiller/Desktop/br…` ellipses).
- Every pane has identical chrome — uniformity over emphasis.
- The Operator Console packs **16 agent cards** into a single window via a 4×4 grid.
- The right-hand side panel (V3) collapses to give terminals more room.

---

## 8. Confirmed-from-video vs. inferred-from-transcript — quick index

| Claim | Status |
|---|---|
| BridgeSpace window has a top tab strip with workspace tabs, agent-count pills, `+` and gear icons | V-confirmed |
| Pane headers show status dot · folder icon · agent label · `branch dev` · close | V-confirmed |
| Default theme is very dark with amber+blue brand glow accents | V-confirmed |
| BridgeSpace product icon is a 2×2 panel-grid in a rounded square | V-confirmed |
| Agent panes display each agent's native CLI splash (Claude Code shown verbatim as `Claude Code v2.1.72 / Opus 4.6 with high effort / Claude Max / ~/Desktop/bridgemind`) | V-confirmed |
| Workspace tabs can show an agent count badge ("5", "12") | V-confirmed |
| Up to 16 panes per workspace | T-only (consistent with grid math, V-est) |
| Three workspace types: Bridge Space, Bridge Swarm, Bridge Canvas | T-only |
| Bridge agent (V3) has tools that can launch other agents on user's behalf | T-only |
| Built-in browser tab inside workspace, multiple browser tabs, draggable splitter | T-only |
| Built-in IDE tab inside workspace, click-to-open from terminal output | T-only |
| Visual Design Tool: marquee-select an HTML element, dispatch a prompt to a chosen provider, drag-drop assets onto a selection | T-only |
| Operator Console with per-agent DM lanes + global chat, message totals per role | T-only |
| Swarm topology rendered as crown / hammer hex nodes connected by mint edges | V-confirmed (in brand graphic; in-app rendering not confirmed) |
| Roster presets: 5-agent squad / 50-agent (mentioned). Verified labels: **Squad (5)**, **Team (≈10)**, **Platoon (15)**, plus "Legion" used colloquially, plus 50-agent preset | T-only (squad confirmed numerically; team/platoon labels from V3 transcript) |
| `⌘T` opens new-workspace dialog | T-only |
| Voice prompts via BridgeVoice / BridgeJarvis | T-only |
| Notification "ding" + jump-to-pane (V3) | T-only |
| Pricing: $20/mo basic, V3 coupon = 50% off, launch20 (older) = 20% off | T-only |
| Fast-mode toggle on Codex / GPT 5.4 panes | T-only |
| Bug-bounty pays in Bitcoin | T-only |

---

## 9. Open visual questions

See `open-video-questions.md` for the running list of UI states described verbally but not yet visually verified.
