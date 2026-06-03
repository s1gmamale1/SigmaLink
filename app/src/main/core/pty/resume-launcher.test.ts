import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import {
  buildResumeArgs,
  resumeWorkspacePanes,
  type ResumeLauncherDeps,
} from './resume-launcher.ts';
// SF-2 — use the production slug helper rather than an inline `/`-only replace,
// so the test layout matches the directory Claude (and the bridge) actually use.
import { claudeSlugForCwd } from './claude-resume-sigma.ts';
import type { PtyRegistry, SessionRecord } from './registry.ts';

const claudeProvider = {
  id: 'claude',
  name: 'Claude',
  description: '',
  command: 'claude',
  args: [],
  resumeArgs: ['--resume'],
  color: '#000',
  icon: '',
  installHint: '',
};

const codexProvider = { ...claudeProvider, id: 'codex', name: 'Codex' };
const geminiProvider = { ...claudeProvider, id: 'gemini', name: 'Gemini' };
const kimiProvider = { ...claudeProvider, id: 'kimi', name: 'Kimi' };
const opencodeProvider = { ...claudeProvider, id: 'opencode', name: 'OpenCode' };
const cursorProvider = { ...claudeProvider, id: 'cursor', name: 'Cursor', command: 'cursor-agent' };
const VALID_CLAUDE_SESSION_ID = '01234567-89ab-4cde-9f01-23456789abcd';

const tmpHomes: string[] = [];

function makeClaudeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-resume-'));
  tmpHomes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  provider_effective: string | null;
  cwd: string;
  worktree_path: string | null;
  workspace_root: string;
  repo_root: string | null;
  status: string;
  exit_code: number | null;
  started_at: number;
  exited_at: number | null;
  external_session_id: string | null;
}

function setupDb(): { db: Database.Database; rows: FakeRow[] } {
  const rows: FakeRow[] = [];
  const db = {
    prepare(sql: string) {
      return {
        all(workspaceId: string) {
          expect(sql).toMatch(/FROM agent_sessions/);
          return rows
            .filter((r) => r.workspace_id === workspaceId)
            .filter(
              (r) =>
                r.status === 'running' ||
                (r.status === 'exited' && r.exit_code === -1),
            )
            .sort((a, b) => a.started_at - b.started_at)
            .map((r) => ({
              id: r.id,
              workspaceId: r.workspace_id,
              providerId: r.provider_id,
              providerEffective: r.provider_effective,
              cwd: r.cwd,
              worktreePath: r.worktree_path,
              workspaceRoot: r.workspace_root,
              repoRoot: r.repo_root,
              externalSessionId: r.external_session_id,
            }));
        },
        get(keyOrId: string) {
          if (/FROM kv/.test(sql)) return undefined;
          const row = rows.find((r) => r.id === keyOrId);
          if (!row) return undefined;
          return {
            status: row.status,
            exitCode: row.exit_code,
            exitedAt: row.exited_at,
            startedAt: row.started_at,
          };
        },
        run(...args: unknown[]) {
          if (/provider_effective/.test(sql)) {
            const [providerEffective, sessionId] = args as [string, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.provider_effective = providerEffective;
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
          if (/SET status = \?/.test(sql)) {
            const [status, exitCode, exitedAt, sessionId] = args as [
              string,
              number,
              number,
              string,
            ];
            const row = rows.find((r) => r.id === sessionId);
            if (row) {
              row.status = status;
              row.exit_code = exitCode;
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

function insertSession(
  rows: FakeRow[],
  values: Partial<FakeRow> = {},
): void {
  rows.push({
    id: values.id ?? 'sess-1',
    workspace_id: values.workspace_id ?? 'ws-1',
    provider_id: values.provider_id ?? 'claude',
    provider_effective: values.provider_effective ?? 'claude',
    cwd: values.cwd ?? '/tmp/project',
    worktree_path: values.worktree_path ?? null,
    workspace_root: values.workspace_root ?? values.cwd ?? '/tmp/project',
    repo_root: values.repo_root ?? null,
    status: values.status ?? 'running',
    exit_code: values.exit_code ?? null,
    started_at: values.started_at ?? 100,
    exited_at: values.exited_at ?? null,
    external_session_id:
      values.external_session_id !== undefined
        ? values.external_session_id
        : VALID_CLAUDE_SESSION_ID,
  });
}

function makeSession(id: string, providerId: string, startedAt = 1234): SessionRecord {
  return {
    id,
    providerId,
    cwd: '/tmp/project',
    pid: 4321,
    alive: true,
    startedAt,
    pty: {
      pid: 4321,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
    buffer: { snapshot: () => '', append: () => undefined, clear: () => undefined } as unknown as SessionRecord['buffer'],
    unsubData: () => undefined,
    unsubExit: () => undefined,
  };
}

describe('buildResumeArgs', () => {
  // v1.2.8 — the new per-provider matrix. Each provider has two flavours:
  // by captured id (use the native flag) and the universal --continue fallback.
  // B2 — gemini's CLI only accepts 'latest'/index (not a filename stem), so a
  // PRESENT id still maps to '--resume latest' (against the bridge-aliased
  // workspace slug). But a NULL id now emits NO --resume — a fresh spawn —
  // instead of latching onto gemini's GLOBAL newest session (a different
  // project). See gemini-resume-sigma.ts + the launcher gemini branch.
  it.each([
    ['claude', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['claude', null, ['--continue'], 'continue'],
    ['codex', 'ext-id', ['resume', 'ext-id'], 'id'],
    ['codex', null, ['resume', '--last'], 'continue'],
    // gemini with id → '--resume latest' (G-2 flag fix); null → fresh (B2)
    ['gemini', 'ext-id', ['--resume', 'latest'], 'continue'],
    ['gemini', null, [], 'continue'],
    ['kimi', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['kimi', null, ['--continue'], 'continue'],
    ['opencode', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['opencode', null, ['--continue'], 'continue'],
    // R-2 — cursor mirrors claude's flag shape: --resume <id> / --continue
    ['cursor', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['cursor', null, ['--continue'], 'continue'],
  ] as const)('%s + %s → %j (%s)', (provider, externalId, expected, mode) => {
    const result = buildResumeArgs(provider, externalId);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(expected);
    expect(result!.mode).toBe(mode);
  });

  it('returns null for providers without a known resume strategy', () => {
    expect(buildResumeArgs('shell', null)).toBeNull();
    expect(buildResumeArgs('custom', 'ext-id')).toBeNull();
    expect(buildResumeArgs('unknown-provider', 'ext-id')).toBeNull();
  });

  it('treats empty + whitespace external ids as the continue fallback', () => {
    expect(buildResumeArgs('claude', '')?.args).toEqual(['--continue']);
    expect(buildResumeArgs('claude', '   ')?.args).toEqual(['--continue']);
  });

  // G-2 + B2: gemini --resume never passes a filename stem. With a picked id
  // it maps to '--resume latest' (resolved against the bridge-aliased workspace
  // slug). With NO id it emits an EMPTY arg list — a fresh spawn — so it never
  // falls through to gemini's GLOBAL newest session in a DIFFERENT project.
  it('gemini resume: present id → --resume latest; null id → fresh (no resume arg)', () => {
    const withId = buildResumeArgs('gemini', 'session-2024-01-01T12-00-abc');
    expect(withId).not.toBeNull();
    expect(withId!.args).toEqual(['--resume', 'latest']);
    expect(withId!.mode).toBe('continue');

    const withoutId = buildResumeArgs('gemini', null);
    expect(withoutId).not.toBeNull();
    expect(withoutId!.args).toEqual([]);
    expect(withoutId!.mode).toBe('continue');
  });
});

describe('resumeWorkspacePanes', () => {
  it('appends provider resumeArgs and external session id', async () => {
    const { db, rows } = setupDb();
    insertSession(rows);
    const calls: Array<{ sessionId?: string; providerId: string; command: string; args: string[] }> = [];
    const registry = {
      get: () => undefined,
    } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({
        sessionId: opts.sessionId,
        providerId: opts.providerId,
        command: 'claude',
        args: opts.extraArgs ?? [],
      });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed.length).toBe(1);
    expect(result.failed.length).toBe(0);
    expect(calls[0]?.sessionId).toBe('sess-1');
    expect(calls[0]?.providerId).toBe('claude');
    expect(calls[0]?.args).toEqual(['--resume', VALID_CLAUDE_SESSION_ID]);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.exit_code).toBe(null);
    expect(rows[0]?.exited_at).toBe(null);
    expect(rows[0]?.started_at).toBe(1234);
  });

  it('marks failed resumes as exited without throwing', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-fail' });
    const registry = {
      get: () => undefined,
    } as unknown as PtyRegistry;
    const resolve = (() => {
      throw new Error('spawn failed');
    }) as NonNullable<ResumeLauncherDeps['resolve']>;

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      now: () => 2222,
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed.length).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.error).toBe('spawn failed');
    expect(rows[0]?.status).toBe('exited');
    expect(rows[0]?.exit_code).toBe(-1);
    expect(rows[0]?.exited_at).toBe(2222);
  });

  it('routes missing external_session_id to --continue (no longer a failure)', async () => {
    // v1.2.8 — the v1.2.7 behaviour was: missing id ⇒ mark exited+failed and
    // surface "missing external_session_id" in the toast. The new contract is
    // success-via-fallback: the resume launcher builds `['--continue']` args
    // and spawns normally; only the spawn itself can fail now.
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-missing-external',
      external_session_id: null,
    });
    const calls: Array<{ args: string[] }> = [];
    const registry = {
      get: () => undefined,
    } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({ args: opts.extraArgs ?? [] });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.resumed).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--continue']);
    expect(result.resumed[0]?.externalSessionId).toBe('');
    expect(rows[0]?.status).toBe('running');
  });

  it('maps old worktree-root cwd rows back to the workspace subdir and bridges Claude resume files', async () => {
    const claudeHomeDir = makeClaudeHome();
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-repo-'));
    const workspaceRoot = path.join(repoRoot, 'app');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmalink-wt-root-'));
    const worktreeApp = path.join(worktreePath, path.basename(workspaceRoot));
    fs.mkdirSync(worktreeApp, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'CLAUDE.md'), '# workspace claude\n');
    const externalId = VALID_CLAUDE_SESSION_ID;
    const workspaceSlug = claudeSlugForCwd(workspaceRoot);
    const sourceDir = path.join(claudeHomeDir, '.claude', 'projects', workspaceSlug);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, `${externalId}.jsonl`), '{"ok":true}\n');
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-worktree-root',
      cwd: worktreePath,
      worktree_path: worktreePath,
      workspace_root: workspaceRoot,
      repo_root: repoRoot,
      external_session_id: externalId,
    });
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({ cwd: opts.cwd, args: opts.extraArgs ?? [] });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir,
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed).toHaveLength(1);
    expect(calls[0]).toEqual({ cwd: worktreeApp, args: ['--resume', externalId] });
    expect(fs.readFileSync(path.join(worktreeApp, 'CLAUDE.md'), 'utf8')).toContain(
      'workspace claude',
    );
    const worktreeSlug = claudeSlugForCwd(worktreeApp);
    expect(
      fs.existsSync(
        path.join(claudeHomeDir, '.claude', 'projects', worktreeSlug, `${externalId}.jsonl`),
      ),
    ).toBe(true);
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it('does not pass invalid Claude resume ids through to claude --resume', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-invalid-id',
      external_session_id: 'not-a-uuid',
    });
    const calls: Array<{ args: string[] }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({ args: opts.extraArgs ?? [] });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--continue']);
  });

  it('routes missing external id to --continue for every shipped provider', async () => {
    // v1.2.8 — exhaustive per-provider matrix verifying the universal fallback
    // wires the right args for each CLI. One row per provider, no external id.
    const providers = [
      { def: claudeProvider, expected: ['--continue'] },
      { def: codexProvider, expected: ['resume', '--last'] },
      // B2 — gemini with NO external id now spawns FRESH (empty args) rather
      // than '--resume latest' (which resumed a foreign global session).
      { def: geminiProvider, expected: [] },
      { def: kimiProvider, expected: ['--continue'] },
      { def: opencodeProvider, expected: ['--continue'] },
      // R-2 — cursor falls back to --continue when no external id was captured
      { def: cursorProvider, expected: ['--continue'] },
    ];
    for (const { def, expected } of providers) {
      const { db, rows } = setupDb();
      insertSession(rows, {
        id: `sess-${def.id}`,
        provider_id: def.id,
        provider_effective: def.id,
        external_session_id: null,
      });
      const calls: Array<{ args: string[] }> = [];
      const registry = { get: () => undefined } as unknown as PtyRegistry;
      const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_d, opts) => {
        calls.push({ args: opts.extraArgs ?? [] });
        return {
          ptySession: makeSession(opts.sessionId ?? 'new', opts.providerId),
          providerRequested: opts.providerId,
          providerEffective: def.id,
          commandUsed: def.command,
          argsUsed: opts.extraArgs ?? [],
          fallbackOccurred: false,
        };
      };
      const result = await resumeWorkspacePanes('ws-1', {
        pty: registry,
        db,
        claudeHomeDir: makeClaudeHome(),
        getProvider: () => def,
        resolve,
      });
      expect(result.failed).toHaveLength(0);
      expect(result.resumed).toHaveLength(1);
      expect(calls[0]?.args).toEqual(expected);
      expect(rows[0]?.status).toBe('running');
    }
  });
});

// ── P6 FEAT-1: subset-aware resume (sessionIds allowlist) ──────────────────
// resumeWorkspacePanes accepts an optional `sessionIds` allowlist. When
// provided, only the eligible rows whose id is in the set are resumed; the
// boot path (and every existing call) omits it for full behaviour.

describe('resumeWorkspacePanes — P6 FEAT-1 subset allowlist', () => {
  function makeFanResolve(
    calls: Array<{ sessionId?: string; args: string[] }>,
  ): NonNullable<ResumeLauncherDeps['resolve']> {
    return (_deps, opts) => {
      calls.push({ sessionId: opts.sessionId, args: opts.extraArgs ?? [] });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };
  }

  it('with sessionIds provided, resumes ONLY the allowlisted rows', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-a', started_at: 100 });
    insertSession(rows, { id: 'sess-b', started_at: 200 });
    insertSession(rows, { id: 'sess-c', started_at: 300 });
    const calls: Array<{ sessionId?: string; args: string[] }> = [];

    const result = await resumeWorkspacePanes(
      'ws-1',
      {
        pty: { get: () => undefined } as unknown as PtyRegistry,
        db,
        claudeHomeDir: makeClaudeHome(),
        getProvider: () => claudeProvider,
        resolve: makeFanResolve(calls),
      },
      ['sess-b'],
    );

    expect(result.resumed.map((r) => r.sessionId)).toEqual(['sess-b']);
    expect(calls.map((c) => c.sessionId)).toEqual(['sess-b']);
    // The non-selected rows are untouched: still 'running', not re-spawned.
    expect(rows.find((r) => r.id === 'sess-a')?.status).toBe('running');
    expect(rows.find((r) => r.id === 'sess-c')?.status).toBe('running');
  });

  it('without sessionIds, resumes ALL eligible rows (boot behaviour unchanged)', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-a', started_at: 100 });
    insertSession(rows, { id: 'sess-b', started_at: 200 });
    const calls: Array<{ sessionId?: string; args: string[] }> = [];

    const result = await resumeWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve: makeFanResolve(calls),
    });

    expect(result.resumed.map((r) => r.sessionId).sort()).toEqual([
      'sess-a',
      'sess-b',
    ]);
    expect(calls).toHaveLength(2);
  });

  it('an empty sessionIds array resumes nothing', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-a', started_at: 100 });
    const calls: Array<{ sessionId?: string; args: string[] }> = [];

    const result = await resumeWorkspacePanes(
      'ws-1',
      {
        pty: { get: () => undefined } as unknown as PtyRegistry,
        db,
        claudeHomeDir: makeClaudeHome(),
        getProvider: () => claudeProvider,
        resolve: makeFanResolve(calls),
      },
      [],
    );

    expect(result.resumed).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(rows[0]?.status).toBe('running');
  });

  it('ignores ids that are not eligible rows', async () => {
    const { db, rows } = setupDb();
    insertSession(rows, { id: 'sess-a', started_at: 100 });
    const calls: Array<{ sessionId?: string; args: string[] }> = [];

    const result = await resumeWorkspacePanes(
      'ws-1',
      {
        pty: { get: () => undefined } as unknown as PtyRegistry,
        db,
        claudeHomeDir: makeClaudeHome(),
        getProvider: () => claudeProvider,
        resolve: makeFanResolve(calls),
      },
      ['sess-a', 'sess-does-not-exist'],
    );

    expect(result.resumed.map((r) => r.sessionId)).toEqual(['sess-a']);
    expect(calls).toHaveLength(1);
  });
});

// ── A3: resume re-applies persisted auto_approve ──────────────────────────
// SF-8 Yolo/Bypass — resumeWorkspacePanes must read `auto_approve` from the
// agent_sessions row and pass `autoApprove: row.autoApprove === 1` to
// resolveAndSpawn so the bypass flag is restored on every resume.

interface FakeRowWithAutoApprove extends Omit<FakeRow, 'external_session_id'> {
  external_session_id: string | null;
  auto_approve: number;
}

function setupDbWithAutoApprove(): {
  db: Database.Database;
  rows: FakeRowWithAutoApprove[];
} {
  const rows: FakeRowWithAutoApprove[] = [];
  const db = {
    prepare(sql: string) {
      return {
        all(workspaceId: string) {
          return rows
            .filter((r) => r.workspace_id === workspaceId)
            .filter(
              (r) =>
                r.status === 'running' ||
                (r.status === 'exited' && r.exit_code === -1),
            )
            .sort((a, b) => a.started_at - b.started_at)
            .map((r) => ({
              id: r.id,
              workspaceId: r.workspace_id,
              providerId: r.provider_id,
              providerEffective: r.provider_effective,
              cwd: r.cwd,
              worktreePath: r.worktree_path,
              workspaceRoot: r.workspace_root,
              repoRoot: r.repo_root,
              externalSessionId: r.external_session_id,
              autoApprove: r.auto_approve,
            }));
        },
        get(keyOrId: string) {
          if (/FROM kv/.test(sql)) return undefined;
          const row = rows.find((r) => r.id === keyOrId);
          if (!row) return undefined;
          return {
            status: row.status,
            exitCode: row.exit_code,
            exitedAt: row.exited_at,
            startedAt: row.started_at,
          };
        },
        run(...args: unknown[]) {
          if (/provider_effective/.test(sql)) {
            const [providerEffective, sessionId] = args as [string, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.provider_effective = providerEffective;
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
          if (/SET status = \?/.test(sql)) {
            const [status, exitCode, exitedAt, sessionId] = args as [
              string,
              number,
              number,
              string,
            ];
            const row = rows.find((r) => r.id === sessionId);
            if (row) {
              row.status = status;
              row.exit_code = exitCode;
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

describe('resumeWorkspacePanes — SF-8 auto_approve persistence (A3)', () => {
  it('A3: auto_approve=1 in DB → resolveAndSpawn receives autoApprove=true', async () => {
    const { db, rows } = setupDbWithAutoApprove();
    rows.push({
      id: 'sess-yolo',
      workspace_id: 'ws-aa',
      provider_id: 'claude',
      provider_effective: 'claude',
      cwd: '/tmp/project',
      worktree_path: null,
      workspace_root: '/tmp/project',
      repo_root: null,
      status: 'running',
      exit_code: null,
      started_at: 100,
      exited_at: null,
      external_session_id: VALID_CLAUDE_SESSION_ID,
      auto_approve: 1,
    });

    const spawnOpts: Array<{ autoApprove?: boolean; extraArgs?: string[] }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      spawnOpts.push({ autoApprove: opts.autoApprove, extraArgs: opts.extraArgs });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-aa', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(spawnOpts[0]?.autoApprove).toBe(true);
  });

  it('A3: auto_approve=0 in DB → resolveAndSpawn receives autoApprove=false (default OFF)', async () => {
    const { db, rows } = setupDbWithAutoApprove();
    rows.push({
      id: 'sess-normal',
      workspace_id: 'ws-aa2',
      provider_id: 'claude',
      provider_effective: 'claude',
      cwd: '/tmp/project',
      worktree_path: null,
      workspace_root: '/tmp/project',
      repo_root: null,
      status: 'running',
      exit_code: null,
      started_at: 100,
      exited_at: null,
      external_session_id: VALID_CLAUDE_SESSION_ID,
      auto_approve: 0,
    });

    const spawnOpts: Array<{ autoApprove?: boolean }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      spawnOpts.push({ autoApprove: opts.autoApprove });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-aa2', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(spawnOpts[0]?.autoApprove).toBe(false);
  });
});
