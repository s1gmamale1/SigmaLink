# W6 — Review Room + Tasks/Kanban (Phase 6)

## Summary

Shipped a working Review Room, a Kanban-style Tasks board, and the
backend infrastructure both lean on. The legacy `app/src/_legacy/sections/ReviewRoom.tsx`
remains untouched; the new code lives entirely under
`app/src/renderer/features/review/` and `app/src/renderer/features/tasks/`,
fed by `app/src/main/core/review/` and `app/src/main/core/tasks/`.

Build pipeline status (4/4 green at no-regression baseline):

- `tsc -b && vite build` — 0 errors
- `node scripts/build-electron.cjs` — 0 errors (main + preload + mcp-memory-server)
- `npm run lint` — 55 problems (down from the pre-W6 baseline of 60); zero
  problems originate in any of the W6 files.
- `npm run product:check` — green

## Room layout choice

Tasks ships as its own room (`tasks` in `RoomId`), not as a sub-tab of the
Review Room. Reasons:

- The PRODUCT_SPEC C-014 contract lists Tasks as one of the eleven
  top-level rooms, with a dedicated `Cmd+Shift+7` shortcut.
- The UX critique U11 worry was about *assignment* UI being modal-heavy.
  We resolved that inline: tasks are assigned by *dragging the card* onto
  the swarm-roster rail in the Tasks room, with no modal in between.
- Keeping Tasks separate avoided overloading the Review Room's three-pane
  layout (session list / detail / batch toolbar).

The Tasks room renders the active swarm's roster as a drop target on the
right rail. When a task card is dropped on a roster slot, the agent's
mailbox receives a `SAY` envelope whose body is `SIGMA::TASK <title>`
and whose payload carries `{taskId, description}` so existing
swarm-bridge code keeps working unchanged.

## File map

### New main-process files

- `app/src/main/core/review/types.ts` — re-exports the cross-process
  Review types so the backend has a single import point.
- `app/src/main/core/review/diff.ts` — `computeReviewDiff` and
  `computeConflicts`. Detects detached HEAD via `git symbolic-ref`,
  caps `git diff HEAD` at 16 MiB, slices to ~5 MiB on overflow with a
  `truncated: true` flag, and walks `git ls-files --others
  --exclude-standard` to fold untracked files into the file tree.
  Submodules are silently skipped (the `ls-files` filter rejects entries
  whose stat is a directory) and LFS pointer files flow through normally.
- `app/src/main/core/review/runner.ts` — `ReviewRunner` class. Spawns
  shell commands inside a worktree (using the same `tokenizeShellLine`
  + `resolveWindowsCommand` that the rest of the launcher uses), pipes
  stdout/stderr back through the new `review:run-output` event, and
  persists the last command + exit code on the `session_review` row when
  the process closes.
- `app/src/main/core/review/controller.ts` — `buildReviewController`
  exposing `list`, `getDiff`, `getConflicts`, `runCommand`, `killCommand`,
  `setNotes`, `markPassed`, `markFailed`, `commitAndMerge`, `dropChanges`,
  `pruneOrphans`, `batchCommitAndMerge`. `commitAndMerge` (single + batch)
  cleans up the worktree and deletes the branch on success, then sets
  decision=passed and clears the session's `worktree_path`.
- `app/src/main/core/tasks/types.ts` — task type re-exports.
- `app/src/main/core/tasks/manager.ts` — `TasksManager` class with CRUD,
  status moves, swarm-agent assignment, and a comment thread.
- `app/src/main/core/tasks/controller.ts` — `buildTasksController`. The
  `assignToSwarmAgent` channel both stores the assignment and writes a
  TASK envelope into the agent's mailbox.

### New renderer files

- `app/src/renderer/features/review/ReviewRoom.tsx` — main page.
- `app/src/renderer/features/review/SessionList.tsx` — left rail with
  status badges + multi-select checkboxes.
- `app/src/renderer/features/review/SessionDetail.tsx` — header
  toolbar + tab strip (Diff / Tests / Notes / Conflicts).
- `app/src/renderer/features/review/DiffView.tsx` — file tree on the
  left, hand-rolled unified/split diff renderer on the right.
- `app/src/renderer/features/review/TestsTab.tsx` — command box,
  Run/Stop, and a streaming output buffer (`review:run-output`).
- `app/src/renderer/features/review/NotesTab.tsx` — notes textarea,
  saves on blur.
- `app/src/renderer/features/review/ConflictsTab.tsx` — predicted
  conflict list with refresh button.
- `app/src/renderer/features/review/BatchToolbar.tsx` — bottom-of-rail
  bar that runs `batchCommitAndMerge` and shows a per-session stepper.
- `app/src/renderer/features/tasks/TasksRoom.tsx` — Kanban board with
  five columns + a swarm roster drop rail.
- `app/src/renderer/features/tasks/Column.tsx` — drop column.
- `app/src/renderer/features/tasks/Card.tsx` — draggable card.
- `app/src/renderer/features/tasks/TaskDetailDrawer.tsx` — edit + comments.
- `app/src/renderer/features/tasks/NewTaskDrawer.tsx` — create dialog.

### Modified files (additive Edits)

- `app/src/main/core/db/schema.ts` — appended `tasks`, `task_comments`,
  `session_review` Drizzle tables.
- `app/src/main/core/db/client.ts` — appended `CREATE TABLE IF NOT EXISTS`
  statements for the three new tables.
- `app/src/main/core/git/git-ops.ts` — added `mergePreview(repoRoot,
  base, branch)` (uses `git merge-tree --write-tree --name-only` with a
  name-only intersection fallback for older Git) and `dropChanges(worktreePath)`.
- `app/src/main/core/git/worktree.ts` — added `WorktreePool.removeAndPrune`.
- `app/src/main/rpc-router.ts` — wired `ReviewRunner`, `TasksManager`,
  `buildReviewController`, `buildTasksController`. Cleaned up the runner
  in `shutdownRouter`.
- `app/src/shared/types.ts` — appended `ReviewSession`, `ReviewDiff`,
  `ReviewConflict`, `ReviewState`, `BatchCommitResult`, `Task`,
  `TaskAssignment`, `TaskComment`, `TaskStatus`.
- `app/src/shared/router-shape.ts` — added `review` and `tasks` namespaces.
- `app/src/shared/rpc-channels.ts` — added 12 review channels, 11 tasks
  channels, and three new events (`review:changed`, `review:run-output`,
  `tasks:changed`).
- `app/src/shared/events.ts` — added the three new events to `EventMap`.
- `app/src/renderer/app/state.tsx` — appended `review` and `tasks` slices,
  hydration effects on workspace switch, and live refresh on the matching
  events.
- `app/src/renderer/app/App.tsx` — wired `ReviewRoom` and `TasksRoom`.
- `app/src/renderer/features/sidebar/Sidebar.tsx` — dropped the `phase: 4`
  pill on Review and added a Tasks nav item.

## Architecture notes (A8 — worktree pool gaps)

The diff/runner code addresses every concrete A8 point that was in scope
for this phase:

- **Detached HEAD** — `computeReviewDiff` calls `git symbolic-ref -q HEAD`
  before pulling status. If the worktree is detached the call exits
  non-zero, we keep `branch = "HEAD (detached)"`, and every downstream
  command targets `HEAD` directly so nothing assumes a branch ref.
- **Submodules** — we never recurse with `--recurse-submodules`. The
  untracked-file scan also drops directory entries (a freshly-checked-out
  gitlinked submodule reports as an untracked dir) so they don't leak
  into the diff file tree.
- **LFS** — pointer files are plain text from Git's perspective; the
  diff renderer treats them like any other text patch and the runner
  doesn't try to fetch object data.
- **Big repos** — `git diff HEAD` runs with `maxBuffer: DIFF_HARD_CAP`
  (16 MiB). On overflow we keep the first ~5 MiB of patches plus the
  full `--stat`, set `truncated: true`, and the renderer surfaces a
  prominent "diff truncated" banner.

## UX critique notes (U9 — batch approve, unified diff, conflicts)

- **Batch approve** — `BatchToolbar` selects multiple sessions via
  checkboxes and runs `batchCommitAndMerge` serially with a stepper. On
  the first failure we stop, surface the error, and still report the
  per-session outcomes for the items that succeeded.
- **Unified diff** — `DiffView` defaults to unified, with a split toggle
  in the header. The hand-rolled patch parser is dependency-free
  (no new deps).
- **Conflicts** — the Conflicts tab calls `git merge-tree --write-tree
  --name-only --merge-base=<base> <base> <branch>` against the
  workspace's first existing branch out of {`main`, `master`, `develop`}.
  When that command is not available (older Git) the fallback intersects
  the name-only diffs from each side of the merge base. Each row shows
  which method produced it.

## Persistence

Three new tables, all CASCADEd from their parent so workspace deletion
cleans everything up:

- `tasks(id, workspace_id, title, description, status, assigned_session_id?,
  assigned_swarm_id?, assigned_swarm_agent_id?, labels_json, created_at,
  updated_at, archived_at?)`
- `task_comments(id, task_id, author, body, created_at)`
- `session_review(session_id, notes, decision?, decided_at?,
  last_test_command?, last_test_exit_code?, updated_at)`

Restart preserves task state and review notes — they're queried from these
tables on every workspace switch and the renderer slices are repopulated
from the controller's `list` calls.

## Dependencies

No new dependencies were added. `@dnd-kit/*` was already in
`package.json`. The hand-rolled diff renderer kept us off
`react-diff-viewer-continued`.

## Out of scope (per the task brief)

Three-way merge conflict editor, multi-repo workspaces, per-line code
review comments, and AI-generated commit messages were not in scope.

## Open follow-ups

- The Diff tab loads the patch synchronously over RPC; for very large
  repos the round-trip could be paginated, but the 16 MiB cap and
  truncation logic make this safe today.
- "Open in editor" uses an anchor with a `file://` URL so the OS handler
  picks it up; a dedicated `app.openPath` channel would be more robust
  on Windows where Chromium often blocks `file://` navigation.
- `pruneOrphans(workspaceId)` is wired and exposed but not yet used
  from the renderer; future work will plug it into the
  workspace-launcher's reset path.
