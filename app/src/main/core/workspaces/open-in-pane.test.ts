import { describe, it, expect, vi } from 'vitest';
import { openInPane } from './open-in-pane';
import type { OpenInPaneDeps } from './open-in-pane';

function makeDeps(
  session: { id: string; status: string; cwd: string; worktreePath: string | null } | null,
): { deps: OpenInPaneDeps; respawnInCwd: ReturnType<typeof vi.fn>; updateSessionCwd: ReturnType<typeof vi.fn> } {
  const respawnInCwd = vi.fn().mockResolvedValue(undefined);
  const updateSessionCwd = vi.fn();
  const deps: OpenInPaneDeps = {
    getSession: vi.fn().mockReturnValue(session),
    respawnInCwd,
    updateSessionCwd,
  };
  return { deps, respawnInCwd, updateSessionCwd };
}

describe('openInPane', () => {
  describe('missing session', () => {
    it('returns {ok:false} when session is not found', async () => {
      const { deps } = makeDeps(null);
      const result = await openInPane(deps, { sessionId: 'nonexistent', worktreePath: '/tmp/wt' });
      expect(result).toEqual({ ok: false });
    });

    it('does NOT call respawnInCwd when session is not found', async () => {
      const { deps, respawnInCwd } = makeDeps(null);
      await openInPane(deps, { sessionId: 'nonexistent', worktreePath: '/tmp/wt' });
      expect(respawnInCwd).not.toHaveBeenCalled();
    });

    it('does NOT call updateSessionCwd when session is not found', async () => {
      const { deps, updateSessionCwd } = makeDeps(null);
      await openInPane(deps, { sessionId: 'nonexistent', worktreePath: '/tmp/wt' });
      expect(updateSessionCwd).not.toHaveBeenCalled();
    });
  });

  describe('running session (safety invariant)', () => {
    const runningSession = { id: 'sess-1', status: 'running', cwd: '/old', worktreePath: null };

    it('returns {ok:false} for a running session', async () => {
      const { deps } = makeDeps(runningSession);
      const result = await openInPane(deps, { sessionId: 'sess-1', worktreePath: '/tmp/wt' });
      expect(result).toEqual({ ok: false });
    });

    it('does NOT call respawnInCwd for a running session', async () => {
      const { deps, respawnInCwd } = makeDeps(runningSession);
      await openInPane(deps, { sessionId: 'sess-1', worktreePath: '/tmp/wt' });
      expect(respawnInCwd).not.toHaveBeenCalled();
    });

    it('does NOT call updateSessionCwd for a running session', async () => {
      const { deps, updateSessionCwd } = makeDeps(runningSession);
      await openInPane(deps, { sessionId: 'sess-1', worktreePath: '/tmp/wt' });
      expect(updateSessionCwd).not.toHaveBeenCalled();
    });
  });

  describe('idle session (happy path)', () => {
    const idleSession = { id: 'sess-2', status: 'idle', cwd: '/old', worktreePath: null };

    it('returns {ok:true} for an idle session', async () => {
      const { deps } = makeDeps(idleSession);
      const result = await openInPane(deps, { sessionId: 'sess-2', worktreePath: '/tmp/wt' });
      expect(result).toEqual({ ok: true });
    });

    it('calls updateSessionCwd with sessionId and worktreePath', async () => {
      const { deps, updateSessionCwd } = makeDeps(idleSession);
      await openInPane(deps, { sessionId: 'sess-2', worktreePath: '/tmp/wt' });
      expect(updateSessionCwd).toHaveBeenCalledWith('sess-2', '/tmp/wt', '/tmp/wt');
    });

    it('calls respawnInCwd with sessionId and worktreePath', async () => {
      const { deps, respawnInCwd } = makeDeps(idleSession);
      await openInPane(deps, { sessionId: 'sess-2', worktreePath: '/tmp/wt' });
      expect(respawnInCwd).toHaveBeenCalledWith('sess-2', '/tmp/wt');
    });

    it('calls updateSessionCwd BEFORE respawnInCwd', async () => {
      const callOrder: string[] = [];
      const session = { id: 'sess-2', status: 'idle', cwd: '/old', worktreePath: null };
      const deps: OpenInPaneDeps = {
        getSession: vi.fn().mockReturnValue(session),
        updateSessionCwd: vi.fn().mockImplementation(() => { callOrder.push('update'); }),
        respawnInCwd: vi.fn().mockImplementation(async () => { callOrder.push('respawn'); }),
      };
      await openInPane(deps, { sessionId: 'sess-2', worktreePath: '/tmp/wt' });
      expect(callOrder).toEqual(['update', 'respawn']);
    });
  });

  describe('exited session (also idle-like)', () => {
    it('returns {ok:true} for an exited session (not running)', async () => {
      const exitedSession = { id: 'sess-3', status: 'exited', cwd: '/old', worktreePath: null };
      const { deps } = makeDeps(exitedSession);
      const result = await openInPane(deps, { sessionId: 'sess-3', worktreePath: '/tmp/wt' });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('stopped session', () => {
    it('returns {ok:true} for a stopped session', async () => {
      const stoppedSession = { id: 'sess-4', status: 'stopped', cwd: '/old', worktreePath: null };
      const { deps } = makeDeps(stoppedSession);
      const result = await openInPane(deps, { sessionId: 'sess-4', worktreePath: '/tmp/wt' });
      expect(result).toEqual({ ok: true });
    });
  });
});
