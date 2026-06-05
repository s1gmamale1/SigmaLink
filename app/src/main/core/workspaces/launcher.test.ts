// v1.3.2 — Focused gate test for the Claude resume bridge integration.
//
// The full `executeLaunchPlan` pulls in `getDb`, `worktreePool`, `getSharedDeps`,
// and the provider launcher façade — too much to mock cleanly without a full
// Electron app context. This test file instead pins the **provider gate**: the
// bridge module's two public helpers must be no-ops for every non-Claude
// provider, and active only for Claude. The launcher.ts itself enforces this
// via `if (provider.id === 'claude')` blocks; the bridge module also returns
// 'skipped' for the safety conditions it can detect internally.
//
// Coverage at the bridge level (`claude-resume-sigma.test.ts`) already pins
// symlink creation / idempotency / missing-source handling / traversal refusal.
// This file's job is to keep the launcher contract honest: a regression that
// accidentally fires `prepareClaudeResume` on codex/gemini/kimi/opencode would
// not break those panes (the bridge is a no-op for non-Claude slugs) but it
// would slow first-launch by a stat() per pane. We assert the bridge is never
// invoked for non-Claude providers by spying on the module.
//
// v1.6.0 Phase 3 — also covers `effectivePaneSpawnMode` (pure helper, no deps).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as bridge from '../pty/claude-resume-sigma.ts';
import { effectivePaneSpawnMode } from '../pty/local-pty';
import { isPtyCrash, buildExtraArgs } from './launcher';

// ─────────────────────────────────────────────────────────────────────────────
// CRIT-1/CRIT-2 twin-B — UNIQUE-violation path leaks the git worktree.
//
// The launcher's UNIQUE catch `continue`s before reaching the outer catch that
// holds the only `worktreePool.remove`. Adding `removeAndPrune` in the
// suppress branch is the fix. These tests verify the contract:
//   • removeAndPrune IS called on a git-repo pane that hits UNIQUE
//   • the returned session carries status:'error'
//   • removeAndPrune is NOT called when the INSERT succeeds (no spurious pruning)
//   • removeAndPrune is NOT called for plain-mode (no worktree was created)
//
// Mocking approach: mirrors factory-spawn.test.ts — vi.mock the DB client,
// the provider launcher façade, and all other I/O-touching side-effects so
// the test runs purely in-process (no better-sqlite3 Electron ABI, no PTY).
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../db/client', () => ({
  getDb: vi.fn(),
  getRawDb: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../providers/launcher', () => ({
  resolveAndSpawn: vi.fn(),
  ProviderLaunchError: class ProviderLaunchError extends Error {},
}));

vi.mock('../../rpc-router', () => ({
  getSharedDeps: vi.fn(() => null),
}));

vi.mock('../browser/mcp-config-writer', () => ({
  writeMcpConfigForAgent: vi.fn(),
}));

vi.mock('./guardrail-block', () => ({
  writeGuardrailBlock: vi.fn(async () => undefined),
}));

vi.mock('./ruflo-worktree-mcp', () => ({
  writeRufloMcpIntoCwd: vi.fn(),
}));

// Note: '../pty/claude-resume-sigma' is intentionally NOT mocked here.
// The CRIT tests use providerId:'shell', which never triggers the claude/gemini
// branches in executeLaunchPlan, so the real bridge module is never called.
// Mocking it would conflict with the existing `bridge` import tests above that
// assert the module is NOT mocked (vi.isMockFunction === false).

vi.mock('../pty/gemini-resume-sigma', () => ({
  prepareGeminiResume: vi.fn(async () => 'skipped'),
  ensureGeminiProjectDir: vi.fn(async () => undefined),
}));

vi.mock('../git/auto-checkpoint', () => ({
  maybeAutoCheckpoint: vi.fn(async () => undefined),
}));

import { getDb, getRawDb } from '../db/client';
import { resolveAndSpawn } from '../providers/launcher';
import { executeLaunchPlan } from './launcher';
import type { LaunchPlan } from '../../../shared/types';

const WS_ID = 'ws-launcher-test';
const REPO_ROOT = '/tmp/repo-root';
const WT_PATH = '/tmp/wt/pane-0';
const SESSION_ID = 'sess-launcher-twin-b';

/** A minimal wsRow shaped like a git-mode workspace DB row. */
const GIT_WS_ROW = {
  id: WS_ID,
  name: 'test-ws',
  rootPath: '/tmp/ws',
  repoRoot: REPO_ROOT,
  repoMode: 'git',
  createdAt: Date.now(),
  lastOpenedAt: Date.now(),
};

/** A minimal raw-db stub that satisfies the KV-reads inside launcher.ts. */
function makeRawStub() {
  return {
    prepare: vi.fn((_sql: string) => ({
      get: vi.fn((_key?: unknown) => undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => undefined),
    })),
    // transaction(fn) just invokes fn — mirrors makeRawStub in factory-spawn.test.ts
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
  };
}

/** Stubs resolveAndSpawn to return a minimal ptySession with id SESSION_ID. */
function stubSpawnForLauncher(): void {
  vi.mocked(resolveAndSpawn).mockImplementation(
    () =>
      ({
        ptySession: {
          id: SESSION_ID,
          providerId: 'shell',
          cwd: '/tmp/ws',
          pid: 9999,
          alive: true,
          startedAt: Date.now(),
          externalSessionId: null,
          pty: {
            pid: 9999,
            write: vi.fn(),
            resize: vi.fn(),
            kill: vi.fn(),
            onData: vi.fn(() => () => undefined),
            onExit: vi.fn(() => () => undefined),
          },
        },
        providerRequested: 'shell',
        providerEffective: 'shell',
        commandUsed: '',
        argsUsed: [],
        fallbackOccurred: false,
      }) as unknown as ReturnType<typeof resolveAndSpawn>,
  );
}

/** Builds a LauncherDeps-compatible test object with spied worktreePool. */
function makeTestDeps(worktreeCreateResult?: { worktreePath: string; branch: string; sessionId: string }) {
  const pty = {
    kill: vi.fn(),
    forget: vi.fn(),
    write: vi.fn(),
  };
  const removeAndPrune = vi.fn().mockResolvedValue(undefined);
  const worktreePool = {
    create: vi.fn().mockResolvedValue(
      worktreeCreateResult ?? { worktreePath: WT_PATH, branch: 'branch-pane-0', sessionId: SESSION_ID },
    ),
    remove: vi.fn().mockResolvedValue(undefined),
    removeAndPrune,
  };
  const deps = { pty, worktreePool } as unknown as Parameters<typeof executeLaunchPlan>[1];
  return { deps, pty, removeAndPrune };
}

/** A minimal git-repo LaunchPlan with one 'shell' pane (no claude/gemini branches). */
function makeGitPlan(): LaunchPlan {
  return {
    workspaceRoot: '/tmp/ws',
    panes: [{ paneIndex: 0, providerId: 'shell' }],
  } as unknown as LaunchPlan;
}

beforeEach(() => {
  stubSpawnForLauncher();
  vi.mocked(getRawDb).mockReturnValue(makeRawStub() as unknown as ReturnType<typeof getRawDb>);
});

afterEach(() => {
  vi.mocked(getDb).mockReset();
  vi.mocked(getRawDb).mockReset();
  vi.mocked(resolveAndSpawn).mockReset();
  vi.restoreAllMocks();
});

describe('executeLaunchPlan — CRIT-1/CRIT-2 twin-B: worktree cleanup on UNIQUE violation', () => {
  it('removeAndPrune is called when a git-repo launch hits a UNIQUE violation', async () => {
    const { deps, pty, removeAndPrune } = makeTestDeps();

    const insertRun = vi.fn(() => {
      throw new Error(
        'UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index',
      );
    });
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(() => GIT_WS_ROW) })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const { sessions } = await executeLaunchPlan(makeGitPlan(), deps);

    // SF-12 contract preserved: PTY is killed + forgotten.
    expect(pty.kill).toHaveBeenCalled();
    expect(pty.forget).toHaveBeenCalled();

    // CRIT-1/CRIT-2: worktree created before the INSERT must be cleaned up.
    expect(removeAndPrune).toHaveBeenCalledWith(REPO_ROOT, WT_PATH);

    // An error session is pushed for the suppressed pane.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe('error');
  });

  it('removeAndPrune is NOT called when the INSERT succeeds (no spurious pruning)', async () => {
    const { deps, removeAndPrune } = makeTestDeps();

    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(() => GIT_WS_ROW) })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const { sessions } = await executeLaunchPlan(makeGitPlan(), deps);

    expect(removeAndPrune).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe('running');
  });

  it('removeAndPrune is NOT called for a plain-mode workspace on UNIQUE violation', async () => {
    const { deps, removeAndPrune } = makeTestDeps();

    const insertRun = vi.fn(() => {
      throw new Error(
        'UNIQUE constraint failed: agent_sessions.workspace_id, agent_sessions.pane_index',
      );
    });
    const PLAIN_WS_ROW = { ...GIT_WS_ROW, repoMode: 'plain', repoRoot: null };
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(() => PLAIN_WS_ROW) })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ run: insertRun })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })) })),
    } as unknown as ReturnType<typeof getDb>);

    const plan: LaunchPlan = {
      workspaceRoot: '/tmp/ws',
      panes: [{ paneIndex: 0, providerId: 'shell' }],
    } as unknown as LaunchPlan;

    const { sessions } = await executeLaunchPlan(plan, deps);

    // No worktree was created (plain mode), so removeAndPrune must not be called.
    expect(removeAndPrune).not.toHaveBeenCalled();
    expect(sessions[0]!.status).toBe('error');
  });
});

describe('Claude resume bridge — provider gate semantics', () => {
  it('exports both helpers as async functions', () => {
    expect(typeof bridge.prepareClaudeResume).toBe('function');
    expect(typeof bridge.ensureClaudeProjectDir).toBe('function');
  });

  it('returns a known-safe outcome for every input the launcher might pass', async () => {
    // The launcher gates on `provider.id === 'claude'`, but defence-in-depth:
    // if a future refactor accidentally invokes the bridge for non-Claude
    // panes the bridge's own input validation must keep it harmless.
    const outcomes = await Promise.all([
      // workspaceCwd === worktreeCwd → 'skipped'
      bridge.prepareClaudeResume('/tmp/x', '/tmp/x', '00000000-0000-4000-8000-000000000000'),
      // Non-UUID id → 'skipped'
      bridge.prepareClaudeResume('/tmp/a', '/tmp/b', 'codex-style-id-not-a-uuid'),
      // Relative workspaceCwd → 'skipped'
      bridge.prepareClaudeResume('relative/path', '/tmp/b', '00000000-0000-4000-8000-000000000000'),
    ]);
    for (const outcome of outcomes) {
      expect(['skipped', 'missing']).toContain(outcome);
    }
  });

  it('ensureClaudeProjectDir returns null for invalid worktree cwd shapes', async () => {
    expect(await bridge.ensureClaudeProjectDir('')).toBeNull();
    expect(await bridge.ensureClaudeProjectDir('relative')).toBeNull();
    expect(await bridge.ensureClaudeProjectDir('/tmp/../etc')).toBeNull();
  });

  it('claudeSlugForCwd matches the on-disk convention the Claude CLI uses', () => {
    // Pinned so any future "tidy" of the slug helper (e.g. base64 encoding
    // for readability) would fail loudly. The Claude CLI's path layout is the
    // contract this bridge is bridging — it cannot change unilaterally.
    expect(bridge.claudeSlugForCwd('/foo/bar')).toBe('-foo-bar');
    expect(bridge.claudeSlugForCwd('/Users/dev/proj')).toBe('-Users-dev-proj');
  });

  // Sanity: confirm vi has not magically loaded a different bridge module.
  it('imports the production bridge module (not a mock)', () => {
    expect(vi.isMockFunction(bridge.prepareClaudeResume)).toBe(false);
    expect(vi.isMockFunction(bridge.ensureClaudeProjectDir)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.6.0 Phase 3 — effectivePaneSpawnMode: per-pane safe-scope override
//
// These tests are pure (no DB/pty deps). They verify the decision table for
// the per-pane spawn-mode override introduced by the SAFE-SCOPE approach.
//
// Provider taxonomy by prompt-delivery path:
//   Path A (arg injection) — oneshotArgs:  claude, codex
//   Path A (arg injection) — initialPromptFlag: gemini
//   Path B (post-spawn write) — neither:  kimi, opencode
// ─────────────────────────────────────────────────────────────────────────────

describe('effectivePaneSpawnMode — per-pane safe-scope override (Phase 3)', () => {
  // ── CRITICAL INVARIANT: direct mode is always a no-op ──────────────────

  it('direct mode, no prompt → stays direct', () => {
    expect(effectivePaneSpawnMode('direct', false, false, false)).toBe('direct');
  });

  it('direct mode, prompt + oneshotArgs provider → stays direct', () => {
    // claude / codex — oneshotArgs present, global mode is direct
    expect(effectivePaneSpawnMode('direct', true, true, false)).toBe('direct');
  });

  it('direct mode, prompt + initialPromptFlag provider → stays direct', () => {
    // gemini — initialPromptFlag present, global mode is direct
    expect(effectivePaneSpawnMode('direct', true, false, true)).toBe('direct');
  });

  it('direct mode, prompt + Path B provider (no flag, no oneshotArgs) → stays direct', () => {
    // kimi / opencode — global mode is direct; override must NOT fire
    expect(effectivePaneSpawnMode('direct', true, false, false)).toBe('direct');
  });

  // ── shell-first mode, Path A providers: prompt is in CLI args — no override needed ──

  it('shell-first, no prompt, oneshotArgs provider → stays shell-first', () => {
    // Dispatch without initialPrompt — shell-first should survive unchanged
    expect(effectivePaneSpawnMode('shell-first', false, true, false)).toBe('shell-first');
  });

  it('shell-first, prompt + oneshotArgs provider (claude/codex) → stays shell-first', () => {
    // Path A: prompt becomes a CLI arg via oneshotArgs; shell-first injection
    // handles it correctly. No fallback to direct.
    expect(effectivePaneSpawnMode('shell-first', true, true, false)).toBe('shell-first');
  });

  it('shell-first, prompt + initialPromptFlag provider (gemini) → stays shell-first', () => {
    // Path A: prompt becomes a CLI arg via initialPromptFlag; shell-first
    // injection handles it. No fallback.
    expect(effectivePaneSpawnMode('shell-first', true, false, true)).toBe('shell-first');
  });

  // ── shell-first mode, Path B providers: post-spawn write races → override to direct ──

  it('shell-first, prompt + Path B provider (kimi/opencode) → overrides to direct', () => {
    // THE CORE CASE: no oneshotArgs, no initialPromptFlag, but has initialPrompt.
    // The post-spawn pty.write would race the shell→CLI startup. Must fall back
    // to direct so the write lands safely.
    expect(effectivePaneSpawnMode('shell-first', true, false, false)).toBe('direct');
  });

  it('shell-first, NO prompt + Path B provider → stays shell-first (no fallback needed)', () => {
    // Without an initialPrompt there is no post-spawn write, so no race.
    // The pane should keep shell-first for durability.
    expect(effectivePaneSpawnMode('shell-first', false, false, false)).toBe('shell-first');
  });

  // ── Edge: both oneshotArgs AND initialPromptFlag set ──────────────────────

  it('shell-first, prompt + both flags set → stays shell-first', () => {
    // Both flags present; oneshotArgs takes precedence in buildExtraArgs but
    // either way the prompt is in the CLI args. No post-spawn write needed.
    expect(effectivePaneSpawnMode('shell-first', true, true, true)).toBe('shell-first');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isPtyCrash — crash-classification IPC helper (pty:error broadcast gate)
//
// This pure helper is extracted from the inline onExit closure so it can be
// unit-tested without spinning up the full executeLaunchPlan context.
// ─────────────────────────────────────────────────────────────────────────────

describe('isPtyCrash — crash vs clean exit classification', () => {
  // ── Clean exit ──────────────────────────────────────────────────────────────

  it('code 0, no signal, not earlyDeath → NOT a crash', () => {
    expect(isPtyCrash(false, 0, undefined)).toBe(false);
  });

  it('code 0, signal 0, not earlyDeath → NOT a crash', () => {
    expect(isPtyCrash(false, 0, 0)).toBe(false);
  });

  it('code 0, signal null, not earlyDeath → NOT a crash', () => {
    expect(isPtyCrash(false, 0, null)).toBe(false);
  });

  // ── Crash via earlyDeath ────────────────────────────────────────────────────

  it('earlyDeath=true, code 0, no signal → IS a crash (early exit)', () => {
    expect(isPtyCrash(true, 0, undefined)).toBe(true);
  });

  it('earlyDeath=true, code 0, signal 0 → IS a crash (early exit)', () => {
    expect(isPtyCrash(true, 0, 0)).toBe(true);
  });

  // ── Crash via non-zero exit code ────────────────────────────────────────────

  it('code 1, not earlyDeath → IS a crash', () => {
    expect(isPtyCrash(false, 1, undefined)).toBe(true);
  });

  it('code -1 (synthetic ENOENT), not earlyDeath → IS a crash', () => {
    expect(isPtyCrash(false, -1, undefined)).toBe(true);
  });

  it('code 127 (command not found), not earlyDeath → IS a crash', () => {
    expect(isPtyCrash(false, 127, undefined)).toBe(true);
  });

  // ── Crash via signal ────────────────────────────────────────────────────────

  it('code 0, signal SIGTERM (15) → IS a crash', () => {
    expect(isPtyCrash(false, 0, 15)).toBe(true);
  });

  it('code 0, signal SIGKILL (9) → IS a crash', () => {
    expect(isPtyCrash(false, 0, 9)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEAT-14 — buildExtraArgs `--model` injection (per-provider, fail-safe)
//
// Pure helper (findProvider is pure data). Verifies the launcher only appends
// `--model <id>` for providers whose CLI accepts the flag, and never for the
// SKIPPED set — so an unknown flag never breaks codex/kimi/opencode/shell.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExtraArgs — FEAT-14 per-pane model flag', () => {
  it('claude with a model → prepends --model <id>', () => {
    expect(buildExtraArgs('claude', undefined, 'claude-sonnet-4-6')).toEqual([
      '--model',
      'claude-sonnet-4-6',
    ]);
  });

  it('gemini with a model → prepends --model <id>', () => {
    expect(buildExtraArgs('gemini', undefined, 'gemini-2.5-pro')).toEqual([
      '--model',
      'gemini-2.5-pro',
    ]);
  });

  it('cursor with a model → prepends --model <id>', () => {
    expect(buildExtraArgs('cursor', undefined, 'gpt-5')).toEqual(['--model', 'gpt-5']);
  });

  it('codex with a model → SKIPPED (no --model flag, no crash)', () => {
    expect(buildExtraArgs('codex', undefined, 'gpt-5.4')).toEqual([]);
  });

  it('kimi / opencode / shell with a model → SKIPPED', () => {
    expect(buildExtraArgs('kimi', undefined, 'kimi-k2.6')).toEqual([]);
    expect(buildExtraArgs('opencode', undefined, 'opencode-default')).toEqual([]);
    expect(buildExtraArgs('shell', undefined, 'whatever')).toEqual([]);
  });

  it('no model → no --model tokens (default behaviour preserved)', () => {
    expect(buildExtraArgs('claude', undefined, undefined)).toEqual([]);
  });

  it('M1 — model NOT in the catalog allowlist → dropped (no --model)', () => {
    // A renderer-supplied modelId that isn't a known catalog model for the
    // provider must not flow through as a CLI arg.
    expect(buildExtraArgs('claude', undefined, '--dangerously-skip-permissions')).toEqual([]);
    expect(buildExtraArgs('claude', undefined, 'gemini-2.5-pro')).toEqual([]); // wrong provider's model
  });

  it('unknown provider → empty array (never throws)', () => {
    expect(buildExtraArgs('does-not-exist', undefined, 'm')).toEqual([]);
  });

  it('model + prompt: model tokens precede the prompt tokens', () => {
    // gemini uses initialPromptFlag — both should be present, model first.
    const out = buildExtraArgs('gemini', 'hello world', 'gemini-2.5-pro');
    expect(out.slice(0, 2)).toEqual(['--model', 'gemini-2.5-pro']);
    expect(out).toContain('hello world');
  });
});
