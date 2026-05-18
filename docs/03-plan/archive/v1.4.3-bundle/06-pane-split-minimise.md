# 06 — Pane Split + Minimise (Feature)

**Severity**: Feature — completes the long-deferred "Coming in v1.2" tooltips
**Effort**: L (~3d)
**Cluster**: A (pane-grid — bundled with #05 in ONE PR)
**Suggested delegate**: Codex via OpenCode (mid-complexity UI + design judgment for Split modes) OR Opus
**Depends on**: nothing
**Blocks**: nothing
**Pairs with**: #05 (same files)

## Context

Pane Split (horizontal / vertical) and Pane Minimise (collapse to header strip) icons have shown "Coming in v1.2" tooltips since the v1.2.5 honest-label rename (commit `e193943`). v1.4.2 deferred this; v1.4.3 brings it forward.

The brought-forward design from `docs/03-plan/v1.4.2-bundle/13-pane-split-minimise.md` (now obsolete after merge into this file) recommended **Option B (flat group sentinel, NOT pane-tree)** — cheaper, supports 2-level deep nesting which is sufficient for v1.4.x.

User authorized inclusion in v1.4.3 via AskUserQuestion answer.

## Data model

NEW migration `app/src/main/core/db/migrations/0017_pane_split_columns.ts` adds to `agent_sessions`:

| Column | Type | Description |
|---|---|---|
| `split_group_id` | TEXT NULLABLE | Shared id for panes that form a split group. NULL = standalone. |
| `split_direction` | TEXT NULLABLE | `'horizontal'` or `'vertical'`. NULL for standalone. |
| `split_index` | INTEGER NULLABLE | 0/1 within the group. NULL for standalone. |
| `minimised` | INTEGER DEFAULT 0 | Boolean as 0/1. |

Plus a composite index: `agent_sessions_split_idx` on `(workspace_id, split_group_id)`.

Migration follows the idempotent pattern from 0014/0015 (CREATE TABLE IF NOT EXISTS / PRAGMA introspection / BEGIN/COMMIT/ROLLBACK).

Register in `app/src/main/core/db/migrate.ts`.

Update `app/src/main/core/db/schema.ts` Drizzle schema.

## File:line targets

### Main process

**NEW RPC** `rpc.swarms.splitPane({ paneId, direction, provider }): Promise<AgentSession>` in `app/src/main/rpc-router.ts`. Reuses `addAgentToSwarm()` at `factory.ts:198` for the actual spawn primitive.

```ts
'swarms.splitPane': async ({ paneId, direction, provider }) => {
  const parent = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(paneId);
  if (!parent) throw new Error('parent pane not found');
  if (parent.split_group_id) {
    throw new Error('pane is already in a split group (max 2-level deep in v1.4.x)');
  }

  const groupId = parent.split_group_id ?? `split-${randomUUID()}`;

  // Reuse the existing spawn primitive (sub-pane shares parent's worktree)
  const newSession = await addAgentToSwarm({
    swarmId: parent.swarm_id,
    workspaceId: parent.workspace_id,
    providerId: provider,
    cwd: parent.cwd,                  // SHARE parent's cwd
    worktreePath: parent.worktree_path, // SHARE parent's worktree
    // ... other inherited fields ...
  });

  // Annotate both panes
  db.prepare(`
    UPDATE agent_sessions
    SET split_group_id = ?, split_direction = ?, split_index = ?
    WHERE id = ?
  `).run(groupId, direction, 0, parent.id);

  db.prepare(`
    UPDATE agent_sessions
    SET split_group_id = ?, split_direction = ?, split_index = ?
    WHERE id = ?
  `).run(groupId, direction, 1, newSession.id);

  return newSession;
},
```

**NEW RPC** `rpc.swarms.minimisePane({ paneId, minimised: boolean }): Promise<void>` — toggles the `minimised` column.

**NEW helper** `app/src/main/core/swarms/split-dao.ts`:
- `setPaneSplit(paneId, groupId, direction, index): void`
- `setPaneMinimised(paneId, minimised: boolean): void`
- `getPaneSplitGroup(groupId): AgentSession[]`

Update `app/src/main/core/swarms/factory.ts:198` `addAgentToSwarm()` to accept optional `worktreePath` parameter (so split sub-panes share parent's worktree). Today it always creates a new worktree — modify to skip the create step when `worktreePath` is provided.

### Renderer

`app/src/renderer/features/command-room/GridLayout.tsx`:

- Read `split_group_id` from each session in the layout
- Group adjacent panes with same `split_group_id` into a single grid cell
- Within that cell, render a sub-grid: 2 cols (vertical split) or 2 rows (horizontal split)
- Sub-grid divider: similar resize-handle pattern as the main grid, but scoped to the group cell

```tsx
// Pseudocode
function GridCell({ panes }: { panes: AgentSession[] }) {
  if (panes.length === 1) return <SessionTerminal session={panes[0]} />;
  // Split group
  const dir = panes[0].split_direction;
  return (
    <div className={dir === 'horizontal' ? 'grid grid-rows-2' : 'grid grid-cols-2'}>
      {panes.map(p => <SessionTerminal key={p.id} session={p} />)}
      <SplitDivider direction={dir} groupId={panes[0].split_group_id!} />
    </div>
  );
}
```

`app/src/renderer/features/command-room/PaneHeader.tsx`:

- Wire `Split-H` icon click → opens provider dropdown → `rpc.swarms.splitPane({direction: 'horizontal', provider})`
- Wire `Split-V` icon click → same but `direction: 'vertical'`
- Wire `Minimise` icon click → `rpc.swarms.minimisePane({minimised: !current})`
- When `session.minimised === true`, render pane as collapsed header strip (~32px tall)
- Both Split icons disabled when pane already in a split group (max 2-level deep)

### State

`app/src/renderer/app/state.types.ts`:
- Extend `Pane` / `AgentSession` type with `splitGroupId`, `splitDirection`, `splitIndex`, `minimised` fields

`app/src/renderer/app/state.reducer.ts`:
- `SPLIT_PANE` action — adds new session AND mutates parent's split fields
- `MINIMISE_PANE` action — toggles `minimised` for one session

## Tests

### Vitest

- `app/src/main/core/db/migrations/0017_pane_split_columns.test.ts` — idempotent migration, columns/index present
- `app/src/main/core/swarms/split-dao.test.ts` — `setPaneSplit`, `setPaneMinimised`, `getPaneSplitGroup`
- `app/src/main/rpc-router.test.ts` — `swarms.splitPane` happy path, max-depth rejection, worktree sharing
- `app/src/renderer/features/command-room/GridLayout.test.tsx` — sub-grid renders for split groups; standalone panes unaffected
- `app/src/renderer/features/command-room/PaneHeader.test.tsx` — Split-H/V icon onClick wired; Minimise toggle

### E2E

NEW `tests/e2e/pane-split.spec.ts`:

1. Open 4-pane grid (Claude in all 4)
2. Click Split-H on pane 1 → provider dropdown opens → pick Codex
3. Assert: pane 1 area now shows 2 sub-panes (Claude on top, Codex below), both alive
4. Drag the sub-divider; assert proportions update
5. Click Minimise on Codex sub-pane; assert collapsed to header strip
6. Click again to restore
7. Quit + reopen app; verify split group persists (depends on #02 rehydration)

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-05-06-pane-features/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # +15-20 new cases
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
node scripts/build-electron.cjs             # clean
```

**Manual smoke** (REQUIRED — new feature):
- Open 4-pane Claude grid
- Split pane 1 horizontally with Codex → both render side-by-side, both PTYs live
- Send turns in each sub-pane → both respond
- Resize divider → both sub-panes resize smoothly
- Minimise pane 2 → collapses to header strip; PTY keeps emitting (verify by un-minimising)
- Quit + reopen → split group restored

## Risks

- **R-06-1** Worktree sharing — if two providers in the same split group both modify `package.json`, they could conflict. Document: split sub-panes are co-tenants on the same git branch; user is responsible for coordination. Worktree share is intentional design.
- **R-06-2** Resize calculation for sub-grid — fractional CSS Grid units within an already-fractional parent. Test on 4×4 and 5×5 grids; ensure no overflow.
- **R-06-3** `factory.ts:198` `addAgentToSwarm` change to accept optional `worktreePath` — verify all existing callers don't pass it (don't break the create-fresh path).
- **R-06-4** Max-depth — splitting an already-split pane is rejected with a clear error toast. Future v1.5+ could support deeper nesting via pane-tree (Option A from the original brief).
- **R-06-5** terminal-cache + split — each sub-pane is a separate `<SessionTerminal>` with its own sessionId, so the v1.4.2 #03 cache handles their lifecycles transparently. Verify by reading `terminal-cache.ts` — no changes needed there.

## Pairs with

- #05 — same files (`CommandRoom.tsx`, `PaneHeader.tsx`, `GridLayout.tsx`), same PR

## Closes

- The "Coming in v1.2" tooltips on Split-H, Split-V, and Minimise icons (latent since v1.2.5)
- BACKLOG.md "Split / Minimise pane actions" rows
- WISHLIST "Pane Split + Minimise functional implementations" L row

## Doc source

Brought forward from `docs/03-plan/v1.4.2-bundle/13-pane-split-minimise.md` (now obsolete; superseded by this file).
