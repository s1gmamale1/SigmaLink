/**
 * SMK-3 — Provider-wide skill discovery.
 *
 * Scans ALL providers via the `~/.claude/plugins/installed_plugins.json`
 * manifest (NOT blind-glob — the cache has 80+ temp_* dirs) plus flat provider
 * dirs for claude user skills, codex, and gemini.  Accepts injected `homeDir`
 * and `fs` for hermetic unit tests.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSkillMd } from './frontmatter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstalledSkillSource =
  | 'superpowers'
  | 'ruflo'
  | 'claude-plugin'
  | 'claude'
  | 'claude-cmd'
  | 'codex'
  | 'gemini'
  | 'custom';

export interface InstalledSkillEntry {
  name: string;
  description: string;
  source: InstalledSkillSource;
  /** Which CLI the skill originated from. */
  provider: 'claude' | 'codex' | 'gemini' | 'unknown';
  /**
   * Advisory source-origin prefix only ('/' for claude/gemini, '$' for codex).
   * The ACTUAL injection prefix is decided by the DESTINATION pane's
   * `session.providerId` in `insertSkillCommand.ts` (a codex skill dropped on
   * a claude pane injects with '/'), not by this field.
   */
  prefix: '/' | '$';
}

/** Minimal fs surface required by this module — accepts string paths only so
 *  tests can inject a plain in-memory fake without PathLike/Buffer overloads.
 *  readFileSync encoding is optional so the test fake (which ignores it) is
 *  assignable to this interface without an overload clash. */
interface FsLike {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[] | Buffer[];
  readFileSync(path: string, encoding?: BufferEncoding): string;
}

export interface DiscoveryOptions {
  homeDir?: string;
  fs?: FsLike;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PREFIX = '/' as const;
const CODEX_PREFIX = '$' as const;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function discoverInstalledSkills(opts: DiscoveryOptions = {}): InstalledSkillEntry[] {
  const home = opts.homeDir ?? os.homedir();
  const fs = opts.fs ?? nodeFs;
  const out: InstalledSkillEntry[] = [];
  const seen = new Set<string>(); // dedupe by source+name

  const readdir = (d: string): string[] => {
    try {
      return fs.readdirSync(d) as string[];
    } catch {
      return [];
    }
  };

  const push = (e: InstalledSkillEntry) => {
    const key = `${e.source}:${e.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  /**
   * Scan a flat `<base>/<skill>/SKILL.md` provider dir.
   * Each entry's SKILL.md is parsed; failures are silently skipped.
   */
  const scanFlat = (
    base: string,
    source: InstalledSkillSource,
    provider: InstalledSkillEntry['provider'],
    prefix: '/' | '$',
  ) => {
    if (!fs.existsSync(base)) return;
    for (const dir of readdir(base)) {
      const md = path.join(base, dir, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      try {
        const text = fs.readFileSync(md, 'utf8') as string;
        const parsed = parseSkillMd(text, dir);
        if (parsed.ok) {
          push({ name: parsed.data.name, description: parsed.data.description, source, provider, prefix });
        }
      } catch {
        /* skip unreadable */
      }
    }
  };

  // -------------------------------------------------------------------------
  // 1) Claude plugins via the manifest.
  //    The manifest has the correct versioned installPath for each plugin so
  //    we avoid blind-globbing the cache (80+ temp_git_*/temp_subdir_* dirs).
  // -------------------------------------------------------------------------
  try {
    const manifestPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    if (fs.existsSync(manifestPath)) {
      const manifestText = fs.readFileSync(manifestPath, 'utf8') as string;
      const manifest = JSON.parse(manifestText) as {
        plugins?: Record<string, Array<{ installPath?: string }>>;
      };
      for (const [pluginKey, entries] of Object.entries(manifest.plugins ?? {})) {
        for (const entry of entries ?? []) {
          const installPath = entry?.installPath;
          if (!installPath) continue;
          const skillsDir = path.join(installPath, 'skills');
          // The real manifest namespaces keys as `<name>@<marketplace>`
          // (e.g. `superpowers@claude-plugins-official`, `ruflo-core@ruflo`).
          // Tag on the un-namespaced base key; keep the path `/ruflo/` fallback.
          const baseKey = pluginKey.split('@')[0];
          const source: InstalledSkillSource =
            baseKey === 'superpowers'
              ? 'superpowers'
              : baseKey.startsWith('ruflo') || installPath.includes(`${path.sep}ruflo${path.sep}`)
              ? 'ruflo'
              : 'claude-plugin';
          scanFlat(skillsDir, source, 'claude', CLAUDE_PREFIX);
        }
      }
    }
  } catch {
    /* manifest absent/corrupt — fall through */
  }

  // -------------------------------------------------------------------------
  // 2) Claude user skills (flat): ~/.claude/skills/<skill>/SKILL.md
  // -------------------------------------------------------------------------
  scanFlat(path.join(home, '.claude', 'skills'), 'claude', 'claude', CLAUDE_PREFIX);

  // -------------------------------------------------------------------------
  // 3) Codex skills (flat, $ prefix): ~/.codex/skills/<skill>/SKILL.md
  // -------------------------------------------------------------------------
  scanFlat(path.join(home, '.codex', 'skills'), 'codex', 'codex', CODEX_PREFIX);

  // -------------------------------------------------------------------------
  // 4) Gemini / agents skills (flat): ~/.agents/skills/<skill>/SKILL.md
  // -------------------------------------------------------------------------
  scanFlat(path.join(home, '.agents', 'skills'), 'gemini', 'gemini', CLAUDE_PREFIX);

  // -------------------------------------------------------------------------
  // 5) Claude commands: ~/.claude/commands/**/*.md (recursive, skip README).
  //    Name = file stem.  Best-effort — must never throw.
  // -------------------------------------------------------------------------
  const cmdBase = path.join(home, '.claude', 'commands');
  const walkCmds = (dir: string) => {
    for (const ent of readdir(dir)) {
      const full = path.join(dir, ent);
      if (!ent.endsWith('.md')) {
        // Treat as a subdirectory — recurse.
        if (fs.existsSync(full)) walkCmds(full);
      } else if (ent.toLowerCase() !== 'readme.md') {
        try {
          const text = fs.readFileSync(full, 'utf8') as string;
          const stem = ent.replace(/\.md$/, '');
          const parsed = parseSkillMd(text, stem);
          const name = parsed.ok ? parsed.data.name : stem;
          const description = parsed.ok ? parsed.data.description : '';
          push({ name, description, source: 'claude-cmd', provider: 'claude', prefix: CLAUDE_PREFIX });
        } catch {
          /* skip */
        }
      }
    }
  };
  if (fs.existsSync(cmdBase)) walkCmds(cmdBase);

  return out;
}
