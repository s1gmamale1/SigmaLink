# 13 — Pane Split + Minimise (functional implementations)

**Severity**: Feature
**Effort**: L (~3d)
**Cluster**: Pane-grid Cluster B (after #05)
**Suggested delegate**: Codex via OpenCode
**Depends on**: #05 (same files) — bundle into ONE PR

## Context

Pane Split (horizontal / vertical) and Pane Minimise (collapse to header strip) icons are present in `PaneHeader.tsx` but currently show "Coming in v1.2" tooltips and are no-ops. v1.4.2 makes them functional.

This is the heaviest packet in the v1.4.2 bundle. Don't underestimate scope.

## Concept

### Split

- **Horizontal split**: divide the pane into top/bottom; the new sub-pane gets a new provider choice.
- **Vertical split**: divide the pane into left/right.
- Each sub-pane has its own PTY, its own worktree (or shares with parent?), its own header.
- Sub-panes can be re-split (recursive tree).

### Minimise

- Collapse pane to a header strip (~32px tall). xterm content hidden but PTY running.
- Restore via clicking the header.

## State model

Current pane state is flat: an array of `Pane` objects in `swarms.panes`. Split requires a tree.

Two options:
- **A — Pane-tree**: replace flat array with binary tree (`PaneNode | SplitNode`). Recursive render. Cleanest model but invasive refactor.
- **B — Group sentinel**: keep flat array but add `splitGroupId` + `splitDirection` + `splitIndex` fields to `Pane`. Adjacent panes with same groupId render together. Less invasive but doesn't compose well with recursion.

**Recommendation**: B for v1.4.2 (cheaper, 2-level deep is enough for now). Defer A to v1.5+ if users want deeper nesting.

## Implementation outline

### Backend (main process)

`addAgentToSwarm()` at `factory.ts:198` already supports adding a pane to a swarm. For Split:

1. New RPC: `rpc.swarms.splitPane({ paneId, direction: 'horizontal' | 'vertical', provider: ProviderId })`
2. Calls `addAgentToSwarm()` to spawn the new pane.
3. New DAO: `setPaneSplit({ paneId, groupId, direction, index })` — annotates both old and new panes with the same `groupId`.
4. New migration `0016_pane_split_columns.ts` — adds `split_group_id`, `split_direction`, `split_index` columns to `panes` table.

### Renderer (Command Room)

1. Group adjacent panes with same `splitGroupId` into a single grid cell.
2. Within that cell, render a sub-grid: 2 columns (vertical split) or 2 rows (horizontal split).
3. Pane header `+ Split H` and `+ Split V` icons → open provider dropdown → dispatch `splitPane(...)`.
4. Pane header `Minimise` icon → toggle a `minimised: boolean` field on `Pane`. Renderer collapses pane to header-only when true.
5. Resize handles between sub-panes within a group.

### Migration

`0016_pane_split_columns.ts` idempotent ALTER TABLE per existing pattern (0011-0015).

## File:line targets

| File | Operation |
|---|---|
| `app/src/main/core/db/migrations/0016_pane_split_columns.ts` (NEW) | Add `split_group_id`, `split_direction`, `split_index`, `minimised` columns |
| `app/src/main/core/db/migrate.ts` | Register 0016 |
| `app/src/main/core/db/schema.ts` | Add fields to `panes` Drizzle schema |
| `app/src/main/core/swarms/factory.ts` | `splitPane()` operation; reuse `addAgentToSwarm` for the spawn |
| `app/src/main/rpc-router.ts` | New `rpc.swarms.splitPane` handler |
| `app/src/main/core/swarms/swarms-dao.ts` | `setPaneSplit()`, `setPaneMinimised()` DAO functions |
| `app/src/renderer/features/command-room/GridLayout.tsx` | Group splits; sub-grid layout; resize handles |
| `app/src/renderer/features/command-room/PaneHeader.tsx` | Wire Split (H/V) + Minimise icons |
| `app/src/renderer/features/command-room/CommandRoom.tsx` | Pass split state to GridLayout |
| `app/src/renderer/app/state.types.ts` | Extend `Pane` type with split fields |
| `tests/e2e/pane-split.spec.ts` (NEW) | Cover split H, split V, minimise, nested behavior |

## Verification

- Vitest: GridLayout test for sub-grid render.
- Vitest: factory.test.ts for splitPane spawn.
- Playwright: split a Claude pane horizontally with Codex; both PTYs live; resize divider; minimise one; restore.
- Manual: 4-pane workspace → split each → resulting 4 split groups → all PTYs running.

## Reusable utilities

- `addAgentToSwarm()` at `factory.ts:198` — the existing spawn primitive
- `rpc.workspaces.createWorktree` for sub-pane worktree (or share with parent? — decision needed)
- #03's terminal-preservation mechanism (sub-panes must also preserve xterm on remount)
- #12's focus model (focused pane can be a split group? — defer; top-level only)

## Risks

- R-13-1: Worktree-per-sub-pane proliferates worktrees. Decision: share worktree with parent (sub-panes are co-tenants on same git branch). Document explicitly.
- R-13-2: Resize within group conflicts with grid divider resize. Need clear hit-targets.
- R-13-3: 3-day estimate may be optimistic if a pane-tree refactor (Option A) ends up being needed.

## Cross-references

- BACKLOG.md "Split / Minimise pane actions" (lines 107-111, 349-352)
- WISHLIST line 77
- v1.2.5 commit `e193943` first introduced the disabled tooltip

## Pairs with

- #05 (same files — bundle as one PR for Cluster B)
- #12 (don't merge until #12 also done — they share PaneHeader.tsx and GridLayout.tsx)
