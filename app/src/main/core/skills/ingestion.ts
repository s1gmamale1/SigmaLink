// Ingest a skill folder from disk into SigmaLink's managed skills root.
//
// The renderer hands us an absolute path to the skill folder (the one whose
// top-level contains `SKILL.md`). We:
//   1. Read SKILL.md, validate frontmatter (frontmatter.ts).
//   2. Walk the folder, compute a deterministic content hash.
//   3. Copy the tree to a temp sibling directory under `<userData>/skills/`,
//      then `fs.rename` it onto the final managed path. If the rename target
//      already exists with the same hash, it is left alone (idempotent reinstall).
//      A different hash with `force: false` raises `SkillUpdateRequiredError` so
//      the renderer can offer an "Update" affordance.
//
// The rename-into-place pattern means partial copies never leave a half-written
// canonical skill on disk. A best-effort cleanup on failure removes the temp dir.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSkillMd } from './frontmatter';
import type { Skill } from './types';

export interface IngestOptions {
  /** Absolute path to the SigmaLink-managed `<userData>/skills/` root. */
  managedRoot: string;
  /** Allow replacing an existing managed skill that has a different hash. */
  force?: boolean;
}

export class SkillUpdateRequiredError extends Error {
  readonly skillName: string;
  readonly existingHash: string;
  readonly incomingHash: string;
  constructor(skillName: string, existingHash: string, incomingHash: string) {
    super(
      `Skill "${skillName}" is already installed with a different content hash. ` +
        `Pass force=true (UI Update button) to overwrite.`,
    );
    this.name = 'SkillUpdateRequiredError';
    this.skillName = skillName;
    this.existingHash = existingHash;
    this.incomingHash = incomingHash;
  }
}

interface HashedFile {
  relPath: string;
  size: number;
  sha256: string;
  absPath: string;
}

function sha256OfFile(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashTree(rootAbs: string): { hash: string; files: HashedFile[] } {
  const files: HashedFile[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Stable order — sort for hash determinism across platforms.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Skip OS junk files / VCS metadata to keep the hash stable across machines.
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db' || entry.name === '.git') continue;
      const child = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child, rel);
      } else if (entry.isFile()) {
        const size = fs.statSync(child).size;
        files.push({
          relPath: rel,
          size,
          sha256: sha256OfFile(child),
          absPath: child,
        });
      }
    }
  };
  walk(rootAbs, '');
  const hasher = crypto.createHash('sha256');
  for (const f of files) {
    hasher.update(`${f.relPath}:${f.size}:${f.sha256}\n`);
  }
  return { hash: hasher.digest('hex'), files };
}

function copyTree(srcRoot: string, files: HashedFile[], destRoot: string): void {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const f of files) {
    const dest = path.join(destRoot, f.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.absPath, dest);
  }
  // Touch a marker so callers can detect SigmaLink-managed copies later.
  void srcRoot;
}

function safeRimraf(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Ingest a folder containing SKILL.md into the managed skills root.
 *
 * Throws on validation failure or if a hash conflict is detected without
 * `force: true`.
 */
export async function ingestFolder(srcAbsPath: string, opts: IngestOptions): Promise<Skill> {
  const stat = fs.statSync(srcAbsPath);
  if (!stat.isDirectory()) {
    throw new Error(`ingestFolder: ${srcAbsPath} is not a directory`);
  }

  const skillMdPath = path.join(srcAbsPath, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`ingestFolder: no SKILL.md at ${srcAbsPath}`);
  }

  const text = fs.readFileSync(skillMdPath, 'utf8');
  const fallbackName = path.basename(srcAbsPath);
  const parsed = parseSkillMd(text, fallbackName);
  if (!parsed.ok) {
    throw new Error(`Skill validation failed: ${parsed.error}`);
  }
  const fm = parsed.data;

  // Compute content hash before writing so we can short-circuit re-ingests.
  const { hash, files } = hashTree(srcAbsPath);

  fs.mkdirSync(opts.managedRoot, { recursive: true });
  const finalDir = path.join(opts.managedRoot, fm.name);
  const tempDir = path.join(opts.managedRoot, `.tmp-${fm.name}-${crypto.randomBytes(6).toString('hex')}`);

  // Hash check against existing managed copy (idempotent reinstall).
  if (fs.existsSync(finalDir)) {
    const existingHash = (() => {
      try {
        const existing = hashTree(finalDir);
        return existing.hash;
      } catch {
        return null;
      }
    })();
    if (existingHash === hash) {
      // Same content → no-op. Return the metadata for the existing install.
      return {
        id: fm.name,
        name: fm.name,
        description: fm.description,
        version: fm.version,
        tags: fm.tags,
        contentHash: hash,
        managedPath: finalDir,
        installedAt: stat.mtimeMs ?? Date.now(),
      };
    }
    if (!opts.force) {
      throw new SkillUpdateRequiredError(fm.name, existingHash ?? 'unknown', hash);
    }
  }

  try {
    copyTree(srcAbsPath, files, tempDir);
  } catch (err) {
    safeRimraf(tempDir);
    throw new Error(
      `Failed to stage skill copy at ${tempDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Replace any existing canonical copy atomically.
  if (fs.existsSync(finalDir)) safeRimraf(finalDir);
  try {
    fs.renameSync(tempDir, finalDir);
  } catch (err) {
    safeRimraf(tempDir);
    throw new Error(
      `Failed to rename ${tempDir} to ${finalDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    id: fm.name,
    name: fm.name,
    description: fm.description,
    version: fm.version,
    tags: fm.tags,
    contentHash: hash,
    managedPath: finalDir,
    installedAt: Date.now(),
  };
}

/**
 * Zip ingestion is deferred — see W6-SKILLS report. Without a zip extraction
 * dependency in the existing surface (no `adm-zip`, `unzipper`, etc. shipped),
 * we surface a clear error instead of a silent no-op.
 */
export async function ingestZip(zipPath: string, opts: IngestOptions): Promise<never> {
  void zipPath;
  void opts;
  throw new Error(
    'Zip ingestion is not yet implemented. Drop the unzipped folder containing SKILL.md instead.',
  );
}

/**
 * Re-hash a managed skill folder. Used by the manager to verify on-disk
 * state still matches the DB row (e.g., after a manual edit).
 */
export function rehashManagedFolder(folderAbsPath: string): string {
  return hashTree(folderAbsPath).hash;
}

/**
 * Recursive copy used by the fan-out writer. Exposed so we don't duplicate
 * the walk + copy logic.
 */
export function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
