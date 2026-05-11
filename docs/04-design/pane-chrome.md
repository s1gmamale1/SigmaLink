# Pane chrome — v1.1.4

v1.1.4 collapsed the per-pane header from two strips (h-7 PaneHeader + h-6 PaneStatusStrip = h-13 total) into a single h-7 strip. This doc captures the new layout, where the dropped info went, and how the icon row maps to existing state.

## Header layout

```
┌──────────────────────────────────────────────────────────────────┐   ← 2px provider colour stripe
│ ● CLAUDE·1                                  [⊞] [║] [▽] [×]      │   ← h-7 strip
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│                  terminal output                                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Pieces, left to right:

| Piece | Source |
|---|---|
| **2px colour stripe** (top edge) | `providerColor(session.providerId)` |
| **Status dot** (●) | green=running, amber=error, grey=exited |
| **Truncated `PROVIDER·index` label** | `provider.name.toUpperCase().slice(0,8) + '·' + paneIndex`, `max-w-[80px]` truncate |
| **Tooltip on hover of the label** | branch · model · effort · cwd (Radix `<Tooltip>`) |
| **Focus icon (⊞)** | lucide `Maximize2` → `ctx.activate(session.id)` (existing `paneFocus` state) |
| **Split icon (║)** | lucide `Columns2` → disabled, tooltip "Coming in v1.2" |
| **Minimise icon (▽)** | lucide `Minimize2` → disabled, tooltip "Coming in v1.2" |
| **Close icon (×)** | lucide `X` → `rpc.pty.kill(session.id)` |

Each icon button: ~14px glyph in a 24px tap target. Hover bg-muted; disabled buttons get `opacity-40 cursor-not-allowed`.

## What moved where

| v1.1.3 location | v1.1.4 location |
|---|---|
| Stop button (in header) | Right-click context menu on pane body (`Stop` + `Close pane` items) |
| Model / effort labels (PaneStatusStrip) | Tooltip body on the provider name |
| Working directory (PaneStatusStrip) | Tooltip body on the provider name |
| Branch label (header) | Tooltip body on the provider name |

`PaneStatusStrip.tsx` is **deleted**. All imports/references removed from `CommandRoom.tsx`.

## Right-click context menu

`CommandRoom.tsx` `PaneCell` wraps the pane body in a Radix `<ContextMenu>` with:

- **Stop** (destructive variant): calls `rpc.pty.kill(session.id)`. Disabled when `session.status === 'exited' || 'error'`.
- **Close pane** (destructive variant): same RPC, always enabled.

## Active-pane focus

The Focus icon (⊞) binds to the existing `paneFocus` state machine in `CommandRoom.tsx`. Clicking Focus expands the pane to fill the grid; Esc unfocuses (handler already in `Terminal.tsx`). The keyboard shortcut Cmd+Shift+M still works.

Active-pane ring: keeps the existing `--ring` token (SigmaLink primary blue). V3 used orange; the SigmaLink brand rebrand applies — primary blue stays.

## Pane index

`paneIndex` is 1-based and derived from `ctx.index + 1` inside `GridLayout.renderCell`. Two Claude panes side-by-side will show `CLAUDE·1` and `CLAUDE·2`, distinguishable when truncated to 8 chars.

## GridLayout shapes (v1.1.4)

`shapeFor(count)` adds a single new tier for the 9-pane case:

```ts
if (count <= 1) return { cols: 1, rows: 1 };
if (count === 2) return { cols: 2, rows: 1 };
if (count <= 4) return { cols: 2, rows: 2 };
if (count <= 6) return { cols: 3, rows: 2 };
if (count <= 8) return { cols: 4, rows: 2 };
if (count <= 10) return { cols: 5, rows: 2 };
if (count === 9) return { cols: 3, rows: 3 };     // ← NEW v1.1.4
if (count <= 12) return { cols: 4, rows: 3 };
if (count <= 16) return { cols: 4, rows: 4 };
return { cols: 5, rows: 4 };
```

The 9 → 3×3 tier sits above the 12-tier so 9 panes match V3 reference (no empty trailing cell). 10/11/12 are unchanged at 4×3.
