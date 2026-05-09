// RPC controller for the skills subsystem. Wraps `SkillsManager` for the
// renderer. Every method that mutates state emits `skills:changed` via the
// manager-supplied broadcaster (registered in `rpc-router.ts`).

import { defineController } from '../../../shared/rpc';
import type { Skill, SkillProviderState } from '../../../shared/types';
import type { SkillsManager } from './manager';
import { isProviderTarget, type ProviderTarget } from './types';

export interface SkillsControllerDeps {
  manager: SkillsManager;
}

function requireProvider(value: unknown): ProviderTarget {
  if (typeof value !== 'string' || !isProviderTarget(value)) {
    throw new Error(`Unknown provider target: ${String(value)}`);
  }
  return value;
}

export function buildSkillsController(deps: SkillsControllerDeps) {
  const m = deps.manager;
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
