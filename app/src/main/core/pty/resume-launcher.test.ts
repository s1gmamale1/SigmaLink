import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import {
  buildResumeArgs,
  respawnFailedWorkspacePanes,
  resumeWorkspacePanes,
  unfailZombieSwarms,
  type ResumeLauncherDeps,
} from './resume-launcher.ts';
import { KV_PTY_SPAWN_MODE } from './local-pty.ts';
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

function setupDb(kv: Record<string, string> = {}): { db: Database.Database; rows: FakeRow[] } {
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
          if (/FROM kv/.test(sql)) {
            const value = kv[keyOrId];
            return value === undefined ? undefined : { value };
          }
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
          if (/SET external_session_id = \?/.test(sql)) {
            // GHOST-HEAL — clear (null) or stamp the new pre-assigned id.
            const [value, sessionId] = args as [string | null, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.external_session_id = value;
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
  // by captured id (use the native flag) and, on a NULL id, a FRESH spawn.
  // SESSION-COLLAPSE FIX — a null id no longer emits a "continue-latest"
  // fallback (`claude --continue` / `codex resume --last` / etc.). Those
  // resumed the cwd's (or globally) newest session, which in in-place mode
  // (shared cwd) collapsed every pane onto the operator's own / a sibling's
  // session. A null id now emits EMPTY args → a fresh spawn, matching the
  // policy gemini already adopted in B2.
  it.each([
    ['claude', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['claude', null, [], 'continue'],
    ['codex', 'ext-id', ['resume', 'ext-id'], 'id'],
    ['codex', null, [], 'continue'],
    // gemini with id → '--resume latest' (G-2 flag fix); null → fresh (B2)
    ['gemini', 'ext-id', ['--resume', 'latest'], 'continue'],
    ['gemini', null, [], 'continue'],
    ['kimi', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['kimi', null, [], 'continue'],
    ['opencode', 'ext-id', ['--session', 'ext-id'], 'id'],
    ['opencode', null, [], 'continue'],
    // R-2 — cursor mirrors claude's flag shape: --resume <id>, else fresh
    ['cursor', 'ext-id', ['--resume', 'ext-id'], 'id'],
    ['cursor', null, [], 'continue'],
  ] as const)('%s + %s → %j (%s)', (provider, externalId, expected, mode) => {
    const result = buildResumeArgs(provider, externalId);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(expected);
    expect(result!.mode).toBe(mode);
  });

  // SESSION-COLLAPSE regression — a null/ghost id must NEVER produce a
  // continue-latest flag (the in-place pane-collapse bug). Every provider's
  // null branch is a fresh spawn (empty args).
  it('null id never emits a continue-latest flag for any provider', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'kimi', 'opencode', 'cursor']) {
      const args = buildResumeArgs(provider, null)?.args ?? [];
      expect(args).not.toContain('--continue');
      expect(args).not.toContain('--last');
      expect(args).toEqual([]);
    }
  });

  it('returns null for providers without a known resume strategy', () => {
    expect(buildResumeArgs('shell', null)).toBeNull();
    expect(buildResumeArgs('custom', 'ext-id')).toBeNull();
    expect(buildResumeArgs('unknown-provider', 'ext-id')).toBeNull();
  });

  it('treats empty + whitespace external ids as a fresh spawn (no continue-latest)', () => {
    expect(buildResumeArgs('claude', '')?.args).toEqual([]);
    expect(buildResumeArgs('claude', '   ')?.args).toEqual([]);
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
    // Seed the conversation JSONL so the in-place resume bridge finds it and
    // keeps `--resume <id>`. (An absent/stale JSONL now correctly falls back to
    // --continue — that path is covered in claude-resume-sigma.test.ts.)
    const claudeHome = makeClaudeHome();
    const seedDir = path.join(claudeHome, '.claude', 'projects', claudeSlugForCwd('/tmp/project'));
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(
      path.join(seedDir, `${VALID_CLAUDE_SESSION_ID}.jsonl`),
      '{"type":"system"}\n',
      'utf8',
    );
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
      claudeHomeDir: claudeHome,
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

  it('routes missing external_session_id to a FRESH spawn (no longer a failure, no continue-latest)', async () => {
    // v1.2.8 — the v1.2.7 behaviour was: missing id ⇒ mark exited+failed and
    // surface "missing external_session_id" in the toast. SESSION-COLLAPSE FIX —
    // a missing id now spawns FRESH (empty args), NOT `['--continue']`: in
    // in-place mode --continue resumed the cwd's latest session (the operator's
    // own / a sibling pane's), collapsing every pane onto one conversation.
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
    expect(calls[0]?.args).toEqual([]); // FRESH spawn — never --continue
    expect(result.resumed[0]?.externalSessionId).toBe('');
    expect(rows[0]?.status).toBe('running');
  });

  it('GHOST-HEAL: a ghost claude id resumes FRESH with fresh semantics and PERSISTS the new pre-assigned id', async () => {
    // The reported bug: a pane whose stored id has no JSONL on disk (ghost)
    // spawned fresh on EVERY reopen because the new session's real id was never
    // captured (the resume path used sessionId + isResume:true → no pre-assign,
    // no capture). Boot-resume's fresh-fallback must now use FRESH semantics
    // (preassignedSessionId + isResume:false) AND stamp the pre-assigned id back
    // so the NEXT reopen resumes by a real id.
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-ghost',
      // valid UUID shape (passes isClaudeSessionId) but no JSONL in the empty
      // tmp claude home → prepareClaudeResume returns 'missing' → fresh fallback.
      external_session_id: VALID_CLAUDE_SESSION_ID,
    });
    const NEW_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({
        preassignedSessionId: opts.preassignedSessionId,
        sessionId: opts.sessionId,
        isResume: opts.isResume,
        args: opts.extraArgs ?? [],
      });
      return {
        ptySession: makeSession(
          opts.preassignedSessionId ?? opts.sessionId ?? 'new',
          opts.providerId,
        ),
        providerRequested: opts.providerId,
        providerEffective: 'claude',
        commandUsed: 'claude',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
        preassignedExternalSessionId: NEW_ID, // claude --session-id mint
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: registry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => claudeProvider,
      resolve,
    });

    // FRESH semantics — NOT resume-by-id.
    expect(calls[0]?.preassignedSessionId).toBe('sess-ghost');
    expect(calls[0]?.sessionId).toBeUndefined();
    expect(calls[0]?.isResume).toBe(false);
    expect(calls[0]?.args).toEqual([]);
    // The new real id is persisted → the next reopen resumes by it (no re-ghost).
    expect(rows[0]?.external_session_id).toBe(NEW_ID);
    expect(result.resumed[0]?.externalSessionId).toBe(NEW_ID);
    expect(rows[0]?.status).toBe('running');
  });

  it('GHOST-HEAL is claude-only: a ghost codex id stays fresh-no-capture (no disk-scan re-collapse)', async () => {
    // codex has no deterministic --session-id; its only capture is a cwd
    // disk-scan that races siblings/the operator in the shared in-place cwd
    // (the collapse we fixed: pane-4 ← pane-5). So codex ghosts must NOT be
    // healed — they spawn fresh via the resume path (sessionId + isResume:true,
    // no capture), leaving the row untouched.
    const { db, rows } = setupDb();
    insertSession(rows, {
      id: 'sess-codex-ghost',
      provider_id: 'codex',
      provider_effective: 'codex',
      external_session_id: null,
    });
    const calls: Array<{
      preassignedSessionId?: string;
      sessionId?: string;
      isResume?: boolean;
      args: string[];
    }> = [];
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      calls.push({
        preassignedSessionId: opts.preassignedSessionId,
        sessionId: opts.sessionId,
        isResume: opts.isResume,
        args: opts.extraArgs ?? [],
      });
      return {
        ptySession: makeSession(
          opts.sessionId ?? opts.preassignedSessionId ?? 'new',
          opts.providerId,
        ),
        providerRequested: opts.providerId,
        providerEffective: 'codex',
        commandUsed: 'codex',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await resumeWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      claudeHomeDir: makeClaudeHome(),
      getProvider: () => codexProvider,
      resolve,
    });

    // Resume-path semantics (NOT pre-assign): sessionId set, no preassign,
    // isResume:true → no capture sink fires.
    expect(calls[0]?.sessionId).toBe('sess-codex-ghost');
    expect(calls[0]?.preassignedSessionId).toBeUndefined();
    expect(calls[0]?.isResume).toBe(true);
    expect(calls[0]?.args).toEqual([]); // fresh (no `resume --last`)
    // The row is NOT overwritten by a heal — stays as-is (fresh-no-capture).
    expect(rows[0]?.external_session_id).toBeNull();
    expect(result.resumed).toHaveLength(1);
  });

  it('passes the configured PTY spawn mode into boot resume spawns', async () => {
    const { db, rows } = setupDb({ [KV_PTY_SPAWN_MODE]: 'shell-first' });
    insertSession(rows);
    const spawnOpts: Array<{ spawnMode?: 'direct' | 'shell-first' }> = [];
    const registry = { get: () => undefined } as unknown as PtyRegistry;
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      spawnOpts.push({ spawnMode: opts.spawnMode });
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
    expect(spawnOpts[0]?.spawnMode).toBe('shell-first');
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
    expect(calls[0]?.args).toEqual([]); // invalid id → FRESH spawn, never --continue
  });

  it('routes missing external id to a FRESH spawn for every shipped provider', async () => {
    // SESSION-COLLAPSE FIX — exhaustive per-provider matrix. A missing external
    // id now spawns FRESH (empty args) for EVERY provider, never a
    // continue-latest flag: in in-place mode the shared cwd made --continue /
    // resume --last collapse every pane onto the operator's own / a sibling's
    // session. (gemini already did this in B2; the rest now match.)
    const providers = [
      { def: claudeProvider, expected: [] },
      { def: codexProvider, expected: [] },
      { def: geminiProvider, expected: [] },
      { def: kimiProvider, expected: [] },
      { def: opencodeProvider, expected: [] },
      { def: cursorProvider, expected: [] },
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

describe('respawnFailedWorkspacePanes', () => {
  it('passes the configured PTY spawn mode into failed-respawn spawns', async () => {
    const { db, rows } = setupDb({ [KV_PTY_SPAWN_MODE]: 'shell-first' });
    insertSession(rows, {
      id: 'sess-respawn',
      provider_id: 'shell',
      provider_effective: 'shell',
      external_session_id: null,
      status: 'exited',
      exit_code: -1,
      exited_at: 111,
    });
    const spawnOpts: Array<{ spawnMode?: 'direct' | 'shell-first'; sessionId?: string }> = [];
    const resolve: NonNullable<ResumeLauncherDeps['resolve']> = (_deps, opts) => {
      spawnOpts.push({ spawnMode: opts.spawnMode, sessionId: opts.sessionId });
      return {
        ptySession: makeSession(opts.sessionId ?? 'new-id', opts.providerId),
        providerRequested: opts.providerId,
        providerEffective: 'shell',
        commandUsed: '',
        argsUsed: opts.extraArgs ?? [],
        fallbackOccurred: false,
      };
    };

    const result = await respawnFailedWorkspacePanes('ws-1', {
      pty: { get: () => undefined } as unknown as PtyRegistry,
      db,
      resolve,
    });

    expect(result).toEqual({ workspaceId: 'ws-1', spawned: 1, failed: 0 });
    expect(spawnOpts[0]).toEqual({ sessionId: 'sess-respawn', spawnMode: 'shell-first' });
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
      // GHOST-HEAL — the fresh-fallback spawns via preassignedSessionId (not
      // sessionId); capture the EFFECTIVE row id either way so the "which rows
      // resumed" assertions hold regardless of resume-by-id vs fresh semantics.
      calls.push({
        sessionId: opts.sessionId ?? opts.preassignedSessionId,
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
          if (/SET external_session_id = \?/.test(sql)) {
            // GHOST-HEAL — clear (null) or stamp the new pre-assigned id.
            const [value, sessionId] = args as [string | null, string];
            const row = rows.find((r) => r.id === sessionId);
            if (row) row.external_session_id = value;
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

describe('unfailZombieSwarms', () => {
  function fakeSwarmDb(swarms: Array<{ id: string; workspace_id: string; status: string; ended_at: number | null }>) {
    const db = {
      prepare(sql: string) {
        return {
          run(workspaceId: string) {
            expect(sql).toMatch(/UPDATE swarms/);
            expect(sql).toMatch(/status = 'failed'/); // heals ONLY zombie-marked swarms
            let changes = 0;
            for (const s of swarms) {
              if (s.workspace_id === workspaceId && s.status === 'failed') {
                s.status = 'running';
                s.ended_at = null;
                changes += 1;
              }
            }
            return { changes };
          },
        };
      },
    } as unknown as Database.Database;
    return { db, swarms };
  }

  it("flips janitor-failed swarms back to running (unlocks '+ Pane' after resume)", () => {
    const { db, swarms } = fakeSwarmDb([
      { id: 'sw-1', workspace_id: 'ws-1', status: 'failed', ended_at: 123 },
      { id: 'sw-2', workspace_id: 'ws-2', status: 'failed', ended_at: 456 },
    ]);
    expect(unfailZombieSwarms(db, 'ws-1')).toBe(1);
    expect(swarms[0]).toMatchObject({ status: 'running', ended_at: null });
    // Other workspaces are untouched.
    expect(swarms[1]).toMatchObject({ status: 'failed', ended_at: 456 });
  });

  it("leaves operator-stopped ('completed') swarms ended", () => {
    const { db, swarms } = fakeSwarmDb([
      { id: 'sw-1', workspace_id: 'ws-1', status: 'completed', ended_at: 123 },
    ]);
    expect(unfailZombieSwarms(db, 'ws-1')).toBe(0);
    expect(swarms[0]).toMatchObject({ status: 'completed', ended_at: 123 });
  });

  it('never throws when the DB write fails (best-effort heal)', () => {
    const db = {
      prepare() {
        throw new Error('db is closing');
      },
    } as unknown as Database.Database;
    expect(unfailZombieSwarms(db, 'ws-1')).toBe(0);
  });
});
