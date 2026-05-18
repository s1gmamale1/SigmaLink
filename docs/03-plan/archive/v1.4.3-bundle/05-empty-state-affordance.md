# 05 — EmptyState Defensive UX (P3)

**Severity**: P3 — defense-in-depth UX; the actual fix is #02
**Effort**: XS (~1hr)
**Cluster**: A (pane-grid — bundled with #06 in ONE PR)
**Suggested delegate**: Qwen via OpenCode OR Sonnet
**Depends on**: #02 (only meaningful after rehydration delivers sessions)
**Blocks**: nothing

## Context

User report: "+Pane button still not working and not even a clickable element. It's either disabled button or just a triangle box."

Investigation revealed the "triangle box" is the `EmptyState` component's `<Button>Go to Workspaces</Button>` action that renders when `sessions.length === 0` at `CommandRoom.tsx:195-208`. The +Pane button JSX is byte-identical to v1.4.1 and renders correctly — but it lives in the TOP-BAR that never mounts in the empty-state path.

Once #02 fixes rehydration, restored workspaces will have sessions and the top-bar (with +Pane button) will render normally. **#05 is defense-in-depth**: if rehydration ever regresses again, OR if a user genuinely lands in an empty workspace (e.g. all sessions exited gracefully), they get a recovery affordance INLINE in the EmptyState — no need to walk back through Workspaces → Launcher → grid wizard.

## File:line targets

### `app/src/renderer/features/command-room/CommandRoom.tsx:195-208`

Current empty-state branch:

```tsx
if (sessions.length === 0) {
  return (
    <EmptyState
      icon={TerminalIcon}
      title="No agents launched yet"
      description="Head back to the Workspaces room to pick a grid preset and launch."
      action={
        <Button size="sm" onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}>
          Go to Workspaces
        </Button>
      }
    />
  );
}
```

Replace with:

```tsx
if (sessions.length === 0) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[CommandRoom] Empty state — workspace activated but sessions slice empty. ' +
      'Either user just landed on a fresh workspace, OR rehydration failed.'
    );
  }
  const canAddPane = activeSwarm?.status === 'running' && providers.length > 0;
  return (
    <EmptyState
      icon={TerminalIcon}
      title="No agents launched yet"
      description={
        canAddPane
          ? "Add your first pane below, or go back to Workspaces to pick a grid preset."
          : "Head back to the Workspaces room to pick a grid preset and launch."
      }
      action={
        <div className="flex gap-2">
          {canAddPane && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void addPane(providers[0].id)}
              disabled={adding}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add first pane
            </Button>
          )}
          <Button size="sm" onClick={() => dispatch({ type: 'SET_ROOM', room: 'workspaces' })}>
            Go to Workspaces
          </Button>
        </div>
      }
    />
  );
}
```

**Key behaviors**:
- Only show "Add first pane" when swarm is running AND providers list is loaded (avoids broken-click state)
- Reuse the existing `addPane` function from the +Pane button (same `useCallback` reference at line 201)
- Pick `providers[0].id` as the default (typically Claude); could be smarter but unnecessary for v1.4.3
- Dev-only `console.warn` surfaces the empty-state mount so future dogfood reports can confirm whether rehydration happened
- Description text adapts based on canAddPane

### NEW `app/src/renderer/features/command-room/CommandRoom.test.tsx`

This file doesn't exist today per the investigation. Create it with these initial cases:

1. **Empty state, swarm running, providers loaded** — both buttons render
2. **Empty state, swarm paused** — only "Go to Workspaces" renders (canAddPane = false)
3. **Empty state, providers list empty** — only "Go to Workspaces" renders
4. **Non-empty state (sessions.length > 0)** — neither EmptyState nor "Add first pane" renders; top-bar with +Pane button renders
5. **Click "Add first pane"** — calls addPane with providers[0].id

Use React Testing Library; mock `useAppState`, `useDispatch`, `rpc.providers.list`, `addPane`.

## Gate

```bash
cd /Users/aisigma/projects/SigmaLink-feat-v1.4.3-05-06-pane-features/app
pnpm exec tsc -b --pretty false           # clean
pnpm exec vitest run                       # +5 new cases
pnpm exec eslint .                         # 0 errors
pnpm run build                              # clean
```

**Manual smoke**:
1. Open a workspace with the dev DB cleared (`sqlite3 ... "DELETE FROM agent_sessions WHERE workspace_id = ?"`).
2. Reopen the workspace → CommandRoom empty state.
3. Verify the EmptyState shows "Add first pane" + "Go to Workspaces" buttons (assuming workspace has a swarm).
4. Click "Add first pane" → pane spawns with first available provider.
5. Verify the top-bar +Pane button is now visible (sessions.length > 0).

## Risks

- **R-05-1** Bypassing the Launcher wizard skips the user's intentional provider/grid choice. Acceptable for the recovery path (user has already opened the workspace; just wants a quick recovery).
- **R-05-2** `providers[0]` might be Claude on macOS but something else on Windows depending on probe order. Document this in the per-fix MD; consider a smarter default in v1.4.4 (last-used provider per workspace).
- **R-05-3** The dev-only `console.warn` adds noise in development. Worth it for the diagnostic signal in future bug reports.

## Pairs with

- #02 — only useful AFTER rehydration is in place (else the empty state masks the rehydration bug)
- #06 — same files; same PR

## Closes

- The "triangle box" complaint at its surface (the affordance now reads "Add first pane" not "Go to Workspaces")
- The user's frustration at having to walk through the Launcher wizard for every workspace reopen edge case

## Doc source

New file — supersedes the v1.4.2 `05-add-pane-ux.md` which was based on the H1/H2/H3 hypotheses that have now been invalidated.
