// Phase 4 — derivePaneIdentity shared metadata bundle coverage.
import { describe, expect, it } from 'vitest';
import { derivePaneIdentity } from './pane-identity';
import type { AgentSession } from '@/shared/types';

function makeSession(o: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    providerId: 'claude',
    status: 'running',
    branch: 'feature/x',
    cwd: '/repo',
    startedAt: 0,
    ...o,
  } as AgentSession;
}

describe('derivePaneIdentity', () => {
  it('exposes alias, agentId, provider name/color, model+effort, branch, cwd', () => {
    const id = derivePaneIdentity(makeSession());
    expect(typeof id.alias).toBe('string');
    expect(id.alias.length).toBeGreaterThan(0);
    expect(typeof id.agentId).toBe('string');
    expect(id.providerName.length).toBeGreaterThan(0);
    expect(id.providerColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(id.branch).toBe('feature/x');
    expect(id.cwd).toBe('/repo');
    expect(typeof id.modelLabel).toBe('string');
    expect(typeof id.effortLabel).toBe('string');
  });

  it('defaults branch to "dev" when the session has none', () => {
    expect(derivePaneIdentity(makeSession({ branch: undefined })).branch).toBe('dev');
  });

  it('defaults worktreePath to null when absent', () => {
    expect(derivePaneIdentity(makeSession({ worktreePath: undefined })).worktreePath).toBeNull();
  });

  it('is not relabelled when displayProviderId is absent', () => {
    expect(derivePaneIdentity(makeSession()).isRelabelled).toBe(false);
  });

  it('flags relabel when displayProviderId differs from the real providerId', () => {
    const id = derivePaneIdentity(
      makeSession({ providerId: 'claude', displayProviderId: 'codex' }),
    );
    expect(id.isRelabelled).toBe(true);
    expect(id.realProviderName.length).toBeGreaterThan(0);
  });

  it('is deterministic — same session yields the same alias/accent', () => {
    const s = makeSession();
    expect(derivePaneIdentity(s).alias).toBe(derivePaneIdentity(s).alias);
    expect(derivePaneIdentity(s).agentAccent).toBe(derivePaneIdentity(s).agentAccent);
  });
});
