// V3-W14-007 — Filesystem RPC controller for the Editor tab.
//
// Wave-1 hardening (H-2/H-3/H-11): every handler now routes its target path
// through the central `assertAllowedPath` keystone (core/security/path-guard).
//  - H-3: reads are no longer unconditionally allowed on any absolute path.
//  - H-2: writes no longer trust the renderer-supplied `repoRoot`; containment
//    is decided solely by the injected allowed-roots provider.
//  - H-11: `fsReadFile` does a PARTIAL read (open + read up to `cap` bytes)
//    instead of reading the whole file before truncating.
//
// Containment is FAIL-CLOSED: when no `allowedRoots` provider is supplied the
// handler denies everything (throws `'path outside workspace'`). An un-wired
// caller therefore denies rather than silently leaking the old any-path
// behaviour. The router (rpc-router.ts) injects the real provider built from
// DB workspaces + the worktree pool.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { assertAllowedPath, type AllowedRootsSource } from '../security/path-guard';

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: number;
}

export interface ReadFileResult {
  content: string;
  encoding: 'utf8' | 'binary';
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

const HIDDEN_DIRS: ReadonlySet<string> = new Set([
  '.git', '.DS_Store', 'node_modules', '.next', '.turbo', '.cache',
  'dist', 'build', 'out', '.svelte-kit', '.parcel-cache', 'coverage',
]);

/** Quick heuristic for binary content. UTF-8 BOM and most text is fine; raw
 *  NUL bytes in the first 8 KiB strongly suggest binary. */
function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Fail-closed containment. Resolve `target` against the allowed roots and
 * return the realpath-resolved absolute path. When `allowedRoots` is absent we
 * deny everything (empty roots ⇒ `assertAllowedPath` throws), so an un-wired
 * caller is safe by construction.
 */
function containPath(target: string, allowedRoots: AllowedRootsSource | undefined): string {
  const roots = allowedRoots ? allowedRoots() : [];
  return assertAllowedPath(target, roots);
}

export async function fsReadDir(
  input: { path: string; allowedRoots?: AllowedRootsSource },
): Promise<{ entries: DirEntry[] }> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.readDir: path required');
  // H-3: contain the directory path before listing it.
  const safe = containPath(target, input.allowedRoots);
  let dirents;
  try {
    dirents = await fsp.readdir(safe, { withFileTypes: true });
  } catch (err) {
    throw new Error(`fs.readDir: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries: DirEntry[] = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (HIDDEN_DIRS.has(d.name)) return;
      // Hide dotfiles except a couple of high-signal ones; the kv toggle to
      // surface them all is parked for a future wave.
      if (d.name.startsWith('.') && d.name !== '.gitignore' && d.name !== '.env.example') return;
      const full = path.join(safe, d.name);
      try {
        const st = await fsp.stat(full);
        entries.push({
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size: d.isFile() ? st.size : undefined,
          modifiedAt: st.mtimeMs,
        });
      } catch {
        /* missing symlink target / perms denied — skip silently */
      }
    }),
  );
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

export async function fsReadFile(
  input: { path: string; maxBytes?: number; allowedRoots?: AllowedRootsSource },
): Promise<ReadFileResult> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.readFile: path required');
  // H-3: contain the file path before touching the disk.
  const safe = containPath(target, input.allowedRoots);
  const cap = Math.max(1, Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
  let stat;
  try {
    stat = await fsp.stat(safe);
  } catch (err) {
    throw new Error(`fs.readFile: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile()) throw new Error('fs.readFile: not a regular file');
  const truncated = stat.size > cap;
  // H-11: partial read — open the file and read at most `cap` bytes into a
  // right-sized buffer. NEVER read the whole file before truncating (a
  // multi-GB file used to be fully buffered, then sliced, defeating the cap).
  const readLen = Math.min(stat.size, cap);
  const sliced = await readUpTo(safe, readLen);
  if (isLikelyBinary(sliced)) return { content: '', encoding: 'binary', truncated };
  return { content: sliced.toString('utf8'), encoding: 'utf8', truncated };
}

/** Open `file` and read exactly the first `len` bytes (or fewer if the file is
 *  shorter than `len` after the stat — e.g. a concurrent truncation). Closes
 *  the descriptor in a `finally` so we never leak fds on a read error. */
async function readUpTo(file: string, len: number): Promise<Buffer> {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  const handle = await fsp.open(file, 'r');
  try {
    const { bytesRead } = await handle.read(buf, 0, len, 0);
    return bytesRead === len ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function fsWriteFile(
  input: {
    path: string;
    content: string;
    /**
     * @deprecated Renderer-supplied repo root. RETAINED for back-compat with
     * existing callers but NO LONGER used for the security decision (H-2: a
     * malicious renderer could pass `repoRoot:"/"` to collapse the old
     * `path.relative` guard). Containment is now decided exclusively by the
     * injected `allowedRoots` provider, which the main process controls.
     */
    repoRoot?: string;
    allowedRoots?: AllowedRootsSource;
  },
): Promise<{ ok: true }> {
  const { path: target } = input;
  if (!target) throw new Error('fs.writeFile: path required');
  // H-2: containment comes from the authoritative allowed-roots provider, NOT
  // the renderer's `repoRoot`. Fail-closed when the provider is absent.
  const safe = containPath(target, input.allowedRoots);
  await fsp.writeFile(safe, input.content, 'utf8');
  return { ok: true };
}
