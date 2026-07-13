// claude-account-watch.test.ts — account-switch propagation (2026-07-14).
//
// Covers the three units of claude-account-watch.ts:
//   - readClaudeAccountIdentity: ~/.claude.json oauthAccount parsing
//   - identitySwitched + createClaudeAccountWatcher: switch detection
//     (checkNow() is the test seam — no fs.watchFile timers in tests)
//   - restartLiveClaudePanes: kill → expected-exit flag → resume-in-place,
//     mirroring resume-launcher.test.ts's fake db/registry fixtures.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import {
  createClaudeAccountWatcher,
  defaultClaudeConfigPath,
  identitySwitched,
  readClaudeAccountIdentity,
  restartLiveClaudePanes,
  type ClaudeAccountIdentity,
} from './claude-account-watch.ts';
import { claudeSlugForCwd } from './claude-resume-sigma.ts';
import type { ResumeLauncherDeps } from './resume-launcher.ts';
import type { PtyRegistry, SessionRecord } from './registry.ts';

const VALID_CLAUDE_SESSION_ID = '01234567-89ab-4cde-9f01-23456789abcd';

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(configPath: string, oauthAccount: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify({ numStartups: 5, oauthAccount }), 'utf8');
}

// ---------------------------------------------------------------------------
// readClaudeAccountIdentity
// ---------------------------------------------------------------------------

describe('readClaudeAccountIdentity', () => {
  it('reads accountUuid + emailAddress from oauthAccount', () => {
    const dir = makeTmpDir('sigmalink-acct-');
    const p = path.join(dir, '.claude.json');
    writeConfig(p, { accountUuid: 'uuid-1', emailAddress: 'a@x.com', displayName: 'A' });
    expect(readClaudeAccountIdentity(p)).toEqual({
      accountUuid: 'uuid-1',
      emailAddress: 'a@x.com',
    });
  });

  it('returns null for a missing file', () => {
    const dir = makeTmpDir('sigmalink-acct-');
    expect(readClaudeAccountIdentity(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const dir = makeTmpDir('sigmalink-acct-');
    const p = path.join(dir, '.claude.json');
    fs.writeFileSync(p, '{not json', 'utf8');
    expect(readClaudeAccountIdentity(p)).toBeNull();
  });

  it('returns null when oauthAccount is absent (logged out)', () => {
    const dir = makeTmpDir('sigmalink-acct-');
    const p = path.join(dir, '.claude.json');
    fs.writeFileSync(p, JSON.stringify({ numStartups: 5 }), 'utf8');
    expect(readClaudeAccountIdentity(p)).toBeNull();
  });

  it('tolerates a partial oauthAccount (uuid-only / email-only)', () => {
    const dir = makeTmpDir('sigmalink-acct-');
    const p = path.join(dir, '.claude.json');
    writeConfig(p, { accountUuid: 'uuid-only' });
    expect(readClaudeAccountIdentity(p)).toEqual({ accountUuid: 'uuid-only', emailAddress: '' });
    writeConfig(p, { emailAddress: 'only@x.com' });
    expect(readClaudeAccountIdentity(p)).toEqual({ accountUuid: '', emailAddress: 'only@x.com' });
  });

  it('defaultClaudeConfigPath points at <home>/.claude.json', () => {
    expect(defaultClaudeConfigPath('/Users/zed')).toBe('/Users/zed/.claude.json');
  });
});

// ---------------------------------------------------------------------------
// identitySwitched + watcher
// ---------------------------------------------------------------------------

describe('identitySwitched', () => {
  const a: ClaudeAccountIdentity = { accountUuid: 'u-a', emailAddress: 'a@x.com' };
  const b: ClaudeAccountIdentity = { accountUuid: 'u-b', emailAddress: 'b@x.com' };

  it('fires only on non-null → different non-null', () => {
    expect(identitySwitched(a, b)).toBe(true);
    expect(identitySwitched(a, { ...a })).toBe(false);
    expect(identitySwitched(null, a)).toBe(false); // first login / fresh boot
    expect(identitySwitched(a, null)).toBe(false); // logout / transient parse failure
    expect(identitySwitched(null, null)).toBe(false);
  });

  it('accountUuid wins when both sides have one (email may lag upstream, #23906)', () => {
    expect(
      identitySwitched(
        { accountUuid: 'u-a', emailAddress: 'same@x.com' },
        { accountUuid: 'u-b', emailAddress: 'same@x.com' },
      ),
    ).toBe(true);
    expect(
      identitySwitched(
        { accountUuid: 'u-a', emailAddress: 'old@x.com' },
        { accountUuid: 'u-a', emailAddress: 'new@x.com' },
      ),
    ).toBe(false);
  });

  it('falls back to email when a uuid is missing on either side', () => {
    expect(
      identitySwitched(
        { accountUuid: '', emailAddress: 'a@x.com' },
        { accountUuid: 'u-b', emailAddress: 'b@x.com' },
      ),
    ).toBe(true);
  });
});

describe('createClaudeAccountWatcher', () => {
  it('detects an account switch across checkNow() passes', () => {
    const dir = makeTmpDir('sigmalink-watch-');
    const p = path.join(dir, '.claude.json');
    writeConfig(p, { accountUuid: 'u-a', emailAddress: 'a@x.com' });
    const onSwitch = vi.fn();
    const watcher = createClaudeAccountWatcher({ configPath: p, onSwitch });
    watcher.start();

    // Same identity → no fire.
    watcher.checkNow();
    expect(onSwitch).not.toHaveBeenCalled();

    // Different identity → one fire with (next, prev).
    writeConfig(p, { accountUuid: 'u-b', emailAddress: 'b@x.com' });
    watcher.checkNow();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith(
      { accountUuid: 'u-b', emailAddress: 'b@x.com' },
      { accountUuid: 'u-a', emailAddress: 'a@x.com' },
    );

    // Unchanged again → still one fire.
    watcher.checkNow();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('a transient unreadable read never fires and never poisons the baseline', () => {
    const dir = makeTmpDir('sigmalink-watch-');
    const p = path.join(dir, '.claude.json');
    writeConfig(p, { accountUuid: 'u-a', emailAddress: 'a@x.com' });
    const onSwitch = vi.fn();
    const watcher = createClaudeAccountWatcher({ configPath: p, onSwitch });
    watcher.start();

    // Mid-rewrite torn state → identity null → no fire.
    fs.writeFileSync(p, '{torn', 'utf8');
    watcher.checkNow();
    expect(onSwitch).not.toHaveBeenCalled();

    // Same account comes back → NOT a switch (baseline survived the null).
    writeConfig(p, { accountUuid: 'u-a', emailAddress: 'a@x.com' });
    watcher.checkNow();
    expect(onSwitch).not.toHaveBeenCalled();

    // A REAL switch after the recovery still fires, with the pre-glitch prev.
    writeConfig(p, { accountUuid: 'u-b', emailAddress: 'b@x.com' });
    watcher.checkNow();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][1]).toEqual({ accountUuid: 'u-a', emailAddress: 'a@x.com' });
    watcher.stop();
  });

  it('logout (oauthAccount removed) then re-login to the SAME account never fires', () => {
    const dir = makeTmpDir('sigmalink-watch-');
    const p = path.join(dir, '.claude.json');
    writeConfig(p, { accountUuid: 'u-a', emailAddress: 'a@x.com' });
    const onSwitch = vi.fn();
    const watcher = createClaudeAccountWatcher({ configPath: p, onSwitch });
    watcher.start();
    fs.writeFileSync(p, JSON.stringify({ numStartups: 6 }), 'utf8');
    watcher.checkNow();
    writeConfig(p, { accountUuid: 'u-a', emailAddress: 'a@x.com' });
    watcher.checkNow();
    expect(onSwitch).not.toHaveBeenCalled();
    watcher.stop();
  });
});

// ---------------------------------------------------------------------------
// restartLiveClaudePanes
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  provider_effective: string | null;
  cwd: string;
  workspace_root: string;
  status: string;
  exit_code: number | null;
  started_at: number;
  exited_at: number | null;
  external_session_id: string | null;
  auto_approve: number | null;
  closed_at: number | null;
}

function setupDb(kv: Record<string, string> = {}): { db: Database.Database; rows: FakeRow[] } {
  const rows: FakeRow[] = [];
  const db = {
    prepare(sql: string) {
      return {
        all() {
          expect(sql).toMatch(/FROM agent_sessions/);
          // Mirrors listLiveClaudeRows' WHERE clause.
          return rows
            .filter(
              (r) =>
                r.closed_at === null &&
                r.status === 'running' &&
                (r.provider_effective ?? r.provider_id) === 'claude',
            )
            .sort((x, y) => x.started_at - y.started_at)
            .map((r) => ({
              id: r.id,
              workspaceId: r.workspace_id,
              providerId: r.provider_id,
              providerEffective: r.provider_effective,
              cwd: r.cwd,
              workspaceRoot: r.workspace_root,
              externalSessionId: r.external_session_id,
              autoApprove: r.auto_approve,
            }));
        },
        get(key: string) {
          expect(sql).toMatch(/FROM kv/);
          const value = kv[key];
          return value === undefined ? undefined : { value };
        },
        run(...args: unknown[]) {
          if (/SET provider_effective/.test(sql)) {
            const [providerEffective, sessionId] = args as [string, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.provider_effective = providerEffective;
            return { changes: row ? 1 : 0 };
          }
          if (/SET external_session_id = \?/.test(sql)) {
            const [value, sessionId] = args as [string | null, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.external_session_id = value;
            return { changes: row ? 1 : 0 };
          }
          if (/status = 'running'/.test(sql)) {
            const [startedAt, sessionId] = args as [number, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) {
              row.status = 'running';
              row.exit_code = null;
              row.exited_at = null;
              row.started_at = startedAt;
            }
            return { changes: row ? 1 : 0 };
          }
          if (/status = 'exited'/.test(sql)) {
            const [exitedAt, sessionId] = args as [number, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) {
              row.status = 'exited';
              row.exit_code = -1;
              row.exited_at = exitedAt;
            }
            return { changes: row ? 1 : 0 };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
    },
  } as unknown as Database.Database;
  return { db, rows };
}

function insertLiveClaudeRow(rows: FakeRow[], values: Partial<FakeRow> = {}): void {
  rows.push({
    id: values.id ?? 'sess-1',
    workspace_id: values.workspace_id ?? 'ws-1',
    provider_id: values.provider_id ?? 'claude',
    provider_effective:
      values.provider_effective !== undefined ? values.provider_effective : 'claude',
    cwd: values.cwd ?? '/tmp/project',
    workspace_root: values.workspace_root ?? values.cwd ?? '/tmp/project',
    status: values.status ?? 'running',
    exit_code: values.exit_code ?? null,
    started_at: values.started_at ?? 100,
    exited_at: values.exited_at ?? null,
    external_session_id:
      values.external_session_id !== undefined
        ? values.external_session_id
        : VALID_CLAUDE_SESSION_ID,
    auto_approve: values.auto_approve ?? null,
    closed_at: values.closed_at ?? null,
  });
}

interface FakeRegistry {
  registry: PtyRegistry;
  killed: string[];
  expectedExits: string[];
  callOrder: string[];
}

function makeFakeRegistry(
  live: Record<string, { alive: boolean; dieOnKill?: boolean }>,
): FakeRegistry {
  const killed: string[] = [];
  const expectedExits: string[] = [];
  const callOrder: string[] = [];
  const registry = {
    get(id: string) {
      const rec = live[id];
      if (!rec) return undefined;
      return { id, alive: rec.alive } as unknown as SessionRecord;
    },
    kill(id: string) {
      killed.push(id);
      callOrder.push(`kill:${id}`);
      const rec = live[id];
      if (rec && rec.dieOnKill !== false) rec.alive = false;
    },
    markExpectedExit(id: string) {
      expectedExits.push(id);
      callOrder.push(`expect:${id}`);
    },
  } as unknown as PtyRegistry;
  return { registry, killed, expectedExits, callOrder };
}

function makeSpawnedSession(id: string): SessionRecord {
  return {
    id,
    providerId: 'claude',
    cwd: '/tmp/project',
    pid: 4321,
    alive: true,
    startedAt: 5678,
    pty: {
      pid: 4321,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    buffer: {
      snapshot: () => '',
      append: () => undefined,
      clear: () => undefined,
    } as unknown as SessionRecord['buffer'],
    unsubData: () => undefined,
    unsubExit: () => undefined,
  };
}

function makeResolveResult(
  ptySession: SessionRecord,
  extra: { preassignedExternalSessionId?: string } = {},
) {
  return {
    ptySession,
    providerRequested: 'claude',
    providerEffective: 'claude',
    commandUsed: 'claude',
    argsUsed: [] as string[],
    fallbackOccurred: false,
    ...extra,
  };
}

function makeClaudeHomeWithSession(cwd: string, sessionId: string): string {
  const home = makeTmpDir('sigmalink-acctswitch-home-');
  const seedDir = path.join(home, '.claude', 'projects', claudeSlugForCwd(cwd));
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, `${sessionId}.jsonl`), '{"type":"system"}\n', 'utf8');
  return home;
}

describe('restartLiveClaudePanes', () => {
  it('marks expected-exit BEFORE kill, then resumes by id and re-marks running', async () => {
    const { db, rows } = setupDb();
    const cwd = makeTmpDir('sigmalink-acctswitch-cwd-');
    insertLiveClaudeRow(rows, { cwd, workspace_root: cwd });
    const claudeHome = makeClaudeHomeWithSession(cwd, VALID_CLAUDE_SESSION_ID);
    const fake = makeFakeRegistry({ 'sess-1': { alive: true } });
    const calls: Array<{
      sessionId?: string;
      preassignedSessionId?: string;
      isResume?: boolean;
      extraArgs?: string[];
      providerId: string;
    }> = [];
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({
        sessionId: opts.sessionId,
        preassignedSessionId: opts.preassignedSessionId,
        isResume: opts.isResume,
        extraArgs: opts.extraArgs,
        providerId: opts.providerId,
      });
      return makeResolveResult(
        makeSpawnedSession(opts.sessionId ?? opts.preassignedSessionId ?? 'x'),
      );
    };

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve,
      claudeHomeDir: claudeHome,
    });

    expect(result).toEqual({ restarted: 1, failed: 0, skipped: 0, workspaceIds: ['ws-1'] });
    // Safety order: the expected-exit flag must be up before the kill lands.
    expect(fake.callOrder).toEqual(['expect:sess-1', 'kill:sess-1']);
    expect(calls).toEqual([
      {
        sessionId: 'sess-1',
        preassignedSessionId: undefined,
        isResume: true,
        extraArgs: ['--resume', VALID_CLAUDE_SESSION_ID],
        providerId: 'claude',
      },
    ]);
    expect(rows[0].status).toBe('running');
    expect(rows[0].started_at).toBe(5678);
  });

  it('null external id → ghost-heal fresh spawn with pre-assigned id, stamped back', async () => {
    const { db, rows } = setupDb();
    const cwd = makeTmpDir('sigmalink-acctswitch-cwd-');
    insertLiveClaudeRow(rows, { cwd, workspace_root: cwd, external_session_id: null });
    const claudeHome = makeTmpDir('sigmalink-acctswitch-home-');
    const fake = makeFakeRegistry({ 'sess-1': { alive: true } });
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) =>
      makeResolveResult(makeSpawnedSession(opts.preassignedSessionId ?? 'x'), {
        preassignedExternalSessionId: 'fresh-preassigned-uuid',
      });

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve,
      claudeHomeDir: claudeHome,
    });

    expect(result.restarted).toBe(1);
    expect(rows[0].external_session_id).toBe('fresh-preassigned-uuid');
    expect(rows[0].status).toBe('running');
  });

  it('skips a row whose PTY is not registry-alive (exit already in flight)', async () => {
    const { db, rows } = setupDb();
    insertLiveClaudeRow(rows);
    const fake = makeFakeRegistry({ 'sess-1': { alive: false } });
    const resolve = vi.fn();

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve: resolve as unknown as NonNullable<ResumeLauncherDeps['resolve']>,
    });

    expect(result).toEqual({ restarted: 0, failed: 0, skipped: 1, workspaceIds: [] });
    expect(fake.killed).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never spawns a twin when the kill does not take (pane stays alive)', async () => {
    const { db, rows } = setupDb();
    insertLiveClaudeRow(rows);
    const fake = makeFakeRegistry({ 'sess-1': { alive: true, dieOnKill: false } });
    const resolve = vi.fn();

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve: resolve as unknown as NonNullable<ResumeLauncherDeps['resolve']>,
      killWaitMs: 0,
    });

    expect(result.failed).toBe(1);
    expect(result.restarted).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    // Row untouched: the pane is still (unexpectedly) alive — leave its state.
    expect(rows[0].status).toBe('running');
  });

  it('a spawn failure marks the row into the exited/-1 respawn bucket', async () => {
    const { db, rows } = setupDb();
    const cwd = makeTmpDir('sigmalink-acctswitch-cwd-');
    insertLiveClaudeRow(rows, { cwd, workspace_root: cwd });
    const claudeHome = makeClaudeHomeWithSession(cwd, VALID_CLAUDE_SESSION_ID);
    const fake = makeFakeRegistry({ 'sess-1': { alive: true } });
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = () => {
      throw new Error('spawn blew up');
    };

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve,
      claudeHomeDir: claudeHome,
      now: () => 999,
    });

    expect(result).toEqual({ restarted: 0, failed: 1, skipped: 0, workspaceIds: ['ws-1'] });
    expect(rows[0].status).toBe('exited');
    expect(rows[0].exit_code).toBe(-1);
    expect(rows[0].exited_at).toBe(999);
  });

  it('restarts multiple live claude panes across workspaces and reports each workspace once', async () => {
    const { db, rows } = setupDb();
    const cwdA = makeTmpDir('sigmalink-acctswitch-cwd-');
    const cwdB = makeTmpDir('sigmalink-acctswitch-cwd-');
    insertLiveClaudeRow(rows, { id: 'sess-a1', workspace_id: 'ws-a', cwd: cwdA, workspace_root: cwdA, external_session_id: null });
    insertLiveClaudeRow(rows, { id: 'sess-a2', workspace_id: 'ws-a', cwd: cwdA, workspace_root: cwdA, external_session_id: null, started_at: 200 });
    insertLiveClaudeRow(rows, { id: 'sess-b1', workspace_id: 'ws-b', cwd: cwdB, workspace_root: cwdB, external_session_id: null, started_at: 300 });
    const claudeHome = makeTmpDir('sigmalink-acctswitch-home-');
    const fake = makeFakeRegistry({
      'sess-a1': { alive: true },
      'sess-a2': { alive: true },
      'sess-b1': { alive: true },
    });
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) =>
      makeResolveResult(makeSpawnedSession(opts.preassignedSessionId ?? 'x'));

    const result = await restartLiveClaudePanes({
      pty: fake.registry,
      db,
      resolve,
      claudeHomeDir: claudeHome,
    });

    expect(result.restarted).toBe(3);
    expect(result.workspaceIds.sort()).toEqual(['ws-a', 'ws-b']);
    expect(fake.killed).toEqual(['sess-a1', 'sess-a2', 'sess-b1']);
  });
});
