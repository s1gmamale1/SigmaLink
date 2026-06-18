# File Viewer — Create / Delete / Rename / Move (Editor FileTree)

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan
**Area:** `src/renderer/features/editor/` (FileTree) + `src/main/core/fs/` (RPC controller)

## Summary

The Editor tab's file viewer (`FileTree.tsx`) is read-only today: it lists
directories (`fs.readDir`) and opens files into Monaco (`onOpenFile`). This
feature makes the tree mutable. Users can:

- **New File** — create an empty file, then auto-open it in the editor.
- **New Folder** — create a directory, then auto-expand it.
- **Rename** — rename a file or folder in place.
- **Delete** — move a file or folder (recursively) to the OS Trash (recoverable).
- **Drag-to-move** — drag a node onto a folder to move it there.

Actions are triggered via a right-click **context menu** on tree rows plus
**New File / New Folder** buttons in the tree header (for the empty-tree / root
case). All operations are sandboxed by the existing `assertAllowedPath`
containment keystone.

## Goals / Non-Goals

**Goals**
- Full create/delete/rename/move for files and folders from the FileTree.
- Recoverable deletes (OS Trash), not irreversible `rm`.
- Reuse existing primitives: `path-guard`, `prompt-dialog`, `context-menu`,
  `alert-dialog` (optional), `sonner`.
- Keep the security boundary in exactly one place (`assertAllowedPath`).

**Non-Goals**
- Multi-select / bulk operations.
- Copy/duplicate, cut/paste.
- File-content templates or scaffolding.
- Cross-workspace moves (a move stays within the same allowed-roots set;
  containment naturally forbids escaping).
- Re-pathing an already-open Monaco buffer when its file is renamed (the open
  tab keeps the old path; documented limitation, see Risks).

## Current Architecture (as-is)

- `src/renderer/features/editor/FileTree.tsx` (332 lines) — recursive, lazy
  tree. Caches directory listings in `childrenByPath`; `refreshRoot()` clears
  the whole cache. Rows already implement `onDragStart` emitting an
  `application/sigmalink-file` payload (`{absolutePath, relativePath,
  workspaceId}`) consumed by terminal drop zones.
- `src/renderer/features/editor/EditorTab.tsx` — mounts FileTree (240px) +
  Monaco; `handleOpen` opens a file.
- `src/main/core/fs/controller.ts` — `fsReadDir`, `fsReadFile`, `fsWriteFile`,
  `fsExists`. All route their target through `assertAllowedPath`.
- `src/main/core/security/path-guard.ts` — `assertAllowedPath(target, roots)`.
  Realpath-safe, symlink-safe, **fail-closed** (empty roots ⇒ throw). Already
  handles **not-yet-existing** targets by realpath-resolving the nearest
  existing ancestor and re-attaching the trailing segments — so create / mkdir
  / rename-destination / trash all work through it unchanged.
- RPC is mirrored across four surfaces that MUST stay in sync:
  - `src/shared/rpc-channels.ts` — channel allowlist (`fs.*`).
  - `src/shared/router-shape.ts` — the `fs` TS interface shape.
  - `src/main/core/rpc/schemas.ts` — per-channel zod input/output schemas.
  - `src/main/rpc-router.ts` — wiring (injects `allowedRoots: fsAllowedRoots`).
  `src/shared/rpc-channels.test.ts` enforces parity.
- UI primitives already present in `src/components/ui/`: `prompt-dialog.tsx`
  (themed single-line prompt, drop-in `window.prompt`), `alert-dialog.tsx`,
  `context-menu.tsx` (radix), `sonner` (toasts).

## Design

### 1. Backend — four new `fs` RPC channels

Implemented in `core/fs/controller.ts`, each contained via `assertAllowedPath`
(fail-closed). Wired in `rpc-router.ts` with `allowedRoots: fsAllowedRoots`.

| Channel | Input | Behavior |
|---|---|---|
| `fs.createFile` | `{ path }` | Create empty file with the `wx` flag — **fails if it already exists** (no clobber). Parent dir must already exist and be inside roots. Returns `{ ok: true }`. |
| `fs.mkdir` | `{ path }` | Create a single directory; **fails if it exists**. Returns `{ ok: true }`. |
| `fs.rename` | `{ from, to }` | Rename/move. `from` **and** `to` are each contained via `assertAllowedPath`. Refuse if `to` already exists (no clobber). Backs both Rename and drag-move. Returns `{ ok: true }`. |
| `fs.trash` | `{ path }` | Contain `path`, then move it to the OS Trash. Recursive for folders (the OS handles it). Returns `{ ok: true }`. |

**Trash without coupling the controller to Electron.** `core/fs/controller.ts`
is pure `node:fs` + `path-guard` (no Electron import) so it stays
unit-testable. `fsTrash` takes an **injected** `trashItem: (absPath: string) =>
Promise<void>`, mirroring the existing `allowedRoots` injection. The router
passes Electron's `shell.trashItem`; tests pass a fake that records the path.

```ts
export async function fsCreateFile(input: { path; allowedRoots? }): Promise<{ ok: true }>
export async function fsMkdir(input: { path; allowedRoots? }): Promise<{ ok: true }>
export async function fsRename(input: { from; to; allowedRoots? }): Promise<{ ok: true }>
export async function fsTrash(
  input: { path; allowedRoots?; trashItem: (p: string) => Promise<void> },
): Promise<{ ok: true }>
```

Wiring in `rpc-router.ts`:

```ts
import { shell } from 'electron';
// ...
createFile: async (input: { path: string }) =>
  fsCreateFile({ ...input, allowedRoots: fsAllowedRoots }),
mkdir: async (input: { path: string }) =>
  fsMkdir({ ...input, allowedRoots: fsAllowedRoots }),
rename: async (input: { from: string; to: string }) =>
  fsRename({ ...input, allowedRoots: fsAllowedRoots }),
trash: async (input: { path: string }) =>
  fsTrash({ ...input, allowedRoots: fsAllowedRoots, trashItem: shell.trashItem.bind(shell) }),
```

**Parity checklist** (one row per channel, all four surfaces):
`rpc-channels.ts` (`'fs.createFile'`, `'fs.mkdir'`, `'fs.rename'`, `'fs.trash'`)
→ `router-shape.ts` (`fs.createFile/mkdir/rename/trash` signatures) →
`schemas.ts` (zod input/output: `{ ok: true }` outputs; `rename` input has
`from`+`to`) → `rpc-router.ts` (handlers above). Re-run
`rpc-channels.test.ts`.

### 2. Renderer — FileTree enhancements

**`useFileMutations` hook** (`editor/useFileMutations.ts`)
- Methods: `createFile(dir, name)`, `createFolder(dir, name)`,
  `rename(fromPath, newName)`, `move(fromPath, destDir)`, `trash(path)`.
- Each: build the target path (via `fs-path` helpers) → call the rpc → on
  success `toast.success`, on error `toast.error(message)` → return the set of
  **affected parent directories** so the caller can invalidate them.
- Pure orchestration; holds no React state. Takes `rootPath`/`workspaceId` for
  context only.

**Context menu** — wrap each `TreeNode` row in radix `ContextMenu`
(`context-menu.tsx`):
- On a **directory**: New File, New Folder (both target this dir), Rename,
  Delete.
- On a **file**: New File, New Folder (target the file's **parent** dir),
  Rename, Delete.
- Menu actions open the relevant dialog (create/rename) or fire trash directly.

**Header buttons** — New File / New Folder in the FileTree header, acting on
`rootPath`. This is the path for creating into an **empty** tree (nothing to
right-click).

**Dialogs** — a single `PromptDialog` instance driven by FileTreeInner state
`{ mode: 'newFile' | 'newFolder' | 'rename' | null, targetDir?, targetPath?,
defaultValue? }`:
- New File / New Folder: empty default, placeholder `name.ext` / `folder`.
- Rename: default = current basename, selected on open (PromptDialog already
  focuses+selects).
- Confirm runs the matching `useFileMutations` method, then invalidates dirs.

**Delete** — fires `trash(path)` directly with **no blocking confirm** (OS
Trash is recoverable); feedback is a `toast.success('Moved to Trash')`. (An
`alert-dialog` confirm for non-empty folders is intentionally omitted; it can
be added later without touching the backend.)

**Refresh** — add `refreshDir(path: string)`: delete `path` from
`childrenByPath` (and ensure it stays expanded), which re-triggers the existing
lazy-load effect to refetch just that directory. Mutations invalidate:
- create/mkdir → the parent dir.
- rename (same dir) → the parent dir.
- move / rename-into-different-dir → **both** source and destination parents.

**Post-create UX** — after `createFile`, call `onOpenFile(newPath)` and select
the row; after `createFolder`, add the new path to `expanded`.

### 3. Drag-to-move

Folder rows (and the root) become **drop targets**:
- `onDragOver`: `preventDefault()` (to allow drop) + apply a highlight class;
  `onDragLeave` clears it.
- `onDrop`: read the existing `application/sigmalink-file` payload, parse
  `absolutePath` as the source, compute `to = join(targetDir,
  basename(source))`, call `useFileMutations.move`, invalidate both parents.

**Guards** (all reject silently / via `toast.error`):
- Drop onto **itself** (source === target) → no-op.
- Drop onto its **current parent** (`dirname(source) === targetDir`) → no-op.
- Move a folder **into its own descendant** (`isDescendant(targetDir, source)`)
  → reject ("cannot move a folder into itself").
- `to` already exists → backend rejects (no clobber) → `toast.error`.

The existing `onDragStart` payload is reused unchanged, so dragging a file into
a **terminal** still works (different drop target, same payload).

### 4. Helpers / file size

Extract the inline `ptr` object from FileTree into
`editor/fs-path.ts` and add `dirname` + `isDescendant`:

```ts
export const fsPath = { join, basename, dirname };
export function isDescendant(maybeChild: string, ancestor: string): boolean;
```

Reused by the tree, the mutation hook, and drag-move; independently testable.

FileTree.tsx will grow with the context menu + drag handlers. If it crosses
~450 lines, extract the recursive node into `FileTreeNode.tsx` (keep every file
< 500 lines per CLAUDE.md). The mutation hook and `fs-path` already pull weight
out of the component.

### 5. Error handling

- Every backend handler throws a descriptive `Error`; the rejected RPC is
  caught in `useFileMutations` and surfaced via `toast.error(err.message)`.
  Cases: name collision (`EEXIST` / "already exists"), out-of-roots
  (`'path outside workspace'`), permission denied (`EACCES`), parent missing.
- **Leaf-name validation in the dialog** for fast feedback before any rpc:
  reject empty/whitespace, names containing `/` or `\`, and `.` / `..`.
  (`PromptDialog.requireValue` already blocks empty; add the separator/dot
  check in the confirm handler.) Backend containment remains the real guard —
  the dialog check is UX, not security.

### 6. Testing

**Backend** (`core/fs/controller.test.ts`, real temp dirs via `fs.mkdtemp`,
mirrors `core/assistant/tools.test.ts` — no DB, so no MockDb needed):
- `createFile`: creates an empty file; **rejects clobber** of an existing file;
  rejects a path outside roots (`'path outside workspace'`).
- `mkdir`: creates a dir; rejects if it exists; rejects out-of-roots.
- `rename`: renames within roots; **contains both ends** (rejects a `to` that
  escapes roots, rejects a `from` that escapes); rejects clobber of an existing
  `to`.
- `trash`: calls the injected `trashItem` with the **contained** (realpath'd)
  path; rejects out-of-roots **before** calling `trashItem`.
- Parity: extend `rpc-channels.test.ts` so the four new channels exist across
  allowlist + schema + shape.

**Renderer** (`FileTree.test.tsx` / `useFileMutations.test.ts`, jsdom, mocked
`rpc`):
- Each mutation calls the right rpc with the right path and, on success,
  invalidates the correct parent dir(s) (assert a refetch / `readDir` re-call).
- Context-menu items fire the matching action; file-row New File targets the
  parent dir.
- Drag-move guards: self / current-parent → no rpc; descendant → rejected;
  happy path → `fs.rename` with the computed `to`.
- jsdom has no real `DataTransfer`/layout — stub `dataTransfer.getData` and
  note the limitation; visual drag highlight is asserted by class, not pixels.

## Risks & Mitigations

- **RPC surface drift** — four mirrored surfaces is the repo's recurring
  footgun. Mitigation: explicit parity checklist (§1) + `rpc-channels.test.ts`.
- **Renamed open buffer goes stale** — Monaco keeps the old path after a
  rename. Acceptable for v1; documented Non-Goal. Could later re-key the open
  tab on a rename event.
- **Drag-move edge cases** — folder-into-descendant, clobber, no-op drops.
  Mitigation: explicit guards (§3) + tests; backend `to`-exists check is the
  backstop.
- **Accidental delete** — mitigated by OS Trash recoverability; no `rm`. If
  this proves too loose in practice, add an `alert-dialog` confirm for
  non-empty folders (no backend change).
- **FileTree.tsx size** — mitigated by extracting `fs-path.ts` +
  `useFileMutations.ts` and, if needed, `FileTreeNode.tsx`.

## Out of Scope (future)

- Copy/duplicate, cut/paste, multi-select bulk ops.
- Confirm-on-delete dialog (deferred; recoverable trash makes it optional).
- Re-pathing open Monaco buffers on rename.
- New-file templates / scaffolds.
