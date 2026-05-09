// High-level orchestrator for the skills subsystem. Wraps the SQLite tables
// `skills` + `skill_provider_state` and the lower-level ingestion + fan-out
// modules. The renderer interacts with this class only via the controller.

import fs from 'node:fs';
import path from 'node:path';
import { getRawDb } from '../db/client';
import { parseSkillMd } from './frontmatter';
import { ingestFolder, ingestZip, SkillUpdateRequiredError } from './ingestion';
import { applyFanout, removeFanout } from './fanout';
import {
  PROVIDER_TARGETS,
  isProviderTarget,
  type ProviderTarget,
  type Skill,
  type SkillProviderState,
} from './types';

export interface SkillsManagerDeps {
  /** Absolute path to the Electron `userData` directory. */
  userData: string;
  /** Optional broadcaster — `skills:changed` fires after every mutation. */
  emit?: (event: string, payload: unknown) => void;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: string | null;
  content_hash: string;
  managed_path: string;
  installed_at: number;
  tags_json: string | null;
}

interface SkillProviderRow {
  skill_id: string;
  provider_id: string;
  enabled: number;
  last_fanout_at: number | null;
  last_error: string | null;
}

function rowToSkill(row: SkillRow): Skill {
  let tags: string[] | undefined;
  if (row.tags_json) {
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) tags = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version ?? undefined,
    contentHash: row.content_hash,
    managedPath: row.managed_path,
    installedAt: row.installed_at,
    tags,
  };
}

function rowToProviderState(row: SkillProviderRow): SkillProviderState {
  if (!isProviderTarget(row.provider_id)) {
    // Defensive — DB shouldn't contain unknown providers, but if so, default
    // to claude. Caller filters later.
  }
  return {
    skillId: row.skill_id,
    providerId: row.provider_id as ProviderTarget,
    enabled: row.enabled !== 0,
    lastFanoutAt: row.last_fanout_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export class SkillsManager {
  private readonly managedRoot: string;
  private readonly emit: (event: string, payload: unknown) => void;

  constructor(deps: SkillsManagerDeps) {
    this.managedRoot = path.join(deps.userData, 'skills');
    this.emit = deps.emit ?? (() => undefined);
    fs.mkdirSync(this.managedRoot, { recursive: true });
  }

  /** Lazy DB getter so unit tests can swap out the schema. */
  private db() {
    return getRawDb();
  }

  list(): { skills: Skill[]; states: SkillProviderState[] } {
    const skillRows = this.db().prepare(`SELECT id, name, description, version, content_hash, managed_path, installed_at, tags_json FROM skills ORDER BY installed_at DESC`).all() as SkillRow[];
    const stateRows = this.db().prepare(`SELECT skill_id, provider_id, enabled, last_fanout_at, last_error FROM skill_provider_state`).all() as SkillProviderRow[];
    return {
      skills: skillRows.map(rowToSkill),
      states: stateRows.map(rowToProviderState),
    };
  }

  getReadme(skillId: string): { name: string; body: string } | null {
    const row = this.db().prepare(`SELECT name, managed_path FROM skills WHERE id = ?`).get(skillId) as { name: string; managed_path: string } | undefined;
    if (!row) return null;
    const skillMdPath = path.join(row.managed_path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return { name: row.name, body: '' };
    try {
      return { name: row.name, body: fs.readFileSync(skillMdPath, 'utf8') };
    } catch {
      return { name: row.name, body: '' };
    }
  }

  async ingestFolder(srcAbsPath: string, opts?: { force?: boolean }): Promise<Skill> {
    let skill: Skill;
    try {
      skill = await ingestFolder(srcAbsPath, {
        managedRoot: this.managedRoot,
        force: opts?.force,
      });
    } catch (err) {
      if (err instanceof SkillUpdateRequiredError) {
        // Surface a structured error message — the controller forwards it.
        throw new Error(`UPDATE_REQUIRED:${err.skillName}:${err.incomingHash}`);
      }
      throw err;
    }

    // Upsert into the DB.
    const tagsJson = skill.tags && skill.tags.length ? JSON.stringify(skill.tags) : null;
    this.db()
      .prepare(
        `INSERT INTO skills (id, name, description, version, content_hash, managed_path, installed_at, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           version = excluded.version,
           content_hash = excluded.content_hash,
           managed_path = excluded.managed_path,
           installed_at = excluded.installed_at,
           tags_json = excluded.tags_json`,
      )
      .run(
        skill.id,
        skill.name,
        skill.description,
        skill.version ?? null,
        skill.contentHash,
        skill.managedPath,
        skill.installedAt,
        tagsJson,
      );

    // Default each provider state to disabled if not present yet.
    for (const provider of PROVIDER_TARGETS) {
      this.db()
        .prepare(
          `INSERT OR IGNORE INTO skill_provider_state (skill_id, provider_id, enabled, last_fanout_at, last_error) VALUES (?, ?, 0, NULL, NULL)`,
        )
        .run(skill.id, provider);
    }

    // If providers are already enabled (re-ingest of an existing skill), re-fan.
    await this.reFanout(skill.id, opts?.force);

    this.emit('skills:changed', { reason: 'ingest', skillId: skill.id });
    return skill;
  }

  async ingestZip(zipPath: string, opts?: { force?: boolean }): Promise<Skill> {
    return ingestZip(zipPath, { managedRoot: this.managedRoot, force: opts?.force }) as never;
  }

  async uninstall(skillId: string): Promise<void> {
    const row = this.db().prepare(`SELECT id, name, managed_path FROM skills WHERE id = ?`).get(skillId) as { id: string; name: string; managed_path: string } | undefined;
    if (!row) return;

    // Best-effort fan-out removal across every provider, regardless of
    // whether their state is enabled — the user might have flipped the
    // toggle off without finishing the cleanup.
    for (const provider of PROVIDER_TARGETS) {
      removeFanout(provider, row.name);
    }

    // Remove the managed copy.
    try {
      fs.rmSync(row.managed_path, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }

    // Cascade rows. We keep an explicit DELETE in case the FK isn't enforced
    // for whatever reason (e.g. legacy DB); the schema also defines CASCADE.
    this.db().prepare(`DELETE FROM skill_provider_state WHERE skill_id = ?`).run(skillId);
    this.db().prepare(`DELETE FROM skills WHERE id = ?`).run(skillId);

    this.emit('skills:changed', { reason: 'uninstall', skillId });
  }

  async enableForProvider(skillId: string, provider: ProviderTarget): Promise<SkillProviderState> {
    const skill = this.requireSkill(skillId);
    this.db()
      .prepare(
        `INSERT INTO skill_provider_state (skill_id, provider_id, enabled, last_fanout_at, last_error) VALUES (?, ?, 1, NULL, NULL)
         ON CONFLICT(skill_id, provider_id) DO UPDATE SET enabled = 1, last_error = NULL`,
      )
      .run(skillId, provider);

    const result = await this.fanoutSingle(skill, provider);
    this.emit('skills:changed', { reason: 'provider-enable', skillId, provider });
    return result;
  }

  async disableForProvider(skillId: string, provider: ProviderTarget): Promise<SkillProviderState> {
    const skill = this.requireSkill(skillId);
    const removeResult = removeFanout(provider, skill.name);
    const errMsg = removeResult.ok ? null : removeResult.error ?? 'unknown removal error';
    this.db()
      .prepare(
        `INSERT INTO skill_provider_state (skill_id, provider_id, enabled, last_fanout_at, last_error) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(skill_id, provider_id) DO UPDATE SET enabled = 0, last_fanout_at = excluded.last_fanout_at, last_error = excluded.last_error`,
      )
      .run(skillId, provider, Date.now(), errMsg);

    this.emit('skills:changed', { reason: 'provider-disable', skillId, provider });
    return {
      skillId,
      providerId: provider,
      enabled: false,
      lastFanoutAt: Date.now(),
      lastError: errMsg ?? undefined,
    };
  }

  async reFanout(skillId: string, force?: boolean): Promise<SkillProviderState[]> {
    const skill = this.requireSkill(skillId);
    const states = this.db()
      .prepare(`SELECT skill_id, provider_id, enabled, last_fanout_at, last_error FROM skill_provider_state WHERE skill_id = ?`)
      .all(skillId) as SkillProviderRow[];

    const enabledTargets: ProviderTarget[] = states
      .filter((s) => s.enabled !== 0 && isProviderTarget(s.provider_id))
      .map((s) => s.provider_id as ProviderTarget);

    if (enabledTargets.length === 0) return states.map(rowToProviderState);

    // Re-parse SKILL.md so the fan-out has the latest body for synthesised
    // Gemini extensions etc.
    const skillMdPath = path.join(skill.managedPath, 'SKILL.md');
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const parsed = parseSkillMd(text, skill.name);
    if (!parsed.ok) {
      throw new Error(`Managed SKILL.md no longer valid: ${parsed.error}`);
    }

    const results = await applyFanout(skill, skill.managedPath, parsed.data, parsed.body, enabledTargets, { force });
    const now = Date.now();
    for (const r of results) {
      this.db()
        .prepare(
          `UPDATE skill_provider_state SET last_fanout_at = ?, last_error = ? WHERE skill_id = ? AND provider_id = ?`,
        )
        .run(now, r.ok ? null : r.error ?? 'unknown error', skillId, r.provider);
    }

    return states.map((row) => {
      const updated = results.find((r) => r.provider === row.provider_id);
      return {
        skillId: row.skill_id,
        providerId: row.provider_id as ProviderTarget,
        enabled: row.enabled !== 0,
        lastFanoutAt: updated ? now : row.last_fanout_at ?? undefined,
        lastError: updated ? (updated.ok ? undefined : updated.error) : row.last_error ?? undefined,
      };
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private requireSkill(skillId: string): Skill {
    const row = this.db()
      .prepare(`SELECT id, name, description, version, content_hash, managed_path, installed_at, tags_json FROM skills WHERE id = ?`)
      .get(skillId) as SkillRow | undefined;
    if (!row) throw new Error(`Skill not found: ${skillId}`);
    return rowToSkill(row);
  }

  private async fanoutSingle(skill: Skill, provider: ProviderTarget): Promise<SkillProviderState> {
    const skillMdPath = path.join(skill.managedPath, 'SKILL.md');
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const parsed = parseSkillMd(text, skill.name);
    if (!parsed.ok) {
      throw new Error(`Managed SKILL.md no longer valid: ${parsed.error}`);
    }
    const results = await applyFanout(skill, skill.managedPath, parsed.data, parsed.body, [provider]);
    const r = results[0]!;
    const now = Date.now();
    this.db()
      .prepare(
        `UPDATE skill_provider_state SET last_fanout_at = ?, last_error = ? WHERE skill_id = ? AND provider_id = ?`,
      )
      .run(now, r.ok ? null : r.error ?? 'unknown error', skill.id, provider);

    return {
      skillId: skill.id,
      providerId: provider,
      enabled: true,
      lastFanoutAt: now,
      lastError: r.ok ? undefined : r.error,
    };
  }
}
