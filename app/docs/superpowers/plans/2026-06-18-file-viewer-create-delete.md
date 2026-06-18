# File Viewer Create/Delete/Rename/Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Editor tab's file tree mutable — create files/folders, rename, delete to OS Trash, and drag-to-move — all sandboxed by the existing path-containment keystone.

**Architecture:** Add four contained `fs.*` RPC channels (`createFile`, `mkdir`, `rename`, `trash`) in the main process, then drive them from the renderer via a `useFileMutations` hook wired into a right-click context menu, header buttons, and folder drop targets on the existing `FileTree`. Deletes use Electron `shell.trashItem` (recoverable). Every path flows through `assertAllowedPath` (fail-closed).

**Tech Stack:** TypeScript, React 19, Electron, Radix UI (`context-menu`, `dialog`), `sonner` toasts, Vitest + jsdom, `node:fs`.

**Spec:** `docs/superpowers/specs/2026-06-18-file-viewer-create-delete-design.md`

## Global Constraints

- **Path containment is mandatory.** Every main-process fs handler MUST route its target through `containPath(target, allowedRoots)` (which calls `assertAllowedPath`). It is fail-closed: no roots ⇒ throws `'path outside workspace'`. Never trust a renderer-supplied path. For `rename`, contain BOTH `from` and `to`.
- **RPC parity across FIVE surfaces.** Every new channel must appear in: `src/shared/rpc-channels.ts` (CHANNELS), `src/shared/router-shape.ts` (`AppRouter.fs`), `src/main/core/rpc/schemas.ts` (CHANNEL_SCHEMAS), `src/main/rpc-router.ts` (`fsCtl`), AND `src/shared/rpc-channels.test.ts` (`TYPED_ROUTER_CHANNELS` fs block). The test `rpc-channels.test.ts` fails if channels and handlers drift.
- **TS `erasableSyntaxOnly`:** no `constructor(private x)`, no `enum`, no `namespace`. (All new code here is plain functions/hooks, so this is informational.)
- **Files < 500 lines** (CLAUDE.md). `FileTree.tsx` grows in Tasks 5–6; if it crosses ~450 lines, extract the recursive node into `FileTreeNode.tsx`.
- **Tests = Vitest.** Backend fs tests use REAL temp dirs via the existing `withTmpDir` helper (no DB, so no MockDb). Renderer tests use jsdom with `@/renderer/lib/rpc` and `sonner` mocked.
- **Delete = OS Trash** (`shell.trashItem`), recoverable, NO blocking confirm dialog.
- **No local e2e** (it launches competing Electron windows). Local gate only: `npx tsc -b`, `npx vitest run <files>`, `npm run lint`. Defer e2e to CI.
- **Commit message trailer:** end each commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Renderer path helpers (`fs-path.ts`)

Extract the inline `ptr` join/basename from `FileTree.tsx` into a shared, tested module and add `dirname` + `isDescendant` (needed by the mutation hook and drag-move).

**Files:**
- Create: `src/renderer/features/editor/fs-path.ts`
- Test: `src/renderer/features/editor/fs-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `fsPath.join(...parts: string[]): string`
  - `fsPath.basename(p: string): string`
  - `fsPath.dirname(p: string): string`
  - `isDescendant(maybeChild: string, ancestor: string): boolean` — true when `maybeChild` is `ancestor` itself or sits underneath it.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/editor/fs-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fsPath, isDescendant } from './fs-path';

describe('fsPath', () => {
  it('joins POSIX segments and trims separators', () => {
    expect(fsPath.join('/a/b', 'c.txt')).toBe('/a/b/c.txt');
    expect(fsPath.join('/a/b/', '/c/')).toBe('/a/b/c');
  });
  it('joins Windows segments with a backslash', () => {
    expect(fsPath.join('C:\\a\\b', 'c.txt')).toBe('C:\\a\\b\\c.txt');
  });
  it('basename returns the trailing segment', () => {
    expect(fsPath.basename('/a/b/c.txt')).toBe('c.txt');
    expect(fsPath.basename('/a/b/')).toBe('b');
  });
  it('dirname returns the parent path', () => {
    expect(fsPath.dirname('/a/b/c.txt')).toBe('/a/b');
    expect(fsPath.dirname('/a')).toBe('/a'); // at/above root: no parent
  });
});

describe('isDescendant', () => {
  it('is true for the path itself', () => {
    expect(isDescendant('/a/b', '/a/b')).toBe(true);
  });
  it('is true for a child path', () => {
    expect(isDescendant('/a/b/c', '/a/b')).toBe(true);
  });
  it('is false for a sibling sharing a name prefix', () => {
    expect(isDescendant('/a/bc', '/a/b')).toBe(false);
  });
  it('is false for an unrelated path', () => {
    expect(isDescendant('/x/y', '/a/b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/editor/fs-path.test.ts`
Expected: FAIL — `Failed to resolve import "./fs-path"`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/features/editor/fs-path.ts`:

```ts
// Tiny renderer-side path helpers — `path-browserify` isn't in our deps and the
// renderer can't import node:path. Paths are always absolute (POSIX or Windows).
// Extracted from FileTree's inline `ptr` so the tree, the mutation hook, and
// drag-move share one implementation.

function sepOf(p: string): string {
  return p.includes('\\') && !p.startsWith('/') ? '\\' : '/';
}

export const fsPath = {
  join(...parts: string[]): string {
    const sep = sepOf(parts[0] ?? '');
    return parts
      .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
      .filter(Boolean)
      .join(sep);
  },
  basename(p: string): string {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx === -1 ? norm : norm.slice(idx + 1);
  },
  dirname(p: string): string {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx <= 0 ? norm : norm.slice(0, idx);
  },
};

/**
 * True when `maybeChild` is `ancestor` itself or sits underneath it. Used to
 * forbid dragging a folder into its own subtree. Segment-aware (not a raw
 * startsWith) so `/a/bc` is NOT considered inside `/a/b`.
 */
export function isDescendant(maybeChild: string, ancestor: string): boolean {
  const a = ancestor.replace(/[\\/]+$/, '');
  const c = maybeChild.replace(/[\\/]+$/, '');
  if (a === c) return true;
  return c.startsWith(a + sepOf(a));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/editor/fs-path.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/editor/fs-path.ts src/renderer/features/editor/fs-path.test.ts
git commit -m "feat(editor): extract fs-path helpers (join/basename/dirname/isDescendant)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend fs mutation controllers

Add four pure controller functions to `core/fs/controller.ts`, each contained via the existing `containPath` keystone, and unit-test them against real temp dirs. No router wiring yet (Task 3).

**Files:**
- Modify: `src/main/core/fs/controller.ts` (append four functions after `fsExists`)
- Test: `src/main/core/fs/controller.test.ts` (append describe blocks; reuses the existing `withTmpDir` + `roots` helpers)

**Interfaces:**
- Consumes: `containPath(target, allowedRoots)` (already in `controller.ts`), `AllowedRootsSource`.
- Produces:
  - `fsCreateFile(input: { path: string; allowedRoots?: AllowedRootsSource }): Promise<{ ok: true }>`
  - `fsMkdir(input: { path: string; allowedRoots?: AllowedRootsSource }): Promise<{ ok: true }>`
  - `fsRename(input: { from: string; to: string; allowedRoots?: AllowedRootsSource }): Promise<{ ok: true }>`
  - `fsTrash(input: { path: string; allowedRoots?: AllowedRootsSource; trashItem: (absPath: string) => Promise<void> }): Promise<{ ok: true }>`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/fs/controller.test.ts`. First extend the import on line 12:

```ts
import { fsWriteFile, fsExists, fsCreateFile, fsMkdir, fsRename, fsTrash } from './controller';
```

Then append these describe blocks at the end of the file:

```ts
describe('fsCreateFile', () => {
  it('creates an empty file inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'new.txt');
      const res = await fsCreateFile({ path: target, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect(await fsp.readFile(target, 'utf8')).toBe('');
    });
  });
  it('rejects clobbering an existing file', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'exists.txt');
      await fsp.writeFile(target, 'keep');
      await expect(
        fsCreateFile({ path: target, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/fs\.createFile/);
      expect(await fsp.readFile(target, 'utf8')).toBe('keep'); // untouched
    });
  });
  it('rejects a path outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(
        fsCreateFile({ path: path.join(dir, '..', 'escape.txt'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
  it('is fail-closed with no allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(fsCreateFile({ path: path.join(dir, 'x.txt') })).rejects.toThrow(
        'path outside workspace',
      );
    });
  });
});

describe('fsMkdir', () => {
  it('creates a directory inside an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'sub');
      const res = await fsMkdir({ path: target, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect((await fsp.stat(target)).isDirectory()).toBe(true);
    });
  });
  it('rejects when the directory already exists', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'sub');
      await fsp.mkdir(target);
      await expect(
        fsMkdir({ path: target, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/fs\.mkdir/);
    });
  });
  it('rejects a path outside the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await expect(
        fsMkdir({ path: path.join(dir, '..', 'evil'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
});

describe('fsRename', () => {
  it('renames a file within an allowed root', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      const to = path.join(dir, 'b.txt');
      await fsp.writeFile(from, 'data');
      const res = await fsRename({ from, to, allowedRoots: roots(dir) });
      expect(res.ok).toBe(true);
      expect(await fsp.readFile(to, 'utf8')).toBe('data');
      expect(fsExists({ path: from, allowedRoots: roots(dir) })).toBe(false);
    });
  });
  it('rejects when the destination already exists', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      const to = path.join(dir, 'b.txt');
      await fsp.writeFile(from, 'a');
      await fsp.writeFile(to, 'b');
      await expect(
        fsRename({ from, to, allowedRoots: roots(dir) }),
      ).rejects.toThrow(/destination already exists/);
    });
  });
  it('rejects when the destination escapes the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      const from = path.join(dir, 'a.txt');
      await fsp.writeFile(from, 'a');
      await expect(
        fsRename({ from, to: path.join(dir, '..', 'b.txt'), allowedRoots: roots(dir) }),
      ).rejects.toThrow('path outside workspace');
    });
  });
  it('rejects when the source escapes the allowed roots', async () => {
    await withTmpDir(async (dir) => {
      await withTmpDir(async (other) => {
        const from = path.join(other, 'a.txt');
        await fsp.writeFile(from, 'a');
        await expect(
          fsRename({ from, to: path.join(dir, 'b.txt'), allowedRoots: roots(dir) }),
        ).rejects.toThrow('path outside workspace');
      });
    });
  });
});

describe('fsTrash', () => {
  it('contains the path then calls the injected trashItem with the realpath', async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, 'doomed.txt');
      await fsp.writeFile(target, 'bye');
      const calls: string[] = [];
      const res = await fsTrash({
        path: target,
        allowedRoots: roots(dir),
        trashItem: async (p) => {
          calls.push(p);
        },
      });
      expect(res.ok).toBe(true);
      expect(calls).toEqual([target]); // contained, realpath'd target
    });
  });
  it('rejects out-of-roots BEFORE calling trashItem', async () => {
    await withTmpDir(async (dir) => {
      const calls: string[] = [];
      await expect(
        fsTrash({
          path: path.join(dir, '..', 'outside.txt'),
          allowedRoots: roots(dir),
          trashItem: async (p) => {
            calls.push(p);
          },
        }),
      ).rejects.toThrow('path outside workspace');
      expect(calls).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/core/fs/controller.test.ts`
Expected: FAIL — `fsCreateFile`/`fsMkdir`/`fsRename`/`fsTrash` are not exported.

- [ ] **Step 3: Write the implementations**

Append to `src/main/core/fs/controller.ts` (after `fsExists`):

```ts
export async function fsCreateFile(
  input: { path: string; allowedRoots?: AllowedRootsSource },
): Promise<{ ok: true }> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.createFile: path required');
  const safe = containPath(target, input.allowedRoots);
  try {
    // 'wx' — create empty, fail if it already exists (no clobber). The parent
    // dir must already exist (it does: you create into a visible tree folder).
    const handle = await fsp.open(safe, 'wx');
    await handle.close();
  } catch (err) {
    throw new Error(`fs.createFile: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true };
}

export async function fsMkdir(
  input: { path: string; allowedRoots?: AllowedRootsSource },
): Promise<{ ok: true }> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.mkdir: path required');
  const safe = containPath(target, input.allowedRoots);
  try {
    // Non-recursive: throws EEXIST if the directory already exists.
    await fsp.mkdir(safe);
  } catch (err) {
    throw new Error(`fs.mkdir: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true };
}

export async function fsRename(
  input: { from: string; to: string; allowedRoots?: AllowedRootsSource },
): Promise<{ ok: true }> {
  if (!input.from || !input.to) throw new Error('fs.rename: from and to required');
  // Contain BOTH ends — a move must not let `to` escape the sandbox.
  const safeFrom = containPath(input.from, input.allowedRoots);
  const safeTo = containPath(input.to, input.allowedRoots);
  // No-clobber: refuse if the destination already exists. (A case-only rename
  // on a case-insensitive FS is conservatively rejected; acceptable for v1.)
  if (fs.existsSync(safeTo)) throw new Error('fs.rename: destination already exists');
  try {
    await fsp.rename(safeFrom, safeTo);
  } catch (err) {
    throw new Error(`fs.rename: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true };
}

export async function fsTrash(
  input: {
    path: string;
    allowedRoots?: AllowedRootsSource;
    // Injected so the controller stays Electron-free + unit-testable; the router
    // passes Electron's shell.trashItem. Moves to the OS Trash (recoverable).
    trashItem: (absPath: string) => Promise<void>;
  },
): Promise<{ ok: true }> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.trash: path required');
  // Contain FIRST — out-of-roots throws here, before trashItem ever runs.
  const safe = containPath(target, input.allowedRoots);
  await input.trashItem(safe);
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/core/fs/controller.test.ts`
Expected: PASS (all new blocks green, existing tests still green).

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc -b`
Expected: no errors.

```bash
git add src/main/core/fs/controller.ts src/main/core/fs/controller.test.ts
git commit -m "feat(fs): add createFile/mkdir/rename/trash controllers (contained)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the four fs channels across all RPC surfaces

Expose the Task 2 controllers as `fs.*` RPC channels. This touches five files that MUST stay in sync; the parity test is the backstop.

**Files:**
- Modify: `src/shared/rpc-channels.ts` (CHANNELS fs block, ~line 117)
- Modify: `src/shared/router-shape.ts` (`AppRouter.fs`, ~line 413)
- Modify: `src/main/core/rpc/schemas.ts` (CHANNEL_SCHEMAS fs block, ~line 626)
- Modify: `src/main/rpc-router.ts` (import + `fsCtl`, ~lines 133 & 1794)
- Modify: `src/shared/rpc-channels.test.ts` (`TYPED_ROUTER_CHANNELS` fs block, ~line 137)
- Test: `src/shared/rpc-channels.test.ts` (must stay green)

**Interfaces:**
- Consumes: `fsCreateFile`, `fsMkdir`, `fsRename`, `fsTrash` (Task 2); `shell` from `electron` (already imported at `rpc-router.ts:9`); `fsAllowedRoots` (already in scope in `buildRouter`).
- Produces (renderer-callable, auto-typed via the rpc Proxy from `AppRouter`):
  - `rpc.fs.createFile({ path }) → { ok: true }`
  - `rpc.fs.mkdir({ path }) → { ok: true }`
  - `rpc.fs.rename({ from, to }) → { ok: true }`
  - `rpc.fs.trash({ path }) → { ok: true }`

- [ ] **Step 1: Add the channels to the allowlist**

In `src/shared/rpc-channels.ts`, after the `'fs.writeFile',` line (117), insert:

```ts
  // file-viewer mutations (2026-06-18) — create/delete/rename/move
  'fs.createFile',
  'fs.mkdir',
  'fs.rename',
  'fs.trash',
```

- [ ] **Step 2: Add the channels to the parity test's enumeration**

In `src/shared/rpc-channels.test.ts`, in the `// fs (fsCtl)` block (after `'fs.writeFile',`, ~line 136), insert the same four:

```ts
  'fs.createFile',
  'fs.mkdir',
  'fs.rename',
  'fs.trash',
```

- [ ] **Step 3: Add the TypeScript shapes**

In `src/shared/router-shape.ts`, inside the `fs: {` block, after the `writeFile: (...) => Promise<{ ok: true }>;` member (line 413), insert:

```ts
    // file-viewer mutations (2026-06-18). All paths are contained by the
    // main-process allowed-roots guard (core/fs/controller.ts).
    createFile: (input: { path: string }) => Promise<{ ok: true }>;
    mkdir: (input: { path: string }) => Promise<{ ok: true }>;
    rename: (input: { from: string; to: string }) => Promise<{ ok: true }>;
    trash: (input: { path: string }) => Promise<{ ok: true }>;
```

- [ ] **Step 4: Add the zod schemas**

In `src/main/core/rpc/schemas.ts`, in the `// ── fs ──` block after the `'fs.writeFile': {...}` entry (line 626), insert:

```ts
  'fs.createFile': { input: z.object({ path: PATH_STR }), output: any },
  'fs.mkdir': { input: z.object({ path: PATH_STR }), output: any },
  'fs.rename': { input: z.object({ from: PATH_STR, to: PATH_STR }), output: any },
  'fs.trash': { input: z.object({ path: PATH_STR }), output: any },
```

- [ ] **Step 5: Wire the handlers**

In `src/main/rpc-router.ts`, extend the controller import (line 133):

```ts
import { fsReadDir, fsReadFile, fsWriteFile, fsExists, fsCreateFile, fsMkdir, fsRename, fsTrash } from './core/fs/controller';
```

Then in `fsCtl = defineController({ ... })`, after the `writeFile:` handler (line 1795), insert:

```ts
    createFile: async (input: { path: string }) =>
      fsCreateFile({ ...input, allowedRoots: fsAllowedRoots }),
    mkdir: async (input: { path: string }) =>
      fsMkdir({ ...input, allowedRoots: fsAllowedRoots }),
    rename: async (input: { from: string; to: string }) =>
      fsRename({ ...input, allowedRoots: fsAllowedRoots }),
    trash: async (input: { path: string }) =>
      fsTrash({ ...input, allowedRoots: fsAllowedRoots, trashItem: (p) => shell.trashItem(p) }),
```

- [ ] **Step 6: Run the parity test and type-check**

Run: `npx vitest run src/shared/rpc-channels.test.ts`
Expected: PASS (forward + inverse checks green — all four channels appear in both CHANNELS and the handler enumeration).

Run: `npx tsc -b`
Expected: no errors (handler input types match `AppRouter.fs`).

- [ ] **Step 7: Commit**

```bash
git add src/shared/rpc-channels.ts src/shared/rpc-channels.test.ts src/shared/router-shape.ts src/main/core/rpc/schemas.ts src/main/rpc-router.ts
git commit -m "feat(rpc): expose fs.createFile/mkdir/rename/trash channels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `useFileMutations` hook

A renderer hook that wraps the four RPC calls with toast feedback and returns the new path (or null/false on failure) so the caller can refresh + auto-open.

**Files:**
- Create: `src/renderer/features/editor/useFileMutations.ts`
- Test: `src/renderer/features/editor/useFileMutations.test.ts`

**Interfaces:**
- Consumes: `fsPath` (Task 1); `rpcSilent.fs.createFile/mkdir/rename/trash` (Task 3); `toast` from `sonner`.
- Produces:
  - `useFileMutations(): FileMutations` where
    ```ts
    interface FileMutations {
      createFile(dir: string, name: string): Promise<string | null>; // new path or null
      createFolder(dir: string, name: string): Promise<string | null>;
      rename(fromPath: string, newName: string): Promise<string | null>;
      move(fromPath: string, destDir: string): Promise<string | null>;
      trash(targetPath: string): Promise<boolean>;
    }
    ```

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/editor/useFileMutations.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const fs = {
  createFile: vi.fn(async () => ({ ok: true as const })),
  mkdir: vi.fn(async () => ({ ok: true as const })),
  rename: vi.fn(async () => ({ ok: true as const })),
  trash: vi.fn(async () => ({ ok: true as const })),
};
vi.mock('@/renderer/lib/rpc', () => ({ rpcSilent: { fs }, rpc: { fs } }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', () => ({ toast }));

import { useFileMutations } from './useFileMutations';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFileMutations', () => {
  it('createFile joins dir+name, calls rpc, returns the new path', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.createFile('/ws/src', 'new.ts');
    });
    expect(fs.createFile).toHaveBeenCalledWith({ path: '/ws/src/new.ts' });
    expect(out).toBe('/ws/src/new.ts');
    expect(toast.success).toHaveBeenCalled();
  });

  it('createFolder calls fs.mkdir', async () => {
    const { result } = renderHook(() => useFileMutations());
    await act(async () => {
      await result.current.createFolder('/ws', 'sub');
    });
    expect(fs.mkdir).toHaveBeenCalledWith({ path: '/ws/sub' });
  });

  it('rename keeps the parent dir and swaps the basename', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.rename('/ws/a.txt', 'b.txt');
    });
    expect(fs.rename).toHaveBeenCalledWith({ from: '/ws/a.txt', to: '/ws/b.txt' });
    expect(out).toBe('/ws/b.txt');
  });

  it('move reparents under destDir keeping the basename', async () => {
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = null;
    await act(async () => {
      out = await result.current.move('/ws/src/a.txt', '/ws/dest');
    });
    expect(fs.rename).toHaveBeenCalledWith({ from: '/ws/src/a.txt', to: '/ws/dest/a.txt' });
    expect(out).toBe('/ws/dest/a.txt');
  });

  it('trash calls fs.trash and returns true', async () => {
    const { result } = renderHook(() => useFileMutations());
    let ok = false;
    await act(async () => {
      ok = await result.current.trash('/ws/gone.txt');
    });
    expect(fs.trash).toHaveBeenCalledWith({ path: '/ws/gone.txt' });
    expect(ok).toBe(true);
  });

  it('surfaces a backend error as a toast and returns null', async () => {
    fs.createFile.mockRejectedValueOnce(new Error('fs.createFile: EEXIST'));
    const { result } = renderHook(() => useFileMutations());
    let out: string | null = 'x';
    await act(async () => {
      out = await result.current.createFile('/ws', 'dup.txt');
    });
    expect(out).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('fs.createFile: EEXIST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/editor/useFileMutations.test.ts`
Expected: FAIL — `Failed to resolve import "./useFileMutations"`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/features/editor/useFileMutations.ts`:

```ts
// File-tree mutation hook. Wraps the contained fs.* RPC channels with toast
// feedback and returns the resulting path (or null/false) so the tree can
// refresh the affected directory and auto-open new files. Holds no state.

import { useMemo } from 'react';
import { toast } from 'sonner';
import { rpcSilent } from '@/renderer/lib/rpc';
import { fsPath } from './fs-path';

export interface FileMutations {
  /** Create an empty file `name` inside `dir`. Returns the new path or null. */
  createFile(dir: string, name: string): Promise<string | null>;
  /** Create a directory `name` inside `dir`. Returns the new path or null. */
  createFolder(dir: string, name: string): Promise<string | null>;
  /** Rename a node in place. Returns the new path or null. */
  rename(fromPath: string, newName: string): Promise<string | null>;
  /** Move a node into `destDir`, keeping its basename. Returns the new path or null. */
  move(fromPath: string, destDir: string): Promise<string | null>;
  /** Move a node to the OS Trash. Returns true on success. */
  trash(targetPath: string): Promise<boolean>;
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useFileMutations(): FileMutations {
  return useMemo<FileMutations>(
    () => ({
      async createFile(dir, name) {
        const target = fsPath.join(dir, name);
        try {
          await rpcSilent.fs.createFile({ path: target });
          toast.success(`Created ${name}`);
          return target;
        } catch (err) {
          toast.error(errMsg(err, `Failed to create ${name}`));
          return null;
        }
      },
      async createFolder(dir, name) {
        const target = fsPath.join(dir, name);
        try {
          await rpcSilent.fs.mkdir({ path: target });
          toast.success(`Created ${name}`);
          return target;
        } catch (err) {
          toast.error(errMsg(err, `Failed to create folder ${name}`));
          return null;
        }
      },
      async rename(fromPath, newName) {
        const to = fsPath.join(fsPath.dirname(fromPath), newName);
        try {
          await rpcSilent.fs.rename({ from: fromPath, to });
          toast.success(`Renamed to ${newName}`);
          return to;
        } catch (err) {
          toast.error(errMsg(err, 'Rename failed'));
          return null;
        }
      },
      async move(fromPath, destDir) {
        const to = fsPath.join(destDir, fsPath.basename(fromPath));
        try {
          await rpcSilent.fs.rename({ from: fromPath, to });
          toast.success(`Moved ${fsPath.basename(fromPath)}`);
          return to;
        } catch (err) {
          toast.error(errMsg(err, 'Move failed'));
          return null;
        }
      },
      async trash(targetPath) {
        try {
          await rpcSilent.fs.trash({ path: targetPath });
          toast.success(`Moved ${fsPath.basename(targetPath)} to Trash`);
          return true;
        } catch (err) {
          toast.error(errMsg(err, 'Delete failed'));
          return false;
        }
      },
    }),
    [],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/features/editor/useFileMutations.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/editor/useFileMutations.ts src/renderer/features/editor/useFileMutations.test.ts
git commit -m "feat(editor): useFileMutations hook (create/rename/move/trash + toasts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: FileTree — context menu, header buttons, dialogs, dir refresh

Make the tree mutable: per-directory invalidation, a right-click context menu on every row, New File / New Folder header buttons, and a single `PromptDialog` driving create/rename. Delete fires trash directly (no confirm). Drag-to-move comes in Task 6.

**Files:**
- Modify: `src/renderer/features/editor/FileTree.tsx`
- Test: `src/renderer/features/editor/FileTree.test.tsx` (create)

**Interfaces:**
- Consumes: `useFileMutations` (Task 4); `fsPath` (Task 1); `PromptDialog` from `@/components/ui/prompt-dialog`; `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuSeparator` from `@/components/ui/context-menu`.
- Produces: a mutable FileTree. `TreeNode` gains action props `onNewFile(dir)`, `onNewFolder(dir)`, `onRename(path, currentName)`, `onDelete(path)`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/features/editor/FileTree.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// readDir returns one dir ("src") then that dir's contents ("a.ts").
const readDir = vi.fn(async ({ path }: { path: string }) => {
  if (path.endsWith('/src')) return { entries: [{ name: 'a.ts', type: 'file' as const }] };
  return { entries: [{ name: 'src', type: 'dir' as const }] };
});
const kv = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
vi.mock('@/renderer/lib/rpc', () => ({
  rpc: { fs: { readDir } },
  rpcSilent: { kv },
}));

const mutations = {
  createFile: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
  createFolder: vi.fn(async (dir: string, name: string) => `${dir}/${name}`),
  rename: vi.fn(async () => '/ws/renamed'),
  move: vi.fn(async () => '/ws/dest/a.ts'),
  trash: vi.fn(async () => true),
};
vi.mock('./useFileMutations', () => ({ useFileMutations: () => mutations }));

import { FileTree } from './FileTree';

beforeEach(() => vi.clearAllMocks());

function renderTree() {
  return render(
    <FileTree workspaceId="ws1" rootPath="/ws" selectedPath={null} onOpenFile={vi.fn()} />,
  );
}

describe('FileTree mutations', () => {
  it('header "New File" opens the prompt and creates at the root', async () => {
    renderTree();
    fireEvent.click(screen.getByLabelText('New file'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'fresh.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutations.createFile).toHaveBeenCalledWith('/ws', 'fresh.ts'));
  });

  it('row context menu "Delete" trashes that file', async () => {
    renderTree();
    // Expand "src" to reveal a.ts.
    fireEvent.click(await screen.findByText('src'));
    const fileRow = await screen.findByText('a.ts');
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByText('Delete'));
    await waitFor(() => expect(mutations.trash).toHaveBeenCalledWith('/ws/src/a.ts'));
  });
});
```

Note: jsdom Radix context-menu interaction can be flaky; if `findByText('Delete')` doesn't surface the portalled item, assert via the menu's `role="menuitem"` (`within(document.body).findByRole('menuitem', { name: 'Delete' })`). Keep whichever resolves the portal in this jsdom/Radix version.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/editor/FileTree.test.tsx`
Expected: FAIL — no `New file` button / no context menu yet.

- [ ] **Step 3: Add imports and the `ptr → fsPath` swap**

In `src/renderer/features/editor/FileTree.tsx`:

Replace the inline `ptr` object (lines ~23–36) and its two usages (`ptr.basename`, `ptr.join`) with the shared helper. Add to the imports near the top:

```ts
import { FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { fsPath } from './fs-path';
import { useFileMutations } from './useFileMutations';
import { PromptDialog } from '@/components/ui/prompt-dialog';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
```

Delete the `const ptr = { ... }` block and replace `ptr.join` → `fsPath.join`, `ptr.basename` → `fsPath.basename` throughout the file (two sites: `rootName` memo and the `childPath` computation in TreeNode).

- [ ] **Step 4: Add dialog + mutation orchestration to `FileTreeInner`**

Add this state and helpers inside `FileTreeInner` (alongside the existing `expanded`/`childrenByPath` state):

```tsx
  const mutations = useFileMutations();

  // One PromptDialog drives create-file / create-folder / rename. `target` is
  // the directory for creates, or the node path for a rename.
  type DialogState =
    | { mode: 'newFile' | 'newFolder'; dir: string }
    | { mode: 'rename'; path: string; currentName: string };
  const [dialog, setDialog] = useState<DialogState | null>(null);

  // Invalidate one directory's cached listing; the lazy-load effect refetches
  // because the path is still in `expanded` but no longer in childrenByPath.
  const refreshDir = useCallback((dir: string) => {
    setChildren((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
  }, []);

  const openNewFile = useCallback((dir: string) => setDialog({ mode: 'newFile', dir }), []);
  const openNewFolder = useCallback((dir: string) => setDialog({ mode: 'newFolder', dir }), []);
  const openRename = useCallback(
    (path: string, currentName: string) => setDialog({ mode: 'rename', path, currentName }),
    [],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      const ok = await mutations.trash(path);
      if (ok) refreshDir(fsPath.dirname(path));
    },
    [mutations, refreshDir],
  );

  // Reject leaf names that contain separators or are dot-only (UX guard; the
  // backend containment is the real boundary).
  const validName = (name: string) =>
    name.trim().length > 0 && !/[\\/]/.test(name) && name !== '.' && name !== '..';

  const handleDialogConfirm = useCallback(
    async (raw: string) => {
      const name = raw.trim();
      if (!dialog) return;
      if (dialog.mode !== 'rename' && !validName(name)) return;
      if (dialog.mode === 'newFile') {
        const created = await mutations.createFile(dialog.dir, name);
        if (created) {
          refreshDir(dialog.dir);
          setExpanded((prev) => new Set(prev).add(dialog.dir));
          onOpenFile(created);
        }
      } else if (dialog.mode === 'newFolder') {
        const created = await mutations.createFolder(dialog.dir, name);
        if (created) {
          refreshDir(dialog.dir);
          setExpanded((prev) => new Set(prev).add(dialog.dir).add(created));
        }
      } else {
        if (!validName(name) || name === dialog.currentName) return;
        const moved = await mutations.rename(dialog.path, name);
        if (moved) refreshDir(fsPath.dirname(dialog.path));
      }
    },
    [dialog, mutations, refreshDir, onOpenFile],
  );
```

- [ ] **Step 5: Add the header buttons and the PromptDialog render**

In `FileTreeInner`'s returned JSX, add two buttons next to the existing Refresh button in the header `<div>`:

```tsx
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => openNewFile(rootPath)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="New file"
            title="New file"
          >
            <FilePlus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => openNewFolder(rootPath)}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={refreshRoot}
            className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            aria-label="Refresh file tree"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
```

(Replace the existing single Refresh `<button>` with this grouped `<div>`.)

Pass the action callbacks into the root `<TreeNode>` (add props), and render the dialog just before the closing tag of the outer `<div>`:

```tsx
        <TreeNode
          fullPath={rootPath}
          name={rootName}
          type="dir"
          depth={0}
          expanded={expanded}
          childrenByPath={childrenByPath}
          selectedPath={selectedPath}
          onToggle={toggle}
          onOpen={onOpenFile}
          onNewFile={openNewFile}
          onNewFolder={openNewFolder}
          onRename={openRename}
          onDelete={handleDelete}
          workspaceId={workspaceId}
          rootPath={rootPath}
        />
```

```tsx
      <PromptDialog
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        title={
          dialog?.mode === 'newFolder' ? 'New folder'
            : dialog?.mode === 'rename' ? 'Rename' : 'New file'
        }
        label={dialog?.mode === 'newFolder' ? 'Folder name' : 'File name'}
        placeholder={dialog?.mode === 'newFolder' ? 'components' : 'index.ts'}
        defaultValue={dialog?.mode === 'rename' ? dialog.currentName : ''}
        confirmLabel={dialog?.mode === 'rename' ? 'Rename' : 'Create'}
        onConfirm={handleDialogConfirm}
      />
```

- [ ] **Step 6: Wrap the TreeNode row in a context menu**

Extend `NodeProps` with the four action callbacks:

```ts
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string, currentName: string) => void;
  onDelete: (path: string) => void;
```

In `TreeNode`, the create-target dir is this node's path when it's a directory, else its parent: `const ownDir = type === 'dir' ? fullPath : fsPath.dirname(fullPath);`. Wrap the existing row `<button>` (the non-root branch) with a `ContextMenu`, and thread the four callbacks into the recursive child `<TreeNode>` elements. The row becomes:

```tsx
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                const relativePath = pathRelative(fullPath, rootPath);
                e.dataTransfer.setData(
                  'application/sigmalink-file',
                  JSON.stringify({ absolutePath: fullPath, relativePath, workspaceId }),
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => (type === 'dir' ? onToggle(fullPath) : onOpen(fullPath))}
              onDoubleClick={() => type === 'dir' && onOpen(fullPath)}
              className={cn(
                'group flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[12px] transition',
                'hover:bg-accent/30',
                isSelected && 'bg-accent text-accent-foreground',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
              title={fullPath}
            >
              {/* …existing chevron / folder / file icon + <span>{name}</span>… */}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem onSelect={() => onNewFile(ownDir)}>
              <FilePlus className="mr-2 h-3.5 w-3.5" /> New File
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onNewFolder(ownDir)}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" /> New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onRename(fullPath, name)}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onDelete(fullPath)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
```

Keep the existing icon/label markup inside the button unchanged. In the recursive `children?.map(...)`, pass `onNewFile={onNewFile} onNewFolder={onNewFolder} onRename={onRename} onDelete={onDelete}` to each child `<TreeNode>`.

(If `ContextMenuItem` has no `variant` prop in this build, drop it and add `className="text-destructive focus:text-destructive"` instead — check `src/components/ui/context-menu.tsx`.)

- [ ] **Step 7: Run the test + type-check**

Run: `npx vitest run src/renderer/features/editor/FileTree.test.tsx`
Expected: PASS.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 8: Check file size, then commit**

Run: `wc -l src/renderer/features/editor/FileTree.tsx`
If > ~480 lines, extract the recursive `TreeNode` into `src/renderer/features/editor/FileTreeNode.tsx` (export it, import back) before committing — keep each file < 500.

```bash
git add src/renderer/features/editor/FileTree.tsx src/renderer/features/editor/FileTree.test.tsx
git commit -m "feat(editor): file-tree context menu, header buttons, create/rename/delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Drag-to-move

Make folder rows (and the root container) drop targets that move the dragged node via `fs.rename`, with guards against no-op and into-own-subtree moves.

**Files:**
- Modify: `src/renderer/features/editor/FileTree.tsx`
- Test: `src/renderer/features/editor/FileTree.test.tsx` (extend)

**Interfaces:**
- Consumes: `mutations.move` (Task 4); `fsPath.dirname` + `isDescendant` (Task 1); the existing `application/sigmalink-file` drag payload (`{ absolutePath }`).
- Produces: a `onDropMove(sourcePath, destDir)` handler on `FileTreeInner`, threaded into `TreeNode` as `onMoveInto(destDir, e)`.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/features/editor/FileTree.test.tsx`:

```tsx
describe('FileTree drag-to-move', () => {
  function dropPayload(absolutePath: string) {
    return {
      dataTransfer: {
        getData: (t: string) =>
          t === 'application/sigmalink-file'
            ? JSON.stringify({ absolutePath, relativePath: absolutePath, workspaceId: 'ws1' })
            : '',
        dropEffect: '',
      },
    };
  }

  it('dropping a file onto a folder moves it there', async () => {
    renderTree();
    const srcFolder = await screen.findByText('src');
    // Drag an outside file onto "src".
    fireEvent.dragOver(srcFolder, dropPayload('/ws/loose.ts'));
    fireEvent.drop(srcFolder, dropPayload('/ws/loose.ts'));
    await waitFor(() => expect(mutations.move).toHaveBeenCalledWith('/ws/loose.ts', '/ws/src'));
  });

  it('does NOT move a node onto its own current parent (no-op)', async () => {
    renderTree();
    const srcFolder = await screen.findByText('src');
    // "/ws/src/already.ts" already lives in /ws/src → dropping on src is a no-op.
    fireEvent.drop(srcFolder, dropPayload('/ws/src/already.ts'));
    expect(mutations.move).not.toHaveBeenCalled();
  });

  it('does NOT move a folder into its own descendant', async () => {
    renderTree();
    const srcFolder = await screen.findByText('src');
    // Dragging "/ws" (an ancestor of /ws/src) onto /ws/src must be rejected.
    fireEvent.drop(srcFolder, dropPayload('/ws'));
    expect(mutations.move).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/features/editor/FileTree.test.tsx -t "drag-to-move"`
Expected: FAIL — no drop handling yet.

- [ ] **Step 3: Add the move handler to `FileTreeInner`**

```tsx
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  const onDropMove = useCallback(
    async (destDir: string, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverDir(null);
      const raw = e.dataTransfer.getData('application/sigmalink-file');
      if (!raw) return;
      let source: string;
      try {
        source = (JSON.parse(raw) as { absolutePath?: string }).absolutePath ?? '';
      } catch {
        return;
      }
      if (!source) return;
      // Guards: self, current-parent (no-op), into own subtree.
      if (source === destDir) return;
      if (fsPath.dirname(source) === destDir) return;
      if (isDescendant(destDir, source)) return;
      const moved = await mutations.move(source, destDir);
      if (moved) {
        refreshDir(fsPath.dirname(source));
        refreshDir(destDir);
        setExpanded((prev) => new Set(prev).add(destDir));
      }
    },
    [mutations, refreshDir],
  );
```

Import `isDescendant`: extend the Task 5 import to `import { fsPath, isDescendant } from './fs-path';`.

Thread `onMoveInto={onDropMove}` and `dragOverDir={dragOverDir}` / `onDragOverDir={setDragOverDir}` into the root `<TreeNode>` and through the recursive children (add to `NodeProps`).

- [ ] **Step 4: Make folder rows drop targets**

On the row `<button>` inside `TreeNode`, when `type === 'dir'`, add:

```tsx
              onDragOver={
                type === 'dir'
                  ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOverDir(fullPath); }
                  : undefined
              }
              onDragLeave={type === 'dir' ? () => onDragOverDir(null) : undefined}
              onDrop={type === 'dir' ? (e) => onMoveInto(fullPath, e) : undefined}
```

Add a highlight class when this dir is the active drop target:

```tsx
                dragOverDir === fullPath && 'ring-1 ring-primary/60 bg-accent/40',
```

(Add `dragOverDir === fullPath && '...'` to the row button's `cn(...)` class list.)

Also make the root container a drop target so dropping in empty space moves to `rootPath`. On the `<div role="tree">`:

```tsx
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => onMoveInto(rootPath, e)}
```

(Folder-row `onDrop` calls `e.stopPropagation()`, so a drop on a folder does not also bubble to the root container.)

- [ ] **Step 5: Run the test + type-check**

Run: `npx vitest run src/renderer/features/editor/FileTree.test.tsx`
Expected: PASS (mutation + all three drag-move guards).

Run: `npx tsc -b`
Expected: no errors.

Note: jsdom has no real `DataTransfer` or layout — the test stubs `getData`; the visual ring highlight is not asserted (covered by the class wiring). Real drag is verified on-device, not in jsdom.

- [ ] **Step 6: Run the full editor + parity suite, then commit**

Run: `npx vitest run src/renderer/features/editor/ src/main/core/fs/ src/shared/rpc-channels.test.ts`
Expected: PASS across fs-path, useFileMutations, FileTree, controller, and channel parity.

Run: `npm run lint`
Expected: clean.

```bash
git add src/renderer/features/editor/FileTree.tsx src/renderer/features/editor/FileTree.test.tsx
git commit -m "feat(editor): drag-to-move files/folders within the file tree

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] `npx tsc -b` — clean.
- [ ] `npx vitest run src/renderer/features/editor/ src/main/core/fs/ src/shared/rpc-channels.test.ts` — green.
- [ ] `npm run lint` — clean.
- [ ] Every new `fs.*` channel appears in all five surfaces (channels, shape, schemas, router, parity test) — `rpc-channels.test.ts` proves it.
- [ ] Manual smoke (operator / on-device, NOT local-headless): right-click a folder → New File creates + auto-opens; New Folder creates + expands; Rename works; Delete moves to OS Trash (recoverable); drag a file onto another folder moves it; dragging a folder into its own subtree is refused.

## Self-Review (completed during planning)

- **Spec coverage:** §1 backend → Tasks 2–3; §2 hook/menu/dialogs/refresh → Tasks 4–5; §3 drag-move → Task 6; §4 helpers/file-size → Tasks 1 & 5 Step 8; §5 error handling → Task 4 (toasts) + Task 5 (`validName`); §6 testing → tests in every task. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
- **Type consistency:** `fsPath`/`isDescendant` (Task 1) used verbatim in Tasks 4–6; `FileMutations` method names (`createFile`/`createFolder`/`rename`/`move`/`trash`) consistent between Task 4's definition and Task 5/6's consumers; channel names (`fs.createFile`/`mkdir`/`rename`/`trash`) identical across Tasks 2–3 and the hook.
