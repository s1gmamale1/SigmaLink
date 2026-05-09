// V3-W14-007 — Filesystem RPC controller for the Editor tab. Reads accept any
// absolute path; writes are gated to paths inside the renderer-supplied repo
// root (path-traversal guard).

import { promises as fsp } from 'node:fs';
import path from 'node:path';

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

export async function fsReadDir(input: { path: string }): Promise<{ entries: DirEntry[] }> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.readDir: path required');
  let dirents;
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true });
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
      const full = path.join(target, d.name);
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
  input: { path: string; maxBytes?: number },
): Promise<ReadFileResult> {
  const target = input.path;
  if (!target || typeof target !== 'string') throw new Error('fs.readFile: path required');
  const cap = Math.max(1, Math.min(input.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES));
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (err) {
    throw new Error(`fs.readFile: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile()) throw new Error('fs.readFile: not a regular file');
  const truncated = stat.size > cap;
  const buf = await fsp.readFile(target);
  const sliced = truncated ? buf.subarray(0, cap) : buf;
  if (isLikelyBinary(sliced)) return { content: '', encoding: 'binary', truncated };
  return { content: sliced.toString('utf8'), encoding: 'utf8', truncated };
}

export async function fsWriteFile(
  input: { path: string; content: string; repoRoot: string },
): Promise<{ ok: true }> {
  const { path: target, repoRoot: root } = input;
  if (!target || !root) throw new Error('fs.writeFile: path and repoRoot required');
  // path.relative() returns a `..`-prefixed string when target escapes root.
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('fs.writeFile: path traversal blocked');
  }
  await fsp.writeFile(path.resolve(target), input.content, 'utf8');
  return { ok: true };
}
