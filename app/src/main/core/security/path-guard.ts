// Wave-1 H-5 — central path-containment keystone.
//
// Every main-process filesystem entry point (the fs RPC controller, the Sigma
// assistant `read_files` tool, …) routes its target path through
// `assertAllowedPath` so the sandbox is enforced in exactly ONE place. The
// logic generalizes the realpath-safe containment R-1 first built privately in
// `core/assistant/tools.ts` (`isInsideRoot` + `resolveInsideAllowedRoots`).
//
// Design rules:
//  - Pure, synchronous, dependency-free (node:fs + node:path only). No DB, no
//    Electron, no async — so it is trivially unit-testable and cannot itself
//    widen the sandbox via a failing import.
//  - Symlink-safe: containment is judged ONLY against the realpath-resolved
//    target. An in-tree symlink whose real target points at e.g. `~/.ssh` is
//    REJECTED, because we never accept the lexical (un-resolved) path.
//  - Fail-closed: an empty `roots` set always throws. A caller that cannot (or
//    forgot to) supply allowed roots therefore DENIES rather than leaks.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Provider of the set of allowed absolute root directories. The wiring layer
 * (rpc-router) builds this from the DB workspaces' `rootPath`/`repoRoot` plus
 * the git worktree pool dir per repo. Returning an empty array means deny-all.
 *
 * It is a function (not a static array) so the allowed set is re-derived on
 * every call — newly opened workspaces are picked up without re-wiring, and a
 * transient DB failure can return `[]` (deny-all) for that one call only.
 */
export interface AllowedRootsSource {
  (): string[];
}

/**
 * True when `resolvedTarget` is `resolvedRoot` itself or lives underneath it.
 *
 * Uses `path.relative` rather than a naive `startsWith` prefix test so that
 * `/a/b` is NOT considered inside `/a/bc` (a prefix check would wrongly accept
 * that, since `'/a/bc'.startsWith('/a/b')` is true). Both arguments are assumed
 * already absolute; the caller resolves/realpaths them first.
 */
export function isInsideRoot(resolvedTarget: string, resolvedRoot: string): boolean {
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Lexical many-roots containment for the reveal/open-shell class of handlers
 * (rpc-router `revealInFolder` / `openShell`). Unlike `assertAllowedPath`
 * this does NOT realpath (those handlers are intentionally lexical); it fixes
 * the raw-`startsWith` class of bugs: separator boundaries (`/a/bc` vs
 * `/a/b`) and win32 drive-letter casing — `path.win32.relative` compares
 * case-insensitively, which is exactly the Windows filesystem contract.
 *
 * `pathImpl` is injected so win32 semantics are unit-testable on any host
 * (pass `path.win32`); production callers omit it and get the platform path.
 */
export function isInsideAnyRoot(
  target: string,
  roots: string[],
  pathImpl: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'> = path,
): boolean {
  const resolvedTarget = pathImpl.resolve(target);
  for (const root of roots) {
    if (!root) continue;
    const resolvedRoot = pathImpl.resolve(root);
    const rel = pathImpl.relative(resolvedRoot, resolvedTarget);
    if (rel === '' || (!rel.startsWith('..') && !pathImpl.isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Resolve `target` (following symlinks) and return its absolute, realpath'd
 * form IFF it sits inside at least one realpath-resolved entry of `roots`.
 * Otherwise throw `Error('path outside workspace')`.
 *
 * Resolution:
 *  - For an existing target: `fs.realpathSync(target)` collapses every symlink
 *    so a planted in-tree symlink is judged by its REAL target, not its lexical
 *    in-tree location.
 *  - For a not-yet-existing write target: realpath its nearest existing
 *    ancestor directory, then re-join the trailing (non-existent) segments. So
 *    a new file whose parent dir is inside an allowed root is allowed, while a
 *    new file under a symlinked-out parent is still judged by the parent's real
 *    location.
 *
 * Empty `roots` ⇒ always throw (fail-closed / deny-all).
 */
export function assertAllowedPath(target: string, roots: string[]): string {
  if (!target || typeof target !== 'string') {
    throw new Error('path outside workspace');
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    // Fail-closed: no allowed roots ⇒ nothing is permitted.
    throw new Error('path outside workspace');
  }

  const resolved = realpathResolved(path.resolve(target));

  for (const root of roots) {
    if (!root) continue;
    // Realpath the root too: a symlinked workspace root (e.g. macOS
    // /var/folders → /private/var/folders) must still match the realpath'd
    // target. A non-existent root falls through to its lexical form.
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      realRoot = path.resolve(root);
    }
    if (isInsideRoot(resolved, realRoot)) return resolved;
  }
  throw new Error('path outside workspace');
}

/**
 * Realpath an absolute path, tolerating a target that does not exist yet.
 *
 * If `abs` exists it is realpath'd directly (all symlinks collapsed). If it
 * does not exist, we walk up to the nearest existing ancestor, realpath THAT,
 * then re-attach the trailing non-existent segments. This keeps the
 * symlink-safety guarantee for the existing portion of the path while still
 * allowing a brand-new write target whose parent dir is legitimate.
 */
function realpathResolved(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    /* falls through — abs (or a parent) does not exist yet */
  }

  // Walk UP from `abs` to the nearest existing ancestor, realpath that, then
  // re-attach the (non-existent) tail relative to the un-resolved ancestor.
  // The loop is bounded by the segment count and terminates at the filesystem
  // root, where `path.dirname(ancestor) === ancestor`.
  let ancestor = path.dirname(abs);
  for (;;) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      const tail = path.relative(ancestor, abs);
      return tail ? path.join(realAncestor, tail) : realAncestor;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // Reached the root with nothing existing — nothing to realpath; return
        // the lexically-resolved path so containment is still enforced.
        return abs;
      }
      ancestor = parent;
    }
  }
}
