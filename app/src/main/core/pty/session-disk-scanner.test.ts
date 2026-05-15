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
  listSessionsInCwd,
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

// ─────────────────────────────────────────────────────────────────────────
// v1.3.0 — listSessionsInCwd
// ─────────────────────────────────────────────────────────────────────────

describe('listSessionsInCwd — Claude', () => {
  it('returns sessions for a cwd slug directory, sorted DESC by mtime', async () => {
    const cwd = '/home/dev/proj';
    const slug = cwd.replace(/\//g, '-');
    const uuidA = makeUuid('aa001111');
    const uuidB = makeUuid('bb002222');
    const baseTime = 1_700_000_000_000;

    const dirA = path.join(tmpHome, '.claude', 'projects', slug, `${uuidA}.jsonl`);
    const dirB = path.join(tmpHome, '.claude', 'projects', slug, `${uuidB}.jsonl`);
    // Write minimal JSONL with a user message on line 2
    fs.mkdirSync(path.dirname(dirA), { recursive: true });
    fs.writeFileSync(dirA, `{"type":"system","created_at":${baseTime - 3600_000}}\n{"type":"user","message":"hello from A"}\n`);
    fs.writeFileSync(dirB, `{"type":"system","created_at":${baseTime - 1800_000}}\n{"type":"user","message":"hello from B"}\n`);
    const tA = new Date(baseTime - 60_000);
    const tB = new Date(baseTime - 1_000);
    fs.utimesSync(dirA, tA, tA);
    fs.utimesSync(dirB, tB, tB);

    const sessions = await listSessionsInCwd('claude', cwd, { homeDir: tmpHome });
    expect(sessions).toHaveLength(2);
    // Sorted DESC: B is newer
    expect(sessions[0].id).toBe(uuidB);
    expect(sessions[1].id).toBe(uuidA);
    expect(sessions[0].providerId).toBe('claude');
    expect(sessions[0].cwd).toBe(cwd);
  });

  it('populates firstMessagePreview from JSONL user turn', async () => {
    const cwd = '/home/dev/preview';
    const slug = cwd.replace(/\//g, '-');
    const uuid = makeUuid('cc003333');
    const filePath = path.join(tmpHome, '.claude', 'projects', slug, `${uuid}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const longMsg = 'A'.repeat(100);
    fs.writeFileSync(filePath, `{"type":"system"}\n{"type":"user","message":"${longMsg}"}\n`);
    const t = new Date(1_700_000_000_000);
    fs.utimesSync(filePath, t, t);

    const sessions = await listSessionsInCwd('claude', cwd, { homeDir: tmpHome });
    expect(sessions).toHaveLength(1);
    // 80 char cap enforced
    expect(sessions[0].firstMessagePreview).toBeDefined();
    expect(sessions[0].firstMessagePreview!.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
  });

  it('returns [] when no claude projects directory exists', async () => {
    const sessions = await listSessionsInCwd('claude', '/no/such/cwd', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });

  it('respects maxCount cap', async () => {
    const cwd = '/home/dev/many';
    const slug = cwd.replace(/\//g, '-');
    const dir = path.join(tmpHome, '.claude', 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const uuid = makeUuid(`dd00${i.toString().padStart(4, '0')}`);
      const file = path.join(dir, `${uuid}.jsonl`);
      fs.writeFileSync(file, '{"type":"system"}\n');
      const t = new Date(1_700_000_000_000 + i * 1000);
      fs.utimesSync(file, t, t);
    }
    const sessions = await listSessionsInCwd('claude', cwd, { homeDir: tmpHome, maxCount: 3 });
    expect(sessions).toHaveLength(3);
  });
});

describe('listSessionsInCwd — Codex', () => {
  it('lists all rollout files in ~/. codex/sessions sorted DESC', async () => {
    const uuidA = makeUuid('ee004444');
    const uuidB = makeUuid('ff005555');
    const baseTime = 1_700_000_000_000;
    const pathA = path.join(tmpHome, '.codex', 'sessions', '2026', '05', '13', `rollout-2026-05-13T10-00-00-${uuidA}.jsonl`);
    const pathB = path.join(tmpHome, '.codex', 'sessions', '2026', '05', '13', `rollout-2026-05-13T10-05-00-${uuidB}.jsonl`);
    touch(pathA, baseTime - 60_000);
    touch(pathB, baseTime - 1_000);

    const sessions = await listSessionsInCwd('codex', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0].id).toBe(uuidB);
    expect(sessions[0].providerId).toBe('codex');
  });

  it('returns [] when ~/.codex/sessions does not exist', async () => {
    const sessions = await listSessionsInCwd('codex', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });

  it('does NOT apply a mtime gate (returns stale sessions unlike findLatestSessionId)', async () => {
    const uuid = makeUuid('gg006666');
    const now = 1_700_000_000_000;
    // 10 minutes old — would be excluded by findLatestSessionId's 5-min window
    const staleTime = now - 10 * 60_000;
    const filePath = path.join(tmpHome, '.codex', 'sessions', 'old', `rollout-2020-01-01T00-00-00-${uuid}.jsonl`);
    touch(filePath, staleTime);

    const findResult = await findLatestSessionId('codex', '/tmp/proj', { homeDir: tmpHome, now });
    const listResult = await listSessionsInCwd('codex', '/tmp/proj', { homeDir: tmpHome });
    expect(findResult).toBe(null); // excluded by mtime gate
    expect(listResult.some((s) => s.id === uuid)).toBe(true); // included by list
  });
});

describe('listSessionsInCwd — Kimi', () => {
  it('lists UUID session dirs under ~/.kimi/sessions/, sorted DESC', async () => {
    const baseTime = 1_700_000_000_000;
    const uuidA = makeUuid('hh007777');
    const uuidB = makeUuid('ii008888');
    const dirA = path.join(tmpHome, '.kimi', 'sessions', 'proj-hash', uuidA);
    const dirB = path.join(tmpHome, '.kimi', 'sessions', 'proj-hash', uuidB);
    touchDir(dirA, baseTime - 60_000);
    touchDir(dirB, baseTime - 1_000);

    const sessions = await listSessionsInCwd('kimi', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0].id).toBe(uuidB);
    expect(sessions[0].providerId).toBe('kimi');
  });

  it('reads firstMessagePreview + title from state.json when present', async () => {
    const uuid = makeUuid('jj009999');
    const dir = path.join(tmpHome, '.kimi', 'sessions', 'proj-hash', uuid);
    fs.mkdirSync(dir, { recursive: true });
    const t = new Date(1_700_000_000_000);
    fs.utimesSync(dir, t, t);
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ timestamp: 1_700_000_000_000, model: 'moonshot-v1', first_user_message: 'explain monads' }),
    );

    const sessions = await listSessionsInCwd('kimi', '/tmp/proj', { homeDir: tmpHome });
    const found = sessions.find((s) => s.id === uuid);
    expect(found).toBeDefined();
    expect(found?.firstMessagePreview).toBe('explain monads');
    expect(found?.title).toBe('moonshot-v1');
  });

  it('returns [] when ~/.kimi/sessions does not exist', async () => {
    const sessions = await listSessionsInCwd('kimi', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });
});

describe('listSessionsInCwd — OpenCode', () => {
  it('returns sessions filtered by cwd, sorted DESC', async () => {
    const now = 1_700_000_000_000;
    const rows = [
      { id: 'oc-a', directory: '/tmp/proj', updated: now - 60_000, title: 'Session A' },
      { id: 'oc-b', directory: '/tmp/proj', updated: now - 1_000, title: 'Session B' },
      { id: 'oc-c', directory: '/tmp/elsewhere', updated: now - 500 },
    ];
    const sessions = await listSessionsInCwd('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      runOpencodeList: async () => JSON.stringify(rows),
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('oc-b');
    expect(sessions[0].title).toBe('Session B');
    expect(sessions[0].providerId).toBe('opencode');
  });

  it('returns [] when subprocess throws', async () => {
    const sessions = await listSessionsInCwd('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      runOpencodeList: async () => { throw new Error('not found'); },
    });
    expect(sessions).toEqual([]);
  });

  it('returns [] when JSON is malformed', async () => {
    const sessions = await listSessionsInCwd('opencode', '/tmp/proj', {
      homeDir: tmpHome,
      runOpencodeList: async () => 'not-json',
    });
    expect(sessions).toEqual([]);
  });
});

describe('listSessionsInCwd — provider scope', () => {
  it('returns [] for gemini (deferred to v1.3.1)', async () => {
    const sessions = await listSessionsInCwd('gemini', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });

  it('returns [] for shell sentinel', async () => {
    const sessions = await listSessionsInCwd('shell', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });

  it('returns [] for unknown provider', async () => {
    const sessions = await listSessionsInCwd('unknown-provider', '/tmp/proj', { homeDir: tmpHome });
    expect(sessions).toEqual([]);
  });
});
