import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../db/client', () => ({
  getRawDb: vi.fn(),
}));

import { getRawDb } from '../db/client';
import { rehashManagedFolder } from './ingestion';
import { targetDirFor } from './fanout';
import { SkillsManager } from './manager';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name = 'review-helper') {
  const managedPath = path.join(root, name);
  fs.mkdirSync(managedPath, { recursive: true });
  fs.writeFileSync(
    path.join(managedPath, 'SKILL.md'),
    ['---', `name: ${name}`, 'description: Review helper', '---', '', 'Use this skill.'].join('\n'),
  );
  return {
    id: `skill-${name}`,
    name,
    description: 'Review helper',
    version: null,
    content_hash: rehashManagedFolder(managedPath),
    managed_path: managedPath,
    installed_at: Date.now(),
    tags_json: null,
  };
}

function fakeDb(rows: unknown[]) {
  const updates: Array<{ lastError: string | null; skillId: string; provider: string }> = [];
  return {
    updates,
    prepare: (sql: string) => {
      if (sql.includes('JOIN skill_provider_state')) {
        return { all: () => rows };
      }
      if (sql.trim().startsWith('UPDATE skill_provider_state')) {
        return {
          run: (_ts: number, lastError: string | null, skillId: string, provider: string) => {
            updates.push({ lastError, skillId, provider });
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

beforeEach(() => {
  vi.mocked(getRawDb).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('SkillsManager.verifyFanoutForWorkspace', () => {
  it('counts enabled fanout targets whose content hash is current', async () => {
    const home = tmpDir('sigmalink-skills-home-');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const userData = tmpDir('sigmalink-skills-userdata-');
    const skill = writeSkill(path.join(userData, 'managed'));
    const target = targetDirFor('codex', skill.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(skill.managed_path, target, { recursive: true });
    const db = fakeDb([{ ...skill, provider_id: 'codex' }]);
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    const manager = new SkillsManager({ userData });

    const result = await manager.verifyFanoutForWorkspace('ws-1');

    expect(result).toEqual({ workspaceId: 'ws-1', verified: 1, refanned: 0, errors: [] });
    expect(db.updates).toEqual([]);
  });

  it('re-fans missing enabled targets and records the provider state update', async () => {
    const home = tmpDir('sigmalink-skills-home-');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const userData = tmpDir('sigmalink-skills-userdata-');
    const skill = writeSkill(path.join(userData, 'managed'));
    const db = fakeDb([{ ...skill, provider_id: 'codex' }]);
    vi.mocked(getRawDb).mockReturnValue(db as unknown as ReturnType<typeof getRawDb>);
    const manager = new SkillsManager({ userData });

    const result = await manager.verifyFanoutForWorkspace('ws-1');

    expect(result).toEqual({ workspaceId: 'ws-1', verified: 0, refanned: 1, errors: [] });
    expect(fs.existsSync(path.join(targetDirFor('codex', skill.name), 'SKILL.md'))).toBe(true);
    expect(db.updates).toEqual([{ lastError: null, skillId: skill.id, provider: 'codex' }]);
  });
});
