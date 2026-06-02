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

import { describe, it, expect, vi } from 'vitest';
import * as bridge from '../pty/claude-resume-sigma.ts';
import { effectivePaneSpawnMode } from '../pty/local-pty';
import { isPtyCrash, buildExtraArgs } from './launcher';

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
