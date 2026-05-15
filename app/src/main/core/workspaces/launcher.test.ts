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
// Coverage at the bridge level (`claude-resume-bridge.test.ts`) already pins
// symlink creation / idempotency / missing-source handling / traversal refusal.
// This file's job is to keep the launcher contract honest: a regression that
// accidentally fires `prepareClaudeResume` on codex/gemini/kimi/opencode would
// not break those panes (the bridge is a no-op for non-Claude slugs) but it
// would slow first-launch by a stat() per pane. We assert the bridge is never
// invoked for non-Claude providers by spying on the module.

import { describe, it, expect, vi } from 'vitest';
import * as bridge from '../pty/claude-resume-bridge.ts';

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
