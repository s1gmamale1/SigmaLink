// RPC controller for the skills subsystem. Wraps `SkillsManager` for the
// renderer. Every method that mutates state emits `skills:changed` via the
// manager-supplied broadcaster (registered in `rpc-router.ts`).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineController } from '../../../shared/rpc';
import type { Skill, SkillProviderState } from '../../../shared/types';
import type { SkillFanoutVerification, SkillsManager } from './manager';
import { isProviderTarget, type ProviderTarget } from './types';
import { parseSkillMd } from './frontmatter';
import {
  installFromUrl as runInstallFromUrl,
  type InstallFromUrlResult,
  type InstallProgressEvent,
} from './marketplace';

export interface InstalledSkillEntry {
  name: string;
  description: string;
  source: 'superpowers' | 'ruflo' | 'custom';
}

export interface SkillsControllerDeps {
  manager: SkillsManager;
  /** Absolute path used by the marketplace installer to stage tarballs. */
  marketplaceTempDir: string;
  /** Broadcaster for `skills:install-progress` events. Optional in tests. */
  emit?: (event: string, payload: unknown) => void;
}

function requireProvider(value: unknown): ProviderTarget {
  if (typeof value !== 'string' || !isProviderTarget(value)) {
    throw new Error(`Unknown provider target: ${String(value)}`);
  }
  return value;
}

export function buildSkillsController(deps: SkillsControllerDeps) {
  const m = deps.manager;
  const emit = deps.emit ?? (() => undefined);
  return defineController({
    list: async (): Promise<{ skills: Skill[]; states: SkillProviderState[] }> => {
      return m.list();
    },
    ingestFolder: async (input: { path: string; force?: boolean }): Promise<Skill> => {
      if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('skills.ingestFolder: missing path');
      }
      return m.ingestFolder(input.path, { force: !!input.force });
    },
    ingestZip: async (input: { path: string; force?: boolean }): Promise<Skill> => {
      if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('skills.ingestZip: missing path');
      }
      return m.ingestZip(input.path, { force: !!input.force });
    },
    /**
     * Phase 4 Step 5 — install a skill from a public GitHub repository.
     * The renderer subscribes to `skills:install-progress` to drive a
     * progress bar; this method only resolves with the final envelope so
     * RPC bookkeeping stays simple.
     */
    installFromUrl: async (input: {
      ownerRepo: string;
      ref?: string;
      subPath?: string;
      force?: boolean;
    }): Promise<InstallFromUrlResult> => {
      if (!input || typeof input.ownerRepo !== 'string' || !input.ownerRepo.trim()) {
        return {
          ok: false,
          error: { code: 'invalid-url', message: 'skills.installFromUrl: missing ownerRepo' },
        };
      }
      const result = await runInstallFromUrl(
        { manager: m, tempDir: deps.marketplaceTempDir },
        {
          ownerRepo: input.ownerRepo,
          ref: input.ref,
          subPath: input.subPath,
          force: !!input.force,
          onProgress: (evt: InstallProgressEvent) => {
            // Mirror the channel name documented in `rpc-channels.ts` so the
            // preload bridge allowlist gates this event.
            emit('skills:install-progress', { ownerRepo: input.ownerRepo, ...evt });
          },
        },
      );
      return result;
    },
    enableForProvider: async (input: { skillId: string; provider: string }): Promise<SkillProviderState> => {
      return m.enableForProvider(input.skillId, requireProvider(input.provider));
    },
    disableForProvider: async (input: { skillId: string; provider: string }): Promise<SkillProviderState> => {
      return m.disableForProvider(input.skillId, requireProvider(input.provider));
    },
    uninstall: async (skillId: string): Promise<void> => {
      await m.uninstall(skillId);
    },
    getReadme: async (skillId: string): Promise<{ name: string; body: string } | null> => {
      return m.getReadme(skillId);
    },
    verifyForWorkspace: async (workspaceId: string): Promise<SkillFanoutVerification> => {
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
        throw new Error('skills.verifyForWorkspace: missing workspaceId');
      }
      const result = await m.verifyFanoutForWorkspace(workspaceId);
      emit('skills:workspace-verified', result);
      return result;
    },

    // v1.6.1 B3 — Skills tab Phase 1 read-only discovery.
    // Discovers superpowers skills from the official plugins cache; Ruflo skills
    // from the embedded Ruflo plugin cache (best-effort); falls back gracefully
    // to an empty list when directories are absent.
    listInstalled: async (): Promise<InstalledSkillEntry[]> => {
      return discoverInstalledSkills();
    },
  });
}

/** Default temp directory for marketplace tarballs. Lives next to the
 *  managed-skills root so admins can wipe both with a single rm. */
export function defaultMarketplaceTempDir(userData: string): string {
  return path.join(userData, 'marketplace-tmp');
}

/**
 * Discover installed superpowers (and optionally Ruflo) skills by scanning
 * the on-disk plugin cache directories. Tolerates missing directories by
 * returning an empty list — never throws.
 *
 * Scan path: ~/.claude/plugins/cache/claude-plugins-official/superpowers/<plugin>/skills/<skill>/SKILL.md
 */
function discoverInstalledSkills(): InstalledSkillEntry[] {
  const results: InstalledSkillEntry[] = [];

  // Superpowers skills: ~/.claude/plugins/cache/claude-plugins-official/superpowers/<plugin>/skills/<skill>/SKILL.md
  try {
    const superpowersBase = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      'claude-plugins-official',
      'superpowers',
    );
    if (fs.existsSync(superpowersBase)) {
      const pluginDirs = safeReaddir(superpowersBase);
      for (const pluginDir of pluginDirs) {
        const skillsDir = path.join(superpowersBase, pluginDir, 'skills');
        if (!fs.existsSync(skillsDir)) continue;
        const skillDirs = safeReaddir(skillsDir);
        for (const skillDir of skillDirs) {
          const skillMd = path.join(skillsDir, skillDir, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          try {
            const text = fs.readFileSync(skillMd, 'utf8');
            const parsed = parseSkillMd(text, skillDir);
            if (parsed.ok) {
              results.push({
                name: parsed.data.name,
                description: parsed.data.description,
                source: 'superpowers',
              });
            }
          } catch {
            /* skip unreadable files */
          }
        }
      }
    }
  } catch {
    /* tolerate any fs error */
  }

  // Ruflo skills: ~/.claude/plugins/cache/ruflo/*/skills/*/SKILL.md (best-effort)
  try {
    const rufloBase = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      'ruflo',
    );
    if (fs.existsSync(rufloBase)) {
      const pluginDirs = safeReaddir(rufloBase);
      for (const pluginDir of pluginDirs) {
        const skillsDir = path.join(rufloBase, pluginDir, 'skills');
        if (!fs.existsSync(skillsDir)) continue;
        const skillDirs = safeReaddir(skillsDir);
        for (const skillDir of skillDirs) {
          const skillMd = path.join(skillsDir, skillDir, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          try {
            const text = fs.readFileSync(skillMd, 'utf8');
            const parsed = parseSkillMd(text, skillDir);
            if (parsed.ok) {
              results.push({
                name: parsed.data.name,
                description: parsed.data.description,
                source: 'ruflo',
              });
            }
          } catch {
            /* skip unreadable files */
          }
        }
      }
    }
  } catch {
    /* best-effort */
  }

  return results;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
