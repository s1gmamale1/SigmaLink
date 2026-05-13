// Disk-scan coverage for codex / kimi / opencode session capture.
//
// Each test builds a synthetic provider directory under a fresh tmpdir, sets
// file mtimes to known values, then drives `findLatestSessionId()` with a
// pinned `now`. Provider IDs outside the scope (claude/gemini/shell) return
// null without touching disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DISK_SCAN_PROVIDERS,
  DISK_SCAN_RETRY_SCHEDULE_MS,
  findLatestSessionId,
} from './session-disk-scanner.ts';

let tmpHome: string;

function makeUuid(seed: string): string {
  // Pad to a UUID-like shape. The scanner only requires the canonical 8-4-4-4-12
  // hex pattern, not RFC 4122 versioning.
  const hex = seed.padEnd(32, '0').slice(0, 32).replace(/[^0-9a-f]/gi, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}

function touch(file: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const t = new Date(mtimeMs);
  fs.utimesSync(file, t, t);
}

function touchDir(dir: string, mtimeMs: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date(mtimeMs);
  fs.utimesSync(dir, t, t);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-disk-scan-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('findLatestSessionId — provider scope', () => {
  it('returns null for claude (pre-assign path, no disk scan)', async () => {
    const id = await findLatestSessionId('claude', '/tmp/proj', { homeDir: tmpHome });
    expect(id).toBe(null);
  });

  it('returns null for gemini (pre-assign path, no disk scan)', async () => {
    const id = await findLatestSessionId('gemini', '/tmp/proj', { homeDir: tmpHome });
    expect(id).toBe(null);
  });

  it('returns null for the shell sentinel', async () => {
    const id = await findLatestSessionId('shell', '/tmp/proj', { homeDir: tmpHome });
    expect(id).toBe(null);
  });

  it('exposes the canonical provider set + retry schedule', () => {
    expect([...DISK_SCAN_PROVIDERS].sort()).toEqual(['codex', 'kimi', 'opencode']);
    // Schedule must be ascending so the registry's retry loop is monotonic.
    const copy = [...DISK_SCAN_RETRY_SCHEDULE_MS];
    expect(copy).toEqual([...copy].sort((a, b) => a - b));
    expect(copy.length).toBeGreaterThanOrEqual(2);
  });
});

describe('findLatestSessionId — codex', () => {
  it('picks the newest rollout filename UUID inside the window', async () => {
    const now = 1_700_000_000_000;
    const olderUuid = makeUuid('aaaa1111');
    const newerUuid = makeUuid('bbbb2222');
    const olderPath = path.join(
      tmpHome,
      '.codex',
      'sessions',
      '2026',
      '05',
      '13',
      `rollout-2026-05-13T10-00-00-${olderUuid}.jsonl`,
    );
    const newerPath = path.join(
      tmpHome,
      '.codex',
      'sessions',
      '2026',
      '05',
      '13',
      `rollout-2026-05-13T10-01-00-${newerUuid}.jsonl`,
    );
    touch(olderPath, now - 60_000);
    touch(newerPath, now - 1_000);

    const id = await findLatestSessionId('codex', '/tmp/proj', {
      homeDir: tmpHome,
      now,
    });
    expect(id).toBe(newerUuid);
  });

  it('ignores rollouts whose mtime falls outside the scan window', async () => {
    const now = 1_700_000_000_000;
    const staleUuid = makeUuid('cccc3333');
    const stalePath = path.join(
      tmpHome,
      '.codex',
      'sessions',
      '2026',
      '04',
      '01',
      `rollout-2026-04-01T10-00-00-${staleUuid}.jsonl`,
    );
    // 10 minutes old — outside the 5-minute default window.
    touch(stalePath, now - 10 * 60_000);

    const id = await findLatestSessionId('codex', '/tmp/proj', {
      homeDir: tmpHome,
      now,
    });
    expect(id).toBe(null);
  });

  it('returns null when ~/.codex does not exist', async () => {
    const id = await findLatestSessionId('codex', '/tmp/proj', {
      homeDir: tmpHome,
      now: 1_700_000_000_000,
    });
    expect(id).toBe(null);
  });
});

describe('findLatestSessionId — kimi', () => {
  it('picks the newest UUID directory under ~/.kimi/sessions/<project>/', async () => {
    const now = 1_700_000_000_000;
    const olderUuid = makeUuid('dddd4444');
    const newerUuid = makeUuid('eeee5555');
    const olderDir = path.join(
      tmpHome,
      '.kimi',
      'sessions',
      'project-hash-abc',
      olderUuid,
    );
    const newerDir = path.join(
      tmpHome,
      '.kimi',
      'sessions',
      'project-hash-abc',
      newerUuid,
    );
    touchDir(olderDir, now - 30_000);
    touchDir(newerDir, now - 5_000);

    const id = await findLatestSessionId('kimi', '/tmp/proj', {
      homeDir: tmpHome,
      now,
    });
    expect(id).toBe(newerUuid);
  });

  it('tolerates a flattened ~/.kimi/sessions/<uuid>/ layout', async () => {
    const now = 1_700_000_000_000;
    const uuid = makeUuid('ffff6666');
    const dir = path.join(tmpHome, '.kimi', 'sessions', uuid);
    touchDir(dir, now - 1_000);

    const id = await findLatestSessionId('kimi', '/tmp/proj', {
      homeDir: tmpHome,
      now,
    });
    expect(id).toBe(uuid);
  });

  it('ignores non-UUID-shaped directory names', async () => {
    const now = 1_700_000_000_000;
    const junkDir = path.join(
      tmpHome,
      '.kimi',
      'sessions',
      'project-hash',
      'not-a-uuid',
    );
    touchDir(junkDir, now - 1_000);

    const id = await findLatestSessionId('kimi', '/tmp/proj', {
      homeDir: tmpHome,
      now,
    });
    expect(id).toBe(null);
  });
});

describe('findLatestSessionId — opencode', () => {
  it('selects the newest session whose directory matches cwd', async () => {
    const now = 1_700_000_000_000;
    const matching = {
      id: 'oc-session-newer',
      directory: '/tmp/proj',
      updated: now - 1_000,
    };
    const older = {
      id: 'oc-session-older',
      directory: '/tmp/proj',
      updated: now - 30_000,
    };
    const other = {
      id: 'oc-session-other-cwd',
      directory: '/tmp/elsewhere',
      updated: now - 500,
    };

    const id = await findLatestSessionId('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      now,
      runOpencodeList: async () => JSON.stringify([older, other, matching]),
    });
    expect(id).toBe('oc-session-newer');
  });

  it('accepts ISO 8601 timestamps in the `updated` field', async () => {
    const now = Date.parse('2026-05-13T10:00:00Z');
    const row = {
      id: 'oc-iso-session',
      directory: '/tmp/proj',
      updated: '2026-05-13T09:59:55Z',
    };
    const id = await findLatestSessionId('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      now,
      runOpencodeList: async () => JSON.stringify([row]),
    });
    expect(id).toBe('oc-iso-session');
  });

  it('returns null when the subprocess throws', async () => {
    const id = await findLatestSessionId('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      now: 1_700_000_000_000,
      runOpencodeList: async () => {
        throw new Error('opencode missing');
      },
    });
    expect(id).toBe(null);
  });

  it('returns null when the JSON is malformed', async () => {
    const id = await findLatestSessionId('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      now: 1_700_000_000_000,
      runOpencodeList: async () => '<not json>',
    });
    expect(id).toBe(null);
  });
});
