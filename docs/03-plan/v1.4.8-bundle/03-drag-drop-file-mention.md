# Packet 03 — Drag-and-drop file → pane @-mention

**Severity**: Feature (user-requested 2026-05-19)
**Effort**: M (~4-6 hr)
**Cluster**: Pane composer / file integration
**Suggested delegate**: Sonnet (UI + main-process IPC, needs DOM drag-drop API)
**Depends on**: nothing
**Blocks**: nothing

## Context

User flow ask:
> "I'm reviewing file that agent did, and see bro needs change or fed up, so I drag that file to the pane, it will auto mention like `@file-name` and proceed with prompt."

Drag-and-drop a file (from the IDE file-tree, Finder, or anywhere) onto a pane → composer auto-inserts `@<file-name>` (or `@<workspace-relative-path>`) and the user continues typing their prompt.

This mirrors Cursor / Claude Code / GitHub Copilot Chat file-mention UX.

## Files

- `app/src/renderer/features/command-room/PaneShell.tsx` (or wherever the pane outer container lives — grep for `Pane` + `dragOver`)
- `app/src/renderer/features/command-room/PaneComposer.tsx` (the per-pane input/composer if one exists; otherwise the pane's xterm wrapper handles input)
- `app/src/main/core/pty/registry.ts` (lines around the pty write handler)
- `app/src/renderer/features/editor/EditorTab.tsx` (the IDE file-tree — needs `draggable` attribute on file rows)
- `app/preload/preload.ts` (or `electron-dist/preload.cjs`) — verify the renderer has access to dropped file paths

## Approach

### Renderer side

1. **Source — make file-tree rows draggable**: in `EditorTab.tsx`, on each file row's element, add:
   ```tsx
   draggable
   onDragStart={(e) => {
     e.dataTransfer.setData('application/sigmalink-file', JSON.stringify({
       path: file.relativePath,
       absolutePath: file.absolutePath,
       workspaceId
     }));
     e.dataTransfer.effectAllowed = 'copy';
   }}
   ```

2. **Target — pane wrapper accepts the drop**: in `PaneShell.tsx` (or equivalent), add:
   ```tsx
   onDragOver={(e) => {
     if (e.dataTransfer.types.includes('application/sigmalink-file') ||
         e.dataTransfer.types.includes('Files')) {
       e.preventDefault();
       e.dataTransfer.dropEffect = 'copy';
     }
   }}
   onDrop={(e) => {
     e.preventDefault();
     const sigmaFile = e.dataTransfer.getData('application/sigmalink-file');
     if (sigmaFile) {
       const { path } = JSON.parse(sigmaFile);
       insertMention(paneId, path);
     } else if (e.dataTransfer.files.length > 0) {
       // Finder drop — Electron exposes `file.path` via webUtils.getPathForFile
       for (const file of e.dataTransfer.files) {
         const absPath = window.electron.webUtils?.getPathForFile?.(file);
         const rel = computeWorkspaceRelative(absPath, workspaceRoot);
         insertMention(paneId, rel);
       }
     }
   }}
   ```

3. **`insertMention(paneId, path)`**: writes `@${path} ` directly into the pane's PTY. This is the same as if the user typed it. Uses the existing `rpc.pty.write` RPC.

### Main-process side

No new RPC needed if `rpc.pty.write({ sessionId, data })` already exists. Verify in `rpc-router.ts`. If it does: done.

If it doesn't, add it. The PTY registry already accepts writes from focus events; expose a thin RPC.

### Visual feedback

- **Dragover state**: while dragging over the pane, render a 2px accent border + a centered overlay `<div>` saying "Drop to mention <filename> in this pane" — same shape as the existing pane-focus border
- **Post-drop**: brief 200ms flash of the same accent color, then revert. Tells the user the drop registered.

## Edge cases

| Case | Behavior |
|---|---|
| Drop file from Finder onto pane | Compute workspace-relative path; if outside workspace, use absolute path with a `@/abs/path` form |
| Drop multiple files at once | Write `@file1.tsx @file2.tsx ` (space-separated, trailing space) |
| Drop onto non-active pane | Focus that pane first, then insert mention |
| Drop folder | Insert as `@folder/` (trailing slash) — let the agent decide whether to expand it |
| Drop binary / huge file | Same behavior — agents handle their own size limits via the @-mention semantic |
| Drop while pane is exited / busy | Show toast "Pane is not running"; don't write |

## Tests

- `PaneShell.test.tsx` extend with a synthetic `DataTransfer` event: assert drop calls `insertMention` with the right path
- `insertMention.test.ts` unit test: assert PTY write is called with `@${path} ` (note trailing space — matters for the agent's parser)
- Manual e2e: drag a file from the IDE tab into a Claude pane, verify the text appears in the pane terminal exactly as `@file-name `

## Verification gate

```bash
cd app
pnpm exec tsc -b --pretty false
pnpm exec eslint .
pnpm exec vitest run
pnpm run build && node scripts/build-electron.cjs
```

Manual dogfood:
- Drag from IDE file-tree → Claude pane → `@file-name ` appears, continue typing prompt
- Drag from Finder → pane → absolute path inserted as fallback
- Multi-file drag from Finder → all paths inserted space-separated

## Risks

- **Electron `dragstart` quirks on Windows**: `webUtils.getPathForFile()` was added in Electron 32; we're on 30.5.1. Confirm API availability; if missing, fall back to `file.path` (deprecated but functional in Electron 30)
- **Cross-process `file://` paths**: dragging from VS Code or external apps may give a `file://` URL instead of a plain path. Normalize before insert
- **xterm focus stealing**: xterm.js captures focus aggressively. After drop, the next keystroke might land in xterm before the inserted mention is visible. Test the flow end-to-end
- **`@` mention syntax varies per CLI**: Claude Code uses `@<path>`. Codex/Gemini/Kimi/OpenCode may use different syntax. **Decide upfront**: just use the Claude convention (`@`) since it's the most common, OR detect the pane's provider and emit the right convention per provider. Recommend simple `@<path>` for v1.4.8.0 (works in Claude + Codex; the others ignore unrecognized prefixes and treat them as literal text the user can re-paste)

## Commit format

```
feat(v1.4.8): drag-and-drop file → pane @-mention

- EditorTab.tsx file-tree rows: draggable + dataTransfer payload
  (workspace-relative path)
- PaneShell.tsx: onDragOver/onDrop accept sigmalink-file + Finder Files
- Insert as `@<path> ` (Claude convention; Codex compatible)
- Multi-file drop joins paths with space separator
- Visual dragover overlay; 200ms post-drop flash
```

---

## v1.4.8 review (2026-05-20)

### Component naming — WRONG

The brief references `PaneShell.tsx` as the drop-target component. That file
does **not exist**. The command-room directory contains:

```
CommandRoom.tsx  GridLayout.tsx  PaneFooter.tsx  PaneHeader.tsx
PaneSplash.tsx   Terminal.tsx    (+ test files)
```

The outer pane shell is the `PaneCell` function inside `CommandRoom.tsx` (lines
522-643). There is no `PaneComposer.tsx` either. The drop-target `onDragOver` /
`onDrop` handlers should be placed on the `<div className="relative flex
min-h-0 flex-1 flex-col">` wrapper inside `PaneCell`, or extracted into a
dedicated `PaneShell.tsx` as part of this packet. Either approach is fine; the
brief must clarify which one is intended and update the file list accordingly.

### `rpc.pty.write` — CONFIRMED EXISTS

`rpc-router.ts` line 584:
```ts
write: async (sessionId: string, data: string) => { pty.write(sessionId, data); }
```
The `PtyRegistry.write` method also exists (line 235 of `registry.ts`). No new
RPC is needed.

### `window.electron.webUtils?.getPathForFile` — WRONG API SHAPE

The brief calls `window.electron.webUtils?.getPathForFile?.(file)`. The actual
preload surface (verified in `electron/preload.ts`) is:

```ts
contextBridge.exposeInMainWorld('sigma', api);
// api.getPathForFile = (file: File): string => webUtils.getPathForFile(file)
```

The renderer must call `window.sigma.getPathForFile(file)`, **not**
`window.electron.webUtils.getPathForFile`. The `window.electron` namespace does
not exist; the entire API is under `window.sigma`.

### Electron 30 + `webUtils.getPathForFile` — CONFIRMED AVAILABLE

Package.json pins `"electron": "^30.0.0"`. The installed version is 30.x
(productName SigmaLink, app version 1.4.7). `webUtils.getPathForFile` was
introduced in **Electron 29** (not 32 as the brief states in the Risks section).
The preload already imports and wraps it (line 6 + lines 30-36 of
`electron/preload.ts`), wrapped in a try/catch that returns `''` on error.

Action: remove the "added in Electron 32" caveat from the Risks section — the
API is already present and pre-wired. The fallback to `file.path` is still
valid insurance for unexpected edge cases but is not the primary concern.

### File-tree drag source — CORRECT FILE, DIFFERENT COMPONENT

`EditorTab.tsx` is not the drag source — it renders the outer shell. The actual
file rows are `<button>` elements inside `TreeNode` in `FileTree.tsx`. The
`draggable` attribute and `onDragStart` handler must be added to that `<button>`
element (line 231 of `FileTree.tsx`), not to `EditorTab.tsx`. The brief's file
list should reference `FileTree.tsx`.

The `FileTree` component receives `workspaceId` and `rootPath` props; the drag
payload can carry `fullPath` (absolute) directly — workspace-relative path must
be computed client-side by stripping `rootPath` prefix.

### `@dnd-kit` already in deps — potential conflict

`package.json` includes `@dnd-kit/core ^6.3.1` and `@dnd-kit/sortable ^10.0.0`.
These libraries install their own `DndContext` and intercept pointer events. If
any parent of the pane grid is wrapped in a `<DndContext>`, browser drag events
(`dragstart`, `dragover`, `drop`) may be suppressed or receive `e.preventDefault()`
from dnd-kit's internal handlers before the custom `onDrop` fires. Verify at
implementation time whether dnd-kit is active in the pane tree; if so, use
dnd-kit's `useDraggable` / `useDroppable` hooks consistently instead of mixing
the native HTML5 drag API.

### `insertMention` write path — correct but needs guard

The approach writes via `rpc.pty.write(sessionId, data)`. The `PtyRegistry.write`
method silently no-ops on an unknown session (`.get(id)?.pty.write(data)`).
The dead-pane edge case in the brief ("show toast if pane not running") requires
an explicit alive check before the RPC call since the RPC itself never throws.
Suggest: check `session.status !== 'running'` before calling — the session
object is already in React state.

### xterm focus-stealing — confirmed concern

`Terminal.tsx` uses `term.focus()` on the `sigma:pty-focus` custom event and the
xterm textarea captures all keystrokes. After `pty.write` injects the `@path `
text, the next keystroke the user types goes directly into the PTY (which is
correct — that's the intent). However, if the composer conceptually expects the
user to keep typing in a React input, there is no React input — the pane IS the
xterm. The "composer" in the brief is the PTY input line itself, so focus
behaviour is correct as designed; the brief is slightly misleading when it uses
the term "composer".

### Visual overlay — no existing pattern to reuse

The brief references "same shape as the existing pane-focus border". There is no
existing dragover overlay pattern in the codebase. The 2px accent border is the
right approach; implement via a `data-dragover` attribute + Tailwind class swap
rather than a separate `<div>` overlay, to avoid z-index fights with `xterm`.

### `PaneFooter.tsx` — not examined

The brief does not reference `PaneFooter.tsx` for this feature; confirmed
correct, no changes needed there.

---

## Open questions

1. **New file vs edit CommandRoom?** — `PaneCell` is currently inlined in
   `CommandRoom.tsx` (~120 lines). Extracting it to `PaneShell.tsx` is the
   cleaner split (keeps `CommandRoom.tsx` under the 500-line project rule); but
   it is additional scope. Decide before implementation starts.

2. **dnd-kit conflict?** — Is `@dnd-kit/core` mounted in the pane tree today?
   If yes, use dnd-kit's own drag primitives; if not, native HTML5 drag is
   simpler.

3. **Absolute vs relative path in payload?** — `FileTree` knows `rootPath` and
   `fullPath`. Passing both in the dataTransfer payload avoids the drop handler
   having to look up the workspace root independently. Confirm payload shape is
   `{ absolutePath, relativePath, workspaceId }`.

4. **Provider-specific syntax?** — Brief recommends universal `@<path>` for
   v1.4.8. Codex also accepts `@file`. Gemini / Kimi / OpenCode treat it as
   literal text — no breakage. Decision: ship `@<path> ` for all providers in
   this release. Revisit in v1.4.9 if provider detection is already available.

5. **Multi-file limit?** — No cap is specified. Dropping an entire directory
   from Finder could enqueue hundreds of `Files` entries. Add a cap (e.g. 10)
   with a toast warning for v1.4.8; agents parsing a 200-path line will struggle
   more than the UX will.

6. **Test setup — `DataTransfer` mock?** — jsdom does not ship a spec-compliant
   `DataTransfer` constructor in some versions; confirm the vitest + jsdom
   version supports `new DataTransfer()` before writing the synthetic event
   tests, or use a minimal stub.

---

**Effort re-estimate**: S (2-3 hr), not M, once the naming is corrected.
The RPC is already wired, `getPathForFile` is already in the preload, and no new
main-process work is needed. The bulk is the drop-target + drag-source DOM wiring
plus visual feedback.
