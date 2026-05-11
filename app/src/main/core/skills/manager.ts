// High-level orchestrator for the skills subsystem. Wraps the SQLite tables
// `skills` + `skill_provider_state` and the lower-level ingestion + fan-out
// modules. The renderer interacts with this class only via the controller.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getRawDb } from '../db/client';
import { parseSkillMd } from './frontmatter';
import { ingestFolder, ingestZip, rehashManagedFolder, SkillUpdateRequiredError } from './ingestion';
import { applyFanout, removeFanout, targetDirFor } from './fanout';
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

export interface SkillFanoutVerifyError {
  skillId: string;
  skillName: string;
  providerId: ProviderTarget;
  targetPath: string;
  message: string;
}

export interface SkillFanoutVerification {
  workspaceId: string;
  verified: number;
  refanned: number;
  errors: SkillFanoutVerifyError[];
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

    const { results, now } = await this.fanoutTargets(skill, enabledTargets, { force });

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

  async verifyFanoutForWorkspace(workspaceId: string): Promise<SkillFanoutVerification> {
    const rows = this.db()
      .prepare(
        `SELECT s.id, s.name, s.description, s.version, s.content_hash, s.managed_path, s.installed_at, s.tags_json,
                ps.provider_id
         FROM skills s
         JOIN skill_provider_state ps ON ps.skill_id = s.id
         WHERE ps.enabled != 0
         ORDER BY s.installed_at DESC`,
      )
      .all() as Array<SkillRow & { provider_id: string }>;

    const result: SkillFanoutVerification = {
      workspaceId,
      verified: 0,
      refanned: 0,
      errors: [],
    };

    const staleBySkill = new Map<string, { skill: Skill; providers: ProviderTarget[] }>();
    for (const row of rows) {
      if (!isProviderTarget(row.provider_id)) continue;
      const skill = rowToSkill(row);
      const provider = row.provider_id as ProviderTarget;
      const targetPath = targetDirFor(provider, skill.name);
      const check = this.isFanoutCurrent(skill, provider, targetPath);
      if (check.ok) {
        result.verified += 1;
        continue;
      }
      const bucket = staleBySkill.get(skill.id) ?? { skill, providers: [] };
      bucket.providers.push(provider);
      staleBySkill.set(skill.id, bucket);
    }

    for (const { skill, providers } of staleBySkill.values()) {
      try {
        const { results } = await this.fanoutTargets(skill, providers, { force: true });
        for (const r of results) {
          if (r.ok) {
            result.refanned += 1;
          } else {
            result.errors.push({
              skillId: skill.id,
              skillName: skill.name,
              providerId: r.provider,
              targetPath: r.targetPath,
              message: r.error ?? 'unknown fanout error',
            });
          }
        }
      } catch (err) {
        for (const provider of providers) {
          result.errors.push({
            skillId: skill.id,
            skillName: skill.name,
            providerId: provider,
            targetPath: targetDirFor(provider, skill.name),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (result.refanned > 0 || result.errors.length > 0) {
      this.emit('skills:changed', { reason: 'fanout-verify', workspaceId });
    }
    return result;
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
    const { results, now } = await this.fanoutTargets(skill, [provider]);
    const r = results[0]!;

    return {
      skillId: skill.id,
      providerId: provider,
      enabled: true,
      lastFanoutAt: now,
      lastError: r.ok ? undefined : r.error,
    };
  }

  private async fanoutTargets(
    skill: Skill,
    providers: ProviderTarget[],
    opts?: { force?: boolean },
  ): Promise<{ results: Awaited<ReturnType<typeof applyFanout>>; now: number }> {
    const skillMdPath = path.join(skill.managedPath, 'SKILL.md');
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const parsed = parseSkillMd(text, skill.name);
    if (!parsed.ok) {
      throw new Error(`Managed SKILL.md no longer valid: ${parsed.error}`);
    }
    const results = await applyFanout(skill, skill.managedPath, parsed.data, parsed.body, providers, opts);
    const now = Date.now();
    for (const r of results) {
      this.db()
        .prepare(
          `UPDATE skill_provider_state SET last_fanout_at = ?, last_error = ? WHERE skill_id = ? AND provider_id = ?`,
        )
        .run(now, r.ok ? null : r.error ?? 'unknown error', skill.id, r.provider);
    }
    return { results, now };
  }

  private isFanoutCurrent(
    skill: Skill,
    provider: ProviderTarget,
    targetPath: string,
  ): { ok: boolean; reason?: string } {
    if (!fs.existsSync(targetPath)) return { ok: false, reason: 'missing target' };
    try {
      if (provider === 'gemini') {
        return sourceFilesMatchTarget(skill.managedPath, targetPath);
      }
      const hash = rehashManagedFolder(targetPath);
      return hash === skill.contentHash
        ? { ok: true }
        : { ok: false, reason: 'content hash mismatch' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

function sourceFilesMatchTarget(sourceDir: string, targetDir: string): { ok: boolean; reason?: string } {
  const sourceFiles = listFiles(sourceDir);
  for (const rel of sourceFiles) {
    const sourcePath = path.join(sourceDir, rel);
    const targetPath = path.join(targetDir, rel);
    if (!fs.existsSync(targetPath)) return { ok: false, reason: `${rel} missing` };
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    if (sourceStat.size !== targetStat.size) return { ok: false, reason: `${rel} size mismatch` };
    if (sha256File(sourcePath) !== sha256File(targetPath)) {
      return { ok: false, reason: `${rel} content mismatch` };
    }
  }
  return { ok: true };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

function sha256File(target: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}
