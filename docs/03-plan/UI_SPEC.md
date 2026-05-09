# SigmaLink — UI Specification

Compiled: 2026-05-09
Companion to `PRODUCT_SPEC.md` and `BUILD_BLUEPRINT.md`. Pixel-level, token-level, component-level. No new product decisions are introduced here; every conflict is resolved in `PRODUCT_SPEC.md` §0.

Sources used for the visual decisions below: `docs/02-research/visual-spec.md`, `docs/02-research/visual-asset-inventory.md`, `docs/02-research/keyboard-shortcuts.md`, `docs/02-research/glossary.md`, and the legacy `app/src/_legacy/sections/CommandRoom.tsx` densities.

---

## 1. Color tokens

All tokens are CSS custom properties on `:root`. Themes override the same token names in their own `<theme>.css` file. The default theme is `obsidian` (dark).

### 1.1 Default dark theme (`obsidian`)

```css
:root {
  /* Surfaces */
  --bg-canvas:           #0B0C10;
  --bg-pane:             #101216;
  --bg-pane-header:      #16191F;
  --bg-tab-active:       #1B1E24;
  --bg-tab-inactive:     #0E1014;
  --bg-overlay:          #0B0C10E6;     /* 90% canvas; for modals */
  --bg-elevated:         #14171D;       /* popovers, tooltips */

  /* Borders */
  --border-subtle:       #1F2229;
  --border-strong:       #2A2F38;
  --border-focus:        #3FA9F5;

  /* Text */
  --text-primary:        #E6E8EC;
  --text-secondary:      #9AA0A6;
  --text-muted:          #5C6068;
  --text-inverse:        #0B0C10;

  /* Brand */
  --brand-warm:          #E6A23A;
  --brand-cool:          #3FA9F5;
  --brand-warm-glow:     rgba(230,162,58,0.35);
  --brand-cool-glow:     rgba(63,169,245,0.35);

  /* Roles */
  --role-coordinator:    #7FA9FF;
  --role-builder:        #7FE6C0;
  --role-scout:          #C7E37F;
  --role-reviewer:       #F5C25B;

  /* Status */
  --status-running:      #F4B73A;       /* warm pulse */
  --status-idle:         #5C6068;
  --status-done:         #7FE6C0;
  --status-error:        #F47272;
  --status-blocked:      #C77FE6;

  /* Accents (for buttons) */
  --accent:              #3FA9F5;
  --accent-hover:        #5BB7F8;
  --accent-pressed:      #2A8AD0;
  --accent-on:           #FFFFFF;

  /* Code/terminal */
  --term-bg:             #0B0C10;
  --term-fg:             #E6E8EC;
  --term-cursor:         #7FE5FF;
  --term-selection:      #3FA9F540;

  /* Diff */
  --diff-add:            #1B3322;
  --diff-add-fg:         #7FE6C0;
  --diff-del:            #3A1F1F;
  --diff-del-fg:         #F47272;
  --diff-line-num:       #5C6068;
}
```

### 1.2 Token usage rules

| token | when to use |
|---|---|
| `--bg-canvas` | full-window background, behind tabs, behind sidebar |
| `--bg-pane` | terminal pane interior, room body container |
| `--bg-pane-header` | pane title strip, room header strip |
| `--bg-tab-active` / `--bg-tab-inactive` | workspace tab strip and browser tab strip |
| `--bg-overlay` | modal scrim |
| `--bg-elevated` | popovers, tooltips, palette dropdown |
| `--border-subtle` | hairlines (1 px) |
| `--border-strong` | input borders, card borders (1 px) |
| `--border-focus` | active focus ring (2 px) |
| `--text-primary` | body text, terminal output, headings |
| `--text-secondary` | metadata, subtitles |
| `--text-muted` | timestamps, paths, helper text |
| `--brand-warm` / `--brand-cool` | accents on hero surfaces only (app icon glow, swarm-window border, wordmark) |
| `--role-*` | role badges and topology hex strokes |
| `--status-*` | status dots, pane border pulses |
| `--accent` | primary CTAs |

### 1.3 Light theme (`solarized-light`) overrides — sample

```css
[data-theme="solarized-light"] {
  --bg-canvas:           #FDF6E3;
  --bg-pane:             #FFFEF7;
  --bg-pane-header:      #EEE8D5;
  --bg-tab-active:       #FFFEF7;
  --bg-tab-inactive:     #EEE8D5;
  --border-subtle:       #E2DAB8;
  --border-strong:       #C7BE9C;
  --text-primary:        #073642;
  --text-secondary:      #586E75;
  --text-muted:          #93A1A1;
  --term-bg:             #FDF6E3;
  --term-fg:             #073642;
}
```

The full 25-theme set is enumerated in `BUILD_BLUEPRINT.md` Phase 7. Each ships only the variables that differ from the default; missing variables inherit `obsidian`.

---

## 2. Typography tokens

```css
:root {
  --font-sans:    'Inter', 'SF Pro Text', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', monospace;
  --font-display: 'Inter', 'SF Pro Display', system-ui, sans-serif;

  /* Sizes (px) */
  --fs-xs:    11;
  --fs-sm:    12;
  --fs-md:    13;
  --fs-base:  14;
  --fs-lg:    16;
  --fs-xl:    18;
  --fs-2xl:   22;
  --fs-3xl:   28;
  --fs-display: 40;

  /* Line heights (unitless) */
  --lh-tight: 1.15;
  --lh-snug:  1.25;
  --lh-base:  1.45;
  --lh-loose: 1.6;

  /* Weights */
  --fw-regular: 400;
  --fw-medium:  500;
  --fw-semibold: 600;
  --fw-bold:    700;
}
```

Per-surface picks:

| surface | family | size | weight | line height |
|---|---|---|---|---|
| Terminal body (compact density) | mono | 11 | 400 | 1.15 |
| Terminal body (balanced) | mono | 12 | 400 | 1.20 |
| Terminal body (expanded) | mono | 13 | 400 | 1.28 |
| Pane header label | sans | 12 | 500 | 1.20 |
| Workspace tab label | sans | 13 | 500 | 1.20 |
| Sidebar item | sans | 13 | 500 | 1.25 |
| Body text | sans | 14 | 400 | 1.45 |
| Secondary text | sans | 12 | 400 | 1.45 |
| Section heading | sans | 18 | 600 | 1.25 |
| Page title | sans | 22 | 600 | 1.20 |
| Display (welcome screen) | display | 28–40 | 700 | 1.10 |
| Inline code in chrome | mono | 12 | 600 | 1.30 |

Underlines on links are off by default; on hover, an inset 1 px underline appears at `currentColor`.

---

## 3. Spacing scale

Base unit: **4 px**.

```
--sp-0:   0px;
--sp-1:   4px;
--sp-2:   8px;
--sp-3:  12px;
--sp-4:  16px;
--sp-6:  24px;
--sp-8:  32px;
--sp-12: 48px;
--sp-16: 64px;
--sp-24: 96px;
```

Component padding rules:
- Sidebar item: `var(--sp-2) var(--sp-3)`.
- Tab: `var(--sp-2) var(--sp-3)`.
- Pane header: `var(--sp-2) var(--sp-3)`.
- Card body: `var(--sp-4)`.
- Modal body: `var(--sp-6)`.
- Form field gap: `var(--sp-3)`.
- Section gap: `var(--sp-4)` to `var(--sp-6)`.

Border radii:
- `--radius-sm: 4px;` pane corners, kbd.
- `--radius-md: 6px;` tab corners (top only), button.
- `--radius-lg: 8px;` card, popover.
- `--radius-xl: 12px;` modal, child windows (matches `visual-spec.md` §4.5).
- `--radius-pill: 9999px;` agent-count pill, status badge.

---

## 4. Component library

### 4.1 shadcn components reused (no modifications)

`accordion`, `alert-dialog`, `alert`, `aspect-ratio`, `avatar`, `badge`, `breadcrumb`, `button`, `button-group`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `collapsible`, `command`, `context-menu`, `dialog`, `drawer`, `dropdown-menu`, `empty`, `field`, `form`, `hover-card`, `input`, `input-group`, `input-otp`, `item`, `kbd`, `label`, `menubar`, `navigation-menu`, `pagination`, `popover`, `progress`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`. (Source: `app/info.md`.)

Style adjustments:
- Override the shadcn `--background` etc. to point at SigmaLink tokens in `app/src/renderer/styles/shadcn-bridge.css`.
- Buttons use 32 px standard height, 24 px small, 40 px large.

### 4.2 Custom components (new)

| name | purpose | file |
|---|---|---|
| `TopTabStrip` | workspace tab strip with agent-count pill, +, gear, brand monogram | `app/src/renderer/features/chrome/TopTabStrip.tsx` |
| `BrandMonogram` | the lightning-bolt glyph in the top-right | `app/src/renderer/features/chrome/BrandMonogram.tsx` |
| `RoomSidebar` | left rail with eleven room icons + active pill | `app/src/renderer/features/chrome/RoomSidebar.tsx` |
| `TerminalGrid` | the mosaic / columns / focus container, drives layout math | `app/src/renderer/features/command-room/TerminalGrid.tsx` |
| `TerminalPane` | one xterm.js pane with header, status, branch indicator | `app/src/renderer/features/command-room/TerminalPane.tsx` |
| `PaneStatusDot` | colour-coded status dot + tooltip | `app/src/renderer/features/command-room/PaneStatusDot.tsx` |
| `BranchIndicator` | branch fork glyph + branch name | `app/src/renderer/features/command-room/BranchIndicator.tsx` |
| `RoleRosterCard` | one card per swarm agent in the roster setup | `app/src/renderer/features/swarm-room/RoleRosterCard.tsx` |
| `SwarmGridCard` | compact agent card in the 4×4 Operator console grid | `app/src/renderer/features/swarm-room/SwarmGridCard.tsx` |
| `MailboxBubble` | a single mailbox envelope rendered in the side chat | `app/src/renderer/features/swarm-room/MailboxBubble.tsx` |
| `SkillDropZone` | drag/drop overlay + per-room embedded zone | `app/src/renderer/features/skills/SkillDropZone.tsx` |
| `SkillCard` | one skill row with provider toggles and validation badges | `app/src/renderer/features/skills/SkillCard.tsx` |
| `MemoryGraphCanvas` | force-directed graph with zoom/pan/drag/ego mode | `app/src/renderer/features/memory/MemoryGraphCanvas.tsx` |
| `BrowserTabBar` | tabs + + close + drag-to-reorder | `app/src/renderer/features/browser/BrowserTabBar.tsx` |
| `AgentDriveIndicator` | warm-amber dot + ripple animation | `app/src/renderer/features/browser/AgentDriveIndicator.tsx` |
| `KanbanColumn` | one column with drag-drop slots and "+" affordance | `app/src/renderer/features/tasks/KanbanColumn.tsx` |
| `TaskCard` | one task card with role chip and assignee avatar | `app/src/renderer/features/tasks/TaskCard.tsx` |
| `JumpToPaneToast` | sonner-based toast with "Jump" action | `app/src/renderer/features/chrome/JumpToPaneToast.tsx` |
| `ProviderBadge` | provider chip with colour + lucide icon | `app/src/renderer/components/ProviderBadge.tsx` |
| `RoleBadge` | role chip (crown/hammer/scope/shield) | `app/src/renderer/components/RoleBadge.tsx` |
| `StatusPill` | running/idle/done/error/blocked pill | `app/src/renderer/components/StatusPill.tsx` |
| `KbdHint` | inline keyboard shortcut hint | `app/src/renderer/components/KbdHint.tsx` |
| `EmptyRoom` | empty-state component used by every room | `app/src/renderer/components/EmptyRoom.tsx` |

---

## 5. Per-room layouts

### 5.1 Workspaces room

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TopTabStrip (40 px)                                                       ⚙ ⚡ │
├───────┬──────────────────────────────────────────────────────────────────────┤
│       │  Workspaces                                                          │
│       │  ─────────────                                                       │
│       │  + New workspace      [Bridge Space] [Bridge Swarm] [Bridge Canvas] │
│       │                                                                      │
│ Side  │  Recent                                                              │
│ bar   │  ┌──────────────────────────────┬──────────────────────────────┐    │
│ 240px │  │ Folder · 12 panes · last 5h   │ Folder · 4 panes · last 1d   │    │
│       │  │ /Users/.../bridgemind         │ /Users/.../sigmaproto         │    │
│       │  └──────────────────────────────┴──────────────────────────────┘    │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Grid: outer 12-column. Sidebar fixed 240 px (collapsed 48 px). Body fills remaining width with 24 px page gutter.
- Recent grid: `auto-fit, minmax(280px, 1fr)`.
- Responsive: under 960 px window width, the sidebar collapses to icon-only (48 px). Under 720 px, the Recent grid becomes one column.

### 5.2 Command room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────────────────────────────────────────────┤
│ Side  │  Layout: [Mosaic][Cols][Focus]   Density: [Compact][Balanced][Exp]   │
│ bar   ├──────────────────────────────────────────────────────────────────────┤
│ 48 px │  ┌────────┬────────┬────────┬────────┐                               │
│       │  │ ●hdrx  │ ●hdr2  │ ●hdr3  │ ●hdr4  │   header per pane            │
│       │  │  term  │  term  │  term  │  term  │                              │
│       │  ├────────┼────────┼────────┼────────┤                              │
│       │  │ ●hdr5  │ ●hdr6  │ …      │ …      │                              │
│       │  │  term  │  term  │        │        │                              │
│       │  └────────┴────────┴────────┴────────┘                              │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Layout modes (carry over from legacy DD-030):
  - `mosaic` — `auto-fit, minmax(min(100%, <minWidth>px), 1fr)`.
  - `columns` — 1/2/3 columns based on session count (≤2: 1 col; ≤6: 2 cols; >6: 3 cols).
  - `focus` — single pane filling the body, with a thumbnail strip on the right.
- Density min sizes:
  - compact: minWidth 260, minHeight 240, font 11/1.15.
  - balanced (default): 320 × 300, font 12/1.20.
  - expanded: 400 × 360, font 13/1.28.
- Pane header: 28 px tall, contents `[StatusDot] [folder icon] [Agent label] [BranchIndicator dev] [-stop] [x close]`.
- Responsive: layout toggle row collapses to a dropdown under 720 px width.

### 5.3 Swarm room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────┬───────────────────────────────────────┤
│ Side  │  Roster: [Squad][Team][...]   │  Address Book                        │
│ bar   │  Mission: [textarea]          │   #all                               │
│ 48 px │  Brain:   [drop zone]         │   coordinator 1   ●busy              │
│       │                              │   builder 1       ●idle               │
│       │  ┌─ SwarmGrid (4×4) ────────┐ │   builder 2       ●done               │
│       │  │ Card · Card · Card · Card│ │   scout 1         ●idle               │
│       │  │ Card · Card · Card · Card│ │   reviewer 1      ●blocked            │
│       │  │ Card · Card · Card · Card│ │                                       │
│       │  │ Card · Card · Card · Card│ ├───────────────────────────────────────┤
│       │  └──────────────────────────┘ │  SideChat (live mailbox tail)        │
│       │  Roll Call · Broadcast …       │  ▸ MailboxBubble · MailboxBubble …   │
└───────┴──────────────────────────────┴───────────────────────────────────────┘
```

- Two-column body. Left column 60 % (roster + grid + broadcast bar); right column 40 % (address book + side chat).
- The 4 × 4 SwarmGrid follows `visual-spec.md` §4.3: rounded 12 px outer corners, `border-subtle` 1 px, optional brand glow on hero (top-of-room) only.
- Cards: 130 × 70 px at default density; 96 × 56 px at compact.
- Responsive: under 1080 px, the right column becomes a bottom drawer accessible via a toggle.

### 5.4 Review room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬─────────────────────────┬────────────────────────────────────────────┤
│ Side  │ Sessions awaiting review │  Diff for selected file                    │
│ bar   │ ┌──────────────────────┐ │  ┌─────── before ─────┬── after ───────┐   │
│ 48 px │ │ session 1 · 3 files  │ │  │  -line              │  +line          │   │
│       │ │ session 2 · 12 files │ │  │  …                  │  …              │   │
│       │ └──────────────────────┘ │  └────────────────────┴─────────────────┘   │
│       │                          │  Comments | Command Runner | Decide          │
└───────┴─────────────────────────┴────────────────────────────────────────────┘
```

- Three-column body (15 % / 50 % / 35 %), resizable.
- Diff viewer is split-mode by default; a toggle switches to unified.
- Command runner inline below the diff with a tail view.
- Responsive: under 1280 px, the left list becomes a dropdown above the diff.

### 5.5 Memory room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────┬───────────────────────────────────────┤
│ Side  │ Notes                         │  Editor                              │
│ bar   │ [search]                      │  # Title                             │
│ 48 px │ • title 1                     │  body markdown with [[wikilinks]]    │
│       │ • title 2                     │  …                                   │
│       │ • title 3                     ├───────────────────────────────────────┤
│       │                              │  Backlinks · Suggested · Tags         │
│       │ [Toggle Graph]               ├───────────────────────────────────────┤
│       │                              │  MemoryGraphCanvas (toggleable)      │
└───────┴──────────────────────────────┴───────────────────────────────────────┘
```

- Two-column body (30 % / 70 %). The Graph view replaces the Editor when toggled.
- Graph canvas: full-bleed inside the right column; pan + zoom + drag; hover-pulse uses `--brand-cool-glow`.

### 5.6 Browser room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────────────────────────────────────────────┤
│ Side  │ BrowserTabBar  ●driving                                              │
│ bar   ├──────────────────────────────────────────────────────────────────────┤
│ 48 px │ ⟵ ⟶ ↻  https://...                            ⨯ devtools  □ design  │
│       ├──────────────────────────────────────────────────────────────────────┤
│       │                                                                      │
│       │            WebContentsView (full body)                              │
│       │                                                                      │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Top: tab strip at 32 px; address bar at 36 px; combined chrome 68 px.
- WebContentsView fills remaining body.
- Agent-drive indicator: a 6 px dot inside the active tab; on call, a soft ripple expands to 12 px and back over 500 ms.

### 5.7 Skills room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────────────────────────────────────────────┤
│ Side  │  Drop SKILL.md or skill folder here  (or Shift+drop anywhere)        │
│ bar   ├──────────────────────────────────────────────────────────────────────┤
│ 48 px │  ┌── SkillCard ───────────────────────────────────────────────────┐  │
│       │  │ name            description...                                 │  │
│       │  │ providers: [Claude ✓][Codex ✓][Gemini ✓]   v1.2  ⚠ 1 warning   │  │
│       │  └─────────────────────────────────────────────────────────────────┘  │
│       │  ┌── SkillCard ───────────────────────────────────────────────────┐  │
│       │  │ ...                                                            │  │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Drop zone: full-width, 96 px tall, dashed `--border-subtle` border, lights up `--accent` on `dragenter`.
- SkillCard: 88 px tall, two columns (text 70 % / actions 30 %).

### 5.8 Tasks room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────────────────────────────────────────────┤
│ Side  │  Todo (n)        In Progress (n)     In Review (n)     Done (n)      │
│ bar   │  ┌──────────┐    ┌──────────┐        ┌──────────┐      ┌──────────┐ │
│ 48 px │  │ TaskCard │    │ TaskCard │        │ TaskCard │      │ TaskCard │ │
│       │  ├──────────┤    ├──────────┤        ├──────────┤      ├──────────┤ │
│       │  │ TaskCard │    │ TaskCard │        │          │      │          │ │
│       │  ├──────────┤    │   …      │        │          │      │          │ │
│       │  │   +      │    │          │        │          │      │          │ │
│       │  └──────────┘    └──────────┘        └──────────┘      └──────────┘ │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Four columns; each column 24 px gutter; cards 280 px wide at default density, 240 px at compact.
- Responsive: under 1080 px, fewer columns visible at once with horizontal scroll; under 720 px, columns stack with collapse toggles.

### 5.9 Settings room

- Left rail (180 px) with sections: Providers, Themes, MCP Servers, Shortcuts, Logs, About.
- Right body shows the section content with consistent 24 px gutter.

### 5.10 Bridge Assistant room

```
┌── TopTabStrip ───────────────────────────────────────────────────────────────┐
├───────┬──────────────────────────────────────────────────────────────────────┤
│ Side  │  Conversation (markdown bubbles)                                      │
│ bar   │  ┌─ Tool call: launch_pane(claude, 4) ─┐                             │
│ 48 px │  │ inputs: { ... }                     │                             │
│       │  │ output: 4 sessions started          │                             │
│       │  └─────────────────────────────────────┘                             │
│       │  Type a message...                              [Send] (Cmd+Enter)   │
└───────┴──────────────────────────────────────────────────────────────────────┘
```

- Two-column at >1280 px: left chat / right tool-call inspector.
- Single column otherwise: tool-call inspector as collapsible cards inline.

### 5.11 Command Palette overlay

- 640 px wide, max 480 px tall, centred horizontally, top offset 96 px.
- `--bg-elevated` background, `--border-strong` 1 px, `--radius-lg` corners.
- Result groups: Rooms · Workspaces · Providers · Skills · Tasks · Memory · Actions.

---

## 6. Iconography

`lucide-react` is the single icon source.

### 6.1 Sidebar / room icons

| room | icon |
|---|---|
| Workspaces | `LayoutGrid` |
| Command | `Terminal` |
| Swarm | `Users` |
| Review | `ClipboardCheck` |
| Memory | `Brain` |
| Browser | `Globe` |
| Skills | `Sparkles` |
| Tasks | `KanbanSquare` |
| Settings | `Settings` |
| Bridge Assistant | `BotMessageSquare` |
| Command Palette (header hint only) | `Command` |

### 6.2 Role icons

| role | icon |
|---|---|
| Coordinator | `Crown` |
| Builder | `Hammer` |
| Scout | `Telescope` |
| Reviewer | `ShieldCheck` |

### 6.3 Provider icons

| provider | icon | colour |
|---|---|---|
| claude | `Bot` | `#E57035` |
| codex | `Code2` | `#10A37F` |
| gemini | `Sparkles` | `#4285F4` |
| kimi | `Moon` | `#22D3EE` |
| cursor | `MousePointer2` | `#A855F7` |
| opencode | `Code` | `#F97316` |
| droid | `Cpu` | `#22C55E` |
| copilot | `Github` | `#FFFFFF` (on dark) |
| aider | `Wrench` | `#EAB308` |
| continue | `Play` | `#6366F1` |
| custom | `Settings` | `#6B7280` |

### 6.4 Pane / chrome icons

| element | icon |
|---|---|
| Status dot | rendered as a 6 px filled circle, not lucide |
| Branch indicator | `GitBranch` 12 px |
| Close pane | `X` 14 px |
| Stop pane | `Square` 12 px |
| Restart pane | `RotateCw` 12 px |
| Add pane | `Plus` 14 px |
| Settings | `Settings` 16 px |
| Brand monogram | custom inline SVG (lightning bolt) — `app/src/renderer/assets/monogram.svg` |

---

## 7. Motion

```css
:root {
  --motion-fast:        120ms;
  --motion-standard:    180ms;
  --motion-emphasised:  240ms;
  --ease-standard:      cubic-bezier(.2,.0,.0,1);
  --ease-emphasised:    cubic-bezier(.3,.0,.0,1);
  --ease-decelerate:    cubic-bezier(.0,.0,.2,1);
}
```

Per-element rules:
- Hover transitions: 120 ms / `--ease-standard`.
- Modal enter: 180 ms / `--ease-emphasised`. Modal exit: 120 ms / `--ease-standard`.
- Tab switch: 120 ms cross-fade.
- Pane status pulse: 1.6 s breathing, `ease-in-out`, `--status-running` halo at 35 % opacity, only while `running`.
- Brand glow pulse on hero surfaces: 4.0 s breathing, only on Bridge Assistant header and Swarm room SwarmGrid border. Pause when the user has `prefers-reduced-motion: reduce`.
- Jump to pane: pane border briefly transitions to `--brand-cool` over 240 ms, then back over 240 ms.
- Agent-drive indicator ripple: 500 ms total (180 ms grow, 320 ms fade).
- Drag-drop ghost: 0.6 opacity, no transition.

No animation may exceed 240 ms outside the two named breathing pulses.

---

## 8. Empty states

One short sentence per state.

| state | sentence |
|---|---|
| Workspaces — none yet | "Pick a folder to start your first workspace." |
| Command — no panes | "No agents running. Use the launcher or press Cmd+T." |
| Swarm — no swarm started | "Pick a roster preset and write a mission to launch a swarm." |
| Swarm — side chat empty | "No mailbox traffic yet. Broadcast or roll-call to wake the swarm." |
| Review — nothing to review | "Agents have not produced any reviewable changes." |
| Memory — empty hub | "Your knowledge graph is empty. Create a note to get started." |
| Memory — no search results | "No notes match. Try fewer keywords or look at orphans." |
| Browser — no tabs | "Open a URL to start. Agents can drive any tab." |
| Skills — empty | "Drop a SKILL.md or skill folder here." |
| Tasks — empty board | "No tasks yet. Add one to a column with the + button." |
| Assistant — new conversation | "Tell Bridge what you want to build." |

## 9. Error states

| state | sentence |
|---|---|
| Provider not found | "Provider not found on PATH. Open Settings → Providers to install." |
| PTY spawn failed | "The agent could not start. Check the log file for details." |
| Worktree create failed | "Could not create the worktree. Check disk space and Git permissions." |
| Mailbox write failed | "The mailbox is unreachable. The swarm may need to be restarted." |
| Skill validation failed | "This skill failed validation. See the warning badges for details." |
| Browser supervisor crash | "Playwright MCP supervisor exited. Browser is still usable, but agents cannot drive it." |
| MCP server config write failed | "Could not write the agent's MCP config. The agent will run without tools." |
| DB write failed | "Could not save state. Your last action may not persist." |
| Memory disk write failed | "Could not save the note to disk. The change is not committed." |

---

## 10. Loading patterns

- **Spinner** (shadcn) — for in-flight RPC where the latency is expected to exceed 200 ms but the result will fully replace the surface (e.g. opening a workspace, ingesting skills, switching themes — though theme switch is instant). Place inline at the action point; never block the entire room with a global spinner.
- **Skeleton** (shadcn) — for list and grid surfaces during initial load (Workspaces Recent, Tasks columns, Memory note list, Skills cards, Swarm side chat). Use the same layout box and dimensions as the real content; show for at most 800 ms before degrading to an empty state with a retry CTA.
- **Progress bar** — only for explicit long-running operations the user initiated (skill ingest of a multi-skill plugin, theme catalog import, full graph re-index). Top of the relevant room.
- **Streaming** — terminal output and Bridge Assistant tool output stream chunk-by-chunk; no spinner.
- **Indeterminate pulse** — pane border `--status-running` breathing and the agent-drive ripple are both indeterminate "I am working" cues; never use both for the same surface.

---

## 11. Accessibility floor

- All interactive elements have `aria-label` or visible label.
- Focus ring 2 px `--border-focus` with 2 px outer offset.
- Sidebar items expose `aria-current="page"` for the active room.
- Layout toggle buttons expose `aria-pressed`.
- Status dots include a screen-reader-only span ("running", "idle", "error", etc.).
- Keyboard navigation: every shortcut in `PRODUCT_SPEC.md` §13 is reachable; Tab order matches visual order.
- Reduced motion: when `prefers-reduced-motion: reduce`, all breathing pulses pause and Jump-to-pane becomes an instant border colour swap.
- Colour contrast: text on `--bg-canvas` ≥ 4.5:1; text on `--bg-pane-header` ≥ 4.5:1; status dots include shape changes (filled / hollow / ringed) so colour is never the sole channel.
