/**
 * v1.5.1-A — Shared path helper.
 *
 * Returns `abs` relative to `root`. If `abs` is NOT under `root`, returns `abs`
 * unchanged (the caller can still use the absolute path as a fallback).
 *
 * Handles both POSIX (`/`) and Windows (`\`) separators by detecting from the
 * path string itself rather than relying on `process.platform`.
 */
export function pathRelative(abs: string, root: string): string {
  const sep = abs.includes('\\') && !abs.startsWith('/') ? '\\' : '/';
  const prefix = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}
