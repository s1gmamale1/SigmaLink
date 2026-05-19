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
