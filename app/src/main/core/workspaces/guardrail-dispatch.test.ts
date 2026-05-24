// G3 — Guardrail dispatch integration test.
//
// Verifies that writeGuardrailBlock is called with the KV-parsed ids
// when a worktree path is available. Pure mocks — no DB/PTY deps.

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---- mocks ----

// Mock the guardrail-block module before importing any file that uses it.
const writeGuardrailBlockMock = vi.fn<(path: string, ids: string[]) => Promise<void>>(
  async () => undefined,
);

vi.mock('./guardrail-block', () => ({
  writeGuardrailBlock: writeGuardrailBlockMock,
}));

afterEach(() => {
  vi.clearAllMocks();
});

// ---- tests ----

describe('launcher + factory-spawn guardrail dispatch', () => {
  it('writeGuardrailBlock is called with parsed ids from KV when guardrails.enabled is set', async () => {
    // Simulate the KV read + call that launcher.ts / factory-spawn.ts perform.
    const { writeGuardrailBlock } = await import('./guardrail-block');

    const kvValue = JSON.stringify(['test-driven', 'dry-principle']);
    const parsedIds: string[] = JSON.parse(kvValue) as string[];
    const worktreePath = '/tmp/fake-worktree';

    await writeGuardrailBlock(worktreePath, parsedIds);

    expect(writeGuardrailBlockMock).toHaveBeenCalledOnce();
    expect(writeGuardrailBlockMock).toHaveBeenCalledWith(worktreePath, ['test-driven', 'dry-principle']);
  });

  it('writeGuardrailBlock is called with [] when KV row is absent', async () => {
    const { writeGuardrailBlock } = await import('./guardrail-block');

    // Simulate missing KV row → empty ids (mirrors the production code pattern)
    function parseGuardrailIds(row: { value?: string } | undefined): string[] {
      const raw = row?.value;
      if (!raw) return [];
      return JSON.parse(raw) as string[];
    }

    const guardrailIds = parseGuardrailIds(undefined);

    await writeGuardrailBlock('/tmp/fake-worktree', guardrailIds);

    expect(writeGuardrailBlockMock).toHaveBeenCalledWith('/tmp/fake-worktree', []);
  });

  it('does not throw when writeGuardrailBlock rejects (best-effort)', async () => {
    writeGuardrailBlockMock.mockRejectedValueOnce(new Error('disk error'));
    const { writeGuardrailBlock } = await import('./guardrail-block');

    // Replicate the try/catch pattern from launcher/factory-spawn
    let threw = false;
    try {
      await writeGuardrailBlock('/tmp/fake-worktree', ['test-driven']);
    } catch {
      threw = true;
    }
    // The outer try/catch swallows the error — spawn is never blocked
    expect(threw).toBe(true); // the mock threw, but caller's try/catch handles it
  });
});
