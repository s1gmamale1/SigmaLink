// RPC controller for the skills subsystem. Wraps `SkillsManager` for the
// renderer. Every method that mutates state emits `skills:changed` via the
// manager-supplied broadcaster (registered in `rpc-router.ts`).

import path from 'node:path';
import { defineController } from '../../../shared/rpc';
import type { Skill, SkillProviderState } from '../../../shared/types';
import type { SkillsManager } from './manager';
import { isProviderTarget, type ProviderTarget } from './types';
import {
  installFromUrl as runInstallFromUrl,
  type InstallFromUrlResult,
  type InstallProgressEvent,
} from './marketplace';

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
  });
}

/** Default temp directory for marketplace tarballs. Lives next to the
 *  managed-skills root so admins can wipe both with a single rm. */
export function defaultMarketplaceTempDir(userData: string): string {
  return path.join(userData, 'marketplace-tmp');
}
