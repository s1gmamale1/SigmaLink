import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';

import {
  buildResumeArgs,
  resumeWorkspacePanes,
  type ResumeLauncherDeps,
} from './resume-launcher.ts';
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

interface FakeRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  provider_effective: string | null;
  cwd: string;
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
    status: values.status ?? 'running',
    exit_code: values.exit_code ?? null,
    started_at: values.started_at ?? 100,
    exited_at: values.exited_at ?? null,
    external_session_id:
      values.external_session_id !== undefined
        ? values.external_session_id
        : 'external-claude-1',
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
  it.each([
    ['claude', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['claude', null, ['--continue'], 'continue'],
    ['codex', 'ext-id', ['resume', 'ext-id'], 'id'],
    ['codex', null, ['resume', '--last'], 'continue'],
    ['gemini', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['gemini', null, ['--resume', 'latest'], 'continue'],
    ['kimi', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['kimi', null, ['--continue'], 'continue'],
    ['opencode', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['opencode', null, ['--continue'], 'continue'],
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
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.resumed.length).toBe(1);
    expect(result.failed.length).toBe(0);
    expect(calls[0]?.sessionId).toBe('sess-1');
    expect(calls[0]?.providerId).toBe('claude');
    expect(calls[0]?.args).toEqual(['--resume', 'external-claude-1']);
    expect(result.resumed[0]?.resumeMode).toBe('id');
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
      getProvider: () => claudeProvider,
      resolve,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.resumed).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--continue']);
    expect(result.resumed[0]?.externalSessionId).toBe('');
    expect(result.resumed[0]?.resumeMode).toBe('continue');
    expect(rows[0]?.status).toBe('running');
  });

  it('routes missing external id to --continue for every shipped provider', async () => {
    // v1.2.8 — exhaustive per-provider matrix verifying the universal fallback
    // wires the right args for each CLI. One row per provider, no external id.
    const providers = [
      { def: claudeProvider, expected: ['--continue'] },
      { def: codexProvider, expected: ['resume', '--last'] },
      { def: geminiProvider, expected: ['--resume', 'latest'] },
      { def: kimiProvider, expected: ['--continue'] },
      { def: opencodeProvider, expected: ['--continue'] },
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
