// Filesystem layer for `<workspace>/.sigmamemory/<name>.md` notes. Notes are
// markdown files with a YAML frontmatter block. Writes are atomic via
// temp-file-plus-rename; on Windows we retry up to 3x to dodge transient
// EPERM/EBUSY caused by AV scanners or open file handles.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import matter from 'gray-matter';
import type { MemoryFileRecord, MemoryFrontmatter } from './types';

export const MEMORY_DIR_NAME = '.sigmamemory';
const FILE_EXT = '.md';

export interface HubLayout {
  workspaceRoot: string;
  hubPath: string;
}

export function resolveHubPath(workspaceRoot: string): HubLayout {
  return {
    workspaceRoot,
    hubPath: path.join(workspaceRoot, MEMORY_DIR_NAME),
  };
}

export async function ensureHub(workspaceRoot: string): Promise<HubLayout> {
  const layout = resolveHubPath(workspaceRoot);
  await fsp.mkdir(layout.hubPath, { recursive: true });
  return layout;
}

export function ensureHubSync(workspaceRoot: string): HubLayout {
  const layout = resolveHubPath(workspaceRoot);
  fs.mkdirSync(layout.hubPath, { recursive: true });
  return layout;
}

/**
 * Sanitize a note name into a safe filename. We restrict to a permissive
 * subset of printable ASCII — letters, digits, dash, underscore, dot, space,
 * and a small handful of safe extras — and collapse runs of whitespace.
 *
 * Empty results raise. Path separators and `..` segments are stripped
 * defensively to keep notes inside the hub directory.
 */
export function sanitizeName(raw: string): string {
  if (typeof raw !== 'string') throw new Error('Memory name must be a string');
  let cleaned = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 32 || cp === 127) continue;
    cleaned += ch;
  }
  cleaned = cleaned
    .replace(/[\\/]+/g, ' ')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) throw new Error('Memory name resolves to empty after sanitize');
  if (cleaned === '.' || cleaned === '..') throw new Error('Memory name reserved');
  if (cleaned.length > 200) throw new Error('Memory name too long (max 200 chars)');
  return cleaned;
}

export function fileForName(workspaceRoot: string, name: string): string {
  const safe = sanitizeName(name);
  return path.join(resolveHubPath(workspaceRoot).hubPath, safe + FILE_EXT);
}

export async function readMemoryFile(
  workspaceRoot: string,
  name: string,
): Promise<MemoryFileRecord | null> {
  const filePath = fileForName(workspaceRoot, name);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseFile(filePath, name, raw);
}

export async function listMemoryFiles(workspaceRoot: string): Promise<MemoryFileRecord[]> {
  const layout = resolveHubPath(workspaceRoot);
  let entries: string[];
  try {
    entries = await fsp.readdir(layout.hubPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: MemoryFileRecord[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(FILE_EXT)) continue;
    const fullPath = path.join(layout.hubPath, entry);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const name = entry.slice(0, -FILE_EXT.length);
    try {
      const raw = await fsp.readFile(fullPath, 'utf8');
      out.push(parseFile(fullPath, name, raw));
    } catch {
      // Skip unreadable files; the manager will surface the issue elsewhere.
    }
  }
  return out;
}

export interface WriteMemoryArgs {
  workspaceRoot: string;
  name: string;
  body: string;
  frontmatter: MemoryFrontmatter;
}

/**
 * Atomic write: dump to `<file>.tmp-<rand>` in the same directory, then
 * `rename()` over the destination. On Windows we retry up to 3 times with a
 * short backoff to absorb antivirus / Defender contention.
 */
export async function writeMemoryFile(args: WriteMemoryArgs): Promise<string> {
  const layout = await ensureHub(args.workspaceRoot);
  const safe = sanitizeName(args.name);
  const target = path.join(layout.hubPath, safe + FILE_EXT);
  const serialized = serialize(args.body, args.frontmatter);
  const tmp = path.join(
    layout.hubPath,
    `.${safe}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await fsp.writeFile(tmp, serialized, { encoding: 'utf8' });
  let attempt = 0;
  // 3x backoff: 0, 50ms, 100ms
  while (true) {
    try {
      await fsp.rename(tmp, target);
      return target;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EBUSY' || code === 'EEXIST';
      if (!retriable || attempt >= 2) {
        try {
          await fsp.unlink(tmp);
        } catch {
          /* best-effort */
        }
        throw err;
      }
      attempt += 1;
      await delay(50 * attempt);
    }
  }
}

export async function deleteMemoryFile(
  workspaceRoot: string,
  name: string,
): Promise<boolean> {
  const filePath = fileForName(workspaceRoot, name);
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function serialize(body: string, frontmatter: MemoryFrontmatter): string {
  // We assemble manually rather than relying on matter.stringify's YAML lib
  // emitting consistent ordering; the small format here keeps diffs readable.
  const fmLines = ['---'];
  fmLines.push(`name: ${yamlString(frontmatter.name)}`);
  if (frontmatter.tags && frontmatter.tags.length) {
    fmLines.push('tags:');
    for (const tag of frontmatter.tags) {
      fmLines.push(`  - ${yamlString(tag)}`);
    }
  }
  fmLines.push(`created: ${frontmatter.created}`);
  fmLines.push(`updated: ${frontmatter.updated}`);
  fmLines.push('---');
  fmLines.push('');
  return fmLines.join('\n') + body.replace(/^\s+/, '');
}

function parseFile(filePath: string, name: string, raw: string): MemoryFileRecord {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return {
      filePath,
      name,
      body: raw,
      frontmatter: synthesizeFrontmatter(name, raw),
    };
  }
  const fm = parsed.data as Partial<MemoryFrontmatter> & { tags?: unknown };
  const frontmatter: MemoryFrontmatter = {
    name: typeof fm.name === 'string' && fm.name.length ? fm.name : name,
    tags: Array.isArray(fm.tags)
      ? fm.tags.filter((t): t is string => typeof t === 'string')
      : undefined,
    created: typeof fm.created === 'number' ? fm.created : Date.now(),
    updated: typeof fm.updated === 'number' ? fm.updated : Date.now(),
  };
  return {
    filePath,
    name: frontmatter.name,
    body: parsed.content.replace(/^\n+/, ''),
    frontmatter,
  };
}

function synthesizeFrontmatter(name: string, body: string): MemoryFrontmatter {
  void body;
  const now = Date.now();
  return { name, tags: [], created: now, updated: now };
}

function yamlString(value: string): string {
  if (/^[\w./@:#-][\w./@:#\- ]*$/.test(value) && !value.includes(': ')) {
    return value;
  }
  return JSON.stringify(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
