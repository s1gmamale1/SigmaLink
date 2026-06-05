// RPC controller for the skills subsystem. Wraps `SkillsManager` for the
// renderer. Every method that mutates state emits `skills:changed` via the
// manager-supplied broadcaster (registered in `rpc-router.ts`).
//
// v1.7.1 W-5 Skills Phase 2 — adds attach / detach / listBindings for
// INFORMATIONAL skill binding (visual chip association; no behavioral activation).

import path from 'node:path';
import crypto from 'node:crypto';
import { defineController } from '../../../shared/rpc';
import type { Skill, SkillProviderState } from '../../../shared/types';
import type { SkillFanoutVerification, SkillsManager } from './manager';
import { isProviderTarget, type ProviderTarget } from './types';
import {
  installFromUrl as runInstallFromUrl,
  type InstallFromUrlResult,
  type InstallProgressEvent,
} from './marketplace';
import { getRawDb } from '../db/client';
// SMK-3: single source of truth for InstalledSkillEntry lives in discovery.ts.
export type { InstalledSkillEntry, InstalledSkillSource } from './discovery';
import { discoverInstalledSkills, type InstalledSkillEntry } from './discovery';

// v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding row returned over RPC.
// Behavioral activation (skill actually affecting agent context) is deferred.
export interface SkillBindingEntry {
  id: string;
  workspaceId: string;
  /** NULL = workspace-wide; non-null = pane-scoped. */
  paneSessionId: string | null;
  skillName: string;
  skillSource: string;
  attachedAt: number;
}

interface SkillBindingDbRow {
  id: string;
  workspace_id: string;
  pane_session_id: string | null;
  skill_name: string;
  skill_source: string;
  attached_at: number;
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

    // v1.7.1 W-5 Skills Phase 2 — INFORMATIONAL binding CRUD.
    //
    // SCOPE: These methods create/read/delete VISUAL associations between a
    // skill and a pane/workspace. They do NOT affect agent dispatch, do NOT
    // inject into agent context, and do NOT alter Sigma/Jorvis tool-calling.
    // Behavioral activation is a deferred future enhancement.

    /**
     * Attach a skill to a workspace or pane (INFORMATIONAL binding only).
     * Deduplicates: if an identical binding (workspaceId + paneSessionId +
     * skillName + skillSource) already exists, the existing row is returned
     * unchanged (idempotent).
     */
    attach: async (input: {
      workspaceId: string;
      paneSessionId?: string | null;
      skillName: string;
      skillSource: string;
    }): Promise<SkillBindingEntry> => {
      if (!input || typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
        throw new Error('skills.attach: missing workspaceId');
      }
      if (typeof input.skillName !== 'string' || !input.skillName.trim()) {
        throw new Error('skills.attach: missing skillName');
      }
      if (typeof input.skillSource !== 'string' || !input.skillSource.trim()) {
        throw new Error('skills.attach: missing skillSource');
      }
      const db = getRawDb();
      const paneId = input.paneSessionId ?? null;

      // Check for existing identical binding (dedup).
      const existing = db
        .prepare(
          `SELECT id, workspace_id, pane_session_id, skill_name, skill_source, attached_at
           FROM skill_bindings
           WHERE workspace_id = ?
             AND skill_name = ?
             AND skill_source = ?
             AND (pane_session_id IS ? OR (pane_session_id IS NOT NULL AND pane_session_id = ?))`,
        )
        .get(
          input.workspaceId,
          input.skillName,
          input.skillSource,
          paneId,
          paneId,
        ) as SkillBindingDbRow | undefined;

      if (existing) {
        return rowToEntry(existing);
      }

      const id = crypto.randomUUID();
      const attachedAt = Date.now();
      db.prepare(
        `INSERT INTO skill_bindings (id, workspace_id, pane_session_id, skill_name, skill_source, attached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.workspaceId, paneId, input.skillName, input.skillSource, attachedAt);

      return {
        id,
        workspaceId: input.workspaceId,
        paneSessionId: paneId,
        skillName: input.skillName,
        skillSource: input.skillSource,
        attachedAt,
      };
    },

    /**
     * Detach a skill binding by id. No-op if the binding does not exist.
     */
    detach: async (input: { bindingId: string }): Promise<void> => {
      if (!input || typeof input.bindingId !== 'string' || !input.bindingId.trim()) {
        throw new Error('skills.detach: missing bindingId');
      }
      const db = getRawDb();
      db.prepare('DELETE FROM skill_bindings WHERE id = ?').run(input.bindingId);
    },

    /**
     * List all bindings for a workspace (includes both workspace-wide and all
     * pane-scoped bindings within that workspace).
     */
    listBindings: async (input: { workspaceId: string }): Promise<SkillBindingEntry[]> => {
      if (!input || typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) {
        throw new Error('skills.listBindings: missing workspaceId');
      }
      const db = getRawDb();
      const rows = db
        .prepare(
          `SELECT id, workspace_id, pane_session_id, skill_name, skill_source, attached_at
           FROM skill_bindings
           WHERE workspace_id = ?
           ORDER BY attached_at ASC`,
        )
        .all(input.workspaceId) as SkillBindingDbRow[];

      return rows.map(rowToEntry);
    },
  });
}

function rowToEntry(row: SkillBindingDbRow): SkillBindingEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    paneSessionId: row.pane_session_id,
    skillName: row.skill_name,
    skillSource: row.skill_source,
    attachedAt: row.attached_at,
  };
}

/** Default temp directory for marketplace tarballs. Lives next to the
 *  managed-skills root so admins can wipe both with a single rm. */
export function defaultMarketplaceTempDir(userData: string): string {
  return path.join(userData, 'marketplace-tmp');
}
