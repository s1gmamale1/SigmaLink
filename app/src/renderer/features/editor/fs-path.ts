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
